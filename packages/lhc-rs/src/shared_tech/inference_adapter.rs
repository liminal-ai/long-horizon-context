//! Ported from packages/lhc/src/shared-tech/inference-adapter.ts.
//!
//! createInferenceCallbacks returns the same InferenceCallbacks interface direct
//! injection implements. Wave 1 deleted target_ratios_of as premature; Wave 2
//! restores the extraction surface tests/handlers need.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::classify::safe_call;
use super::derivation::{
    BoxFuture, CompressDetailedTurnInput, InferenceCallbacks, InferenceRequestMessage,
    InferenceRequestRole, InferenceResult, ProviderProvenance, SmoothPromptInput,
    SummarizeChunkBriefInput, SummarizeToolResultInput, ToolOutcome, ToolResultOperationClass,
    ToolResultPromptMode, ToolResultResponseShape,
};
use super::inference_types::{
    ModelAssignment, ModelCallFailureKind, ModelCallInput, ModelCallMessage, ModelCallMessageRole,
    ModelCallResult, ResolvedInferenceConfig,
};
use super::js_json::{js_len, js_slice, js_trim};
use super::prompts::registry_get;

/// Partial pick of assignment target-ratio fields (camelCase wire keys).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetRatios {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_min_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_max_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_aim_ratio: Option<f64>,
}

/// TS `boundContent` — marker string is built inline at runtime (no module const).
fn bound_content(content: &str, max_input_chars: i64) -> String {
    if (js_len(content) as i64) <= max_input_chars {
        return content.to_string();
    }
    let marker = format!(
        "\n\n[... truncated: tool result was {} chars; head and tail retained ...]\n\n",
        js_len(content)
    );
    // The marker only earns its place when head + marker + tail still fits the
    // bound. When maxInputChars is smaller than the marker itself, there is no
    // budget for the marker — emitting it would be the one path that crosses the
    // configured boundary exists to hold, so degrade to a plain head truncation
    // that honors the cap exactly.
    if (js_len(&marker) as i64) > max_input_chars {
        return js_slice(content, 0, Some(max_input_chars));
    }
    let keep = max_input_chars - js_len(&marker) as i64;
    let head = ((keep as f64) / 2.0).ceil() as i64;
    let tail = keep - head;
    let mut out = js_slice(content, 0, Some(head));
    out.push_str(&marker);
    if tail > 0 {
        out.push_str(&js_slice(content, js_len(content) as i64 - tail, None));
    }
    out
}

fn inference_failure(
    kind: ModelCallFailureKind,
    message: &str,
    request_messages: Option<Vec<InferenceRequestMessage>>,
) -> InferenceResult {
    let kind_str = kind.as_str();
    let detail = if message.is_empty() {
        kind_str.to_string()
    } else {
        format!("{kind_str}: {message}")
    };
    let reason = match kind {
        ModelCallFailureKind::Auth | ModelCallFailureKind::InvalidRequest => detail,
        ModelCallFailureKind::RateLimit
        | ModelCallFailureKind::Timeout
        | ModelCallFailureKind::Network
        | ModelCallFailureKind::EmptyOutput
        | ModelCallFailureKind::Other => format!("provider_failure: {detail}"),
    };
    InferenceResult::Err {
        reason,
        request_messages,
    }
}

/// Target ratios carried on an assignment, extracted as a plain object so the
/// adapter can merge them into a prompt's render input. Exported so tests pin
/// the extraction directly.
pub fn target_ratios_of(assignment: Option<&ModelAssignment>) -> TargetRatios {
    let Some(assignment) = assignment else {
        return TargetRatios::default();
    };
    TargetRatios {
        target_min_ratio: assignment.target_min_ratio,
        target_max_ratio: assignment.target_max_ratio,
        target_aim_ratio: assignment.target_aim_ratio,
    }
}

/// Merge an assignment's target ratios into a prompt's render input.
fn with_target_ratios(input: &Value, assignment: &ModelAssignment) -> Value {
    let ratios = target_ratios_of(Some(assignment));
    let Value::Object(mut map) = input.clone() else {
        return input.clone();
    };
    if let Ok(Value::Object(ratio_map)) = serde_json::to_value(&ratios) {
        for (key, value) in ratio_map {
            map.insert(key, value);
        }
    }
    Value::Object(map)
}

fn to_model_call_messages(messages: &[InferenceRequestMessage]) -> Vec<ModelCallMessage> {
    messages
        .iter()
        .map(|m| ModelCallMessage {
            role: match m.role {
                InferenceRequestRole::System => ModelCallMessageRole::System,
                InferenceRequestRole::User => ModelCallMessageRole::User,
            },
            content: m.content.clone(),
        })
        .collect()
}

async fn call_kind(config: &ResolvedInferenceConfig, kind: &str, input: Value) -> InferenceResult {
    let Some(assignment) = config.assignments.get(kind) else {
        return inference_failure(
            ModelCallFailureKind::InvalidRequest,
            &format!("no assignment for derivation type \"{kind}\""),
            None,
        );
    };
    // Construction validated the name; a miss here is registry drift after
    // construction and is terminal, never retried into.
    let Some(template) = registry_get(&assignment.prompt) else {
        return inference_failure(
            ModelCallFailureKind::InvalidRequest,
            &format!("prompt template \"{}\" not in registry", assignment.prompt),
            None,
        );
    };
    let messages = (template.render)(&with_target_ratios(&input, assignment));
    // safeCall contains the host: thrown exceptions arrive as structured
    // `other` failures and a hung function loses the timeout race as `timeout`;
    // both flow through the same classification below.
    let result = safe_call(
        &config.call,
        ModelCallInput {
            provider: assignment.provider.clone(),
            model: assignment.model.clone(),
            messages: to_model_call_messages(&messages),
            thinking: assignment.thinking,
        },
        config.timeout_ms,
    )
    .await;
    match result {
        ModelCallResult::Err { kind, message } => inference_failure(kind, &message, Some(messages)),
        ModelCallResult::Ok { text: raw_text } => {
            // Shaping: surrounding whitespace never becomes derivation content — and a
            // model that returned nothing but whitespace has not produced a
            // derivation: a failure, never a ready derivation.
            // `empty_output` is adapter-generated; hosts never return it.
            let text = js_trim(&raw_text);
            if text.is_empty() {
                return inference_failure(
                    ModelCallFailureKind::EmptyOutput,
                    "model returned empty or whitespace-only text",
                    Some(messages),
                );
            }
            // Provenance is the assignment's three config-known strings, copied, never
            // authored from model output.
            InferenceResult::Ok {
                text: text.to_string(),
                provenance: Some(ProviderProvenance {
                    provider: assignment.provider.clone(),
                    model: assignment.model.clone(),
                    prompt: assignment.prompt.clone(),
                }),
                request_messages: Some(messages),
                raw_response: Some(raw_text),
            }
        }
    }
}

/// TS `createInferenceCallbacks(config)`.
pub fn create_inference_callbacks(config: ResolvedInferenceConfig) -> InferenceCallbacks {
    let config = Arc::new(config);
    let config_smooth = Arc::clone(&config);
    let config_tool = Arc::clone(&config);
    let config_compress = Arc::clone(&config);
    let config_brief = Arc::clone(&config);
    InferenceCallbacks {
        smooth_prompt: Arc::new(move |i: SmoothPromptInput| {
            let config = Arc::clone(&config_smooth);
            Box::pin(async move {
                let input = serde_json::to_value(&i).expect("SmoothPromptInput serializes");
                call_kind(&config, "smoothed_prompt", input).await
            }) as BoxFuture<InferenceResult>
        }),
        summarize_tool_result: Arc::new(move |i: SummarizeToolResultInput| {
            let config = Arc::clone(&config_tool);
            Box::pin(async move {
                let input = json!({
                    "toolName": i.tool_name,
                    "content": bound_content(&i.content, config.max_input_chars),
                    "outcome": i.outcome.unwrap_or(ToolOutcome::Unknown).as_str(),
                    "targetTokens": i.target_tokens.unwrap_or(150),
                    "operationClass": i
                        .operation_class
                        .unwrap_or(ToolResultOperationClass::Unknown)
                        .as_str(),
                    "responseShape": i
                        .response_shape
                        .unwrap_or(ToolResultResponseShape::UnknownContent)
                        .as_str(),
                    "promptMode": i
                        .prompt_mode
                        .unwrap_or(ToolResultPromptMode::GenericSummary)
                        .as_str(),
                    "facts": i.facts.unwrap_or_default(),
                });
                call_kind(&config, "tool_result_summary", input).await
            }) as BoxFuture<InferenceResult>
        }),
        compress_detailed_turn: Arc::new(move |i: CompressDetailedTurnInput| {
            let config = Arc::clone(&config_compress);
            Box::pin(async move {
                let input = serde_json::to_value(&i).expect("CompressDetailedTurnInput serializes");
                call_kind(&config, "detailed_turn_compression", input).await
            }) as BoxFuture<InferenceResult>
        }),
        summarize_chunk_brief: Arc::new(move |i: SummarizeChunkBriefInput| {
            let config = Arc::clone(&config_brief);
            Box::pin(async move {
                let input = serde_json::to_value(&i).expect("SummarizeChunkBriefInput serializes");
                call_kind(&config, "chunk_summary_brief", input).await
            }) as BoxFuture<InferenceResult>
        }),
    }
}

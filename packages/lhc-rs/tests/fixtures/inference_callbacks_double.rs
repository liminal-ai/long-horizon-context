//! Ported from packages/lhc/test/fixtures/inference-callbacks-double.ts.
//! Phase 1: REAL double (matches current Python — deterministic marked output
//! via `deterministic_text`). Scripting state is per-instance.
//!
//! Note: `deterministic_text` itself is still `todo!("phase 2")` in the crate,
//! so success-path calls panic as notimpl until Phase 2 fills that helper.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use lhc::shared_tech::derivation::{
    BoxFuture, CompressDetailedTurnInput, InferenceCallbacks, InferenceResult, SmoothPromptInput,
    SummarizeChunkBriefInput, SummarizeToolResultInput,
};
use lhc::shared_tech::deterministic::{DeterministicOpName, deterministic_text};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InferenceCallbackOpName {
    SmoothPrompt,
    SummarizeToolResult,
    CompressDetailedTurn,
    SummarizeChunkBrief,
}

impl InferenceCallbackOpName {
    pub fn as_str(self) -> &'static str {
        match self {
            InferenceCallbackOpName::SmoothPrompt => "smoothPrompt",
            InferenceCallbackOpName::SummarizeToolResult => "summarizeToolResult",
            InferenceCallbackOpName::CompressDetailedTurn => "compressDetailedTurn",
            InferenceCallbackOpName::SummarizeChunkBrief => "summarizeChunkBrief",
        }
    }

    fn to_deterministic(self) -> DeterministicOpName {
        match self {
            InferenceCallbackOpName::SmoothPrompt => DeterministicOpName::SmoothPrompt,
            InferenceCallbackOpName::SummarizeToolResult => {
                DeterministicOpName::SummarizeToolResult
            }
            InferenceCallbackOpName::CompressDetailedTurn => {
                DeterministicOpName::CompressDetailedTurn
            }
            InferenceCallbackOpName::SummarizeChunkBrief => {
                DeterministicOpName::SummarizeChunkBrief
            }
        }
    }
}

fn resolve_op_name(kind: &str) -> InferenceCallbackOpName {
    match kind {
        "smoothPrompt" | "prompt_smoothing" | "smoothed_prompt" => {
            InferenceCallbackOpName::SmoothPrompt
        }
        "summarizeToolResult" | "tool_result_summary" => {
            InferenceCallbackOpName::SummarizeToolResult
        }
        "compressDetailedTurn" | "detailed_turn_compression" => {
            InferenceCallbackOpName::CompressDetailedTurn
        }
        "summarizeChunkBrief" | "chunk_summary_brief" => {
            InferenceCallbackOpName::SummarizeChunkBrief
        }
        other => panic!("inference callbacks double: unknown operation/kind \"{other}\""),
    }
}

#[derive(Debug, Clone)]
struct FailScript {
    remaining: i64,
    reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CapturedInput {
    pub op: InferenceCallbackOpName,
    pub input: Value,
}

struct DoubleState {
    fail_next_script: Option<FailScript>,
    fail_by_op: HashMap<InferenceCallbackOpName, FailScript>,
    delay_by_op: HashMap<InferenceCallbackOpName, u64>,
    capturing: bool,
    captured: Vec<CapturedInput>,
}

#[derive(Clone)]
pub struct CapturedLog {
    state: Arc<Mutex<DoubleState>>,
}

impl CapturedLog {
    pub fn len(&self) -> usize {
        self.state.lock().unwrap().captured.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn snapshot(&self) -> Vec<CapturedInput> {
        self.state.lock().unwrap().captured.clone()
    }
}

/// Deterministic InferenceCallbacks double (DD-7).
#[derive(Clone)]
pub struct InferenceCallbacksDouble {
    state: Arc<Mutex<DoubleState>>,
}

impl Default for InferenceCallbacksDouble {
    fn default() -> Self {
        Self::new()
    }
}

impl InferenceCallbacksDouble {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(DoubleState {
                fail_next_script: None,
                fail_by_op: HashMap::new(),
                delay_by_op: HashMap::new(),
                capturing: false,
                captured: Vec::new(),
            })),
        }
    }

    pub fn fail_next(&self, n: i64, reason: Option<&str>) {
        let mut state = self.state.lock().unwrap();
        state.fail_next_script = Some(FailScript {
            remaining: n,
            reason: reason.unwrap_or("scripted failure (failNext)").to_string(),
        });
    }

    pub fn fail_kind(&self, kind: &str, n: i64, reason: Option<&str>) {
        let op = resolve_op_name(kind);
        let mut state = self.state.lock().unwrap();
        state.fail_by_op.insert(
            op,
            FailScript {
                remaining: n,
                reason: reason
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("scripted failure ({})", op.as_str())),
            },
        );
    }

    pub fn delay_kind(&self, kind: &str, ms: u64) {
        let op = resolve_op_name(kind);
        self.state.lock().unwrap().delay_by_op.insert(op, ms);
    }

    /// Start capturing inputs; returns a live handle (TS returns the array by reference).
    pub fn capture_inputs(&self) -> CapturedLog {
        self.state.lock().unwrap().capturing = true;
        CapturedLog {
            state: Arc::clone(&self.state),
        }
    }

    pub fn captured(&self) -> Vec<CapturedInput> {
        self.state.lock().unwrap().captured.clone()
    }

    async fn run(
        &self,
        op: InferenceCallbackOpName,
        input: Value,
        text: &str,
        suffix: &str,
    ) -> InferenceResult {
        let delay = {
            let mut state = self.state.lock().unwrap();
            if state.capturing {
                state.captured.push(CapturedInput {
                    op,
                    input: input.clone(),
                });
            }
            state.delay_by_op.get(&op).copied().unwrap_or(0)
        };
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        {
            let mut state = self.state.lock().unwrap();
            if let Some(script) = state.fail_next_script.as_mut()
                && script.remaining > 0
            {
                script.remaining -= 1;
                return InferenceResult::Err {
                    reason: script.reason.clone(),
                    request_messages: None,
                };
            }
            if let Some(script) = state.fail_by_op.get_mut(&op)
                && script.remaining > 0
            {
                script.remaining -= 1;
                return InferenceResult::Err {
                    reason: script.reason.clone(),
                    request_messages: None,
                };
            }
        }
        let text = deterministic_text(op.to_deterministic(), &input, text) + suffix;
        InferenceResult::Ok {
            text,
            provenance: None,
            request_messages: None,
            raw_response: None,
        }
    }

    pub async fn smooth_prompt(&self, i: SmoothPromptInput) -> InferenceResult {
        let input = serde_json::to_value(&i).expect("SmoothPromptInput serializes");
        self.run(InferenceCallbackOpName::SmoothPrompt, input, &i.text, "")
            .await
    }

    pub async fn summarize_tool_result(&self, i: SummarizeToolResultInput) -> InferenceResult {
        let input = serde_json::to_value(&i).expect("SummarizeToolResultInput serializes");
        let content = i.content.clone();
        self.run(
            InferenceCallbackOpName::SummarizeToolResult,
            input,
            &content,
            "",
        )
        .await
    }

    pub async fn compress_detailed_turn(&self, i: CompressDetailedTurnInput) -> InferenceResult {
        let input = serde_json::to_value(&i).expect("CompressDetailedTurnInput serializes");
        let dialogue = i.dialogue_text.clone();
        self.run(
            InferenceCallbackOpName::CompressDetailedTurn,
            input,
            &dialogue,
            "",
        )
        .await
    }

    pub async fn summarize_chunk_brief(&self, i: SummarizeChunkBriefInput) -> InferenceResult {
        let input = serde_json::to_value(&i).expect("SummarizeChunkBriefInput serializes");
        let text = i.text.clone();
        self.run(
            InferenceCallbackOpName::SummarizeChunkBrief,
            input,
            &text,
            "",
        )
        .await
    }

    /// Convert to the production `InferenceCallbacks` seam (shared Arc state).
    pub fn to_callbacks(&self) -> InferenceCallbacks {
        let this = self.clone();
        let smooth = this.clone();
        let tool = this.clone();
        let compress = this.clone();
        let brief = this.clone();
        InferenceCallbacks {
            smooth_prompt: Arc::new(move |i| {
                let smooth = smooth.clone();
                Box::pin(async move { smooth.smooth_prompt(i).await }) as BoxFuture<_>
            }),
            summarize_tool_result: Arc::new(move |i| {
                let tool = tool.clone();
                Box::pin(async move { tool.summarize_tool_result(i).await }) as BoxFuture<_>
            }),
            compress_detailed_turn: Arc::new(move |i| {
                let compress = compress.clone();
                Box::pin(async move { compress.compress_detailed_turn(i).await }) as BoxFuture<_>
            }),
            summarize_chunk_brief: Arc::new(move |i| {
                let brief = brief.clone();
                Box::pin(async move { brief.summarize_chunk_brief(i).await }) as BoxFuture<_>
            }),
        }
    }
}

pub fn create_inference_callbacks_double() -> InferenceCallbacksDouble {
    InferenceCallbacksDouble::new()
}

// Silence unused Serialize import if inputs already derive it.
fn _assert_serialize<T: Serialize>() {}
fn _check() {
    _assert_serialize::<SmoothPromptInput>();
}

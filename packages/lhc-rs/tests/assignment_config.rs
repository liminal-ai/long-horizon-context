//! Ported from packages/lhc/test/assignment-config.test.ts. Phase 1.
//!
//! Epic 07 Story 0 — assignment config and defaults (Flow 6 + AC-0.3).

mod fixtures;

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use lhc::shared_tech::derivation::{
    CompressDetailedTurnInput, CompressionTargets, SdkConfig, SdkMode, SmoothPromptInput,
    SummarizeChunkBriefInput, SummarizeToolResultInput, ToolOutcome,
};
use lhc::shared_tech::inference_types::{
    DEFAULT_GUARDS, DerivationGuards, InferenceConfig, ModelAssignment, ModelCall, ModelCallInput,
    ModelCallResult, SmoothedPromptGuards, ThinkingLevel, resolve_guards,
};
use lhc::{Lhc, init_lhc};

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_else(|| "non-string panic payload".into())
}

/// A ModelCall that records every input and resolves to a minimal success.
fn recording_call_ok() -> (ModelCall, Arc<Mutex<Vec<ModelCallInput>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let log_c = Arc::clone(&log);
    let call: ModelCall = Arc::new(move |input| {
        let log_c = Arc::clone(&log_c);
        Box::pin(async move {
            log_c.lock().expect("log").push(input);
            ModelCallResult::Ok { text: "ok".into() }
        })
    });
    (call, log)
}

fn expect_throw_matching(make: impl FnOnce(), needle: &str) {
    let result = std::panic::catch_unwind(AssertUnwindSafe(make));
    let Err(err) = result else {
        panic!("init_lhc must reject this config");
    };
    let msg = panic_message(err);
    if msg.contains("phase 2") || msg.contains("not yet implemented") {
        panic!("{msg}");
    }
    assert!(
        msg.contains(needle),
        "expected panic message to contain {needle:?}, got {msg}"
    );
}

fn assignment(provider: &str, model: &str, prompt: &str) -> ModelAssignment {
    ModelAssignment {
        provider: provider.into(),
        model: model.into(),
        prompt: prompt.into(),
        target_min_ratio: None,
        target_max_ratio: None,
        target_aim_ratio: None,
        thinking: None,
    }
}

async fn run_default_inference_ops(sdk: &Lhc) {
    let _ = (sdk.config.inference_callbacks.smooth_prompt)(SmoothPromptInput { text: "x".into() })
        .await;
    let _ = (sdk.config.inference_callbacks.summarize_tool_result)(SummarizeToolResultInput {
        tool_name: "read".into(),
        content: "c".into(),
        outcome: Some(ToolOutcome::Succeeded),
        target_tokens: None,
        operation_class: None,
        response_shape: None,
        prompt_mode: None,
        facts: None,
    })
    .await;
    let _ = (sdk.config.inference_callbacks.compress_detailed_turn)(CompressDetailedTurnInput {
        dialogue_text: "r".into(),
        input_tokens: 10,
        target_min_tokens: 4,
        target_aim_tokens: 5,
        target_max_tokens: 7,
    })
    .await;
    let _ = (sdk.config.inference_callbacks.summarize_chunk_brief)(SummarizeChunkBriefInput {
        text: "m".into(),
        input_tokens: 10,
        target_min_tokens: 1,
        target_aim_tokens: 2,
        target_max_tokens: 3,
    })
    .await;
}

#[test]
fn constructs_with_only_inference_assignments_no_deterministic_entries_required() {
    let mut assignments = IndexMap::new();
    assignments.insert(
        "smoothed_prompt".into(),
        assignment("p", "m", "smoothing-v1"),
    );
    assignments.insert(
        "tool_result_summary".into(),
        assignment("p", "m", "tool-result-v1"),
    );
    assignments.insert(
        "detailed_turn_compression".into(),
        assignment("p", "m", "detailed-turn-compression-v1"),
    );
    assignments.insert(
        "chunk_summary_brief".into(),
        assignment("p", "m", "chunk-brief-v2"),
    );
    let (call, _log) = recording_call_ok();
    let _ = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
}

#[test]
fn constructs_when_deterministic_types_turn_rendering_chunk_summary_detailed_are_absent() {
    let (call, _log) = recording_call_ok();
    let mut assignments = IndexMap::new();
    assignments.insert(
        "smoothed_prompt".into(),
        assignment("p", "m", "smoothing-v1"),
    );
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let _ = &sdk;
}

#[test]
fn detailed_turn_compression_and_chunk_summary_brief_accept_target_ratios_without_error() {
    let mut assignments = IndexMap::new();
    assignments.insert(
        "smoothed_prompt".into(),
        assignment("p", "m", "smoothing-v1"),
    );
    assignments.insert(
        "tool_result_summary".into(),
        assignment("p", "m", "tool-result-v1"),
    );
    assignments.insert(
        "detailed_turn_compression".into(),
        ModelAssignment {
            provider: "p".into(),
            model: "m".into(),
            prompt: "detailed-turn-compression-v1".into(),
            target_min_ratio: Some(0.35),
            target_aim_ratio: Some(0.5),
            target_max_ratio: Some(0.65),
            thinking: None,
        },
    );
    assignments.insert(
        "chunk_summary_brief".into(),
        ModelAssignment {
            provider: "p".into(),
            model: "m".into(),
            prompt: "chunk-brief-v2".into(),
            target_min_ratio: Some(0.08),
            target_aim_ratio: Some(0.12),
            target_max_ratio: Some(0.2),
            thinking: None,
        },
    );
    let (call, _log) = recording_call_ok();
    let _ = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
}

#[test]
fn rejects_detailed_turn_compression_target_aim_outside_min_max() {
    let mut assignments = IndexMap::new();
    assignments.insert(
        "detailed_turn_compression".into(),
        ModelAssignment {
            provider: "p".into(),
            model: "m".into(),
            prompt: "detailed-turn-compression-v1".into(),
            target_min_ratio: Some(0.35),
            target_aim_ratio: Some(0.8),
            target_max_ratio: Some(0.65),
            thinking: None,
        },
    );
    let (call, _log) = recording_call_ok();
    expect_throw_matching(
        move || {
            let _ = init_lhc(SdkConfig {
                inference_callbacks: None,
                inference: Some(InferenceConfig {
                    call,
                    assignments: Some(assignments),
                    timeout_ms: None,
                    max_input_chars: None,
                }),
                mode: SdkMode::Manual,
                clock: None,
                guards: None,
                tool_result: None,
                lease: None,
                chunk_policy: None,
                view: None,
            });
        },
        "compressionTargets.aimRatio must be between minRatio and maxRatio",
    );
}

#[test]
fn rejects_chunk_summary_brief_target_aim_outside_min_max() {
    let mut assignments = IndexMap::new();
    assignments.insert(
        "chunk_summary_brief".into(),
        ModelAssignment {
            provider: "p".into(),
            model: "m".into(),
            prompt: "chunk-brief-v2".into(),
            target_min_ratio: Some(0.08),
            target_aim_ratio: Some(0.3),
            target_max_ratio: Some(0.2),
            thinking: None,
        },
    );
    let (call, _log) = recording_call_ok();
    expect_throw_matching(
        move || {
            let _ = init_lhc(SdkConfig {
                inference_callbacks: None,
                inference: Some(InferenceConfig {
                    call,
                    assignments: Some(assignments),
                    timeout_ms: None,
                    max_input_chars: None,
                }),
                mode: SdkMode::Manual,
                clock: None,
                guards: None,
                tool_result: None,
                lease: None,
                chunk_policy: None,
                view: None,
            });
        },
        "briefTargets.aimRatio must be between minRatio and maxRatio",
    );
}

#[test]
fn resolve_guards_with_no_input_returns_the_documented_defaults() {
    let guards = resolve_guards(None);
    assert_eq!(guards, DEFAULT_GUARDS);
    assert_eq!(guards.smoothed_prompt.max_inference_tokens, 700);
    assert_eq!(guards.smoothed_prompt.suspicious_output_ratio, 0.15);
    assert_eq!(guards.detailed_turn_compression.tiny_turn_tokens, 80);
    assert_eq!(guards.tool_result_summary.timeout_ms, 60_000);
}

#[test]
fn explicit_guards_override_per_field_while_unset_fields_keep_defaults() {
    let guards = resolve_guards(Some(&DerivationGuards {
        smoothed_prompt: Some(SmoothedPromptGuards {
            max_inference_tokens: Some(500),
            suspicious_output_ratio: None,
        }),
        tool_result_summary: None,
        detailed_turn_compression: None,
    }));
    assert_eq!(guards.smoothed_prompt.max_inference_tokens, 500);
    assert_eq!(guards.smoothed_prompt.suspicious_output_ratio, 0.15);
    assert_eq!(guards.detailed_turn_compression.tiny_turn_tokens, 80);
}

#[test]
fn construction_with_no_guards_succeeds_defaults_applied_at_construction() {
    let (call, _log) = recording_call_ok();
    let mut assignments = IndexMap::new();
    assignments.insert(
        "smoothed_prompt".into(),
        assignment("p", "m", "smoothing-v1"),
    );
    let _ = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
}

#[tokio::test]
async fn with_no_explicit_overrides_every_inference_op_routes_to_the_default_codex_gpt_5_4_mini_lane_with_thinking_none()
 {
    let (call, log) = recording_call_ok();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: None,
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    run_default_inference_ops(&sdk).await;
    let log_snapshot = log.lock().expect("log").clone();
    assert_eq!(log_snapshot.len(), 4);
    for entry in &log_snapshot {
        assert_eq!(entry.provider, "codex");
        assert_eq!(entry.model, "gpt-5.4-mini");
        assert_eq!(entry.thinking, Some(ThinkingLevel::None));
    }
}

#[tokio::test]
async fn preserves_thinking_none_when_override_omits_thinking() {
    let (call, log) = recording_call_ok();
    let mut assignments = IndexMap::new();
    assignments.insert(
        "smoothed_prompt".into(),
        assignment("custom", "custom-model", "smoothing-v1"),
    );
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let _ = (sdk.config.inference_callbacks.smooth_prompt)(SmoothPromptInput { text: "x".into() })
        .await;
    let log_snapshot = log.lock().expect("log");
    assert_eq!(log_snapshot[0].thinking, Some(ThinkingLevel::None));
}

#[test]
fn preserves_detailed_turn_compression_target_ratios_when_override_omits_them() {
    let (call, _log) = recording_call_ok();
    let mut assignments = IndexMap::new();
    assignments.insert(
        "detailed_turn_compression".into(),
        assignment("p", "m", "detailed-turn-compression-v1"),
    );
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    assert_eq!(
        sdk.config.compression_targets,
        CompressionTargets {
            min_ratio: 0.35,
            aim_ratio: 0.5,
            max_ratio: 0.65,
        }
    );
}

#[tokio::test]
async fn allows_explicit_thinking_override() {
    let (call, log) = recording_call_ok();
    let mut assignments = IndexMap::new();
    assignments.insert(
        "smoothed_prompt".into(),
        ModelAssignment {
            provider: "custom".into(),
            model: "custom-model".into(),
            prompt: "smoothing-v1".into(),
            target_min_ratio: None,
            target_max_ratio: None,
            target_aim_ratio: None,
            thinking: Some(ThinkingLevel::High),
        },
    );
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: None,
        inference: Some(InferenceConfig {
            call,
            assignments: Some(assignments),
            timeout_ms: None,
            max_input_chars: None,
        }),
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let _ = (sdk.config.inference_callbacks.smooth_prompt)(SmoothPromptInput { text: "x".into() })
        .await;
    let log_snapshot = log.lock().expect("log");
    assert_eq!(log_snapshot[0].thinking, Some(ThinkingLevel::High));
}

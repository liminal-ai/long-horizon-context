//! Ported from packages/lhc/test/tool-result-summary-inference.test.ts. Phase 1.

use std::sync::Arc;
use std::time::SystemTime;

use lhc::create_deterministic_inference_callbacks;
use lhc::init_lhc;
use lhc::messages::internal::handlers::{
    DeriveToolResultSummaryInput, DeriveToolResultSummaryOpts, DeriveToolResultSummaryResult,
    derive_tool_result_summary,
};
use lhc::shared_tech::derivation::{
    BoxFuture, DerivationMetadata, HandlerRunContext, InferenceCallbacks, InferenceResult,
    ProviderProvenance, SdkConfig, SdkMode, ToolOutcome,
};

fn make_run(inference_callbacks: InferenceCallbacks) -> HandlerRunContext {
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(inference_callbacks.clone()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    HandlerRunContext {
        thread_id: "th_test".into(),
        file_path: "/tmp/tool-result-summary-test.sqlite".into(),
        open_db: Box::new(|| panic!("deriveToolResultSummary tests do not read the database")),
        inference_callbacks,
        // Phase 1: init_lhc never returns; Phase 2 shares sdk.config.clock identity.
        clock: Box::new(SystemTime::now),
        config: sdk.config,
    }
}

fn large_content() -> String {
    "tool-output-token ".repeat(600)
}

#[tokio::test]
async fn forced_fallback_path_does_not_stamp_inference_attempted() {
    let run = make_run(create_deterministic_inference_callbacks());
    let derived = derive_tool_result_summary(
        &run,
        "m4",
        &DeriveToolResultSummaryInput {
            tool_name: "read_file".into(),
            tool_input: None,
            content: large_content(),
            outcome: ToolOutcome::Succeeded,
        },
        Some(&DeriveToolResultSummaryOpts {
            use_inference: Some(false),
        }),
    )
    .await;
    assert!(matches!(derived, DeriveToolResultSummaryResult::Derived(_)));
    let DeriveToolResultSummaryResult::Derived(derived) = derived else {
        return;
    };
    assert_eq!(
        derived.write.metadata,
        Some(DerivationMetadata {
            outcome: Some(ToolOutcome::Succeeded),
            last_error: None,
            discard_reason: None,
            fallback_floor: None,
            fallback_used: None,
            inference_attempted: None,
            inference_succeeded: None,
            size_disposition: None,
            provenance: None,
        })
    );
    assert_eq!(
        derived
            .write
            .metadata
            .as_ref()
            .and_then(|m| m.inference_attempted),
        None
    );
}

#[tokio::test]
async fn inference_path_stamps_success_metadata_when_inference_succeeds() {
    let base = create_deterministic_inference_callbacks();
    let callbacks = InferenceCallbacks {
        smooth_prompt: {
            let base = base.clone();
            Arc::new(move |i| {
                let base = base.clone();
                Box::pin(async move { (base.smooth_prompt)(i).await }) as BoxFuture<_>
            })
        },
        summarize_tool_result: Arc::new(|_| {
            Box::pin(async {
                InferenceResult::Ok {
                    text: "summarized tool output".into(),
                    provenance: Some(ProviderProvenance {
                        provider: "openai".into(),
                        model: "gpt-4o".into(),
                        prompt: "tool-result-v2".into(),
                    }),
                    request_messages: None,
                    raw_response: None,
                }
            }) as BoxFuture<_>
        }),
        compress_detailed_turn: {
            let base = base.clone();
            Arc::new(move |i| {
                let base = base.clone();
                Box::pin(async move { (base.compress_detailed_turn)(i).await }) as BoxFuture<_>
            })
        },
        summarize_chunk_brief: {
            let base = base.clone();
            Arc::new(move |i| {
                let base = base.clone();
                Box::pin(async move { (base.summarize_chunk_brief)(i).await }) as BoxFuture<_>
            })
        },
    };
    let run = make_run(callbacks);
    let derived = derive_tool_result_summary(
        &run,
        "m4",
        &DeriveToolResultSummaryInput {
            tool_name: "read_file".into(),
            tool_input: None,
            content: large_content(),
            outcome: ToolOutcome::Failed,
        },
        Some(&DeriveToolResultSummaryOpts {
            use_inference: Some(true),
        }),
    )
    .await;
    assert!(matches!(derived, DeriveToolResultSummaryResult::Derived(_)));
    let DeriveToolResultSummaryResult::Derived(derived) = derived else {
        return;
    };
    let meta = derived.write.metadata.as_ref().expect("metadata");
    assert_eq!(meta.outcome, Some(ToolOutcome::Failed));
    assert_eq!(meta.inference_attempted, Some(true));
    assert_eq!(meta.inference_succeeded, Some(true));
    assert_eq!(
        meta.provenance,
        Some(ProviderProvenance {
            provider: "openai".into(),
            model: "gpt-4o".into(),
            prompt: "tool-result-v2".into(),
        })
    );
}

#[tokio::test]
async fn inference_path_returns_structured_failure_without_success_metadata() {
    let base = create_deterministic_inference_callbacks();
    let callbacks = InferenceCallbacks {
        smooth_prompt: {
            let base = base.clone();
            Arc::new(move |i| {
                let base = base.clone();
                Box::pin(async move { (base.smooth_prompt)(i).await }) as BoxFuture<_>
            })
        },
        summarize_tool_result: Arc::new(|_| {
            Box::pin(async {
                InferenceResult::Err {
                    reason: "provider_failure: rate_limit: too many requests".into(),
                    request_messages: None,
                }
            }) as BoxFuture<_>
        }),
        compress_detailed_turn: {
            let base = base.clone();
            Arc::new(move |i| {
                let base = base.clone();
                Box::pin(async move { (base.compress_detailed_turn)(i).await }) as BoxFuture<_>
            })
        },
        summarize_chunk_brief: {
            let base = base.clone();
            Arc::new(move |i| {
                let base = base.clone();
                Box::pin(async move { (base.summarize_chunk_brief)(i).await }) as BoxFuture<_>
            })
        },
    };
    let run = make_run(callbacks);
    let derived = derive_tool_result_summary(
        &run,
        "m4",
        &DeriveToolResultSummaryInput {
            tool_name: "read_file".into(),
            tool_input: None,
            content: large_content(),
            outcome: ToolOutcome::Succeeded,
        },
        Some(&DeriveToolResultSummaryOpts {
            use_inference: Some(true),
        }),
    )
    .await;
    match derived {
        DeriveToolResultSummaryResult::InferenceFailed {
            reason,
            request_messages,
        } => {
            assert_eq!(reason, "provider_failure: rate_limit: too many requests");
            assert!(request_messages.is_none());
        }
        DeriveToolResultSummaryResult::Derived(_) => {
            panic!("expected structured inference failure");
        }
    }
}

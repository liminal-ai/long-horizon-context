//! LIM-63A evidence matrix: storage uniqueness, marker visibility, identity posture.

mod fixtures;

use fixtures::{
    CompactContinuationMarkerOverrides, CompactContinuationMarkerPayload, kind, open_raw,
    temp_store, valid_event,
};
use lhc::compact_continuation::{
    CompactContinuationHostFacts, compute_operation_identity, hash_attempt_intent,
    validate_host_facts,
};
use lhc::intake_stream;
use lhc::messages::{self, MessageKind, MessageListOptions};
use lhc::shared_tech::compact_continuation::{
    CompactContinuationHostCapability, CompactContinuationPolicy, CompactContinuationSeam,
    PostMeasurementEstimate, ProviderUsageAuthority, ProviderUsageAvailable, WorkContinuation,
    WriterClaim, compact_continuation_marker_idempotency_key,
};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::storage::CURRENT_THREAD_SCHEMA_VERSION;
use lhc::threads::{NewThreadInput, ThreadRef, new_thread};
use serde_json::json;

#[tokio::test]
async fn host_facts_closed_validation_matrix() {
    let err = validate_host_facts(&json!({}));
    assert!(err.is_some());
    assert_eq!(
        err.unwrap().code,
        ErrorCode::InvalidCompactContinuationInput
    );

    let err = validate_host_facts(&json!({
        "attemptId": "a",
        "testHooks": {"skipRealCompact": true}
    }))
    .expect("reject testHooks");
    assert!(
        err.reason.contains("unknown field") || err.reason.contains("testHooks"),
        "{}",
        err.reason
    );

    let valid = json!({
        "attemptId": "a1",
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0
        },
        "providerUsage": {
            "available": false,
            "reason": "missing",
            "domain": "provider_reported_input"
        },
        "postMeasurementEstimate": {
            "tokens": 0,
            "source": "s",
            "domain": "source_labelled_estimate"
        },
        "policy": {
            "upperTriggerTokens": 100,
            "lowerTargetTokens": 50,
            "hostCapability": "full_state_machine"
        },
        "continuation": { "kind": "none" },
        "writerClaim": "none",
        "captureComplete": true,
        "providerIdentityValid": true,
        "actor": "a",
        "harness": "h"
    });
    assert!(validate_host_facts(&valid).is_none());
}

#[tokio::test]
async fn marker_user_chat_hidden_model_visible() {
    let store = temp_store();
    let file_path = match new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let ref_ = ThreadRef::file_path(&file_path);
    let turn_id = "t-cont";
    let marker = valid_event(
        kind::COMPACT_CONTINUATION_MARKER,
        CompactContinuationMarkerOverrides {
            idempotency_key: Some(compact_continuation_marker_idempotency_key(turn_id)),
            payload: Some(CompactContinuationMarkerPayload {
                continuation_turn_id: turn_id.into(),
                ..Default::default()
            }),
            ..Default::default()
        },
    );
    let batch = intake_stream::message_events(ref_.clone(), &[marker]).await;
    assert!(batch.is_ok(), "{batch:?}");

    let chat = match messages::list(
        ref_.clone(),
        Some(MessageListOptions {
            for_user_chat: Some(true),
            ..Default::default()
        }),
    )
    .await
    {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert!(
        chat.iter()
            .all(|m| m.kind != MessageKind::CompactContinuationMarker)
    );

    let all = match messages::list(ref_, None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert!(
        all.iter()
            .any(|m| m.kind == MessageKind::CompactContinuationMarker)
    );
}

#[tokio::test]
async fn one_unresolved_boundary_unique_index() {
    let store = temp_store();
    let file_path = match new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await
    {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let db = open_raw(&file_path);
    db.prepare(
        r#"INSERT INTO compact_continuation_boundary
        (continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at)
        VALUES ('tA', 'a1', 'pending', 0, 'force_turn_end', '2020-01-01T00:00:00.000Z', NULL)"#,
    )
    .run(&[]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        db.prepare(
            r#"INSERT INTO compact_continuation_boundary
            (continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at)
            VALUES ('tB', 'a2', 'pending', 0, 'force_turn_end', '2020-01-01T00:00:01.000Z', NULL)"#,
        )
        .run(&[]);
    }));
    assert!(
        result.is_err(),
        "second unresolved boundary must be refused by unique index"
    );
    db.close();
}

#[tokio::test]
async fn operation_identity_ignores_retry_posture_fields() {
    let mut facts = CompactContinuationHostFacts {
        attempt_id: "id".into(),
        seam: CompactContinuationSeam {
            model_response_complete: true,
            requested_tools_settled: true,
            capture_flushed: true,
            before_next_provider_request: true,
            inside_transport_retry: false,
            input_epoch_at_decision: 1,
            input_epoch_at_apply: 1,
        },
        provider_usage: ProviderUsageAuthority::Available(ProviderUsageAvailable {
            available: true,
            input_tokens: 10,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total: 10,
            domain: "provider_reported_input".into(),
        }),
        post_measurement_estimate: PostMeasurementEstimate {
            tokens: 1,
            source: "s".into(),
            domain: "source_labelled_estimate".into(),
        },
        policy: CompactContinuationPolicy {
            upper_trigger_tokens: 100,
            lower_target_tokens: 50,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
        },
        continuation: WorkContinuation::ActiveNonTool,
        writer_claim: WriterClaim::None,
        capture_complete: true,
        provider_identity_valid: true,
        single_open_turn: None,
        actor: "actor".into(),
        harness: "harness".into(),
        compact: None,
    };
    let h1 = hash_attempt_intent(&compute_operation_identity(&facts)).0;
    facts.seam.input_epoch_at_apply = 99;
    facts.post_measurement_estimate.tokens = 999;
    facts.capture_complete = false;
    let h2 = hash_attempt_intent(&compute_operation_identity(&facts)).0;
    assert_eq!(h1, h2, "identity must ignore seam/usage/estimate posture");
}

#[test]
fn current_schema_version_is_10() {
    assert_eq!(CURRENT_THREAD_SCHEMA_VERSION, 10);
}

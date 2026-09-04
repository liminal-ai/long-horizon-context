//! LIM-63A evidence matrix: tool-pair, install fingerprint, storage, schema.
//! Maps certified TS cases from compact-continuation-evidence.test.ts.

mod fixtures;

use std::sync::{Arc, Mutex};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, CompactContinuationMarkerOverrides,
    CompactContinuationMarkerPayload, CompactContinuationTestHooks, DerivedThreadOptions,
    ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload, TurnEndOverrides,
    TurnEndPayload, UserPromptOverrides, UserPromptPayload, ViewInjectionPoint,
    create_inference_callbacks_double, derived_thread_fixture, kind, open_raw,
    run_compact_continuation_for_tests, set_view_injection_db_hook, temp_store, valid_event,
};
use lhc::compact_continuation::test_support::{read_pending_boundary, upsert_boundary};
use lhc::compact_continuation::{
    BoundaryStatus, CompactContinuationHostFacts, HostCompactOpts, ToolPairProof, WriterClaimKind,
    get_pending_compact_continuation_boundary, list_compact_continuation_stages,
    prove_pending_tool_pair, run_compact_continuation, validate_host_facts,
};
use lhc::messages::{self, MessageKind, RemoveInput};
use lhc::shared_tech::compact_continuation::{
    CompactContinuationHostCapability, CompactContinuationOutcomeKind, CompactContinuationPolicy,
    CompactContinuationSeam, PostMeasurementEstimate, ProviderUsageAuthority,
    ProviderUsageAvailable, WorkContinuation, WriterClaim,
    compact_continuation_marker_idempotency_key,
};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorCode, OpResult};
use lhc::shared_tech::storage::{CURRENT_THREAD_SCHEMA_VERSION, SqlParam};
use lhc::shared_tech::view::{Band, PartialViewProfilePercentages, ViewCompactParams};
use lhc::thread_view::{self, CompactOpts, InstallPreparedOptions};
use lhc::threads::{NewThreadInput, ThreadRef, new_thread};
use lhc::{init_lhc, intake_stream};
use serde_json::{Map, Value, json};

// ── helpers ───────────────────────────────────────────────────────────────

fn settled_seam() -> CompactContinuationSeam {
    CompactContinuationSeam {
        model_response_complete: true,
        requested_tools_settled: true,
        capture_flushed: true,
        before_next_provider_request: true,
        inside_transport_retry: false,
        input_epoch_at_decision: 1,
        input_epoch_at_apply: 1,
    }
}

fn default_compact_opts() -> HostCompactOpts {
    HostCompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(400.0),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(25.0),
                smooth: Some(25.0),
                detailed: Some(25.0),
                brief: Some(25.0),
            }),
            newest_closed_protection: None,
        }),
    }
}

fn base_facts(attempt_id: &str, cont: WorkContinuation) -> CompactContinuationHostFacts {
    CompactContinuationHostFacts {
        attempt_id: attempt_id.into(),
        seam: settled_seam(),
        provider_usage: ProviderUsageAuthority::Available(ProviderUsageAvailable {
            available: true,
            input_tokens: 90_000,
            cache_creation_tokens: 5_000,
            cache_read_tokens: 10_000,
            total: 105_000,
            domain: "provider_reported_input".into(),
        }),
        post_measurement_estimate: PostMeasurementEstimate {
            tokens: 2_000,
            source: "lhc_token_estimate".into(),
            domain: "source_labelled_estimate".into(),
        },
        policy: CompactContinuationPolicy {
            safe_runway_threshold_tokens: Some(200_000),
            safe_runway_threshold_source: Some("host_safe_runway".into()),
            upper_trigger_tokens: 100_000,
            lower_target_tokens: 400,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
            compact_retry_budget: None,
        },
        continuation: cont,
        writer_claim: WriterClaim::None,
        capture_complete: true,
        provider_identity_valid: true,
        single_open_turn: None,
        actor: "fixture-actor".into(),
        harness: "fixture-harness".into(),
        compact: Some(default_compact_opts()),
    }
}

trait ExpectOk<T> {
    fn expect_ok(self) -> T;
}
impl<T> ExpectOk<T> for OpResult<T> {
    fn expect_ok(self) -> T {
        match self {
            OpResult::Ok { value } => value,
            OpResult::Err { error } => panic!("{}: {}", error.code.as_str(), error.reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CanonicalSnap {
    event_count: i64,
    turn_count: i64,
    marker_count: i64,
    view_id: Option<String>,
    max_event_order: i64,
}

fn snapshot_canonical(file_path: &str) -> CanonicalSnap {
    let db = open_raw(file_path);
    let event_count = db
        .prepare("SELECT COUNT(*) AS n FROM event")
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let turn_count = db
        .prepare("SELECT COUNT(*) AS n FROM turns")
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let marker_count = db
        .prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'compact_continuation_marker'")
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let view_id = db
        .prepare("SELECT view_id FROM thread_view WHERE singleton = 1")
        .get()
        .and_then(|r| {
            r.get("view_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let max_event_order = db
        .prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
        .get()
        .and_then(|r| r.get("m").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    db.close();
    CanonicalSnap {
        event_count,
        turn_count,
        marker_count,
        view_id,
        max_event_order,
    }
}

/// Full serving-view truth for invalid-candidate parity (view + marker substrate).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ViewTruthSnap {
    view_id: Option<String>,
    source_state_json: Option<String>,
    band_tokens: Vec<(String, i64)>,
    marker_count: i64,
    marker_message_count: i64,
}

fn snapshot_view_truth(file_path: &str) -> ViewTruthSnap {
    let db = open_raw(file_path);
    let view_id = db
        .prepare("SELECT view_id FROM thread_view WHERE singleton = 1")
        .get()
        .and_then(|r| {
            r.get("view_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let source_state_json = db
        .prepare("SELECT source_state_json FROM thread_view WHERE singleton = 1")
        .get()
        .and_then(|r| {
            r.get("source_state_json")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let band_rows = db
        .prepare("SELECT band, token_count FROM thread_view_band ORDER BY band")
        .all(&[]);
    let band_tokens = band_rows
        .into_iter()
        .map(|r| {
            (
                r.get("band")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                r.get("token_count").and_then(|v| v.as_i64()).unwrap_or(0),
            )
        })
        .collect();
    let marker_count = db
        .prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'compact_continuation_marker'")
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let marker_message_count = db
        .prepare(
            "SELECT COUNT(*) AS n FROM message WHERE kind = 'compact_continuation_marker' AND deleted_at IS NULL",
        )
        .get()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    db.close();
    ViewTruthSnap {
        view_id,
        source_state_json,
        band_tokens,
        marker_count,
        marker_message_count,
    }
}

fn writer_claim_of(file_path: &str) -> (WriterClaimKind, Option<String>) {
    let db = open_raw(file_path);
    let row = db
        .prepare("SELECT claim, attempt_id FROM compact_continuation_writer WHERE singleton = 1")
        .get()
        .expect("writer");
    let claim = match row.get("claim").and_then(|v| v.as_str()) {
        Some("lhc") => WriterClaimKind::Lhc,
        _ => WriterClaimKind::None,
    };
    let attempt_id = row
        .get("attempt_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    db.close();
    (claim, attempt_id)
}

async fn seed_pending_tool_turn(ref_: &ThreadRef, tool_call_id: &str) {
    let events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "use tools".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: "calling tool".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: tool_call_id.into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("notes.txt"));
                        m
                    },
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: tool_call_id.into(),
                    content: "tool result verbatim payload that must survive".into(),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ];
    assert!(
        intake_stream::message_events(ref_.clone(), &events)
            .await
            .is_ok()
    );
}

async fn seed_open_agentic_turn(ref_: &ThreadRef) {
    let events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "continue the investigation with more context".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload {
                    text: "working on it with more detail ".repeat(20),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: "call-active-1".into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("x.txt"));
                        m
                    },
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: "call-active-1".into(),
                    content: "result body ".repeat(30),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ];
    assert!(
        intake_stream::message_events(ref_.clone(), &events)
            .await
            .is_ok()
    );
}

async fn fixture_thread() -> (fixtures::TempStore, ThreadRef, String) {
    let store = temp_store();
    let f = derived_thread_fixture(
        &store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let path = f.file_path.clone();
    let ref_ = ThreadRef::file_path(&path);
    (store, ref_, path)
}

fn compact_params() -> CompactOpts {
    CompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(400.0),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(25.0),
                smooth: Some(25.0),
                detailed: Some(25.0),
                brief: Some(25.0),
            }),
            newest_closed_protection: None,
        }),
        signal: None,
        compact_point_upper_bound: None,
    }
}

fn next_event_order(db: &lhc::shared_tech::storage::Db) -> i64 {
    db.prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
        .get()
        .and_then(|r| r.get("m").and_then(|v| v.as_i64()))
        .unwrap_or(0)
        + 1
}

fn insert_dup_message(
    db: &lhc::shared_tech::storage::Db,
    kind: &str,
    turn_id: &str,
    token_estimate: i64,
    actor: &str,
    harness: &str,
    content: &str,
    block_type: &str,
    dup_id: &str,
) {
    let order = next_event_order(db);
    db.prepare(
        r#"INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .run(&[
        SqlParam::from(order),
        SqlParam::from(kind),
        SqlParam::from(format!("dup-key-{dup_id}").as_str()),
        SqlParam::from(actor),
        SqlParam::from(harness),
        SqlParam::from(content),
        SqlParam::from("2020-01-01T00:00:00.000Z"),
    ]);
    db.prepare(
        r#"INSERT INTO message (message_id, kind, source_event_order, turn_id, token_estimate, actor, harness, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"#,
    )
    .run(&[
        SqlParam::from(dup_id),
        SqlParam::from(kind),
        SqlParam::from(order),
        SqlParam::from(turn_id),
        SqlParam::from(token_estimate),
        SqlParam::from(actor),
        SqlParam::from(harness),
    ]);
    db.prepare(
        "INSERT INTO message_block (message_id, block_index, block_type, content) VALUES (?, 0, ?, ?)",
    )
    .run(&[
        SqlParam::from(dup_id),
        SqlParam::from(block_type),
        SqlParam::from(content),
    ]);
}

async fn assert_declines_without_mutation(
    name: &str,
    tool_call_id: &str,
    seed_id: &str,
    mutate: impl FnOnce(&str),
) {
    let (_store, ref_, path) = fixture_thread().await;
    if seed_id.is_empty() {
        seed_pending_tool_turn(&ref_, "call-unrelated-other").await;
    } else {
        seed_pending_tool_turn(&ref_, seed_id).await;
    }
    mutate(&path);
    let before = snapshot_canonical(&path);
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));

    let result = run_compact_continuation(
        ref_.clone(),
        base_facts(
            &format!("pair-{name}"),
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec![tool_call_id.into()],
                correlation_valid: true,
            },
        ),
    )
    .await
    .expect_ok();
    // The pair cannot be *protected* through compact, so the continuation
    // machinery declines into the host's ordinary settled-seam compact on
    // canonical state. It still mutates nothing and never claims the writer —
    // and it never strands: the next provider request proceeds.
    assert_eq!(
        result.receipt.outcome,
        CompactContinuationOutcomeKind::DeclineToOrdinaryCompact,
        "{name}"
    );
    assert!(!result.receipt.refused, "{name}");
    assert_eq!(result.receipt.refuse_code, None, "{name}");
    assert_eq!(
        result
            .receipt
            .warnings
            .iter()
            .map(|w| w.code.as_str())
            .collect::<Vec<_>>(),
        vec!["tool_correlation_unproven"],
        "{name}"
    );
    assert!(
        result.receipt.residual.next_provider_request_allowed,
        "{name}"
    );
    assert!(
        !result
            .receipt
            .effects
            .iter()
            .any(|e| e.effect_type().as_str() == "claim_writer")
    );
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    assert_eq!(snapshot_canonical(&path), before);
}

fn preserve_outcomes(o: CompactContinuationOutcomeKind) -> bool {
    matches!(
        o,
        CompactContinuationOutcomeKind::CompactPreserveTool
            | CompactContinuationOutcomeKind::DegradedCompact
            | CompactContinuationOutcomeKind::NoReduction
    )
}

fn success_outcomes(o: CompactContinuationOutcomeKind) -> bool {
    matches!(
        o,
        CompactContinuationOutcomeKind::CompactContinueTurn
            | CompactContinuationOutcomeKind::DegradedCompact
            | CompactContinuationOutcomeKind::NoReduction
    )
}

// Need store re-exports for upsert_boundary / read_pending_boundary
// ── tool-pair matrix ──────────────────────────────────────────────────────

#[tokio::test]
async fn tool_pair_missing_declines_without_mutation() {
    assert_declines_without_mutation("missing", "does-not-exist", "call-unrelated-other", |_| {})
        .await;
}

#[tokio::test]
async fn tool_pair_orphan_call_declines_without_mutation() {
    assert_declines_without_mutation("orphan-call", "call-oc", "call-oc", |path| {
        let db = open_raw(path);
        db.prepare(
            r#"UPDATE message SET deleted_at = ? WHERE message_id IN (
             SELECT m.message_id FROM message m
             JOIN message_block b ON b.message_id = m.message_id
             WHERE b.block_type = 'tool_result' AND json_extract(b.content, '$.toolCallId') = 'call-oc'
           )"#,
        )
        .run(&[SqlParam::from("2020-01-01T00:00:00.000Z")]);
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_orphan_result_declines_without_mutation() {
    assert_declines_without_mutation("orphan-result", "call-or", "call-or", |path| {
        let db = open_raw(path);
        db.prepare(
            r#"UPDATE message SET deleted_at = ? WHERE message_id IN (
             SELECT m.message_id FROM message m
             JOIN message_block b ON b.message_id = m.message_id
             WHERE b.block_type = 'tool_call' AND json_extract(b.content, '$.toolCallId') = 'call-or'
           )"#,
        )
        .run(&[SqlParam::from("2020-01-01T00:00:00.000Z")]);
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_duplicate_call_declines_without_mutation() {
    assert_declines_without_mutation("duplicate-call", "call-dc", "call-dc", |path| {
        let db = open_raw(path);
        let call = db
            .prepare(
                r#"SELECT m.message_id, m.kind, m.turn_id, m.token_estimate, m.actor, m.harness, b.content
                 FROM message m
                 JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_call'
                 WHERE json_extract(b.content, '$.toolCallId') = 'call-dc' AND m.deleted_at IS NULL"#,
            )
            .get()
            .expect("call");
        let msg_id = call.get("message_id").and_then(|v| v.as_str()).unwrap();
        insert_dup_message(
            &db,
            call.get("kind").and_then(|v| v.as_str()).unwrap(),
            call.get("turn_id").and_then(|v| v.as_str()).unwrap(),
            call.get("token_estimate").and_then(|v| v.as_i64()).unwrap_or(0),
            call.get("actor").and_then(|v| v.as_str()).unwrap(),
            call.get("harness").and_then(|v| v.as_str()).unwrap(),
            call.get("content").and_then(|v| v.as_str()).unwrap(),
            "tool_call",
            &format!("{msg_id}-dup"),
        );
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_duplicate_result_declines_without_mutation() {
    assert_declines_without_mutation("duplicate-result", "call-dr", "call-dr", |path| {
        let db = open_raw(path);
        let row = db
            .prepare(
                r#"SELECT m.message_id, m.kind, m.turn_id, m.token_estimate, m.actor, m.harness, b.content
                 FROM message m
                 JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
                 WHERE json_extract(b.content, '$.toolCallId') = 'call-dr' AND m.deleted_at IS NULL"#,
            )
            .get()
            .expect("result");
        let msg_id = row.get("message_id").and_then(|v| v.as_str()).unwrap();
        insert_dup_message(
            &db,
            row.get("kind").and_then(|v| v.as_str()).unwrap(),
            row.get("turn_id").and_then(|v| v.as_str()).unwrap(),
            row.get("token_estimate").and_then(|v| v.as_i64()).unwrap_or(0),
            row.get("actor").and_then(|v| v.as_str()).unwrap(),
            row.get("harness").and_then(|v| v.as_str()).unwrap(),
            row.get("content").and_then(|v| v.as_str()).unwrap(),
            "tool_result",
            &format!("{msg_id}-dup"),
        );
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_call_after_result_declines_without_mutation() {
    assert_declines_without_mutation("call-after-result", "call-car", "call-car", |path| {
        let db = open_raw(path);
        let call = db
            .prepare(
                r#"SELECT m.message_id, m.source_event_order FROM message m
                 JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_call'
                 WHERE json_extract(b.content, '$.toolCallId') = 'call-car'"#,
            )
            .get()
            .expect("call");
        let result = db
            .prepare(
                r#"SELECT m.message_id, m.source_event_order FROM message m
                 JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
                 WHERE json_extract(b.content, '$.toolCallId') = 'call-car'"#,
            )
            .get()
            .expect("result");
        let co = call
            .get("source_event_order")
            .and_then(|v| v.as_i64())
            .unwrap();
        let ro = result
            .get("source_event_order")
            .and_then(|v| v.as_i64())
            .unwrap();
        let call_id = call.get("message_id").and_then(|v| v.as_str()).unwrap();
        let result_id = result.get("message_id").and_then(|v| v.as_str()).unwrap();
        let tmp = next_event_order(&db);
        db.prepare(
            r#"INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
             VALUES (?, 'runtime_note', ?, 'fixture', 'fixture', '{}', ?)"#,
        )
        .run(&[
            SqlParam::from(tmp),
            SqlParam::from(format!("tmp-swap-{tmp}").as_str()),
            SqlParam::from("2020-01-01T00:00:00.000Z"),
        ]);
        db.prepare("UPDATE message SET source_event_order = ? WHERE message_id = ?")
            .run(&[SqlParam::from(tmp), SqlParam::from(call_id)]);
        db.prepare("UPDATE message SET source_event_order = ? WHERE message_id = ?")
            .run(&[SqlParam::from(co), SqlParam::from(result_id)]);
        db.prepare("UPDATE message SET source_event_order = ? WHERE message_id = ?")
            .run(&[SqlParam::from(ro), SqlParam::from(call_id)]);
        db.prepare("DELETE FROM event WHERE event_order = ?")
            .run(&[SqlParam::from(tmp)]);
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_wrong_turn_declines_without_mutation() {
    assert_declines_without_mutation("wrong-turn", "call-wt", "call-wt", |path| {
        let db = open_raw(path);
        let other = db
            .prepare("SELECT turn_id FROM turns WHERE status != 'open' ORDER BY turn_order LIMIT 1")
            .get();
        if let Some(other) = other {
            let tid = other.get("turn_id").and_then(|v| v.as_str()).unwrap();
            db.prepare(
                r#"UPDATE message SET turn_id = ? WHERE message_id IN (
                 SELECT m.message_id FROM message m
                 JOIN message_block b ON b.message_id = m.message_id
                 WHERE b.block_type = 'tool_call' AND json_extract(b.content, '$.toolCallId') = 'call-wt'
               )"#,
            )
            .run(&[SqlParam::from(tid)]);
        } else {
            let max_turn = db
                .prepare("SELECT COALESCE(MAX(turn_order), 0) AS m FROM turns")
                .get()
                .and_then(|r| r.get("m").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            db.prepare(
                r#"INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order, closed_at_event_order)
                 VALUES ('t-wrong', ?, 'closed', 0, 1)"#,
            )
            .run(&[SqlParam::from(max_turn + 1)]);
            db.prepare(
                r#"UPDATE message SET turn_id = 't-wrong' WHERE message_id IN (
                 SELECT m.message_id FROM message m
                 JOIN message_block b ON b.message_id = m.message_id
                 WHERE b.block_type = 'tool_call' AND json_extract(b.content, '$.toolCallId') = 'call-wt'
               )"#,
            )
            .run(&[]);
        }
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_before_compact_point_declines_without_mutation() {
    assert_declines_without_mutation("before-compact-point", "call-bcp", "call-bcp", |path| {
        let db = open_raw(path);
        let max_order = db
            .prepare("SELECT COALESCE(MAX(source_event_order), 0) AS m FROM message")
            .get()
            .and_then(|r| r.get("m").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        let has_view = db
            .prepare("SELECT 1 AS n FROM thread_view WHERE singleton = 1")
            .get()
            .is_some();
        if has_view {
            db.prepare("UPDATE thread_view SET compact_point = ? WHERE singleton = 1")
                .run(&[SqlParam::from(max_order + 1)]);
        } else {
            db.prepare(
                r#"INSERT INTO thread_view (
                   singleton, view_id, created_at, compact_point, covered_from,
                   profile_name, config_json, arrangement_json, gaps_json, source_state_json
                 ) VALUES (1, 'v-test', ?, ?, 0, NULL, '{}', '[]', '[]', '{}')"#,
            )
            .run(&[
                SqlParam::from("2020-01-01T00:00:00.000Z"),
                SqlParam::from(max_order + 1),
            ]);
        }
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_unreadable_payload_declines_without_mutation() {
    assert_declines_without_mutation("unreadable", "call-ur", "call-ur", |path| {
        let db = open_raw(path);
        db.prepare(
            r#"UPDATE message_block SET content = ?
             WHERE block_type = 'tool_result'
               AND json_extract(content, '$.toolCallId') = 'call-ur'"#,
        )
        .run(&[SqlParam::from(
            r#"{"toolCallId":"call-ur","content":123,"isError":false}"#,
        )]);
        db.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_id_mismatch_unit_and_runtime() {
    let dup_key_call = r#"{"toolCallId":"call-mm","toolCallId":"call-other","toolName":"read_file","arguments":{"path":"x"}}"#;
    let (_store, ref_, path) = fixture_thread().await;
    seed_pending_tool_turn(&ref_, "call-mm").await;
    let db = open_raw(&path);
    db.prepare(
        r#"UPDATE message_block SET content = ?
         WHERE block_type = 'tool_call'
           AND json_extract(content, '$.toolCallId') = 'call-mm'"#,
    )
    .run(&[SqlParam::from(dup_key_call)]);
    let extract = db
        .prepare(
            r#"SELECT json_extract(content, '$.toolCallId') AS id FROM message_block
             WHERE block_type = 'tool_call' AND json_extract(content, '$.toolCallId') = 'call-mm'"#,
        )
        .get()
        .expect("extract");
    assert_eq!(extract.get("id").and_then(|v| v.as_str()), Some("call-mm"));
    // JSON.parse last-key wins in JS; serde_json last-key also wins.
    let parsed: Value = serde_json::from_str(dup_key_call).unwrap();
    assert_eq!(
        parsed.get("toolCallId").and_then(|v| v.as_str()),
        Some("call-other")
    );
    match prove_pending_tool_pair(&db, "call-mm") {
        ToolPairProof::Err { reason, .. } => {
            assert_eq!(reason.as_str(), "tool_call_id_mismatch");
        }
        _ => panic!("expected mismatch"),
    }
    db.close();

    assert_declines_without_mutation("id-mismatch", "call-mm2", "call-mm2", |path| {
        let d = open_raw(path);
        d.prepare(
            r#"UPDATE message_block SET content = ?
             WHERE block_type = 'tool_call'
               AND json_extract(content, '$.toolCallId') = 'call-mm2'"#,
        )
        .run(&[SqlParam::from(
            r#"{"toolCallId":"call-mm2","toolCallId":"call-other","toolName":"read_file","arguments":{"path":"x"}}"#,
        )]);
        d.close();
    })
    .await;
}

#[tokio::test]
async fn tool_pair_valid_preserve_path_claims_releases() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_pending_tool_turn(&ref_, "call-ok-above").await;
    let before_markers = snapshot_canonical(&path).marker_count;
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "pair-valid-above",
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec!["call-ok-above".into()],
                correlation_valid: true,
            },
        ),
    )
    .await
    .expect_ok();
    assert!(preserve_outcomes(result.receipt.outcome));
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    assert_eq!(snapshot_canonical(&path).marker_count, before_markers);
    let listed = messages::list(ref_.clone(), None).await.expect_ok();
    let pair: Vec<_> = listed
        .iter()
        .filter(|m| {
            (m.kind == MessageKind::ToolCall || m.kind == MessageKind::ToolResult)
                && m.blocks.iter().any(|b| {
                    b.content.get("toolCallId").and_then(|v| v.as_str()) == Some("call-ok-above")
                })
        })
        .collect();
    assert_eq!(pair.len(), 2);
}

// ── marker-event crash gap ────────────────────────────────────────────────

#[tokio::test]
async fn interrupt_after_marker_event_resume_reconciles() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;

    let interrupted = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("marker-event-gap-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_marker_event: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let c_turn = interrupted.continuation_turn_id.clone().expect("turn");
    assert!(c_turn.starts_with('t'));

    let marker_key = compact_continuation_marker_idempotency_key(&c_turn);
    let events = intake_stream::list_events(ref_.clone()).await.expect_ok();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.idempotency_key() == marker_key)
            .count(),
        1
    );

    let pending = get_pending_compact_continuation_boundary(ref_.clone())
        .await
        .expect_ok();
    assert_eq!(
        pending.as_ref().map(|b| b.status),
        Some(BoundaryStatus::Pending)
    );
    assert_eq!(pending.as_ref().map(|b| b.marker_persisted), Some(false));
    assert_eq!(
        writer_claim_of(&path),
        (WriterClaimKind::Lhc, Some("marker-event-gap-1".into()))
    );

    let stages_before = list_compact_continuation_stages(ref_.clone(), "marker-event-gap-1")
        .await
        .expect_ok();
    assert!(stages_before.iter().any(|s| {
        s.stage == "interrupted"
            && s.detail
                .as_ref()
                .and_then(|d| d.get("after").and_then(|v| v.as_str()))
                == Some("marker_event_commit")
    }));

    let mut facts = base_facts("marker-event-gap-1", WorkContinuation::ActiveNonTool);
    facts.writer_claim = WriterClaim::Lhc;
    let resumed = run_compact_continuation(ref_.clone(), facts)
        .await
        .expect_ok();
    assert!(!resumed.forced_boundary_this_attempt);
    assert_eq!(
        resumed.continuation_turn_id.as_deref(),
        Some(c_turn.as_str())
    );
    assert!(success_outcomes(resumed.receipt.outcome));
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    assert!(resumed.pending_boundary.is_none());

    let events_after = intake_stream::list_events(ref_.clone()).await.expect_ok();
    assert_eq!(
        events_after
            .iter()
            .filter(|e| e.idempotency_key() == marker_key)
            .count(),
        1
    );
    let stages_after = list_compact_continuation_stages(ref_.clone(), "marker-event-gap-1")
        .await
        .expect_ok();
    assert!(stages_after.iter().any(|s| s.stage == "marker_persisted"));
    assert!(stages_after.iter().any(|s| s.stage == "writer_released"));
    assert!(stages_after.iter().any(|s| {
        s.stage == "interrupted"
            && s.detail
                .as_ref()
                .and_then(|d| d.get("after").and_then(|v| v.as_str()))
                == Some("marker_event_commit")
    }));
}

// ── marker-delta / install fingerprint ────────────────────────────────────

async fn prepare_with_open_continuation(
    ref_: &ThreadRef,
    path: &str,
) -> (thread_view::PreparedCompact, String, Option<String>) {
    let forced = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("prep-force", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let continuation_turn_id = forced.continuation_turn_id.expect("turn");
    let db = open_raw(path);
    db.prepare(
        r#"UPDATE compact_continuation_writer SET claim = 'none', attempt_id = NULL, claimed_at = NULL WHERE singleton = 1"#,
    )
    .run(&[]);
    db.close();
    let prep = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let view_before = snapshot_canonical(path).view_id;
    (prep, continuation_turn_id, view_before)
}

#[tokio::test]
async fn marker_and_source_changes_after_prepare_activate() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let (prepared, continuation_turn_id, _view_before) =
        prepare_with_open_continuation(&ref_, &path).await;
    let marker_key = compact_continuation_marker_idempotency_key(&continuation_turn_id);

    let marker_batch = intake_stream::message_events(
        ref_.clone(),
        &[valid_event(
            kind::COMPACT_CONTINUATION_MARKER,
            CompactContinuationMarkerOverrides {
                idempotency_key: Some(marker_key.clone()),
                payload: Some(CompactContinuationMarkerPayload {
                    continuation_turn_id: continuation_turn_id.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    assert!(marker_batch.is_ok());

    let ok_install = thread_view::install_prepared_compact(
        ref_.clone(),
        prepared,
        InstallPreparedOptions {
            allowed_marker_idempotency_key: Some(marker_key),
            ..Default::default()
        },
    )
    .await;
    assert!(ok_install.is_ok(), "{ok_install:?}");

    // Negative path on a fresh fixture.
    let (_s2, ref2, path2) = fixture_thread().await;
    seed_open_agentic_turn(&ref2).await;
    let (prep2, cont2, _) = prepare_with_open_continuation(&ref2, &path2).await;
    let key2 = compact_continuation_marker_idempotency_key(&cont2);
    let marker2 = intake_stream::message_events(
        ref2.clone(),
        &[valid_event(
            kind::COMPACT_CONTINUATION_MARKER,
            CompactContinuationMarkerOverrides {
                idempotency_key: Some(key2.clone()),
                payload: Some(CompactContinuationMarkerPayload {
                    continuation_turn_id: cont2,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    assert!(marker2.is_ok());

    let db = open_raw(&path2);
    let row = db
        .prepare(
            r#"SELECT message_id FROM message
             WHERE kind = 'tool_result' AND deleted_at IS NULL
             ORDER BY source_event_order DESC LIMIT 1"#,
        )
        .get();
    assert!(row.is_some());
    let mid = row
        .as_ref()
        .and_then(|r| r.get("message_id").and_then(|v| v.as_str()))
        .unwrap();
    db.prepare(
        r#"UPDATE message_block SET content = json_set(content, '$.content', 'TAMPERED-BLOCK')
         WHERE message_id = ? AND block_type = 'tool_result'"#,
    )
    .run(&[SqlParam::from(mid)]);
    db.close();

    let activated = thread_view::install_prepared_compact(
        ref2.clone(),
        prep2,
        InstallPreparedOptions {
            allowed_marker_idempotency_key: Some(key2),
            ..Default::default()
        },
    )
    .await
    .expect_ok();
    assert_eq!(
        snapshot_canonical(&path2).view_id.as_deref(),
        Some(activated.view_id.as_str())
    );
}

#[tokio::test]
async fn derivation_changes_after_prepare_activate() {
    let (_store, ref_, path) = fixture_thread().await;
    let db0 = open_raw(&path);
    let row = db0
        .prepare(
            r#"SELECT subject_kind, subject_id, derivation_type, content FROM derivation
             WHERE state = 'ready' AND content IS NOT NULL LIMIT 1"#,
        )
        .get();
    assert!(row.is_some(), "need ready derivation");
    let sk = row
        .as_ref()
        .and_then(|r| r.get("subject_kind").and_then(|v| v.as_str()))
        .unwrap()
        .to_string();
    let sid = row
        .as_ref()
        .and_then(|r| r.get("subject_id").and_then(|v| v.as_str()))
        .unwrap()
        .to_string();
    let dt = row
        .as_ref()
        .and_then(|r| r.get("derivation_type").and_then(|v| v.as_str()))
        .unwrap()
        .to_string();
    let content = row
        .as_ref()
        .and_then(|r| r.get("content").and_then(|v| v.as_str()))
        .unwrap()
        .to_string();
    db0.close();

    let prep = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let db = open_raw(&path);
    let changed = db
        .prepare(
            "UPDATE derivation SET content = ? WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?",
        )
        .run(&[
            SqlParam::from(format!("{content}-MUTATED").as_str()),
            SqlParam::from(sk.as_str()),
            SqlParam::from(sid.as_str()),
            SqlParam::from(dt.as_str()),
        ]);
    assert_eq!(changed.changes, 1);
    db.close();

    let activated = thread_view::install_prepared_compact(
        ref_.clone(),
        prep,
        InstallPreparedOptions::default(),
    )
    .await
    .expect_ok();
    assert_eq!(
        snapshot_canonical(&path).view_id.as_deref(),
        Some(activated.view_id.as_str())
    );
}

#[tokio::test]
async fn message_changes_after_prepare_activate() {
    let (_store, ref_, path) = fixture_thread().await;
    let listed = messages::list(ref_.clone(), None).await.expect_ok();
    let removable = listed
        .iter()
        .find(|m| m.kind == MessageKind::AssistantText || m.kind == MessageKind::ToolResult)
        .expect("removable");
    let prep = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let removed = messages::remove(
        ref_.clone(),
        RemoveInput {
            message_id: removable.message_id.clone(),
        },
    )
    .await;
    assert!(removed.is_ok());
    let activated = thread_view::install_prepared_compact(
        ref_.clone(),
        prep,
        InstallPreparedOptions::default(),
    )
    .await
    .expect_ok();
    assert_eq!(
        snapshot_canonical(&path).view_id.as_deref(),
        Some(activated.view_id.as_str())
    );
}

#[tokio::test]
async fn second_coherent_prepared_view_can_replace_first() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let prep_a = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let prep_b = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let inst_a = thread_view::install_prepared_compact(
        ref_.clone(),
        prep_a,
        InstallPreparedOptions::default(),
    )
    .await
    .expect_ok();
    let view_after_a = snapshot_canonical(&path).view_id;
    assert_eq!(view_after_a.as_deref(), Some(inst_a.view_id.as_str()));
    let inst_b = thread_view::install_prepared_compact(
        ref_.clone(),
        prep_b,
        InstallPreparedOptions::default(),
    )
    .await
    .expect_ok();
    assert_eq!(
        snapshot_canonical(&path).view_id.as_deref(),
        Some(inst_b.view_id.as_str())
    );
}

#[tokio::test]
async fn compact_install_before_validate_runs_inside_write_txn() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let prep = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let nested_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let nested_err_c = Arc::clone(&nested_err);
    set_view_injection_db_hook(
        ViewInjectionPoint::CompactInstallBeforeValidate,
        Some(Arc::new(move |db| {
            let msg = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                db.exec("BEGIN IMMEDIATE");
            })) {
                Ok(()) => "nested_begin_succeeded".to_string(),
                Err(payload) => {
                    if let Some(s) = payload.downcast_ref::<String>() {
                        s.clone()
                    } else if let Some(s) = payload.downcast_ref::<&str>() {
                        (*s).to_string()
                    } else {
                        "panic".to_string()
                    }
                }
            };
            *nested_err_c.lock().unwrap() = Some(msg);
        })),
    );
    let inst = thread_view::install_prepared_compact(
        ref_.clone(),
        prep,
        InstallPreparedOptions::default(),
    )
    .await;
    set_view_injection_db_hook(ViewInjectionPoint::CompactInstallBeforeValidate, None);
    assert!(inst.is_ok(), "{inst:?}");
    let err = nested_err.lock().unwrap().clone().unwrap_or_default();
    assert!(
        err.to_lowercase().contains("transaction") || err.to_lowercase().contains("within"),
        "expected nested begin failure, got {err}"
    );
}

#[tokio::test]
async fn message_excerpt_source_change_after_prepare_activates() {
    let store = temp_store();
    let double = create_inference_callbacks_double();
    let _sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
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
    for i in 0..4 {
        let batch = intake_stream::message_events(
            ref_.clone(),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: format!("undrained turn {i} unique-excerpt-marker-{i}"),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: format!("reply {i} ").repeat(30),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TURN_END,
                    TurnEndOverrides {
                        payload: Some(TurnEndPayload {
                            outcome: Some("completed".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ),
            ],
        )
        .await;
        assert!(batch.is_ok());
    }
    let _ = intake_stream::message_events(
        ref_.clone(),
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "open tail".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "still open".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;

    let params = CompactOpts {
        profile: None,
        params: Some(ViewCompactParams {
            lower_bound: Some(200.0),
            percentages: Some(PartialViewProfilePercentages {
                full: Some(10.0),
                smooth: Some(70.0),
                detailed: Some(10.0),
                brief: Some(10.0),
            }),
            newest_closed_protection: None,
        }),
        signal: None,
        compact_point_upper_bound: None,
    };
    let prep = thread_view::prepare_compact(ref_.clone(), params.clone())
        .await
        .expect_ok();
    let smooth = prep.bands.iter().find(|b| b.band == Band::Smooth);
    assert!(smooth.is_some());
    assert!(
        smooth
            .unwrap()
            .rendered_text
            .contains("unique-excerpt-marker-")
    );
    assert!(!prep.selected_source_turn_ids.is_empty());
    let ok = thread_view::install_prepared_compact(
        ref_.clone(),
        prep,
        InstallPreparedOptions::default(),
    )
    .await;
    assert!(ok.is_ok());

    let prep2 = thread_view::prepare_compact(ref_.clone(), params)
        .await
        .expect_ok();
    assert!(
        prep2
            .bands
            .iter()
            .find(|b| b.band == Band::Smooth)
            .map(|b| b.rendered_text.contains("unique-excerpt-marker-"))
            .unwrap_or(false)
    );
    let db = open_raw(&file_path);
    let row = db
        .prepare(
            r#"SELECT m.message_id FROM message m
             JOIN message_block b ON b.message_id = m.message_id
             WHERE m.kind = 'user_prompt' AND b.content LIKE '%unique-excerpt-marker-3%'
             LIMIT 1"#,
        )
        .get();
    assert!(row.is_some());
    let mid = row
        .as_ref()
        .and_then(|r| r.get("message_id").and_then(|v| v.as_str()))
        .unwrap();
    db.prepare(
        r#"UPDATE message_block SET content = json_set(content, '$.text', 'MUTATED-EXCERPT-SOURCE')
         WHERE message_id = ?"#,
    )
    .run(&[SqlParam::from(mid)]);
    db.close();
    let activated = thread_view::install_prepared_compact(
        ref_.clone(),
        prep2,
        InstallPreparedOptions::default(),
    )
    .await
    .expect_ok();
    assert_eq!(
        snapshot_canonical(&file_path).view_id.as_deref(),
        Some(activated.view_id.as_str())
    );
}

#[tokio::test]
async fn source_block_change_after_prepare_activates() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let prep = thread_view::prepare_compact(ref_.clone(), compact_params())
        .await
        .expect_ok();
    let db = open_raw(&path);
    db.prepare(
        r#"UPDATE message_block SET content = json_set(content, '$.text', 'BLOCK-MUT')
         WHERE message_id IN (
           SELECT message_id FROM message WHERE kind = 'assistant_text' AND deleted_at IS NULL
           ORDER BY source_event_order DESC LIMIT 1
         )"#,
    )
    .run(&[]);
    db.close();
    let activated = thread_view::install_prepared_compact(
        ref_.clone(),
        prep,
        InstallPreparedOptions::default(),
    )
    .await
    .expect_ok();
    assert_eq!(
        snapshot_canonical(&path).view_id.as_deref(),
        Some(activated.view_id.as_str())
    );
}

// ── invalid candidate / install labels ────────────────────────────────────

#[tokio::test]
async fn unresolved_tool_call_exact_compact_failed_failed_repairable() {
    let (_store, ref_, path) = fixture_thread().await;
    let batch = intake_stream::message_events(
        ref_.clone(),
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "please use a tool".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "calling".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-unresolved".into(),
                        tool_name: "read_file".into(),
                        arguments: {
                            let mut m = Map::new();
                            m.insert("path".into(), json!("a.txt"));
                            m
                        },
                    }),
                    ..Default::default()
                },
            ),
        ],
    )
    .await;
    assert!(batch.is_ok());
    // Install a real prior serving view so byte-identity is meaningful.
    let prior_install = thread_view::compact(
        ref_.clone(),
        CompactOpts {
            profile: None,
            params: Some(ViewCompactParams {
                lower_bound: Some(50.0),
                percentages: Some(PartialViewProfilePercentages {
                    full: Some(25.0),
                    smooth: Some(25.0),
                    detailed: Some(25.0),
                    brief: Some(25.0),
                }),
                newest_closed_protection: None,
            }),
            signal: None,
            compact_point_upper_bound: None,
        },
    )
    .await;
    assert!(
        matches!(prior_install, OpResult::Ok { .. }),
        "prior compact install should succeed: {prior_install:?}"
    );
    let before = snapshot_view_truth(&path);
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("invalid-candidate-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert_eq!(
        result.receipt.outcome,
        CompactContinuationOutcomeKind::RetryCompact
    );
    assert!(!result.receipt.refused);
    assert_eq!(
        result
            .receipt
            .warnings
            .iter()
            .map(|w| w.code.as_str())
            .collect::<Vec<_>>(),
        vec!["compact_attempt_failed"]
    );
    assert_eq!(result.receipt.retry.attempt_index, 1);
    assert!(result.receipt.retry.retry_authorized);
    // The relief failed; the session keeps working on the body it already has.
    assert!(result.next_provider_request_allowed);
    assert!(
        result
            .decision
            .transition_path
            .iter()
            .any(|s| s.as_str().contains("compact"))
    );
    assert_eq!(
        result.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::FailedRepairable)
    );
    assert_eq!(
        result
            .pending_boundary
            .as_ref()
            .map(|b| b.last_stage.as_str()),
        Some("compact_failed")
    );
    assert_eq!(
        result
            .pending_boundary
            .as_ref()
            .map(|b| b.attempt_id.as_str()),
        Some("invalid-candidate-1")
    );
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    // Certified: invalid candidate must not replace the serving view or insert a marker.
    assert!(
        result.receipt.residual.prior_serving_view_intact,
        "residual priorServingViewIntact must be true"
    );
    assert!(
        result.compact_receipt.is_none(),
        "invalid candidate must not produce a compact receipt"
    );
    let after = snapshot_view_truth(&path);
    assert_eq!(
        after.view_id, before.view_id,
        "serving view id must remain unchanged"
    );
    assert_eq!(
        after.source_state_json, before.source_state_json,
        "source_state_json must remain byte-identical"
    );
    assert_eq!(
        after.band_tokens, before.band_tokens,
        "view band tokens must remain unchanged"
    );
    assert_eq!(
        after.marker_count, before.marker_count,
        "no compact_continuation_marker event may be inserted"
    );
    assert_eq!(
        after.marker_message_count, before.marker_message_count,
        "no compact_continuation_marker message may be inserted"
    );
    // Forced turn_end is durable (event/turn may advance) but serving view is intact.
    let stages = list_compact_continuation_stages(ref_.clone(), "invalid-candidate-1")
        .await
        .expect_ok();
    assert!(
        stages.iter().any(|s| s.stage == "compact_failed"),
        "must log compact_failed"
    );
    assert!(
        !stages.iter().any(|s| s.stage == "install_succeeded"),
        "must never log install_succeeded for invalid candidate"
    );
    assert!(
        !stages.iter().any(|s| s.stage == "install_failed"),
        "must not label invalid candidate as install_failed"
    );
    assert!(
        !stages.iter().any(|s| s.stage == "marker_persisted"),
        "must not persist marker for invalid candidate"
    );
}

#[tokio::test]
async fn marker_reassembly_includes_marker_in_candidate_and_install() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts("marker-reasm-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    assert!(
        result.marker_persisted,
        "valid active path must persist marker"
    );
    assert!(result.compact_receipt.is_some());
    let stages = list_compact_continuation_stages(ref_.clone(), "marker-reasm-1")
        .await
        .expect_ok();
    assert!(stages.iter().any(|s| s.stage == "marker_persisted"));
    assert!(stages.iter().any(|s| s.stage == "install_succeeded"));
    // Model-serving path includes the marker text after re-assembly+install.
    let ctx = thread_view::get_llm_request_context(ref_.clone())
        .await
        .expect_ok();
    let joined: String = ctx
        .messages
        .iter()
        .flat_map(|m| m.content.iter().map(|p| p.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        joined.contains("[compact continuation]"),
        "marker must be part of model-visible candidate after re-assembly: {joined}"
    );
    let c_turn = result.continuation_turn_id.expect("continuation turn");
    assert!(joined.contains(&format!("continuationTurnId={c_turn}")));
    assert_eq!(snapshot_canonical(&path).marker_count, 1);
}

#[tokio::test]
async fn candidate_assembly_error_returns_opresult_and_releases_writer() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    // After prepare succeeds, fail candidate assembly (TS: release writer + return
    // OpResult error; no marker, no install). Test seam only.
    let result = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("assembly-err-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_candidate_assembly: true,
            ..Default::default()
        }),
    )
    .await;
    match result {
        OpResult::Err { error } => {
            assert_eq!(error.code, ErrorCode::StorageFailure);
            assert!(
                error.reason.contains("candidate assembly"),
                "reason={}",
                error.reason
            );
        }
        OpResult::Ok { value } => {
            panic!("expected OpResult error from candidate assembly, got ok: {value:?}");
        }
    }
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    let stages = list_compact_continuation_stages(ref_.clone(), "assembly-err-1")
        .await
        .expect_ok();
    assert!(!stages.iter().any(|s| s.stage == "install_succeeded"));
    assert!(!stages.iter().any(|s| s.stage == "marker_persisted"));
    // Force may have committed turn_end before prepare, but no marker/install.
    assert_eq!(snapshot_view_truth(&path).marker_count, 0);
}

#[tokio::test]
async fn preserve_tool_invalid_candidate_no_install_no_marker() {
    let (_store, ref_, path) = fixture_thread().await;
    // Settled open turn with unresolved tool_call — invalid for preserve-tool
    // structural tail, and also fails durable pair proof before claim when
    // correlation claims a missing pair. Use a valid pair then corrupt tail
    // structure by leaving an extra unresolved call so candidate is invalid
    // only if we reached material — pair proof refuses first.
    // For preserve-tool invalid *candidate* after claim, seed a valid correlated
    // pair and also add an extra unresolved tool_call so settled-tail structure
    // fails after claim.
    seed_pending_tool_turn(&ref_, "call-preserve-bad").await;
    let extra = intake_stream::message_events(
        ref_.clone(),
        &[valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: "call-extra-unresolved".into(),
                    tool_name: "read_file".into(),
                    arguments: {
                        let mut m = Map::new();
                        m.insert("path".into(), json!("y.txt"));
                        m
                    },
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    assert!(extra.is_ok());
    let prior = snapshot_view_truth(&path);
    let before_markers = prior.marker_count;
    let result = run_compact_continuation(
        ref_.clone(),
        base_facts(
            "preserve-invalid-1",
            WorkContinuation::PendingCorrelatedToolResult {
                protected_tool_call_ids: vec!["call-preserve-bad".into()],
                correlation_valid: true,
            },
        ),
    )
    .await
    .expect_ok();
    // Preserve-tool never inserts a continuation marker.
    assert_eq!(
        snapshot_canonical(&path).marker_count,
        before_markers,
        "preserve-tool path must never insert a continuation marker"
    );
    assert!(
        result.compact_receipt.is_none(),
        "invalid preserve candidate must not return a compact receipt"
    );
    let stages = list_compact_continuation_stages(ref_.clone(), "preserve-invalid-1")
        .await
        .expect_ok();
    assert!(!stages.iter().any(|s| s.stage == "marker_persisted"));
    assert!(
        !stages.iter().any(|s| s.stage == "install_succeeded"),
        "invalid preserve candidate must not install"
    );
    assert_eq!(writer_claim_of(&path), (WriterClaimKind::None, None));
    let _ = prior;
}

#[tokio::test]
async fn valid_active_and_preserve_install_exactly_once() {
    // Active non-tool
    {
        let (_store, ref_, _) = fixture_thread().await;
        seed_open_agentic_turn(&ref_).await;
        let result = run_compact_continuation(
            ref_.clone(),
            base_facts("valid-active-once", WorkContinuation::ActiveNonTool),
        )
        .await
        .expect_ok();
        assert!(result.compact_receipt.is_some());
        let stages = list_compact_continuation_stages(ref_.clone(), "valid-active-once")
            .await
            .expect_ok();
        let install_count = stages
            .iter()
            .filter(|s| s.stage == "install_succeeded")
            .count();
        assert_eq!(install_count, 1, "active path installs exactly once");
        assert_eq!(
            stages
                .iter()
                .filter(|s| s.stage == "marker_persisted")
                .count(),
            1
        );
    }
    // Preserve-tool
    {
        let (_store, ref_, path) = fixture_thread().await;
        seed_pending_tool_turn(&ref_, "call-once").await;
        let before_markers = snapshot_canonical(&path).marker_count;
        let result = run_compact_continuation(
            ref_.clone(),
            base_facts(
                "valid-preserve-once",
                WorkContinuation::PendingCorrelatedToolResult {
                    protected_tool_call_ids: vec!["call-once".into()],
                    correlation_valid: true,
                },
            ),
        )
        .await
        .expect_ok();
        assert!(result.compact_receipt.is_some());
        let stages = list_compact_continuation_stages(ref_.clone(), "valid-preserve-once")
            .await
            .expect_ok();
        let install_count = stages
            .iter()
            .filter(|s| s.stage == "install_succeeded")
            .count();
        assert_eq!(install_count, 1, "preserve path installs exactly once");
        assert_eq!(
            snapshot_canonical(&path).marker_count,
            before_markers,
            "preserve path inserts no marker"
        );
        assert!(!stages.iter().any(|s| s.stage == "marker_persisted"));
    }
}

#[tokio::test]
async fn fail_install_before_write_install_failed_stage() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let failed = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("label-install", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert_eq!(
        failed.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::FailedRepairable)
    );
    assert_eq!(
        failed
            .pending_boundary
            .as_ref()
            .map(|b| b.last_stage.as_str()),
        Some("install_failed")
    );
    let stages = list_compact_continuation_stages(ref_.clone(), "label-install")
        .await
        .expect_ok();
    assert!(stages.iter().any(|s| s.stage == "install_failed"));
}

// ── closed validation table ───────────────────────────────────────────────

fn valid_host_json() -> Value {
    json!({
        "attemptId": "val-base",
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 1,
            "inputEpochAtApply": 1
        },
        "providerUsage": {
            "available": true,
            "inputTokens": 90000,
            "cacheCreationTokens": 5000,
            "cacheReadTokens": 10000,
            "total": 105000,
            "domain": "provider_reported_input"
        },
        "postMeasurementEstimate": {
            "tokens": 2000,
            "source": "lhc_token_estimate",
            "domain": "source_labelled_estimate"
        },
        "policy": {
            "upperTriggerTokens": 100000,
            "lowerTargetTokens": 400,
            "hostCapability": "full_state_machine"
        },
        "continuation": { "kind": "active_non_tool" },
        "writerClaim": "none",
        "captureComplete": true,
        "providerIdentityValid": true,
        "actor": "fixture-actor",
        "harness": "fixture-harness",
        "compact": {
            "params": {
                "lowerBound": 400,
                "percentages": { "full": 25, "smooth": 25, "detailed": 25, "brief": 25 }
            }
        }
    })
}

fn assert_invalid(facts: Value, pattern_sub: &str) {
    let err = validate_host_facts(&facts).expect("should reject");
    assert_eq!(err.code, ErrorCode::InvalidCompactContinuationInput);
    assert!(
        err.reason.contains(pattern_sub)
            || err
                .reason
                .to_lowercase()
                .contains(&pattern_sub.to_lowercase()),
        "reason '{}' does not contain '{pattern_sub}'",
        err.reason
    );
}

#[test]
fn closed_validation_table() {
    let valid = valid_host_json();
    assert!(validate_host_facts(&valid).is_none());

    let mut top = valid.clone();
    top.as_object_mut()
        .unwrap()
        .insert("extra".into(), json!(true));
    assert_invalid(top, "hostFacts.extra");

    let mut seam = valid.clone();
    seam["seam"]
        .as_object_mut()
        .unwrap()
        .insert("extra".into(), json!(1));
    assert_invalid(seam, "seam.extra");

    let mut pu = valid.clone();
    pu["providerUsage"]
        .as_object_mut()
        .unwrap()
        .insert("bonus".into(), json!(1));
    assert_invalid(pu, "providerUsage.bonus");

    let mut pme = valid.clone();
    pme["postMeasurementEstimate"]
        .as_object_mut()
        .unwrap()
        .insert("extra".into(), json!(true));
    assert_invalid(pme, "postMeasurementEstimate.extra");

    let mut pol = valid.clone();
    pol["policy"]
        .as_object_mut()
        .unwrap()
        .insert("extra".into(), json!(true));
    assert_invalid(pol, "policy.extra");

    let mut cont = valid.clone();
    cont["continuation"] = json!({ "kind": "none", "x": 1 });
    assert_invalid(cont, "continuation");

    let mut cont_a = valid.clone();
    cont_a["continuation"] = json!({ "kind": "active_non_tool", "toolCallId": "x" });
    assert_invalid(cont_a, "extra");

    let mut cont_t = valid.clone();
    cont_t["continuation"] = json!({ "kind": "pending_correlated_tool_result" });
    assert_invalid(cont_t, "toolCallId");

    let mut compact = valid.clone();
    compact["compact"] = json!({ "profile": "continuation", "weird": true });
    assert_invalid(compact, "compact.weird");

    let mut hooks = valid.clone();
    hooks
        .as_object_mut()
        .unwrap()
        .insert("testHooks".into(), json!({ "skipRealCompact": true }));
    assert_invalid(hooks, "testHooks");

    let mut frac = valid.clone();
    frac["providerUsage"]["inputTokens"] = json!(1.5);
    assert_invalid(frac, "integer");

    let mut epoch = valid.clone();
    epoch["seam"]["inputEpochAtDecision"] = json!(-1);
    assert_invalid(epoch, "non-negative");

    let mut actor = valid.clone();
    actor["actor"] = json!("");
    assert_invalid(actor, "actor");

    let mut domain = valid.clone();
    domain["providerUsage"]["domain"] = json!("wrong");
    assert_invalid(domain, "provider_reported_input");

    let mut cap = valid.clone();
    cap["policy"]["hostCapability"] = json!("magic");
    assert_invalid(cap, "hostCapability");

    let mut pct = valid.clone();
    pct["compact"]["params"]["percentages"] =
        json!({ "full": 10, "smooth": 10, "detailed": 10, "brief": 10 });
    assert_invalid(pct, "100");

    let mut lb = valid.clone();
    lb["compact"]["params"]["lowerBound"] = json!(0);
    assert_invalid(lb, "lowerBound");

    // Unavailable reason variants pass when closed.
    let mut unavail = valid.clone();
    unavail["providerUsage"] =
        json!({ "available": false, "reason": "invalid", "domain": "provider_reported_input" });
    assert!(validate_host_facts(&unavail).is_none());
}

// ── storage invariants ────────────────────────────────────────────────────

#[tokio::test]
async fn upsert_boundary_owner_mismatch_does_not_mutate() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let forced = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("own-a", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let turn_id = forced.continuation_turn_id.expect("turn");
    let db = open_raw(&path);
    let before = db
        .prepare(
            "SELECT attempt_id, status, last_stage FROM compact_continuation_boundary WHERE continuation_turn_id = ?",
        )
        .get_params(&[SqlParam::from(turn_id.as_str())])
        .expect("boundary");
    assert_eq!(
        before.get("attempt_id").and_then(|v| v.as_str()),
        Some("own-a")
    );
    let status_before = before
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let last_stage_before = before
        .get("last_stage")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        upsert_boundary(
            &db,
            &turn_id,
            "other-owner",
            BoundaryStatus::Complete,
            true,
            "stolen",
            "2020-01-01T00:00:00.000Z",
            Some("2020-01-01T00:00:00.000Z"),
        );
    }));
    assert!(panic_result.is_err(), "owner mismatch must panic");
    let after = db
        .prepare(
            "SELECT attempt_id, status, last_stage FROM compact_continuation_boundary WHERE continuation_turn_id = ?",
        )
        .get_params(&[SqlParam::from(turn_id.as_str())])
        .expect("boundary");
    assert_eq!(
        after.get("attempt_id").and_then(|v| v.as_str()),
        Some("own-a")
    );
    assert_eq!(
        after.get("status").and_then(|v| v.as_str()),
        Some(status_before.as_str())
    );
    assert_eq!(
        after.get("last_stage").and_then(|v| v.as_str()),
        Some(last_stage_before.as_str())
    );
    assert_ne!(
        after.get("last_stage").and_then(|v| v.as_str()),
        Some("stolen")
    );
    db.close();
}

#[tokio::test]
async fn partial_unique_index_rejects_second_unresolved_boundary() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let forced = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("uniq-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let _ = forced;
    let db = open_raw(&path);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        db.prepare(
            r#"INSERT INTO compact_continuation_boundary (
                 continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
               ) VALUES ('t-second', 'uniq-2', 'pending', 0, 'x', ?, NULL)"#,
        )
        .run(&[SqlParam::from("2020-01-01T00:00:00.000Z")]);
    }));
    assert!(
        result.is_err(),
        "second unresolved boundary must fail unique index"
    );
    db.close();
}

#[tokio::test]
async fn read_pending_boundary_throws_on_two_unresolved_without_index() {
    let (_store, ref_, path) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let forced = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("corr-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            interrupt_after_boundary: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    let _ = forced;
    let db = open_raw(&path);
    db.exec("DROP INDEX IF EXISTS idx_compact_continuation_boundary_one_unresolved");
    db.prepare(
        r#"INSERT INTO compact_continuation_boundary (
             continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
           ) VALUES ('t-second', 'corr-2', 'pending', 0, 'x', ?, NULL)"#,
    )
    .run(&[SqlParam::from("2020-01-01T00:00:00.000Z")]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = read_pending_boundary(&db);
    }));
    assert!(result.is_err(), "corruption must panic");
    db.close();
}

#[tokio::test]
async fn nonterminal_receipt_updates_append_only_stage_history() {
    let (_store, ref_, _) = fixture_thread().await;
    seed_open_agentic_turn(&ref_).await;
    let failed = run_compact_continuation_for_tests(
        ref_.clone(),
        base_facts("hist-1", WorkContinuation::ActiveNonTool),
        None,
        Some(CompactContinuationTestHooks {
            fail_install_before_write: true,
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert_eq!(
        failed.pending_boundary.as_ref().map(|b| b.status),
        Some(BoundaryStatus::FailedRepairable)
    );
    let stages1 = list_compact_continuation_stages(ref_.clone(), "hist-1")
        .await
        .expect_ok();
    let n1 = stages1.len();
    assert!(stages1.iter().any(|s| s.stage == "retry_posture"));
    assert!(stages1.iter().any(|s| s.stage == "claimed_writer"));

    let repaired = run_compact_continuation(
        ref_.clone(),
        base_facts("hist-1", WorkContinuation::ActiveNonTool),
    )
    .await
    .expect_ok();
    let _ = repaired;
    let stages2 = list_compact_continuation_stages(ref_.clone(), "hist-1")
        .await
        .expect_ok();
    assert!(stages2.len() > n1);
    assert!(
        stages2
            .iter()
            .filter(|s| s.stage == "retry_posture")
            .count()
            >= 2
    );
    assert!(stages2.iter().any(|s| s.stage == "claimed_writer"));
}

// ── public export surface / schema ────────────────────────────────────────

#[test]
fn public_sdk_does_not_export_run_for_tests() {
    // Production closed surface: public `run_compact_continuation` is available
    // without hooks. The fault-injection path lives only under
    // `compact_continuation::test_support`, which is feature-gated (`test-util`)
    // and proven compile-fail when the feature is off (see
    // `tests/ui_feature_off/test_support_requires_feature.rs`).
    let _hooks = CompactContinuationTestHooks::default();
    let _ = std::any::type_name::<CompactContinuationTestHooks>();
    let _ = std::any::type_name_of_val(&run_compact_continuation);
    // With `test-util` enabled for this binary, test_support remains reachable
    // for residual fixtures — that is intentional and not a production export.
    let _ = std::any::type_name_of_val(
        &lhc::compact_continuation::test_support::run_compact_continuation_for_tests,
    );
}

#[tokio::test]
async fn fresh_threads_are_schema_v12() {
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
    let v = db
        .prepare("PRAGMA user_version")
        .get()
        .and_then(|r| r.get("user_version").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    assert_eq!(v, CURRENT_THREAD_SCHEMA_VERSION);
    assert_eq!(v, 12);
    let hv = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_host_validation'",
        )
        .get();
    assert!(hv.is_some());
    let idx = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_compact_continuation_boundary_one_unresolved'",
        )
        .get();
    assert!(idx.is_some());
    db.close();
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

    let chat = messages::list(
        ref_.clone(),
        Some(lhc::messages::MessageListOptions {
            for_user_chat: Some(true),
            ..Default::default()
        }),
    )
    .await
    .expect_ok();
    assert!(
        chat.iter()
            .all(|m| m.kind != MessageKind::CompactContinuationMarker)
    );

    let all = messages::list(ref_, None).await.expect_ok();
    assert!(
        all.iter()
            .any(|m| m.kind == MessageKind::CompactContinuationMarker)
    );
}

#[test]
fn current_schema_version_is_12() {
    assert_eq!(CURRENT_THREAD_SCHEMA_VERSION, 12);
}

#[tokio::test]
async fn host_facts_closed_validation_matrix_smoke() {
    assert!(validate_host_facts(&json!({})).is_some());
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
    assert!(validate_host_facts(&valid_host_json()).is_none());
}

#[tokio::test]
async fn operation_identity_ignores_retry_posture_fields() {
    use lhc::compact_continuation::{compute_operation_identity, hash_attempt_intent};
    let mut facts = base_facts("id", WorkContinuation::ActiveNonTool);
    let h1 = hash_attempt_intent(&compute_operation_identity(&facts)).0;
    facts.seam.input_epoch_at_apply = 99;
    facts.post_measurement_estimate.tokens = 999;
    facts.capture_complete = false;
    let h2 = hash_attempt_intent(&compute_operation_identity(&facts)).0;
    assert_eq!(h1, h2, "identity must ignore seam/usage/estimate posture");
}

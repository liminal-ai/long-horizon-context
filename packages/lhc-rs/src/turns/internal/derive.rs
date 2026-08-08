//! Ported from packages/lhc/src/turns/internal/derive.ts. Phase 1 skeleton.
//!
//! Turn derivation handlers + dispatch. Critical fidelity:
//! - `chunk_detailed_handler` / `chunk_brief_handler` are sync zero-arg factories
//!   returning [`WorkHandler`]; the handler table binds SEPARATE private handler
//!   stubs (not the factories as async handlers).
//! - `inference_failed` accepts only `{ reason: string }`.
//! - `source_damaged` / `inference_failed` / `dependency_not_ready` return
//!   [`NonOkHandlerOutcome`] (Deferred/Failed/Blocked only — never `Ok`).
//! - `DetailedChunkComposition` stays exhaustive over the same non-ok arms.

use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::messages::internal::derive::MessageDeriveDerivationType;
use crate::messages::internal::derive::{
    MessageDerivationFloorRecovery, write_message_derivation_floor_in_thread,
};
use crate::shared_tech::context::resolve_instance_poke;
use crate::shared_tech::derivation::{
    BoxFuture, BriefTargets, Clock, CompletionTx, CompressDetailedTurnInput, CompressionTargets,
    DerivationMetadata, DerivationState, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext,
    InferenceResult, ResolvedSdkConfig, SizeDisposition,
    SubjectKind, SummarizeChunkBriefInput, WorkHandler, WorkItemRef,
};
use crate::shared_tech::durable_work::{
    ApplyDerivationSuccessDisposition, ApplyDerivationTerminalDisposition, DerivationAttempt,
    DerivationCompletionError, DerivationTerminalFailure, DerivationTerminalState,
    DurableWorkDispatchResult, DurableWorkSettledDisposition, HandlerRunIdentity,
    RunWorkHandlerItem, apply_derivation_success, apply_derivation_terminal_failure,
    run_work_handler,
};
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};
use crate::shared_tech::logging::{
    DerivationLogEntry, DerivationLogEventKind, DerivationLogTarget, LogEntry, LogLevel,
    append_derivation_log, write_log,
};
use crate::shared_tech::persist::{
    DbReadTransaction, DbTransaction, DbWriteTransaction, PostCommitHook, PostCommitHookSet,
    create_post_commit_hook_set,
};
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::work_queue::{
    ClaimTiming, EnqueueDerivationTarget, EnqueueInput, ImmediateClaimInput, ImmediateClaimOutcome,
    ImmediateDerivationBoundary, WorkHandlerMap, WorkKind, WorkOwner, WorkSourceRef,
    create_or_claim_immediate_work_item, enqueue, has_live_item,
};
use crate::turns::ChunkDeriveDerivationType;
use crate::turns::TurnStatus;
use crate::turns::internal::chunks::ChunkPolicy;

use super::chunks::{enqueue_chunk_summaries, place_turn};
use super::compose::{
    RecoveryReason, compose_pre_detailed_assembly, compose_rendering_input,
    compose_structured_turn_text,
};
use super::derivations::{
    TurnOwnedSubjectKind, chunk_exists, read_chunk_summary_derivation, read_member_messages,
    read_member_projections, read_message_derivation_rows, read_turn_derivation_row,
    read_turn_source,
};
use super::store::select_open_turn_ids;

const SQL_SELECT_THREAD_ID: &str = r#"SELECT thread_id FROM thread_metadata WHERE id = 1"#;

const SQL_SELECT_CLAIMED_WORK_ITEM: &str =
    r#"SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"#;

const SQL_DELETE_CLAIMED_WORK_ITEM: &str =
    r#"DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"#;

/// TS `db.exec("BEGIN IMMEDIATE;")` — module-local transaction literal.
const SQL_BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE;";
/// TS `db.exec("COMMIT;")`.
const SQL_COMMIT: &str = "COMMIT;";
/// TS `db.exec("ROLLBACK;")`.
const SQL_ROLLBACK: &str = "ROLLBACK;";

/// TS `Extract<HandlerOutcome, { ok: false }>` — Deferred | Failed | Blocked
/// only (never admits `Ok`). Used by `sourceDamaged` / `inferenceFailed` /
/// `dependencyNotReady`; [`DetailedChunkComposition`] stays exhaustive over
/// the same non-ok arms.
enum NonOkHandlerOutcome {
    /// TS `Extract<HandlerOutcome, { ok: false }>` includes Deferred; turn
    /// derive paths currently construct Failed/Blocked only.
    #[allow(dead_code)]
    Deferred {
        reason: String,
        on_deferred: Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>,
    },
    Failed {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}

impl NonOkHandlerOutcome {
    fn into_handler_outcome(self) -> HandlerOutcome {
        match self {
            NonOkHandlerOutcome::Deferred {
                reason,
                on_deferred,
            } => HandlerOutcome::Deferred {
                reason,
                on_deferred,
            },
            NonOkHandlerOutcome::Failed { reason } => HandlerOutcome::Failed { reason },
            NonOkHandlerOutcome::Blocked { reason } => HandlerOutcome::Blocked { reason },
        }
    }

    fn into_detailed_chunk(self) -> DetailedChunkComposition {
        match self {
            NonOkHandlerOutcome::Deferred {
                reason,
                on_deferred,
            } => DetailedChunkComposition::Deferred {
                reason,
                on_deferred,
            },
            NonOkHandlerOutcome::Failed { reason } => DetailedChunkComposition::Failed { reason },
            NonOkHandlerOutcome::Blocked { reason } => DetailedChunkComposition::Blocked { reason },
        }
    }
}

fn source_damaged(reason: &str) -> NonOkHandlerOutcome {
    NonOkHandlerOutcome::Blocked {
        reason: format!("source_damaged: {reason}"),
    }
}

/// TS `inferenceFailed(result: { reason: string })` — narrow shape only.
#[derive(Debug, Clone, PartialEq, Eq)]
struct InferenceFailedReason {
    reason: String,
}

fn inference_failed(result: &InferenceFailedReason) -> NonOkHandlerOutcome {
    NonOkHandlerOutcome::Failed {
        reason: result.reason.clone(),
    }
}

fn dependency_not_ready(reason: &str) -> NonOkHandlerOutcome {
    NonOkHandlerOutcome::Failed {
        reason: reason.to_string(),
    }
}

fn compose_detailed_chunk_summary(member_projections: &[String]) -> String {
    member_projections.join("\n\n")
}

/// TS compression target token bag.
#[derive(Debug, Clone, PartialEq)]
struct CompressionTokenTargets {
    input_tokens: i64,
    target_min_tokens: i64,
    target_aim_tokens: i64,
    target_max_tokens: i64,
}

/// Closed borrowed representation of TS
/// `ResolvedSdkConfig["compressionTargets"] | ResolvedSdkConfig["briefTargets"]`.
enum CompressionRatioTargets<'a> {
    Compression(&'a CompressionTargets),
    Brief(&'a BriefTargets),
}

/// JS `Math.round` — `floor(x + 0.5)`, not Rust `.round()`.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn compression_target_tokens(
    input_tokens: i64,
    targets: CompressionRatioTargets<'_>,
) -> CompressionTokenTargets {
    let (min_ratio, aim_ratio, max_ratio) = match targets {
        CompressionRatioTargets::Compression(t) => (t.min_ratio, t.aim_ratio, t.max_ratio),
        CompressionRatioTargets::Brief(t) => (t.min_ratio, t.aim_ratio, t.max_ratio),
    };
    CompressionTokenTargets {
        input_tokens,
        target_min_tokens: 1.max(js_round(input_tokens as f64 * min_ratio)),
        target_aim_tokens: 1.max(js_round(input_tokens as f64 * aim_ratio)),
        target_max_tokens: 1.max(js_round(input_tokens as f64 * max_ratio)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SizeDispositionBounds {
    target_min_tokens: i64,
    target_max_tokens: i64,
}

fn size_disposition(output_tokens: i64, targets: SizeDispositionBounds) -> SizeDisposition {
    if output_tokens < targets.target_min_tokens {
        SizeDisposition::UnderMin
    } else if output_tokens > targets.target_max_tokens {
        SizeDisposition::OverMax
    } else {
        SizeDisposition::InRange
    }
}

fn poke_thread_scheduler(db: &Db) {
    let row = db.prepare(SQL_SELECT_THREAD_ID).get();
    if let Some(row) = row {
        if let Some(thread_id) = row.get("thread_id").and_then(|v| v.as_str()) {
            resolve_instance_poke()(thread_id);
        }
    }
}

/// TS `logFallback` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LogFallbackEntry {
    derivation_type: String,
    subject_id: String,
    reason: LogFallbackReason,
    floor_used: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogFallbackReason {
    NotReady,
    FailedFloor,
}

impl LogFallbackReason {
    fn as_str(self) -> &'static str {
        match self {
            LogFallbackReason::NotReady => "not_ready",
            LogFallbackReason::FailedFloor => "failed_floor",
        }
    }
}

fn system_time_to_iso(time: SystemTime) -> String {
    let ms = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64;
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn open_run_db(run: &HandlerRunContext) -> Db {
    match (run.open_db)() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn log_fallback(run: &HandlerRunContext, entry: &LogFallbackEntry) {
    let db = open_run_db(run);
    let txn = DbReadTransaction {
        db: &db,
        thread_id: run.thread_id.clone(),
        file_path: run.file_path.clone(),
    };
    write_log(
        DbTransaction::Read(&txn),
        &LogEntry {
            level: LogLevel::Warning,
            message: "derivation fallback used".into(),
            derivation_type: Some(entry.derivation_type.clone()),
            subject_id: Some(entry.subject_id.clone()),
            reason: Some(entry.reason.as_str().to_string()),
            floor_used: Some(entry.floor_used.clone()),
        },
    );
    db.close();
}

fn empty_metadata() -> DerivationMetadata {
    DerivationMetadata {
        outcome: None,
        last_error: None,
        discard_reason: None,
        fallback_floor: None,
        fallback_used: None,
        inference_attempted: None,
        inference_succeeded: None,
        size_disposition: None,
        provenance: None,
    }
}

fn metadata_nonempty(metadata: &DerivationMetadata) -> bool {
    metadata.outcome.is_some()
        || metadata.last_error.is_some()
        || metadata.discard_reason.is_some()
        || metadata.fallback_floor.is_some()
        || metadata.fallback_used.is_some()
        || metadata.inference_attempted.is_some()
        || metadata.inference_succeeded.is_some()
        || metadata.size_disposition.is_some()
        || metadata.provenance.is_some()
}

fn recovery_log_reason(reason: RecoveryReason) -> LogFallbackReason {
    match reason {
        RecoveryReason::NotReady => LogFallbackReason::NotReady,
        RecoveryReason::FailedFloor => LogFallbackReason::FailedFloor,
    }
}

fn message_floor_derivation_type(derivation_type: &str) -> MessageDeriveDerivationType {
    match derivation_type {
        "smoothed_prompt" => MessageDeriveDerivationType::SmoothedPrompt,
        "tool_result_summary" => MessageDeriveDerivationType::ToolResultSummary,
        other => panic!("unexpected message floor derivation type: {other}"),
    }
}

fn as_turn_owned_subject(kind: SubjectKind) -> TurnOwnedSubjectKind {
    match kind {
        SubjectKind::Turn => TurnOwnedSubjectKind::Turn,
        SubjectKind::Chunk => TurnOwnedSubjectKind::Chunk,
        SubjectKind::Message => {
            panic!("turn-owned derive expected turn|chunk subject, got message")
        }
    }
}

fn completion_error_result(err: &DerivationCompletionError) -> ErrorResult {
    ErrorResult {
        error_class: ErrorClass::StateCorruption,
        code: ErrorCode::DerivationCompletionMismatch,
        reason: err.to_string(),
        event_index: None,
    }
}

fn catch_completion_error<T>(
    result: Result<T, Box<dyn std::any::Any + Send>>,
) -> Result<T, ErrorResult> {
    match result {
        Ok(value) => Ok(value),
        Err(cause) => {
            if let Some(err) = cause.downcast_ref::<DerivationCompletionError>() {
                return Err(completion_error_result(err));
            }
            resume_unwind(cause);
        }
    }
}

async fn turn_derivation_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome {
    let Some(turn_id) = item.source_ref.get("turnId").cloned() else {
        return source_damaged("work item carries no turnId").into_handler_outcome();
    };
    let db = open_run_db(&run);
    let turn = read_turn_source(&db, &turn_id);
    if turn.as_ref().is_none_or(|t| t.deleted) {
        db.close();
        return source_damaged(&format!("turn {turn_id} not found")).into_handler_outcome();
    }
    let turn = turn.unwrap();
    if turn.status != TurnStatus::Closed {
        db.close();
        return source_damaged(&format!("turn {turn_id} is open under a derivation item"))
            .into_handler_outcome();
    }
    let open_turn_ids = select_open_turn_ids(&db);
    if open_turn_ids.len() > 1 {
        db.close();
        return source_damaged(&format!(
            "turn state corrupt: {} turns open ({})",
            open_turn_ids.len(),
            open_turn_ids.join(", ")
        ))
        .into_handler_outcome();
    }

    let messages = read_member_messages(&db, &turn_id);
    let message_ids: Vec<String> = messages.iter().map(|m| m.message_id.clone()).collect();
    let derivations = read_message_derivation_rows(&db, &message_ids);
    let composition = compose_rendering_input(&messages, &derivations);
    let assembly = compose_pre_detailed_assembly(&messages, &derivations);
    let mut seen_recoveries = HashSet::new();
    let mut merged_recoveries = Vec::new();
    for recovery in composition
        .recoveries
        .iter()
        .chain(assembly.recoveries.iter())
    {
        let key = format!("{}:{}", recovery.subject_id, recovery.derivation_type);
        if !seen_recoveries.insert(key) {
            continue;
        }
        merged_recoveries.push(recovery.clone());
    }
    for recovery in &merged_recoveries {
        log_fallback(
            &run,
            &LogFallbackEntry {
                derivation_type: recovery.derivation_type.clone(),
                subject_id: recovery.subject_id.clone(),
                reason: recovery_log_reason(recovery.reason),
                floor_used: recovery.floor_used.clone(),
            },
        );
        write_message_derivation_floor_in_thread(
            &run,
            &MessageDerivationFloorRecovery {
                message_id: recovery.subject_id.clone(),
                derivation_type: message_floor_derivation_type(&recovery.derivation_type),
                content: recovery.content.clone(),
                source_version: recovery.source_version,
            },
        );
    }

    let rendering_text = compose_structured_turn_text(&composition.parts, &turn_id);
    let assembly_text = assembly.text;
    let projected_tokens = estimate_tokens(&assembly_text);
    let thread_id = run.thread_id.clone();
    let file_path = run.file_path.clone();
    let clock: Clock = Arc::clone(&run.clock);
    let compression_source_version = read_turn_derivation_row(
        &db,
        TurnOwnedSubjectKind::Turn,
        &turn_id,
        "pre_detailed_assembly",
    )
    .map(|row| row.source_version)
    .unwrap_or(1);
    let target_projected_tokens = run.config.chunk_policy.target_projected_tokens;
    let max_projected_tokens = run.config.chunk_policy.max_projected_tokens;
    let turn_id_for_applied = turn_id.clone();
    db.close();

    HandlerOutcome::Ok {
        derivations: Some(vec![
            HandlerDerivationWrite {
                subject_kind: SubjectKind::Turn,
                subject_id: turn_id.clone(),
                derivation_type: "turn_rendering".into(),
                content: rendering_text,
                metadata: None,
                gaps: None,
            },
            HandlerDerivationWrite {
                subject_kind: SubjectKind::Turn,
                subject_id: turn_id,
                derivation_type: "pre_detailed_assembly".into(),
                content: assembly_text,
                metadata: None,
                gaps: None,
            },
        ]),
        on_applied: Some(Box::new(move |transaction: CompletionTx<'_>| {
            let add = Arc::new(transaction.on_commit);
            let write_txn = |add: Arc<
                Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>,
            >|
             -> DbWriteTransaction<'_> {
                DbWriteTransaction {
                    db: transaction.db,
                    thread_id: thread_id.clone(),
                    file_path: file_path.clone(),
                    clock: Arc::clone(&clock),
                    post_commit_hook: PostCommitHook {
                        add: Box::new({
                            let add = Arc::clone(&add);
                            move |op| add(op)
                        }),
                    },
                    poke: Arc::from(resolve_instance_poke()),
                }
            };
            let source_ref = WorkSourceRef::Turn {
                turn_id: turn_id_for_applied.clone(),
            };
            if !has_live_item(
                transaction.db,
                WorkKind::DetailedTurnCompression,
                &source_ref,
                compression_source_version,
            ) {
                enqueue(
                    &write_txn(Arc::clone(&add)),
                    EnqueueInput {
                        owner: WorkOwner::Turns,
                        kind: WorkKind::DetailedTurnCompression,
                        source_ref,
                        source_version: Some(compression_source_version),
                        derivations: vec![EnqueueDerivationTarget {
                            subject_kind: SubjectKind::Turn,
                            subject_id: turn_id_for_applied.clone(),
                            derivation_type: "detailed_turn_compression".into(),
                        }],
                        operation: None,
                    },
                );
            }
            let policy = ChunkPolicy {
                target_projected_tokens,
                max_projected_tokens,
            };
            let placement = place_turn(
                transaction.db,
                &turn_id_for_applied,
                projected_tokens,
                &policy,
            );
            for chunk_id in placement.closed_chunk_ids {
                enqueue_chunk_summaries(&write_txn(Arc::clone(&add)), &chunk_id);
            }
        })),
    }
}

async fn detailed_turn_compression_handler(
    run: HandlerRunContext,
    item: WorkItemRef,
) -> HandlerOutcome {
    let Some(turn_id) = item.source_ref.get("turnId").cloned() else {
        return source_damaged("work item carries no turnId").into_handler_outcome();
    };
    let db = open_run_db(&run);
    let turn = read_turn_source(&db, &turn_id);
    if turn.as_ref().is_none_or(|t| t.deleted) {
        db.close();
        return source_damaged(&format!("turn {turn_id} not found")).into_handler_outcome();
    }
    let turn = turn.unwrap();
    if turn.status != TurnStatus::Closed {
        db.close();
        return source_damaged(&format!("turn {turn_id} is open under a derivation item"))
            .into_handler_outcome();
    }

    let assembly_row = read_turn_derivation_row(
        &db,
        TurnOwnedSubjectKind::Turn,
        &turn_id,
        "pre_detailed_assembly",
    );
    if assembly_row
        .as_ref()
        .is_none_or(|row| row.state != DerivationState::Ready || row.content.is_none())
    {
        let state = assembly_row
            .as_ref()
            .map(|row| row.state.as_str())
            .unwrap_or("missing");
        db.close();
        return dependency_not_ready(&format!(
            "pre_detailed_assembly_not_ready: turn {turn_id} pre_detailed_assembly is {state}"
        ))
        .into_handler_outcome();
    }
    let assembly_text = assembly_row.unwrap().content.unwrap();
    let input_tokens = estimate_tokens(&assembly_text);
    let tiny_turn_tokens = run.config.guards.detailed_turn_compression.tiny_turn_tokens;
    let target_tokens = compression_target_tokens(
        input_tokens,
        CompressionRatioTargets::Compression(&run.config.compression_targets),
    );

    let compression_result = if input_tokens < tiny_turn_tokens {
        InferenceResult::Ok {
            text: assembly_text.clone(),
            provenance: None,
            request_messages: None,
            raw_response: None,
        }
    } else {
        (run.inference_callbacks.compress_detailed_turn)(CompressDetailedTurnInput {
            dialogue_text: assembly_text.clone(),
            input_tokens: target_tokens.input_tokens,
            target_min_tokens: target_tokens.target_min_tokens,
            target_aim_tokens: target_tokens.target_aim_tokens,
            target_max_tokens: target_tokens.target_max_tokens,
        })
        .await
    };

    let mut compression_text = assembly_text.clone();
    let mut compression_used_fallback = false;
    let mut compression_failure_reason: Option<String> = None;

    match &compression_result {
        InferenceResult::Err {
            reason,
            request_messages,
        } => {
            let txn = DbReadTransaction {
                db: &db,
                thread_id: run.thread_id.clone(),
                file_path: run.file_path.clone(),
            };
            let mut payload = Map::new();
            payload.insert("reason".into(), json!(reason));
            if let Some(msgs) = request_messages {
                payload.insert(
                    "requestMessages".into(),
                    serde_json::to_value(msgs).unwrap_or(Value::Null),
                );
            }
            append_derivation_log(
                DbTransaction::Read(&txn),
                &DerivationLogEntry {
                    target: DerivationLogTarget {
                        subject_kind: SubjectKind::Turn,
                        subject_id: turn_id.clone(),
                        derivation_type: "detailed_turn_compression".into(),
                    },
                    event_kind: DerivationLogEventKind::InferenceFailed,
                    payload,
                },
            );
            compression_used_fallback = true;
            compression_failure_reason = Some(reason.clone());
        }
        InferenceResult::Ok {
            text,
            provenance,
            request_messages,
            raw_response,
        } => {
            compression_text = text.clone();
            if input_tokens >= tiny_turn_tokens {
                let txn = DbReadTransaction {
                    db: &db,
                    thread_id: run.thread_id.clone(),
                    file_path: run.file_path.clone(),
                };
                let mut payload = Map::new();
                if let Some(provenance) = provenance {
                    payload.insert(
                        "provenance".into(),
                        serde_json::to_value(provenance).unwrap_or(Value::Null),
                    );
                }
                if let Some(msgs) = request_messages {
                    payload.insert(
                        "requestMessages".into(),
                        serde_json::to_value(msgs).unwrap_or(Value::Null),
                    );
                }
                if let Some(raw) = raw_response {
                    payload.insert("rawResponse".into(), json!(raw));
                }
                append_derivation_log(
                    DbTransaction::Read(&txn),
                    &DerivationLogEntry {
                        target: DerivationLogTarget {
                            subject_kind: SubjectKind::Turn,
                            subject_id: turn_id.clone(),
                            derivation_type: "detailed_turn_compression".into(),
                        },
                        event_kind: DerivationLogEventKind::InferenceSucceeded,
                        payload,
                    },
                );
            }
        }
    }

    let projected_tokens = estimate_tokens(&compression_text);
    let mut compression_metadata = empty_metadata();
    if !compression_used_fallback {
        if let InferenceResult::Ok {
            provenance: Some(provenance),
            ..
        } = &compression_result
        {
            compression_metadata.provenance = Some(provenance.clone());
        }
    }
    if compression_used_fallback {
        compression_metadata.inference_attempted = Some(true);
        compression_metadata.inference_succeeded = Some(false);
        compression_metadata.fallback_used = Some(true);
        if let Some(reason) = &compression_failure_reason {
            compression_metadata.last_error = Some(reason.clone());
        }
        compression_metadata.fallback_floor = Some("pre_detailed_assembly".into());
    } else if input_tokens >= tiny_turn_tokens {
        compression_metadata.inference_attempted = Some(true);
        compression_metadata.inference_succeeded = Some(true);
        compression_metadata.size_disposition = Some(size_disposition(
            projected_tokens,
            SizeDispositionBounds {
                target_min_tokens: target_tokens.target_min_tokens,
                target_max_tokens: target_tokens.target_max_tokens,
            },
        ));
    }

    let metadata = if metadata_nonempty(&compression_metadata) {
        Some(compression_metadata)
    } else {
        None
    };

    let thread_id = run.thread_id.clone();
    let file_path = run.file_path.clone();
    let clock: Clock = Arc::clone(&run.clock);
    let on_applied = if compression_used_fallback {
        let turn_id = turn_id.clone();
        let compression_failure_reason = compression_failure_reason.clone();
        Some(Box::new(move |transaction: CompletionTx<'_>| {
            let add = Arc::new(transaction.on_commit);
            let write_txn = DbWriteTransaction {
                db: transaction.db,
                thread_id: thread_id.clone(),
                file_path: file_path.clone(),
                clock: Arc::clone(&clock),
                post_commit_hook: PostCommitHook {
                    add: Box::new({
                        let add = Arc::clone(&add);
                        move |op| add(op)
                    }),
                },
                poke: Arc::from(resolve_instance_poke()),
            };
            let mut payload = Map::new();
            payload.insert("fallbackFloor".into(), json!("pre_detailed_assembly"));
            if let Some(reason) = &compression_failure_reason {
                payload.insert("reason".into(), json!(reason));
            }
            append_derivation_log(
                DbTransaction::Write(&write_txn),
                &DerivationLogEntry {
                    target: DerivationLogTarget {
                        subject_kind: SubjectKind::Turn,
                        subject_id: turn_id.clone(),
                        derivation_type: "detailed_turn_compression".into(),
                    },
                    event_kind: DerivationLogEventKind::FallbackApplied,
                    payload,
                },
            );
            write_log(
                DbTransaction::Write(&write_txn),
                &LogEntry {
                    level: LogLevel::Warning,
                    message: "turn compression fallback used".into(),
                    derivation_type: Some("detailed_turn_compression".into()),
                    subject_id: Some(turn_id),
                    reason: compression_failure_reason,
                    floor_used: Some("pre_detailed_assembly".into()),
                },
            );
        })
            as Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>)
    } else {
        None
    };

    db.close();
    HandlerOutcome::Ok {
        derivations: Some(vec![HandlerDerivationWrite {
            subject_kind: SubjectKind::Turn,
            subject_id: turn_id,
            derivation_type: "detailed_turn_compression".into(),
            content: compression_text,
            metadata,
            gaps: None,
        }]),
        on_applied,
    }
}

/// TS `DetailedChunkComposition` — ok composition bag plus every
/// [`NonOkHandlerOutcome`] arm (Deferred / Failed / Blocked).
enum DetailedChunkComposition {
    Ok {
        text: String,
        fallback_logs: Vec<LogEntry>,
    },
    Deferred {
        reason: String,
        on_deferred: Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>,
    },
    Failed {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}

fn compose_detailed_chunk_from_members(db: &Db, chunk_id: &str) -> DetailedChunkComposition {
    let members = read_member_projections(db, chunk_id);
    let mut member_projections: Vec<String> = Vec::new();
    let mut fallback_logs: Vec<LogEntry> = Vec::new();
    for member in members {
        if let Some(reason) = &member.source_corruption_reason {
            return source_damaged(reason).into_detailed_chunk();
        }
        if member.state.as_deref() == Some("ready") {
            if let Some(content) = member.content.clone() {
                member_projections.push(content);
                continue;
            }
        }
        if member.state.as_deref() == Some("blocked") {
            return source_damaged(&format!(
                "member {} detailed_turn_compression blocked while deriving chunk_summary_detailed",
                member.turn_id
            ))
            .into_detailed_chunk();
        }
        if member.state.as_deref() == Some("failed")
            && member.assembly_state.as_deref() == Some("ready")
        {
            if let Some(assembly_content) = member.assembly_content.clone() {
                member_projections.push(assembly_content);
                fallback_logs.push(LogEntry {
                    level: LogLevel::Warning,
                    message: "derivation fallback used".into(),
                    derivation_type: Some("chunk_summary_detailed".into()),
                    subject_id: Some(chunk_id.to_string()),
                    reason: Some("failed_floor".into()),
                    floor_used: Some(member.turn_id),
                });
                continue;
            }
        }
        let state = member.state.as_deref().unwrap_or("missing");
        return dependency_not_ready(&format!(
            "member_projection_not_ready: member {} detailed_turn_compression is {state}",
            member.turn_id
        ))
        .into_detailed_chunk();
    }
    DetailedChunkComposition::Ok {
        text: compose_detailed_chunk_summary(&member_projections),
        fallback_logs,
    }
}

async fn chunk_detailed_handler_body(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome {
    let Some(chunk_id) = item.source_ref.get("chunkId").cloned() else {
        return source_damaged("work item carries no chunkId").into_handler_outcome();
    };
    let db = open_run_db(&run);
    if !chunk_exists(&db, &chunk_id) {
        db.close();
        return source_damaged(&format!("chunk {chunk_id} not found")).into_handler_outcome();
    }
    let composition = compose_detailed_chunk_from_members(&db, &chunk_id);
    db.close();
    match composition {
        DetailedChunkComposition::Ok {
            text,
            fallback_logs,
        } => {
            let thread_id = run.thread_id.clone();
            let file_path = run.file_path.clone();
            let clock: Clock = Arc::clone(&run.clock);
            let on_applied = if fallback_logs.is_empty() {
                None
            } else {
                Some(Box::new(move |transaction: CompletionTx<'_>| {
                    let add = Arc::new(transaction.on_commit);
                    let write_txn = DbWriteTransaction {
                        db: transaction.db,
                        thread_id,
                        file_path,
                        clock,
                        post_commit_hook: PostCommitHook {
                            add: Box::new(move |op| add(op)),
                        },
                        poke: Arc::from(resolve_instance_poke()),
                    };
                    for entry in &fallback_logs {
                        write_log(DbTransaction::Write(&write_txn), entry);
                    }
                })
                    as Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>)
            };
            HandlerOutcome::Ok {
                derivations: Some(vec![HandlerDerivationWrite {
                    subject_kind: SubjectKind::Chunk,
                    subject_id: chunk_id,
                    derivation_type: "chunk_summary_detailed".into(),
                    content: text,
                    metadata: None,
                    gaps: None,
                }]),
                on_applied,
            }
        }
        DetailedChunkComposition::Deferred {
            reason,
            on_deferred,
        } => HandlerOutcome::Deferred {
            reason,
            on_deferred,
        },
        DetailedChunkComposition::Failed { reason } => HandlerOutcome::Failed { reason },
        DetailedChunkComposition::Blocked { reason } => HandlerOutcome::Blocked { reason },
    }
}

async fn chunk_brief_handler_body(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome {
    let Some(chunk_id) = item.source_ref.get("chunkId").cloned() else {
        return source_damaged("work item carries no chunkId").into_handler_outcome();
    };
    let db = open_run_db(&run);
    if !chunk_exists(&db, &chunk_id) {
        db.close();
        return source_damaged(&format!("chunk {chunk_id} not found")).into_handler_outcome();
    }

    let detailed = read_chunk_summary_derivation(
        &db,
        &chunk_id,
        ChunkDeriveDerivationType::ChunkSummaryDetailed,
    );
    let brief =
        read_chunk_summary_derivation(&db, &chunk_id, ChunkDeriveDerivationType::ChunkSummaryBrief);
    if detailed
        .as_ref()
        .is_none_or(|row| row.state == DerivationState::Pending)
    {
        let source_version = detailed
            .as_ref()
            .map(|row| row.source_version)
            .or_else(|| brief.as_ref().map(|row| row.source_version));
        let Some(source_version) = source_version else {
            db.close();
            return source_damaged(&format!(
                "chunk {chunk_id} has no chunk_summary_detailed or chunk_summary_brief derivation row"
            ))
            .into_handler_outcome();
        };
        let state = detailed
            .as_ref()
            .map(|row| row.state.as_str())
            .unwrap_or("missing");
        let reason = format!(
            "chunk_summary_detailed_not_ready: chunk {chunk_id} chunk_summary_detailed is {state}"
        );
        let thread_id = run.thread_id.clone();
        let file_path = run.file_path.clone();
        let clock: Clock = Arc::clone(&run.clock);
        let chunk_id_deferred = chunk_id.clone();
        db.close();
        return HandlerOutcome::Deferred {
            reason,
            on_deferred: Box::new(move |transaction: CompletionTx<'_>| {
                let add = Arc::new(transaction.on_commit);
                let write_txn = |add: Arc<
                    Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>,
                >|
                 -> DbWriteTransaction<'_> {
                    DbWriteTransaction {
                        db: transaction.db,
                        thread_id: thread_id.clone(),
                        file_path: file_path.clone(),
                        clock: Arc::clone(&clock),
                        post_commit_hook: PostCommitHook {
                            add: Box::new({
                                let add = Arc::clone(&add);
                                move |op| add(op)
                            }),
                        },
                        poke: Arc::from(resolve_instance_poke()),
                    }
                };
                let detailed_ref = WorkSourceRef::Chunk {
                    chunk_id: chunk_id_deferred.clone(),
                };
                if !has_live_item(
                    transaction.db,
                    WorkKind::ChunkSummaryDetailed,
                    &detailed_ref,
                    source_version,
                ) {
                    enqueue(
                        &write_txn(Arc::clone(&add)),
                        EnqueueInput {
                            owner: WorkOwner::Turns,
                            kind: WorkKind::ChunkSummaryDetailed,
                            source_ref: detailed_ref,
                            source_version: Some(source_version),
                            derivations: vec![EnqueueDerivationTarget {
                                subject_kind: SubjectKind::Chunk,
                                subject_id: chunk_id_deferred.clone(),
                                derivation_type: "chunk_summary_detailed".into(),
                            }],
                            operation: None,
                        },
                    );
                }
                enqueue(
                    &write_txn(Arc::clone(&add)),
                    EnqueueInput {
                        owner: WorkOwner::Turns,
                        kind: WorkKind::ChunkSummaryBrief,
                        source_ref: WorkSourceRef::Chunk {
                            chunk_id: chunk_id_deferred.clone(),
                        },
                        source_version: Some(source_version),
                        derivations: vec![EnqueueDerivationTarget {
                            subject_kind: SubjectKind::Chunk,
                            subject_id: chunk_id_deferred,
                            derivation_type: "chunk_summary_brief".into(),
                        }],
                        operation: None,
                    },
                );
            }),
        };
    }
    let detailed = detailed.unwrap();
    if detailed.state == DerivationState::Blocked || detailed.state == DerivationState::Failed {
        let reason = detailed.reason.as_deref().unwrap_or("no reason");
        db.close();
        return source_damaged(&format!(
            "chunk {chunk_id} chunk_summary_detailed is {}: {reason}",
            detailed.state.as_str()
        ))
        .into_handler_outcome();
    }
    let Some(detailed_content) = detailed.content.clone() else {
        db.close();
        return dependency_not_ready(&format!(
            "chunk_summary_detailed_not_ready: chunk {chunk_id} has no detailed content"
        ))
        .into_handler_outcome();
    };

    let target_tokens = compression_target_tokens(
        estimate_tokens(&detailed_content),
        CompressionRatioTargets::Brief(&run.config.brief_targets),
    );
    let result = (run.inference_callbacks.summarize_chunk_brief)(SummarizeChunkBriefInput {
        text: detailed_content,
        input_tokens: target_tokens.input_tokens,
        target_min_tokens: target_tokens.target_min_tokens,
        target_aim_tokens: target_tokens.target_aim_tokens,
        target_max_tokens: target_tokens.target_max_tokens,
    })
    .await;

    match result {
        InferenceResult::Err {
            reason,
            request_messages,
        } => {
            let txn = DbReadTransaction {
                db: &db,
                thread_id: run.thread_id.clone(),
                file_path: run.file_path.clone(),
            };
            let mut payload = Map::new();
            payload.insert("reason".into(), json!(reason.clone()));
            if let Some(msgs) = request_messages {
                payload.insert(
                    "requestMessages".into(),
                    serde_json::to_value(msgs).unwrap_or(Value::Null),
                );
            }
            append_derivation_log(
                DbTransaction::Read(&txn),
                &DerivationLogEntry {
                    target: DerivationLogTarget {
                        subject_kind: SubjectKind::Chunk,
                        subject_id: chunk_id,
                        derivation_type: "chunk_summary_brief".into(),
                    },
                    event_kind: DerivationLogEventKind::InferenceFailed,
                    payload,
                },
            );
            db.close();
            inference_failed(&InferenceFailedReason { reason }).into_handler_outcome()
        }
        InferenceResult::Ok {
            text,
            provenance,
            request_messages,
            raw_response,
        } => {
            let txn = DbReadTransaction {
                db: &db,
                thread_id: run.thread_id.clone(),
                file_path: run.file_path.clone(),
            };
            let mut payload = Map::new();
            if let Some(provenance) = &provenance {
                payload.insert(
                    "provenance".into(),
                    serde_json::to_value(provenance).unwrap_or(Value::Null),
                );
            }
            if let Some(msgs) = &request_messages {
                payload.insert(
                    "requestMessages".into(),
                    serde_json::to_value(msgs).unwrap_or(Value::Null),
                );
            }
            if let Some(raw) = &raw_response {
                payload.insert("rawResponse".into(), json!(raw));
            }
            append_derivation_log(
                DbTransaction::Read(&txn),
                &DerivationLogEntry {
                    target: DerivationLogTarget {
                        subject_kind: SubjectKind::Chunk,
                        subject_id: chunk_id.clone(),
                        derivation_type: "chunk_summary_brief".into(),
                    },
                    event_kind: DerivationLogEventKind::InferenceSucceeded,
                    payload,
                },
            );
            let output_tokens = estimate_tokens(&text);
            let mut metadata = DerivationMetadata {
                outcome: None,
                last_error: None,
                discard_reason: None,
                fallback_floor: None,
                fallback_used: None,
                inference_attempted: Some(true),
                inference_succeeded: Some(true),
                size_disposition: Some(size_disposition(
                    output_tokens,
                    SizeDispositionBounds {
                        target_min_tokens: target_tokens.target_min_tokens,
                        target_max_tokens: target_tokens.target_max_tokens,
                    },
                )),
                provenance: None,
            };
            if let Some(provenance) = provenance {
                metadata.provenance = Some(provenance);
            }
            db.close();
            HandlerOutcome::Ok {
                derivations: Some(vec![HandlerDerivationWrite {
                    subject_kind: SubjectKind::Chunk,
                    subject_id: chunk_id,
                    derivation_type: "chunk_summary_brief".into(),
                    content: text,
                    metadata: Some(metadata),
                    gaps: None,
                }]),
                on_applied: None,
            }
        }
    }
}

/// TS `function chunkDetailedHandler(): WorkHandler` — sync zero-arg factory.
fn chunk_detailed_handler() -> WorkHandler {
    Arc::new(|run, item| {
        Box::pin(async move { chunk_detailed_handler_body(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
}

/// TS `function chunkBriefHandler(): WorkHandler` — sync zero-arg factory.
fn chunk_brief_handler() -> WorkHandler {
    Arc::new(|run, item| {
        Box::pin(async move { chunk_brief_handler_body(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
}

/// Private handler stub bound into [`TURN_WORK_HANDLERS`] for
/// `chunk_summary_detailed` (separate from the factory).
async fn chunk_summary_detailed_handler(
    run: HandlerRunContext,
    item: WorkItemRef,
) -> HandlerOutcome {
    chunk_detailed_handler_body(run, item).await
}

/// Private handler stub bound into [`TURN_WORK_HANDLERS`] for
/// `chunk_summary_brief` (separate from the factory).
async fn chunk_summary_brief_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome {
    chunk_brief_handler_body(run, item).await
}

static TURN_DERIVATION_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { turn_derivation_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

static DETAILED_TURN_COMPRESSION_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { detailed_turn_compression_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// Exact Arc identity for the chunk_summary_detailed map entry (private seam).
/// Table binds this stub — not [`chunk_detailed_handler`] as an async handler.
static CHUNK_SUMMARY_DETAILED_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { chunk_summary_detailed_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// Exact Arc identity for the chunk_summary_brief map entry (private seam).
/// Table binds this stub — not [`chunk_brief_handler`] as an async handler.
static CHUNK_SUMMARY_BRIEF_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { chunk_summary_brief_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// TS `turnWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>>`.
/// Partial/open Record → [`IndexMap`]. Map skeleton REAL; handler bodies todo.
pub static TURN_WORK_HANDLERS: LazyLock<WorkHandlerMap> = LazyLock::new(|| {
    let mut map: WorkHandlerMap = IndexMap::new();
    map.insert(
        WorkKind::TurnDerivation,
        Arc::clone(&TURN_DERIVATION_WORK_HANDLER),
    );
    map.insert(
        WorkKind::DetailedTurnCompression,
        Arc::clone(&DETAILED_TURN_COMPRESSION_WORK_HANDLER),
    );
    // Factories exist as separate sync stubs; table binds handler seams
    // (not the factories themselves as async handlers).
    map.insert(
        WorkKind::ChunkSummaryDetailed,
        Arc::clone(&CHUNK_SUMMARY_DETAILED_WORK_HANDLER),
    );
    map.insert(
        WorkKind::ChunkSummaryBrief,
        Arc::clone(&CHUNK_SUMMARY_BRIEF_WORK_HANDLER),
    );
    map
});

/// TS `deferClaimedTurnWork` item: `{ workItemId: string }`.
struct DeferClaimedItem {
    work_item_id: String,
}

/// TS deferred txn narrow shape: `{ db, onCommit }`.
/// `on_commit` is `'static` (same as [`CompletionTx`] / post-commit hook add).
struct DeferTransaction<'a> {
    db: &'a Db,
    on_commit: Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>,
}

fn defer_claimed_turn_work(
    db: &Db,
    item: &DeferClaimedItem,
    on_deferred: Box<dyn for<'a> FnOnce(DeferTransaction<'a>) + Send>,
) -> bool {
    let PostCommitHookSet { add, flush } = create_post_commit_hook_set();
    db.exec(SQL_BEGIN_IMMEDIATE);
    let result = catch_unwind(AssertUnwindSafe(move || {
        let owned = db
            .prepare(SQL_SELECT_CLAIMED_WORK_ITEM)
            .get_params(&[SqlParam::from(item.work_item_id.as_str())]);
        if owned.is_none() {
            db.exec(SQL_COMMIT);
            return false;
        }
        db.prepare(SQL_DELETE_CLAIMED_WORK_ITEM)
            .run(&[SqlParam::from(item.work_item_id.as_str())]);
        on_deferred(DeferTransaction { db, on_commit: add });
        db.exec(SQL_COMMIT);
        flush();
        true
    }));
    match result {
        Ok(value) => value,
        Err(cause) => {
            // TS catch: `db.exec("ROLLBACK;"); throw cause;` — ROLLBACK errors
            // are not swallowed; after COMMIT, ROLLBACK fails and replaces the
            // original (e.g. post-commit flush) exception.
            db.exec(SQL_ROLLBACK);
            resume_unwind(cause);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DerivationRowForVersion {
    state: String,
    source_version: i64,
}

fn source_version_for_derive(rows: &[DerivationRowForVersion]) -> i64 {
    let max = rows.iter().map(|row| row.source_version).max().unwrap_or(0);
    if rows.iter().any(|row| row.state == "pending") {
        max
    } else {
        max + 1
    }
}

/// Internal result of `deriveTurnOwnedInOpenDb` (no turnId/chunkId — caller stamps).
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOwnedDeriveResult {
    Derived { source_version: i64 },
    Failed { error: ErrorResult },
}

fn failed(error: ErrorResult) -> TurnOwnedDeriveResult {
    TurnOwnedDeriveResult::Failed { error }
}

fn source_ref_id(source_ref: &WorkSourceRef) -> String {
    match source_ref {
        WorkSourceRef::Turn { turn_id } => turn_id.clone(),
        WorkSourceRef::Chunk { chunk_id } => chunk_id.clone(),
        WorkSourceRef::Message { message_id } => message_id.clone(),
    }
}

fn work_in_flight(
    kind: WorkKind,
    source_ref: &WorkSourceRef,
    source_version: i64,
) -> TurnOwnedDeriveResult {
    let source_id = source_ref_id(source_ref);
    failed(ErrorResult {
        error_class: ErrorClass::CallerError,
        code: ErrorCode::DerivationWorkInFlight,
        reason: format!(
            "{} work for {source_id} at sourceVersion {source_version} is already live",
            kind.as_str()
        ),
        event_index: None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeriveTurnOwnedOpts {
    pub source_version: Option<i64>,
}

pub async fn derive_turn_owned_in_open_db(
    db: &Db,
    config: &ResolvedSdkConfig,
    kind: WorkKind,
    source_ref: &WorkSourceRef,
    derivations: &[EnqueueDerivationTarget],
    opts: Option<&DeriveTurnOwnedOpts>,
) -> TurnOwnedDeriveResult {
    let rows: Vec<_> = derivations
        .iter()
        .map(|target| {
            read_turn_derivation_row(
                db,
                as_turn_owned_subject(target.subject_kind),
                &target.subject_id,
                &target.derivation_type,
            )
        })
        .collect();
    if let Some(index) = rows.iter().position(|row| row.is_none()) {
        let target = &derivations[index];
        return failed(ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::TurnNotFound,
            reason: format!(
                "no derived derivation {} exists for {} {}",
                target.derivation_type,
                target.subject_kind.as_str(),
                target.subject_id
            ),
            event_index: None,
        });
    }
    if let Some(blocked) = rows
        .iter()
        .flatten()
        .find(|row| row.state == DerivationState::Blocked)
    {
        return failed(ErrorResult {
            error_class: ErrorClass::StateCorruption,
            code: ErrorCode::SourceDamaged,
            reason: blocked
                .reason
                .clone()
                .unwrap_or_else(|| "turn-owned derivation is blocked".into()),
            event_index: None,
        });
    }
    let checked_rows: Vec<_> = rows.into_iter().map(|row| row.unwrap()).collect();
    let source_version = opts.and_then(|o| o.source_version).unwrap_or_else(|| {
        source_version_for_derive(
            &checked_rows
                .iter()
                .map(|row| DerivationRowForVersion {
                    state: row.state.as_str().to_string(),
                    source_version: row.source_version,
                })
                .collect::<Vec<_>>(),
        )
    });
    let expected_derivations: Vec<ImmediateDerivationBoundary> = derivations
        .iter()
        .zip(checked_rows.iter())
        .map(|(target, row)| ImmediateDerivationBoundary::Present {
            subject_kind: target.subject_kind,
            subject_id: target.subject_id.clone(),
            derivation_type: target.derivation_type.clone(),
            state: row.state.as_str().to_string(),
            source_version: row.source_version,
        })
        .collect();
    let Some(handler) = TURN_WORK_HANDLERS.get(&kind).cloned() else {
        return failed(ErrorResult {
            error_class: ErrorClass::StateCorruption,
            code: ErrorCode::UnknownWorkKind,
            reason: format!("no handler registered for work kind \"{}\"", kind.as_str()),
            event_index: None,
        });
    };
    let claim = create_or_claim_immediate_work_item(
        db,
        ImmediateClaimInput {
            owner: WorkOwner::Turns,
            kind,
            source_ref: source_ref.clone(),
            derivations: derivations.to_vec(),
            expected_derivations,
            operation: None,
            source_version: Some(source_version),
        },
        ClaimTiming {
            now: system_time_to_iso((config.clock)()),
            lease_duration_ms: config.lease.duration_ms,
        },
    );
    let claim_item = match claim {
        ImmediateClaimOutcome::Claimed { item } => item,
        ImmediateClaimOutcome::Expired { item } => {
            apply_derivation_terminal_failure(
                db,
                &DerivationAttempt {
                    source_version,
                    derivations: derivations.to_vec(),
                    work_item_id: Some(item.work_item_id),
                },
                &DerivationTerminalFailure {
                    reason: "claim_expired".into(),
                    state: DerivationTerminalState::Failed,
                    now: system_time_to_iso((config.clock)()),
                },
            );
            poke_thread_scheduler(db);
            return failed(ErrorResult {
                error_class: ErrorClass::SystemError,
                code: ErrorCode::ProviderFailure,
                reason: "claim_expired".into(),
                event_index: None,
            });
        }
        ImmediateClaimOutcome::Queued { .. } => {
            poke_thread_scheduler(db);
            return work_in_flight(kind, source_ref, source_version);
        }
        ImmediateClaimOutcome::InFlight { .. } => {
            return work_in_flight(kind, source_ref, source_version);
        }
    };

    let outcome = run_work_handler(
        db,
        config,
        handler,
        RunWorkHandlerItem {
            work_item_id: claim_item.work_item_id.clone(),
            kind: kind.as_str().to_string(),
            source_ref: source_ref.clone(),
        },
        None,
    )
    .await;
    let attempt = DerivationAttempt {
        source_version,
        derivations: derivations.to_vec(),
        work_item_id: Some(claim_item.work_item_id.clone()),
    };
    match outcome {
        HandlerOutcome::Ok {
            derivations: writes,
            on_applied,
        } => {
            let derived_at = system_time_to_iso((config.clock)());
            let writes = writes.unwrap_or_default();
            let disposition = match catch_completion_error(catch_unwind(AssertUnwindSafe(|| {
                apply_derivation_success(db, &attempt, &writes, &derived_at, on_applied)
            }))) {
                Ok(disposition) => disposition,
                Err(error) => return failed(error),
            };
            if disposition != ApplyDerivationSuccessDisposition::Done {
                return work_in_flight(kind, source_ref, source_version);
            }
            TurnOwnedDeriveResult::Derived { source_version }
        }
        HandlerOutcome::Deferred { on_deferred, .. } => {
            let deferred = defer_claimed_turn_work(
                db,
                &DeferClaimedItem {
                    work_item_id: claim_item.work_item_id,
                },
                Box::new(move |tx| {
                    on_deferred(CompletionTx {
                        db: tx.db,
                        on_commit: tx.on_commit,
                    });
                }),
            );
            if !deferred {
                return work_in_flight(kind, source_ref, source_version);
            }
            poke_thread_scheduler(db);
            work_in_flight(kind, source_ref, source_version)
        }
        HandlerOutcome::Blocked { reason } => {
            let now = system_time_to_iso((config.clock)());
            let disposition = match catch_completion_error(catch_unwind(AssertUnwindSafe(|| {
                apply_derivation_terminal_failure(
                    db,
                    &attempt,
                    &DerivationTerminalFailure {
                        reason: reason.clone(),
                        state: DerivationTerminalState::Blocked,
                        now,
                    },
                )
            }))) {
                Ok(disposition) => disposition,
                Err(error) => return failed(error),
            };
            if disposition == ApplyDerivationTerminalDisposition::LostLease {
                return work_in_flight(kind, source_ref, source_version);
            }
            failed(ErrorResult {
                error_class: ErrorClass::SystemError,
                code: ErrorCode::ProviderFailure,
                reason,
                event_index: None,
            })
        }
        HandlerOutcome::Failed { reason } => {
            let now = system_time_to_iso((config.clock)());
            let disposition = match catch_completion_error(catch_unwind(AssertUnwindSafe(|| {
                apply_derivation_terminal_failure(
                    db,
                    &attempt,
                    &DerivationTerminalFailure {
                        reason: reason.clone(),
                        state: DerivationTerminalState::Failed,
                        now,
                    },
                )
            }))) {
                Ok(disposition) => disposition,
                Err(error) => return failed(error),
            };
            if disposition == ApplyDerivationTerminalDisposition::LostLease {
                return work_in_flight(kind, source_ref, source_version);
            }
            failed(ErrorResult {
                error_class: ErrorClass::SystemError,
                code: ErrorCode::ProviderFailure,
                reason,
                event_index: None,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchTurnOwnedWorkItem {
    pub work_item_id: String,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub source_version: i64,
    pub derivations: Vec<EnqueueDerivationTarget>,
}

pub async fn dispatch_turn_owned_work(
    run: &HandlerRunContext,
    item: &DispatchTurnOwnedWorkItem,
) -> DurableWorkDispatchResult {
    let db = open_run_db(run);
    let Some(handler) = TURN_WORK_HANDLERS.get(&item.kind).cloned() else {
        db.close();
        return DurableWorkDispatchResult::Failed {
            reason: "unknown_work_kind".into(),
        };
    };
    let outcome = run_work_handler(
        &db,
        &run.config,
        handler,
        RunWorkHandlerItem {
            work_item_id: item.work_item_id.clone(),
            kind: item.kind.as_str().to_string(),
            source_ref: item.source_ref.clone(),
        },
        Some(HandlerRunIdentity {
            thread_id: run.thread_id.clone(),
            file_path: run.file_path.clone(),
        }),
    )
    .await;
    match outcome {
        HandlerOutcome::Ok {
            derivations,
            on_applied,
        } => {
            let derived_at = system_time_to_iso((run.config.clock)());
            let disposition = apply_derivation_success(
                &db,
                &DerivationAttempt {
                    source_version: item.source_version,
                    derivations: item.derivations.clone(),
                    work_item_id: Some(item.work_item_id.clone()),
                },
                &derivations.unwrap_or_default(),
                &derived_at,
                on_applied,
            );
            db.close();
            let disposition = match disposition {
                ApplyDerivationSuccessDisposition::Done => DurableWorkSettledDisposition::Done,
                ApplyDerivationSuccessDisposition::StaleDiscarded => {
                    DurableWorkSettledDisposition::StaleDiscarded
                }
                ApplyDerivationSuccessDisposition::LostLease => {
                    DurableWorkSettledDisposition::LostLease
                }
            };
            DurableWorkDispatchResult::Settled { disposition }
        }
        HandlerOutcome::Deferred { on_deferred, .. } => {
            let deferred = defer_claimed_turn_work(
                &db,
                &DeferClaimedItem {
                    work_item_id: item.work_item_id.clone(),
                },
                Box::new(move |tx| {
                    on_deferred(CompletionTx {
                        db: tx.db,
                        on_commit: tx.on_commit,
                    });
                }),
            );
            db.close();
            DurableWorkDispatchResult::Settled {
                disposition: if deferred {
                    DurableWorkSettledDisposition::Done
                } else {
                    DurableWorkSettledDisposition::LostLease
                },
            }
        }
        HandlerOutcome::Blocked { reason } => {
            db.close();
            DurableWorkDispatchResult::Blocked { reason }
        }
        HandlerOutcome::Failed { reason } => {
            db.close();
            DurableWorkDispatchResult::Failed { reason }
        }
    }
}

// Keep REAL exhaustive label table + factory/handler seams referenced.
const _: fn() -> WorkHandler = chunk_detailed_handler;
const _: fn() -> WorkHandler = chunk_brief_handler;
const _: fn(LogFallbackReason) -> &'static str = LogFallbackReason::as_str;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::shared_tech::derivation::{
        DependencyGap, Derivation, DerivationReportEntry, DerivationReportQueue,
        ProviderProvenance, QueueStatus, ToolOutcome, derivation_metadata_to_ordered_value,
    };
    use crate::shared_tech::js_json::js_json_stringify;

    fn parse_size_disposition(raw: &str) -> SizeDisposition {
        match raw {
            "in_range" => SizeDisposition::InRange,
            "under_min" => SizeDisposition::UnderMin,
            "over_max" => SizeDisposition::OverMax,
            other => panic!("unknown sizeDisposition {other}"),
        }
    }

    fn parse_tool_outcome(raw: &str) -> ToolOutcome {
        match raw {
            "succeeded" => ToolOutcome::Succeeded,
            "failed" => ToolOutcome::Failed,
            "unknown" => ToolOutcome::Unknown,
            other => panic!("unknown outcome {other}"),
        }
    }

    fn parse_provenance(value: &Value) -> ProviderProvenance {
        let obj = value.as_object().expect("provenance object");
        ProviderProvenance {
            provider: obj
                .get("provider")
                .and_then(Value::as_str)
                .expect("provider")
                .to_string(),
            model: obj
                .get("model")
                .and_then(Value::as_str)
                .expect("model")
                .to_string(),
            prompt: obj
                .get("prompt")
                .and_then(Value::as_str)
                .expect("prompt")
                .to_string(),
        }
    }

    fn metadata_from_fixture_input(input: &Value) -> DerivationMetadata {
        let obj = input.as_object().expect("metadata input object");
        DerivationMetadata {
            outcome: obj
                .get("outcome")
                .and_then(Value::as_str)
                .map(parse_tool_outcome),
            last_error: obj
                .get("lastError")
                .and_then(Value::as_str)
                .map(str::to_string),
            discard_reason: obj
                .get("discardReason")
                .and_then(Value::as_str)
                .map(str::to_string),
            fallback_floor: obj
                .get("fallbackFloor")
                .and_then(Value::as_str)
                .map(str::to_string),
            fallback_used: obj.get("fallbackUsed").and_then(Value::as_bool),
            inference_attempted: obj.get("inferenceAttempted").and_then(Value::as_bool),
            inference_succeeded: obj.get("inferenceSucceeded").and_then(Value::as_bool),
            size_disposition: obj
                .get("sizeDisposition")
                .and_then(Value::as_str)
                .map(parse_size_disposition),
            provenance: obj.get("provenance").map(parse_provenance),
        }
    }

    fn gaps_from_fixture(value: &Value) -> Vec<DependencyGap> {
        value
            .as_array()
            .expect("gaps array")
            .iter()
            .map(|g| {
                let obj = g.as_object().expect("gap object");
                DependencyGap {
                    subject_kind: match obj.get("subjectKind").and_then(Value::as_str) {
                        Some("message") => SubjectKind::Message,
                        Some("turn") => SubjectKind::Turn,
                        Some("chunk") => SubjectKind::Chunk,
                        other => panic!("unknown subjectKind {other:?}"),
                    },
                    subject_id: obj
                        .get("subjectId")
                        .and_then(Value::as_str)
                        .expect("subjectId")
                        .to_string(),
                    derivation_type: obj
                        .get("derivationType")
                        .and_then(Value::as_str)
                        .expect("derivationType")
                        .to_string(),
                }
            })
            .collect()
    }

    fn derivation_from_fixture_input(input: &Value) -> Derivation {
        let obj = input.as_object().expect("derivation input");
        let state = match obj.get("state").and_then(Value::as_str) {
            Some("pending") => DerivationState::Pending,
            Some("ready") => DerivationState::Ready,
            Some("failed") => DerivationState::Failed,
            Some("blocked") => DerivationState::Blocked,
            other => panic!("unknown state {other:?}"),
        };
        Derivation {
            subject_kind: SubjectKind::Turn,
            subject_id: "t1".to_string(),
            derivation_type: "detailed_turn_compression".to_string(),
            state,
            content: obj
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string),
            reason: obj
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            source_version: 1,
            metadata: obj.get("metadata").map(metadata_from_fixture_input),
            gaps: obj.get("gaps").map(gaps_from_fixture),
            derived_at: obj
                .get("derivedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }

    fn report_from_fixture_input(input: &Value) -> DerivationReportEntry {
        let obj = input.as_object().expect("report input");
        let state = match obj.get("state").and_then(Value::as_str) {
            Some("pending") => DerivationState::Pending,
            Some("ready") => DerivationState::Ready,
            Some("failed") => DerivationState::Failed,
            Some("blocked") => DerivationState::Blocked,
            other => panic!("unknown state {other:?}"),
        };
        DerivationReportEntry {
            subject_kind: SubjectKind::Turn,
            subject_id: "t1".to_string(),
            derivation_type: "detailed_turn_compression".to_string(),
            state,
            content: obj
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string),
            reason: obj
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            source_version: 2,
            metadata: obj.get("metadata").map(metadata_from_fixture_input),
            gaps: obj.get("gaps").map(gaps_from_fixture),
            derived_at: obj
                .get("derivedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            queue: obj.get("queue").map(|q| {
                let status = q
                    .get("status")
                    .and_then(Value::as_str)
                    .expect("queue.status");
                DerivationReportQueue {
                    status: match status {
                        "queued" => QueueStatus::Queued,
                        "claimed" => QueueStatus::Claimed,
                        other => panic!("unknown queue status {other}"),
                    },
                }
            }),
        }
    }

    #[test]
    fn turn_work_handlers_kinds_and_insertion_order() {
        let keys: Vec<_> = TURN_WORK_HANDLERS.keys().copied().collect();
        assert_eq!(
            keys,
            vec![
                WorkKind::TurnDerivation,
                WorkKind::DetailedTurnCompression,
                WorkKind::ChunkSummaryDetailed,
                WorkKind::ChunkSummaryBrief,
            ]
        );
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS.get(&WorkKind::TurnDerivation).unwrap(),
            &TURN_DERIVATION_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS
                .get(&WorkKind::DetailedTurnCompression)
                .unwrap(),
            &DETAILED_TURN_COMPRESSION_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS
                .get(&WorkKind::ChunkSummaryDetailed)
                .unwrap(),
            &CHUNK_SUMMARY_DETAILED_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS
                .get(&WorkKind::ChunkSummaryBrief)
                .unwrap(),
            &CHUNK_SUMMARY_BRIEF_WORK_HANDLER
        ));

        // Amendment G — Node oracle for producer-ordered metadata + Derivation /
        // report wire order. Invokes the production ordering helper (and the
        // custom Serialize paths that reuse it). Inventory unchanged: same test.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/derivation-json-order-cases.jsonl"
        );
        let body = std::fs::read_to_string(path).expect("read derivation-json-order-cases.jsonl");
        let mut checked = 0usize;
        for line in body.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let row: Value = serde_json::from_str(line).expect("fixture jsonl row");
            let name = row.get("name").and_then(Value::as_str).expect("name");
            let kind = row.get("kind").and_then(Value::as_str).expect("kind");
            let expected = match row.get("expected") {
                Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                other => panic!("{name}: expected string|null, got {other:?}"),
            };
            match kind {
                "metadata_absent" => {
                    assert!(expected.is_none(), "{name}: absent metadata has no bytes");
                    checked += 1;
                }
                "metadata" => {
                    let derivation_type = row
                        .get("derivationType")
                        .and_then(Value::as_str)
                        .expect("derivationType");
                    let input = row.get("input").expect("input");
                    let metadata = metadata_from_fixture_input(input);
                    let got = js_json_stringify(&derivation_metadata_to_ordered_value(
                        derivation_type,
                        &metadata,
                    ));
                    assert_eq!(
                        got,
                        expected.expect("metadata expected bytes"),
                        "{name}: metadata producer order"
                    );
                    checked += 1;
                }
                "derivation" => {
                    let input = row.get("input").expect("input");
                    let derivation = derivation_from_fixture_input(input);
                    let value = serde_json::to_value(&derivation).expect("derivation to_value");
                    let got = js_json_stringify(&value);
                    assert_eq!(
                        got,
                        expected.expect("derivation expected bytes"),
                        "{name}: Derivation wire order"
                    );
                    checked += 1;
                }
                "report_entry" => {
                    let input = row.get("input").expect("input");
                    let entry = report_from_fixture_input(input);
                    let value = serde_json::to_value(&entry).expect("report to_value");
                    let got = js_json_stringify(&value);
                    assert_eq!(
                        got,
                        expected.expect("report expected bytes"),
                        "{name}: DerivationReportEntry wire order"
                    );
                    checked += 1;
                }
                other => panic!("unknown fixture kind {other}"),
            }
        }
        assert_eq!(checked, 19, "Amendment G fixture case count");
    }
}

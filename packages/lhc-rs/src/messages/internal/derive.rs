//! Ported from packages/lhc/src/messages/internal/derive.ts.
//!
//! Bounded inline message derivation (not queue drain) + durable-work dispatch.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::intake_stream::EventKind;
use crate::messages::MessageKind;
use crate::shared_tech::derivation::{
    CompletionTx, DerivationState, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext,
    SubjectKind, derivation_metadata_to_ordered_value,
};
use crate::shared_tech::durable_work::{
    DerivationAttempt, DurableWorkDispatchResult, DurableWorkSettledDisposition,
    HandlerRunIdentity, RunWorkHandlerItem, apply_derivation_success, run_work_handler,
};
use crate::shared_tech::errors::{ErrorClass, ErrorCode, ErrorResult, OpResult};
use crate::shared_tech::js_json::{js_json_stringify, js_json_stringify_of};
use crate::shared_tech::persist::create_post_commit_hook_set;
use crate::shared_tech::storage::SqlParam;
use crate::shared_tech::work_queue::{
    EnqueueDerivationTarget, WorkKind, WorkSourceRef, has_live_item,
};

use super::derivations::{MessageDerivationRowView, read_message_derivation_row};
use super::handlers::MESSAGE_WORK_HANDLERS;
use super::store::read_message_by_id;
use super::work::{MESSAGE_WORK_DERIVATIONS, MESSAGE_WORK_KINDS};

pub use super::work::MessageDeriveDerivationType;

const SQL_INSERT_DERIVATION_READY: &str = r#"INSERT OR IGNORE INTO derivation
             (subject_kind, subject_id, derivation_type, state, content, metadata, gaps, source_version, derived_at)
           VALUES ('message', ?, ?, 'ready', ?, ?, ?, ?, ?)"#;

const SQL_UPDATE_DERIVATION_READY: &str = r#"UPDATE derivation
           SET state = 'ready', content = ?, reason = NULL, metadata = ?,
               gaps = ?, derived_at = ?, source_version = ?
           WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?
             AND state = ? AND source_version = ?"#;

const SQL_BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE;";
const SQL_COMMIT: &str = "COMMIT;";
const SQL_ROLLBACK: &str = "ROLLBACK;";

/// TS `MessageDeriveResult` — public discriminated data union tagged by `outcome`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum MessageDeriveResult {
    #[serde(rename_all = "camelCase")]
    Derived {
        message_id: String,
        derivation_type: MessageDeriveDerivationType,
        source_version: i64,
    },
    #[serde(rename_all = "camelCase")]
    NotDerivable { message_id: String },
    #[serde(rename_all = "camelCase")]
    Failed {
        message_id: String,
        error: ErrorResult,
    },
}

impl Serialize for MessageDeriveResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            MessageDeriveResult::Derived {
                message_id,
                derivation_type,
                source_version,
            } => {
                let mut state = serializer.serialize_struct("MessageDeriveResult", 4)?;
                state.serialize_field("messageId", message_id)?;
                state.serialize_field("outcome", "derived")?;
                state.serialize_field("derivationType", derivation_type)?;
                state.serialize_field("sourceVersion", source_version)?;
                state.end()
            }
            MessageDeriveResult::NotDerivable { message_id } => {
                let mut state = serializer.serialize_struct("MessageDeriveResult", 2)?;
                state.serialize_field("messageId", message_id)?;
                state.serialize_field("outcome", "not_derivable")?;
                state.end()
            }
            MessageDeriveResult::Failed { message_id, error } => {
                let mut state = serializer.serialize_struct("MessageDeriveResult", 3)?;
                state.serialize_field("messageId", message_id)?;
                state.serialize_field("outcome", "failed")?;
                state.serialize_field("error", error)?;
                state.end()
            }
        }
    }
}

fn failed_derive(message_id: &str, error: ErrorResult) -> MessageDeriveResult {
    MessageDeriveResult::Failed {
        message_id: message_id.to_string(),
        error,
    }
}

struct DerivationForKind {
    work_kind: WorkKind,
    derivation_type: MessageDeriveDerivationType,
}

fn event_kind_for_message(kind: MessageKind) -> EventKind {
    match kind {
        MessageKind::UserPrompt => EventKind::UserPrompt,
        MessageKind::AssistantText => EventKind::AssistantText,
        MessageKind::AssistantThinking => EventKind::AssistantThinking,
        MessageKind::RuntimeNote => EventKind::RuntimeNote,
        MessageKind::ModelChange => EventKind::ModelChange,
        MessageKind::ThinkingLevelChange => EventKind::ThinkingLevelChange,
        MessageKind::ToolCall => EventKind::ToolCall,
        MessageKind::ToolResult => EventKind::ToolResult,
        MessageKind::CompactContinuationMarker => EventKind::CompactContinuationMarker,
    }
}

fn derivation_for_kind(kind: MessageKind) -> Option<DerivationForKind> {
    let work_kind = *MESSAGE_WORK_KINDS.get(&event_kind_for_message(kind))?;
    let Some(&derivation_type) = MESSAGE_WORK_DERIVATIONS.get(&work_kind) else {
        panic!(
            "no derived derivation mapped for message work kind {}",
            work_kind.as_str()
        );
    };
    Some(DerivationForKind {
        work_kind,
        derivation_type,
    })
}

fn source_version_for_derive(row: Option<&MessageDerivationRowView>) -> i64 {
    match row {
        None => 1,
        Some(row) if row.state == DerivationState::Pending => row.source_version,
        Some(row) => row.source_version + 1,
    }
}

fn provider_failure(message_id: &str, reason: &str) -> MessageDeriveResult {
    failed_derive(
        message_id,
        ErrorResult {
            error_class: ErrorClass::SystemError,
            code: ErrorCode::ProviderFailure,
            reason: reason.to_string(),
            event_index: None,
        },
    )
}

fn work_in_flight(
    message_id: &str,
    work_kind: WorkKind,
    source_version: i64,
) -> MessageDeriveResult {
    failed_derive(
        message_id,
        ErrorResult {
            error_class: ErrorClass::CallerError,
            code: ErrorCode::DerivationWorkInFlight,
            reason: format!(
                "{} work for message {message_id} at sourceVersion {source_version} is already live",
                work_kind.as_str()
            ),
            event_index: None,
        },
    )
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

struct ApplyRecoveredMessageWriteResult {
    applied: bool,
    live_work: bool,
}

struct ExpectedDerivationRow {
    state: String,
    source_version: i64,
}

fn expected_from_row(row: Option<&MessageDerivationRowView>) -> Option<ExpectedDerivationRow> {
    row.map(|row| ExpectedDerivationRow {
        state: row.state.as_str().to_string(),
        source_version: row.source_version,
    })
}

fn apply_recovered_message_write(
    run: &HandlerRunContext,
    work_kind: WorkKind,
    message_id: &str,
    expected: Option<&ExpectedDerivationRow>,
    source_version: i64,
    write: &HandlerDerivationWrite,
    on_applied: Option<Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>>,
) -> ApplyRecoveredMessageWriteResult {
    let db = match (run.open_db)() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let post_commit_hook = create_post_commit_hook_set();
    db.exec(SQL_BEGIN_IMMEDIATE);
    let result = catch_unwind(AssertUnwindSafe(|| {
        let source_ref = WorkSourceRef::Message {
            message_id: message_id.to_string(),
        };
        if has_live_item(&db, work_kind, &source_ref, source_version) {
            db.exec(SQL_COMMIT);
            return ApplyRecoveredMessageWriteResult {
                applied: false,
                live_work: true,
            };
        }

        let metadata = write.metadata.as_ref().map(|m| {
            js_json_stringify(&derivation_metadata_to_ordered_value(
                write.derivation_type.as_str(),
                m,
            ))
        });
        let gaps = write
            .gaps
            .as_ref()
            .map(|g| js_json_stringify_of(g).expect("gaps js_json"));
        let derived_at = system_time_to_iso((run.clock)());
        let mut applied = false;
        let mut wrote = false;
        if expected.is_none() {
            let inserted = db.prepare(SQL_INSERT_DERIVATION_READY).run(&[
                SqlParam::from(message_id),
                SqlParam::from(write.derivation_type.as_str()),
                SqlParam::from(write.content.as_str()),
                SqlParam::from(metadata.as_deref()),
                SqlParam::from(gaps.as_deref()),
                SqlParam::from(source_version),
                SqlParam::from(derived_at.as_str()),
            ]);
            // Approved hit/miss: consume `.changes` directly (derive.ts:93).
            applied = inserted.changes > 0;
            wrote = applied;
        } else if let Some(expected) = expected {
            if expected.state != "pending" && expected.state != "failed" {
                applied = expected.state == "ready" && expected.source_version == source_version;
            } else {
                let changed = db.prepare(SQL_UPDATE_DERIVATION_READY).run(&[
                    SqlParam::from(write.content.as_str()),
                    SqlParam::from(metadata.as_deref()),
                    SqlParam::from(gaps.as_deref()),
                    SqlParam::from(derived_at.as_str()),
                    SqlParam::from(source_version),
                    SqlParam::from(message_id),
                    SqlParam::from(write.derivation_type.as_str()),
                    SqlParam::from(expected.state.as_str()),
                    SqlParam::from(expected.source_version),
                ]);
                // Approved hit/miss: consume `.changes` directly (derive.ts:117).
                applied = changed.changes > 0;
                wrote = applied;
            }
        }
        if !applied {
            let current = read_message_derivation_row(&db, message_id, &write.derivation_type);
            applied = current.as_ref().is_some_and(|c| {
                c.state == DerivationState::Ready && c.source_version == source_version
            });
        }
        let crate::shared_tech::persist::PostCommitHookSet { add, flush } = post_commit_hook;
        if wrote {
            if let Some(on_applied) = on_applied {
                on_applied(CompletionTx {
                    db: &db,
                    on_commit: add,
                });
            }
        }
        db.exec(SQL_COMMIT);
        if wrote {
            flush();
        }
        ApplyRecoveredMessageWriteResult {
            applied,
            live_work: false,
        }
    }));
    match result {
        Ok(value) => {
            db.close();
            value
        }
        Err(cause) => {
            let _ = catch_unwind(AssertUnwindSafe(|| db.exec(SQL_ROLLBACK)));
            db.close();
            std::panic::resume_unwind(cause);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeriveMessageInThreadOpts {
    pub source_version: Option<i64>,
}

pub async fn derive_message_in_thread(
    run: &HandlerRunContext,
    message_id: &str,
    opts: Option<&DeriveMessageInThreadOpts>,
) -> MessageDeriveResult {
    // TS `openDb()` throws on infrastructure failure → outer `derive failed: …`.
    let db = match (run.open_db)() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let record = read_message_by_id(&db, message_id);
    if record.as_ref().is_none_or(|r| r.deleted) {
        db.close();
        return failed_derive(
            message_id,
            ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::MessageNotFound,
                reason: format!("no message {message_id} exists in this thread"),
                event_index: None,
            },
        );
    }
    let record = record.unwrap();
    let Some(mapped) = derivation_for_kind(record.kind) else {
        db.close();
        return MessageDeriveResult::NotDerivable {
            message_id: message_id.to_string(),
        };
    };
    let row = read_message_derivation_row(&db, message_id, mapped.derivation_type.as_str());
    if row
        .as_ref()
        .is_some_and(|r| r.state == DerivationState::Blocked)
    {
        let reason = row
            .as_ref()
            .and_then(|r| r.reason.clone())
            .unwrap_or_else(|| {
                format!(
                    "derivation {} for message {message_id} is blocked",
                    mapped.derivation_type.as_str()
                )
            });
        db.close();
        return failed_derive(
            message_id,
            ErrorResult {
                error_class: ErrorClass::StateCorruption,
                code: ErrorCode::SourceDamaged,
                reason,
                event_index: None,
            },
        );
    }
    let source_version = opts
        .and_then(|o| o.source_version)
        .unwrap_or_else(|| source_version_for_derive(row.as_ref()));
    let source_ref = WorkSourceRef::Message {
        message_id: message_id.to_string(),
    };
    if has_live_item(&db, mapped.work_kind, &source_ref, source_version) {
        db.close();
        return work_in_flight(message_id, mapped.work_kind, source_version);
    }
    let Some(handler) = MESSAGE_WORK_HANDLERS.get(&mapped.work_kind).cloned() else {
        db.close();
        return failed_derive(
            message_id,
            ErrorResult {
                error_class: ErrorClass::StateCorruption,
                code: ErrorCode::UnknownWorkKind,
                reason: format!(
                    "no handler registered for work kind \"{}\"",
                    mapped.work_kind.as_str()
                ),
                event_index: None,
            },
        );
    };
    let outcome = run_work_handler(
        &db,
        &run.config,
        handler,
        RunWorkHandlerItem {
            work_item_id: format!("inline-{message_id}-{}", mapped.work_kind.as_str()),
            kind: mapped.work_kind.as_str().to_string(),
            source_ref: source_ref.clone(),
        },
        Some(HandlerRunIdentity {
            thread_id: run.thread_id.clone(),
            file_path: run.file_path.clone(),
        }),
    )
    .await;
    let expected = expected_from_row(row.as_ref());
    match outcome {
        HandlerOutcome::Deferred { .. } => {
            db.close();
            failed_derive(
                message_id,
                ErrorResult {
                    error_class: ErrorClass::StateCorruption,
                    code: ErrorCode::UnknownWorkKind,
                    reason: "message derivation handler returned unsupported deferred outcome"
                        .into(),
                    event_index: None,
                },
            )
        }
        HandlerOutcome::Blocked { reason } => {
            db.close();
            failed_derive(
                message_id,
                ErrorResult {
                    error_class: ErrorClass::StateCorruption,
                    code: ErrorCode::SourceDamaged,
                    reason,
                    event_index: None,
                },
            )
        }
        HandlerOutcome::Failed { reason } => {
            db.close();
            provider_failure(message_id, &reason)
        }
        HandlerOutcome::Ok {
            derivations,
            on_applied,
        } => {
            let Some(write) = derivations.and_then(|mut d| d.drain(..).next()) else {
                db.close();
                return provider_failure(
                    message_id,
                    "message handler returned no derivation write",
                );
            };
            // Drop outer db before recovered write opens its own connection.
            db.close();
            let persisted = apply_recovered_message_write(
                run,
                mapped.work_kind,
                message_id,
                expected.as_ref(),
                source_version,
                &write,
                on_applied,
            );
            if !persisted.applied {
                if persisted.live_work {
                    return work_in_flight(message_id, mapped.work_kind, source_version);
                }
                let db = match (run.open_db)() {
                    OpResult::Ok { value } => value,
                    OpResult::Err { error } => panic!("{}", error.reason),
                };
                let current =
                    read_message_derivation_row(&db, message_id, mapped.derivation_type.as_str());
                db.close();
                if current.as_ref().is_none_or(|c| {
                    c.state != DerivationState::Ready || c.source_version != source_version
                }) {
                    return work_in_flight(message_id, mapped.work_kind, source_version);
                }
            }
            MessageDeriveResult::Derived {
                message_id: message_id.to_string(),
                derivation_type: mapped.derivation_type,
                source_version,
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MessageDerivationFloorRecovery {
    pub message_id: String,
    pub derivation_type: MessageDeriveDerivationType,
    pub content: String,
    pub source_version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteMessageDerivationFloorResult {
    pub persisted: bool,
}

/// TS `writeMessageDerivationFloorInThread`.
pub fn write_message_derivation_floor_in_thread(
    run: &HandlerRunContext,
    recovery: &MessageDerivationFloorRecovery,
) -> WriteMessageDerivationFloorResult {
    let work_kind = match recovery.derivation_type {
        MessageDeriveDerivationType::SmoothedPrompt => WorkKind::PromptSmoothing,
        MessageDeriveDerivationType::ToolResultSummary => WorkKind::ToolResultSummary,
    };
    let db = match (run.open_db)() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let row =
        read_message_derivation_row(&db, &recovery.message_id, recovery.derivation_type.as_str());
    db.close();
    let expected = expected_from_row(row.as_ref());
    let persisted = apply_recovered_message_write(
        run,
        work_kind,
        &recovery.message_id,
        expected.as_ref(),
        recovery.source_version,
        &HandlerDerivationWrite {
            subject_kind: SubjectKind::Message,
            subject_id: recovery.message_id.clone(),
            derivation_type: recovery.derivation_type.as_str().to_string(),
            content: recovery.content.clone(),
            metadata: None,
            gaps: None,
        },
        None,
    );
    WriteMessageDerivationFloorResult {
        persisted: persisted.applied,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchMessageDeriveWorkItem {
    pub work_item_id: String,
    pub source_version: i64,
    pub derivations: Vec<EnqueueDerivationTarget>,
}

pub async fn dispatch_message_derive_work(
    run: &HandlerRunContext,
    item: &DispatchMessageDeriveWorkItem,
) -> DurableWorkDispatchResult {
    let db = match (run.open_db)() {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let Some(target) = item.derivations.first() else {
        db.close();
        return DurableWorkDispatchResult::Failed {
            reason: "missing_derivation_target".into(),
        };
    };
    let record = read_message_by_id(&db, &target.subject_id);
    if record.as_ref().is_none_or(|r| r.deleted) {
        db.close();
        return DurableWorkDispatchResult::Blocked {
            reason: format!("source_damaged: message {} not found", target.subject_id),
        };
    }
    let record = record.unwrap();
    let Some(mapped) = derivation_for_kind(record.kind) else {
        db.close();
        return DurableWorkDispatchResult::Failed {
            reason: "not_derivable".into(),
        };
    };
    let Some(handler) = MESSAGE_WORK_HANDLERS.get(&mapped.work_kind).cloned() else {
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
            kind: mapped.work_kind.as_str().to_string(),
            source_ref: WorkSourceRef::Message {
                message_id: target.subject_id.clone(),
            },
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
                crate::shared_tech::durable_work::ApplyDerivationSuccessDisposition::Done => {
                    DurableWorkSettledDisposition::Done
                }
                crate::shared_tech::durable_work::ApplyDerivationSuccessDisposition::StaleDiscarded => {
                    DurableWorkSettledDisposition::StaleDiscarded
                }
                crate::shared_tech::durable_work::ApplyDerivationSuccessDisposition::LostLease => {
                    DurableWorkSettledDisposition::LostLease
                }
            };
            DurableWorkDispatchResult::Settled { disposition }
        }
        HandlerOutcome::Deferred { .. } => {
            db.close();
            DurableWorkDispatchResult::Failed {
                reason: "unsupported_deferred_message_derivation".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_tech::errors::{ErrorClass, ErrorCode};
    use crate::shared_tech::js_json::js_json_stringify_of;
    use serde_json::json;

    #[test]
    fn message_derive_result_derived_wire_shape_round_trips() {
        let v = MessageDeriveResult::Derived {
            message_id: "m1".into(),
            derivation_type: MessageDeriveDerivationType::SmoothedPrompt,
            source_version: 2,
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "messageId": "m1",
                "outcome": "derived",
                "derivationType": "smoothed_prompt",
                "sourceVersion": 2,
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"messageId":"m1","outcome":"derived","derivationType":"smoothed_prompt","sourceVersion":2}"#
        );
        let back: MessageDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn message_derive_result_not_derivable_wire_shape_round_trips() {
        let v = MessageDeriveResult::NotDerivable {
            message_id: "m2".into(),
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "messageId": "m2",
                "outcome": "not_derivable",
            })
        );
        assert!(wire.get("derivationType").is_none());
        assert!(wire.get("sourceVersion").is_none());
        assert!(wire.get("error").is_none());
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"messageId":"m2","outcome":"not_derivable"}"#
        );
        let back: MessageDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn message_derive_result_failed_wire_shape_round_trips() {
        let v = MessageDeriveResult::Failed {
            message_id: "m3".into(),
            error: ErrorResult {
                error_class: ErrorClass::CallerError,
                code: ErrorCode::InvalidBounds,
                reason: "nope".into(),
                event_index: None,
            },
        };
        let wire = serde_json::to_value(&v).unwrap();
        assert_eq!(
            wire,
            json!({
                "messageId": "m3",
                "outcome": "failed",
                "error": {
                    "errorClass": "caller_error",
                    "code": "invalid_bounds",
                    "reason": "nope",
                },
            })
        );
        assert_eq!(
            js_json_stringify_of(&v).unwrap(),
            r#"{"messageId":"m3","outcome":"failed","error":{"errorClass":"caller_error","code":"invalid_bounds","reason":"nope"}}"#
        );
        let back: MessageDeriveResult = serde_json::from_value(wire).unwrap();
        assert_eq!(back, v);
    }
}

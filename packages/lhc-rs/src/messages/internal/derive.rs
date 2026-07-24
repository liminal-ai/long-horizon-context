//! Ported from packages/lhc/src/messages/internal/derive.ts. Phase 1 skeleton.
//!
//! `MessageDeriveResult` (Wave 2) + helpers / dispatch surfaces with exact
//! `todo!("phase 2")` bodies. SQL literals REAL (private — TS module-local).

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::messages::MessageKind;
use crate::shared_tech::derivation::{CompletionTx, HandlerDerivationWrite, HandlerRunContext};
use crate::shared_tech::durable_work::DurableWorkDispatchResult;
use crate::shared_tech::errors::ErrorResult;
use crate::shared_tech::work_queue::{EnqueueDerivationTarget, WorkKind};

pub use super::work::MessageDeriveDerivationType;

#[allow(dead_code)]
const SQL_INSERT_DERIVATION_READY: &str = r#"INSERT OR IGNORE INTO derivation
             (subject_kind, subject_id, derivation_type, state, content, metadata, gaps, source_version, derived_at)
           VALUES ('message', ?, ?, 'ready', ?, ?, ?, ?, ?)"#;

#[allow(dead_code)]
const SQL_UPDATE_DERIVATION_READY: &str = r#"UPDATE derivation
           SET state = 'ready', content = ?, reason = NULL, metadata = ?,
               gaps = ?, derived_at = ?, source_version = ?
           WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?
             AND state = ? AND source_version = ?"#;

/// TS `db.exec("BEGIN IMMEDIATE;")` — module-local transaction literal.
#[allow(dead_code)]
const SQL_BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE;";
/// TS `db.exec("COMMIT;")` — used by two success paths.
#[allow(dead_code)]
const SQL_COMMIT: &str = "COMMIT;";
/// TS `db.exec("ROLLBACK;")` — failure path.
#[allow(dead_code)]
const SQL_ROLLBACK: &str = "ROLLBACK;";

/// TS `MessageDeriveResult` — public discriminated data union tagged by `outcome`.
/// Deserialize is serde-tagged; Serialize emits TS construction order
/// (`messageId` before `outcome`).
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

fn failed_derive(_message_id: &str, _error: ErrorResult) -> MessageDeriveResult {
    todo!("phase 2")
}

struct DerivationForKind {
    work_kind: WorkKind,
    derivation_type: MessageDeriveDerivationType,
}

fn derivation_for_kind(_kind: MessageKind) -> Option<DerivationForKind> {
    todo!("phase 2")
}

fn source_version_for_derive(_row: Option<&super::derivations::MessageDerivationRowView>) -> i64 {
    todo!("phase 2")
}

fn provider_failure(_message_id: &str, _reason: &str) -> MessageDeriveResult {
    todo!("phase 2")
}

fn work_in_flight(
    _message_id: &str,
    _work_kind: WorkKind,
    _source_version: i64,
) -> MessageDeriveResult {
    todo!("phase 2")
}

struct ApplyRecoveredMessageWriteResult {
    applied: bool,
    live_work: bool,
}

struct ExpectedDerivationRow {
    state: String,
    source_version: i64,
}

fn apply_recovered_message_write(
    _run: &HandlerRunContext,
    _work_kind: WorkKind,
    _message_id: &str,
    _expected: Option<&ExpectedDerivationRow>,
    _source_version: i64,
    _write: &HandlerDerivationWrite,
    _on_applied: Option<Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>>,
) -> ApplyRecoveredMessageWriteResult {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeriveMessageInThreadOpts {
    pub source_version: Option<i64>,
}

pub async fn derive_message_in_thread(
    _run: &HandlerRunContext,
    _message_id: &str,
    _opts: Option<&DeriveMessageInThreadOpts>,
) -> MessageDeriveResult {
    todo!("phase 2")
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
    _run: &HandlerRunContext,
    _recovery: &MessageDerivationFloorRecovery,
) -> WriteMessageDerivationFloorResult {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchMessageDeriveWorkItem {
    pub work_item_id: String,
    pub source_version: i64,
    pub derivations: Vec<EnqueueDerivationTarget>,
}

pub async fn dispatch_message_derive_work(
    _run: &HandlerRunContext,
    _item: &DispatchMessageDeriveWorkItem,
) -> DurableWorkDispatchResult {
    todo!("phase 2")
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

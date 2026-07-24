//! Ported from packages/lhc/test/fixtures/threads.ts.
//!
//! [`read_derived_forms`] / [`read_chunks`] / [`set_form_state`] are below-SDK
//! sqlite helpers — REAL. SDK-calling thread builders remain `todo!("phase 2")`.

use lhc::intake_stream::MessageEventInput;
use lhc::shared_tech::derivation::SizeDisposition;
use lhc::shared_tech::derivation::{
    DependencyGap, Derivation, DerivationMetadata, DerivationState, ProviderProvenance,
    SubjectKind, ToolOutcome,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::storage::{SqlParam, open_database};
use lhc::turns::TurnStatus;

use super::TempStore;
use super::model_call::DerivationType;

// ── chunk read-back (Story 3): raw rows for boundary assertions ──

/// One `chunk` table row projected for boundary assertions (TS inline map).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSnapshotChunk {
    pub chunk_id: String,
    pub chunk_order: i64,
    pub status: TurnStatus,
    pub accumulated_projected_tokens: i64,
}

/// One `chunk_member` row joined for boundary assertions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSnapshotMember {
    pub chunk_id: String,
    pub turn_id: String,
    pub member_idx: i64,
}

/// TS `ChunkSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSnapshot {
    pub chunks: Vec<ChunkSnapshotChunk>,
    pub members: Vec<ChunkSnapshotMember>,
}

/// TS `readChunks` — REAL below-SDK chunk boundary read-back.
pub fn read_chunks(file_path: &str) -> ChunkSnapshot {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("read_chunks open failed: {}", error.reason),
    };
    let chunk_rows = db
        .prepare(
            "SELECT chunk_id, chunk_order, status, accumulated_projected_tokens
           FROM chunk ORDER BY chunk_order",
        )
        .all(&[]);
    let chunks = chunk_rows
        .iter()
        .map(|row| ChunkSnapshotChunk {
            chunk_id: req_str(row, "chunk_id").to_string(),
            chunk_order: req_i64(row, "chunk_order"),
            status: parse_turn_status(req_str(row, "status")),
            accumulated_projected_tokens: req_i64(row, "accumulated_projected_tokens"),
        })
        .collect();
    let member_rows = db
        .prepare(
            "SELECT cm.chunk_id, cm.turn_id, cm.member_idx FROM chunk_member cm
           JOIN chunk c ON c.chunk_id = cm.chunk_id
           ORDER BY c.chunk_order, cm.member_idx",
        )
        .all(&[]);
    let members = member_rows
        .iter()
        .map(|row| ChunkSnapshotMember {
            chunk_id: req_str(row, "chunk_id").to_string(),
            turn_id: req_str(row, "turn_id").to_string(),
            member_idx: req_i64(row, "member_idx"),
        })
        .collect();
    db.close();
    ChunkSnapshot { chunks, members }
}

fn parse_turn_status(s: &str) -> TurnStatus {
    match s {
        "open" => TurnStatus::Open,
        "closed" => TurnStatus::Closed,
        other => panic!("read_chunks: unknown status {other}"),
    }
}

/// Closed target for [`set_form_state`] (TS inline object).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormStateTarget {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: DerivationType,
}

/// Closed update bag for [`set_form_state`] — narrow Partial of derivation write fields.
#[derive(Debug, Clone, PartialEq)]
pub struct FormStateUpdate {
    pub state: DerivationState,
    pub content: Option<String>,
    pub reason: Option<String>,
    pub metadata: Option<DerivationMetadata>,
    pub derived_at: Option<String>,
}

/// TS `setFormState` — REAL below-SDK sanctioned state writer (UPDATE-only).
pub fn set_form_state(file_path: &str, target: &FormStateTarget, update: &FormStateUpdate) {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("set_form_state open failed: {}", error.reason),
    };
    let metadata = match &update.metadata {
        None => SqlParam::Null,
        Some(meta) => {
            SqlParam::Text(js_json_stringify_of(meta).expect("set_form_state: metadata stringify"))
        }
    };
    db.prepare(
        "UPDATE derivation
         SET state = ?, content = ?, reason = ?, metadata = ?, derived_at = ?
         WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?",
    )
    .run(&[
        SqlParam::from(update.state.as_str()),
        SqlParam::from(update.content.as_deref()),
        SqlParam::from(update.reason.as_deref()),
        metadata,
        SqlParam::from(update.derived_at.as_deref()),
        SqlParam::from(target.subject_kind.as_str()),
        SqlParam::from(target.subject_id.as_str()),
        SqlParam::from(target.derivation_type.as_str()),
    ]);
    let changed = db
        .prepare("SELECT changes() AS n")
        .get()
        .and_then(|row| row.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    if changed != 1 {
        panic!(
            "fixture setFormState hit {changed} rows for {}/{}/{}; expected the pending row from enqueue",
            target.subject_kind.as_str(),
            target.subject_id,
            target.derivation_type.as_str()
        );
    }
    db.close();
}

/// TS `readDerivedForms` — REAL below-SDK derivation read-back.
pub fn read_derived_forms(file_path: &str) -> Vec<Derivation> {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("read_derived_forms open failed: {}", error.reason),
    };
    let rows = db
        .prepare(
            "SELECT subject_kind, subject_id, derivation_type, state, content, reason, metadata,
                source_version, gaps, derived_at
         FROM derivation ORDER BY subject_kind, subject_id, derivation_type",
        )
        .all(&[]);
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let subject_kind = parse_subject_kind(req_str(&row, "subject_kind"));
        let state = parse_derivation_state(req_str(&row, "state"));
        let metadata = match opt_str(&row, "metadata") {
            None => None,
            Some(raw) => Some(parse_metadata(&raw)),
        };
        let gaps = match opt_str(&row, "gaps") {
            None => None,
            Some(raw) => Some(parse_gaps(&raw)),
        };
        out.push(Derivation {
            subject_kind,
            subject_id: req_str(&row, "subject_id").to_string(),
            derivation_type: req_str(&row, "derivation_type").to_string(),
            state,
            content: opt_str(&row, "content").map(str::to_string),
            reason: opt_str(&row, "reason").map(str::to_string),
            source_version: req_i64(&row, "source_version"),
            gaps,
            metadata,
            derived_at: opt_str(&row, "derived_at").map(str::to_string),
        });
    }
    db.close();
    out
}

fn req_str<'a>(row: &'a serde_json::Map<String, serde_json::Value>, key: &str) -> &'a str {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("read_derived_forms: missing string column {key}"))
}

fn opt_str<'a>(row: &'a serde_json::Map<String, serde_json::Value>, key: &str) -> Option<&'a str> {
    match row.get(key)? {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.as_str()),
        other => panic!("read_derived_forms: column {key} expected string/null, got {other}"),
    }
}

fn req_i64(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| panic!("read_derived_forms: non-integer {key}")),
        other => panic!("read_derived_forms: missing number column {key}: {other:?}"),
    }
}

fn parse_subject_kind(s: &str) -> SubjectKind {
    match s {
        "message" => SubjectKind::Message,
        "turn" => SubjectKind::Turn,
        "chunk" => SubjectKind::Chunk,
        other => panic!("read_derived_forms: unknown subject_kind {other}"),
    }
}

fn parse_derivation_state(s: &str) -> DerivationState {
    match s {
        "pending" => DerivationState::Pending,
        "ready" => DerivationState::Ready,
        "failed" => DerivationState::Failed,
        "blocked" => DerivationState::Blocked,
        other => panic!("read_derived_forms: unknown state {other}"),
    }
}

fn parse_metadata(raw: &str) -> DerivationMetadata {
    let value: serde_json::Value =
        serde_json::from_str(raw).expect("read_derived_forms: metadata JSON");
    let obj = value
        .as_object()
        .expect("read_derived_forms: metadata must be object");
    // TS casts `JSON.parse(...) as DerivationMetadata` — unknown keys are ignored,
    // not rejected.
    let provenance = match obj.get("provenance") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(p)) => Some(ProviderProvenance {
            provider: p
                .get("provider")
                .and_then(|v| v.as_str())
                .expect("provenance.provider")
                .to_string(),
            model: p
                .get("model")
                .and_then(|v| v.as_str())
                .expect("provenance.model")
                .to_string(),
            prompt: p
                .get("prompt")
                .and_then(|v| v.as_str())
                .expect("provenance.prompt")
                .to_string(),
        }),
        Some(other) => panic!("provenance must be object, got {other}"),
    };
    DerivationMetadata {
        outcome: obj
            .get("outcome")
            .and_then(|v| v.as_str())
            .map(parse_tool_outcome),
        last_error: obj
            .get("lastError")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        discard_reason: obj
            .get("discardReason")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        fallback_floor: obj
            .get("fallbackFloor")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        fallback_used: obj.get("fallbackUsed").and_then(|v| v.as_bool()),
        inference_attempted: obj.get("inferenceAttempted").and_then(|v| v.as_bool()),
        inference_succeeded: obj.get("inferenceSucceeded").and_then(|v| v.as_bool()),
        size_disposition: obj
            .get("sizeDisposition")
            .and_then(|v| v.as_str())
            .map(parse_size_disposition),
        provenance,
    }
}

fn parse_tool_outcome(s: &str) -> ToolOutcome {
    match s {
        "succeeded" => ToolOutcome::Succeeded,
        "failed" => ToolOutcome::Failed,
        "unknown" => ToolOutcome::Unknown,
        other => panic!("read_derived_forms: unknown outcome {other}"),
    }
}

fn parse_size_disposition(s: &str) -> SizeDisposition {
    match s {
        "in_range" => SizeDisposition::InRange,
        "under_min" => SizeDisposition::UnderMin,
        "over_max" => SizeDisposition::OverMax,
        other => panic!("read_derived_forms: unknown sizeDisposition {other}"),
    }
}

fn parse_gaps(raw: &str) -> Vec<DependencyGap> {
    let value: serde_json::Value =
        serde_json::from_str(raw).expect("read_derived_forms: gaps JSON");
    let arr = value
        .as_array()
        .expect("read_derived_forms: gaps must be array");
    arr.iter()
        .map(|gap| {
            let o = gap
                .as_object()
                .expect("read_derived_forms: gap entry must be object");
            DependencyGap {
                subject_kind: parse_subject_kind(
                    o.get("subjectKind")
                        .and_then(|v| v.as_str())
                        .expect("gap.subjectKind"),
                ),
                subject_id: o
                    .get("subjectId")
                    .and_then(|v| v.as_str())
                    .expect("gap.subjectId")
                    .to_string(),
                derivation_type: o
                    .get("derivationType")
                    .and_then(|v| v.as_str())
                    .expect("gap.derivationType")
                    .to_string(),
            }
        })
        .collect()
}

/// TS private `newThreadFile` — SDK-driving; Phase 1 exact todo.
#[allow(dead_code)]
async fn new_thread_file(_store: &TempStore) -> String {
    todo!("phase 2")
}

/// TS private `send` — SDK-driving; Phase 1 exact todo.
#[allow(dead_code)]
async fn send(_file_path: &str, _batch: &[MessageEventInput]) {
    todo!("phase 2")
}

/// TC-3.2's fallback-rendering state as one shared builder (coverage.md
/// cross-story debt: TC-4.4 consumes this exact scenario). Expects a
/// manual-mode SDK: scripts the prompt's smoothing to fail, then drains.
pub const GAPPED_SMOOTHING_REASON: &str = "provider_failure: scripted smoothing failure";

/// TS `GappedRenderingThread` return shape.
#[derive(Debug, Clone)]
pub struct GappedRenderingThreadResult {
    pub file_path: String,
    pub message_id: String,
    pub turn_id: String,
}

/// TS `gappedRenderingThread` — PARTIAL (SDK-driving).
/// Needs: threads::new_thread, intake_stream::message_events, sdk.work.drain,
/// plus REAL [`set_form_state`] / [`read_derived_forms`].
pub async fn gapped_rendering_thread(
    _store: &TempStore,
    _sdk: &lhc::Lhc,
    _double: &super::inference_callbacks_double::InferenceCallbacksDouble,
) -> GappedRenderingThreadResult {
    todo!("phase 2")
}

/// TS `damagedSourceThread` — PARTIAL (SDK + [`super::corrupt::corrupt_two_open_turns`]).
/// Needs: threads::new_thread, intake_stream::message_events, then
/// corrupt_two_open_turns (REAL in corrupt.rs).
pub async fn damaged_source_thread(_store: &TempStore) -> DamagedSourceThreadResult {
    todo!("phase 2")
}

/// TS `multiStateThread` — PARTIAL.
pub async fn multi_state_thread(_store: &TempStore) -> MultiStateThreadResult {
    todo!("phase 2")
}

/// TS `threadWithClosedTurns` — PARTIAL.
pub async fn thread_with_closed_turns(
    _store: &TempStore,
    _n: usize,
) -> ThreadWithClosedTurnsResult {
    todo!("phase 2")
}

/// TS `threadWithToolRun` — PARTIAL.
pub async fn thread_with_tool_run(
    _store: &TempStore,
    _opts: Option<ToolRunOpts>,
) -> ThreadWithToolRunResult {
    todo!("phase 2")
}

#[derive(Debug, Clone)]
pub struct DamagedSourceThreadResult {
    pub file_path: String,
    pub turn_id: String,
}

#[derive(Debug, Clone)]
pub struct MultiStateClaim {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: DerivationType,
    pub state: DerivationState,
}

#[derive(Debug, Clone)]
pub struct MultiStateThreadResult {
    pub file_path: String,
    pub expected: Vec<MultiStateClaim>,
}

#[derive(Debug, Clone)]
pub struct ThreadWithClosedTurnsResult {
    pub file_path: String,
    pub turn_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolRunOpts {
    pub is_error: Option<bool>,
    pub missing_result: Option<bool>,
    pub result_content: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ThreadWithToolRunResult {
    pub file_path: String,
    pub turn_id: String,
}

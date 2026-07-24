//! Ported from packages/lhc/test/fixtures/threads.ts.
//!
//! [`read_derived_forms`] is a below-SDK sqlite read — REAL (Wave 2).
//! SDK-calling thread builders remain `todo!("phase 2")`.

use lhc::shared_tech::derivation::SizeDisposition;
use lhc::shared_tech::derivation::{
    DependencyGap, Derivation, DerivationMetadata, DerivationState, ProviderProvenance,
    SubjectKind, ToolOutcome,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::open_database;

use super::TempStore;

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

/// TS `damagedSourceThread` — PARTIAL (SDK + [`super::corrupt::corrupt_two_open_turns`]).
pub async fn damaged_source_thread(_store: &TempStore) -> DamagedSourceThreadResult {
    // Needs: threads::new_thread, intake_stream::message_events, then
    // corrupt_two_open_turns (REAL in corrupt.rs).
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
    pub derivation_type: String,
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

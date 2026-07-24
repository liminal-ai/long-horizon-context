//! Ported from packages/lhc/src/shared-tech/work-queue/index.ts.
//!
//! Durable work-item mechanics: recording, ordered listing, and the enqueue
//! wrapper that makes scheduling structural. The util is domain-blind: it
//! knows item mechanics (owner, kind, sourceRef), while each owning domain
//! supplies the derivation targets and handler meaning.

use std::panic::{AssertUnwindSafe, catch_unwind, panic_any, resume_unwind};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::derivation::{CompletionTx, HandlerDerivationWrite, SubjectKind, WorkHandler};
use super::durable_work::{
    DerivationCompletionError, DurableWorkOperation, assert_exact_derivation_writes,
    operation_intent,
};
use super::js_json::js_json_stringify_of;
use super::persist::{DbWriteTransaction, create_post_commit_hook_set};
use super::storage::{Db, SqlParam};

/// TS `WorkHandlerMap` = `Partial<Record<WorkKind, WorkHandler>>`.
/// Insertion-ordered (matches JS object key order when iterating registrations).
pub type WorkHandlerMap = IndexMap<WorkKind, WorkHandler>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkOwner {
    Messages,
    Turns,
}

impl WorkOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkOwner::Messages => "messages",
            WorkOwner::Turns => "turns",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    PromptSmoothing,
    ToolResultSummary,
    TurnDerivation,
    DetailedTurnCompression,
    ChunkSummaryDetailed,
    ChunkSummaryBrief,
}

impl WorkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkKind::PromptSmoothing => "prompt_smoothing",
            WorkKind::ToolResultSummary => "tool_result_summary",
            WorkKind::TurnDerivation => "turn_derivation",
            WorkKind::DetailedTurnCompression => "detailed_turn_compression",
            WorkKind::ChunkSummaryDetailed => "chunk_summary_detailed",
            WorkKind::ChunkSummaryBrief => "chunk_summary_brief",
        }
    }

    /// Parse a wire `kind` string. Exhaustive over the six snake_case values —
    /// no wildcard success path (unknown strings are `None`).
    pub fn from_wire(s: &str) -> Option<WorkKind> {
        match s {
            "prompt_smoothing" => Some(WorkKind::PromptSmoothing),
            "tool_result_summary" => Some(WorkKind::ToolResultSummary),
            "turn_derivation" => Some(WorkKind::TurnDerivation),
            "detailed_turn_compression" => Some(WorkKind::DetailedTurnCompression),
            "chunk_summary_detailed" => Some(WorkKind::ChunkSummaryDetailed),
            "chunk_summary_brief" => Some(WorkKind::ChunkSummaryBrief),
            _ => None,
        }
    }
}

/// TS `sourceRefKey: "messageId" | "turnId" | "chunkId"` — wire camelCase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceRefKey {
    #[serde(rename = "messageId")]
    MessageId,
    #[serde(rename = "turnId")]
    TurnId,
    #[serde(rename = "chunkId")]
    ChunkId,
}

impl SourceRefKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceRefKey::MessageId => "messageId",
            SourceRefKey::TurnId => "turnId",
            SourceRefKey::ChunkId => "chunkId",
        }
    }
}

/// Mechanical metadata for one work kind (TS `WORK_KIND_REGISTRY` entry).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkKindRegistryEntry {
    pub owner: WorkOwner,
    pub source_ref_key: SourceRefKey,
}

/// TS `WORK_KIND_REGISTRY: Record<WorkKind, { owner; sourceRefKey }>`.
/// Wave 0: Record over closed vocab → exhaustive-match fn (deterministic_marker).
pub fn work_kind_registry(kind: WorkKind) -> WorkKindRegistryEntry {
    match kind {
        WorkKind::PromptSmoothing => WorkKindRegistryEntry {
            owner: WorkOwner::Messages,
            source_ref_key: SourceRefKey::MessageId,
        },
        WorkKind::ToolResultSummary => WorkKindRegistryEntry {
            owner: WorkOwner::Messages,
            source_ref_key: SourceRefKey::MessageId,
        },
        WorkKind::TurnDerivation => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::TurnId,
        },
        WorkKind::DetailedTurnCompression => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::TurnId,
        },
        WorkKind::ChunkSummaryDetailed => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::ChunkId,
        },
        WorkKind::ChunkSummaryBrief => WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::ChunkId,
        },
    }
}

/// TS `WorkSourceRef = { messageId } | { turnId } | { chunkId }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorkSourceRef {
    #[serde(rename_all = "camelCase")]
    Message { message_id: String },
    #[serde(rename_all = "camelCase")]
    Turn { turn_id: String },
    #[serde(rename_all = "camelCase")]
    Chunk { chunk_id: String },
}

/// SDK construction wiring for durable work dispatch.
/// Domains own their handler tables; shared-tech merges them and refuses
/// duplicate kind claims (TS `mapWorkQHandlers`).
pub fn map_work_q_handlers(handler_groups: &[WorkHandlerMap]) -> WorkHandlerMap {
    let mut map = IndexMap::new();
    for handlers in handler_groups {
        for (kind, handler) in handlers {
            if map.contains_key(kind) {
                panic!(
                    "work kind \"{}\" registered by more than one domain",
                    kind.as_str()
                );
            }
            map.insert(*kind, Arc::clone(handler));
        }
    }
    map
}

/// TS `status: "queued"` — the only status written before a drain claims it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemRecordStatus {
    Queued,
}

impl WorkItemRecordStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkItemRecordStatus::Queued => "queued",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRecord {
    pub work_item_id: String,
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub status: WorkItemRecordStatus,
    pub queued_at: String,
}

/// Derivations an enqueue schedules work toward (domain-named; util meaning-blind).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueDerivationTarget {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
}

/// Exact JSON object written by `record_item` into `work_item.payload`.
/// All three keys are always present (TS inline object in `recordItem`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordItemPayload {
    source_version: i64,
    operation: DurableWorkOperation,
    derivations: Vec<EnqueueDerivationTarget>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkItemInput {
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub operation: Option<DurableWorkOperation>,
    /// defaults to 1 — first version of a fresh source
    pub source_version: Option<i64>,
    pub derivations: Option<Vec<EnqueueDerivationTarget>>,
}

fn source_id_of(source_ref: &WorkSourceRef) -> String {
    match source_ref {
        WorkSourceRef::Message { message_id } => message_id.clone(),
        WorkSourceRef::Turn { turn_id } => turn_id.clone(),
        WorkSourceRef::Chunk { chunk_id } => chunk_id.clone(),
    }
}

/// TS `Date.prototype.toISOString()` — UTC with millisecond precision.
fn to_iso_string(time: SystemTime) -> String {
    let ms = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64;
    unix_ms_to_iso(ms)
}

fn unix_ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Howard Hinnant civil_from_days (days since Unix epoch → Y-M-D).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = (if y >= 0 { y } else { y - 399 }).div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_ascii_digits(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() || !bytes.iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

/// TS `Date.parse` — finite millis since epoch, or `None` when not finite.
///
/// Amendment D (Lee/Fable, Node >=24.17): two fixed UTC shapes only; ASCII
/// digits; month `01..12`; day `01..31` with Node calendar overflow
/// normalization via [`days_from_civil`]; exact `24:00:00(.000)` → next
/// midnight; hour 24 with nonzero remainder invalid.
fn date_parse_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let millis: i64 = if b.len() == 24 {
        if b[4] != b'-'
            || b[7] != b'-'
            || b[10] != b'T'
            || b[13] != b':'
            || b[16] != b':'
            || b[19] != b'.'
            || b[23] != b'Z'
        {
            return None;
        }
        parse_ascii_digits(&b[20..23])?
    } else if b.len() == 20 {
        if b[4] != b'-'
            || b[7] != b'-'
            || b[10] != b'T'
            || b[13] != b':'
            || b[16] != b':'
            || b[19] != b'Z'
        {
            return None;
        }
        0
    } else {
        return None;
    };
    let y = parse_ascii_digits(&b[0..4])?;
    let mo = parse_ascii_digits(&b[5..7])?;
    let d = parse_ascii_digits(&b[8..10])?;
    let hh = parse_ascii_digits(&b[11..13])?;
    let mm = parse_ascii_digits(&b[14..16])?;
    let ss = parse_ascii_digits(&b[17..19])?;
    if !(1..=12).contains(&mo)
        || !(1..=31).contains(&d)
        || !(0..=59).contains(&mm)
        || !(0..=59).contains(&ss)
        || !(0..=999).contains(&millis)
    {
        return None;
    }
    let (hh, day_adjust) = if hh == 24 {
        if mm != 0 || ss != 0 || millis != 0 {
            return None;
        }
        (0, 1)
    } else if (0..=23).contains(&hh) {
        (hh, 0)
    } else {
        return None;
    };
    let days = days_from_civil(y, mo, d) + day_adjust;
    Some(days * 86_400 * 1000 + hh * 3600 * 1000 + mm * 60 * 1000 + ss * 1000 + millis)
}

fn iso_plus_ms(now: &str, duration_ms: i64) -> String {
    let base = date_parse_ms(now).expect("claim timing now must be Date.parse-able");
    unix_ms_to_iso(base + duration_ms)
}

/// TS `!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.parse(now)`.
fn lease_is_expired(claim_expires_at: &str, now: &str) -> bool {
    match date_parse_ms(claim_expires_at) {
        None => true,
        Some(expires_at) => match date_parse_ms(now) {
            // `expires <= NaN` is false in JS, so a finite expiry with unparseable now is not expired.
            None => false,
            Some(now_ms) => expires_at <= now_ms,
        },
    }
}

fn map_required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn map_optional_str(row: &Map<String, Value>, key: &str) -> Option<String> {
    match row.get(key) {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_str()
                .unwrap_or_else(|| panic!("column {key} not text"))
                .to_string(),
        ),
    }
}

fn map_i64(row: &Map<String, Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or_else(|| panic!("column {key} not integer")),
        Some(Value::String(s)) => s
            .parse()
            .unwrap_or_else(|_| panic!("column {key} not integer")),
        _ => panic!("missing column {key}"),
    }
}

fn work_owner_from_wire(s: &str) -> WorkOwner {
    match s {
        "messages" => WorkOwner::Messages,
        "turns" => WorkOwner::Turns,
        other => panic!("invalid work owner: {other}"),
    }
}

fn queue_live_status_from_wire(s: &str) -> QueueLiveStatus {
    match s {
        "queued" => QueueLiveStatus::Queued,
        "claimed" => QueueLiveStatus::Claimed,
        other => panic!("unexpected work_item status: {other}"),
    }
}

fn raw_claim_row_from_map(row: &Map<String, Value>) -> RawClaimRow {
    RawClaimRow {
        work_item_id: map_required_str(row, "work_item_id"),
        owner: map_required_str(row, "owner"),
        kind: map_required_str(row, "kind"),
        source_ref: map_required_str(row, "source_ref"),
        queued_at: map_required_str(row, "queued_at"),
        payload: map_required_str(row, "payload"),
    }
}

/// TS `Pick<EnqueueDerivationTarget | HandlerDerivationWrite, subjectKind|subjectId|derivationType>`.
trait DerivationTargetKeyParts {
    fn subject_kind(&self) -> SubjectKind;
    fn subject_id(&self) -> &str;
    fn derivation_type(&self) -> &str;
}

impl DerivationTargetKeyParts for EnqueueDerivationTarget {
    fn subject_kind(&self) -> SubjectKind {
        self.subject_kind
    }
    fn subject_id(&self) -> &str {
        &self.subject_id
    }
    fn derivation_type(&self) -> &str {
        &self.derivation_type
    }
}

impl DerivationTargetKeyParts for HandlerDerivationWrite {
    fn subject_kind(&self) -> SubjectKind {
        self.subject_kind
    }
    fn subject_id(&self) -> &str {
        &self.subject_id
    }
    fn derivation_type(&self) -> &str {
        &self.derivation_type
    }
}

fn target_key(target: &impl DerivationTargetKeyParts) -> String {
    format!(
        "{}/{}/{}",
        target.subject_kind().as_str(),
        target.subject_id(),
        target.derivation_type()
    )
}

/// Deterministic id scoped to source version.
pub fn record_item(db: &Db, input: WorkItemInput, queued_at: &str) -> WorkItemRecord {
    let source_version = input.source_version.unwrap_or(1);
    let work_item_id = format!(
        "w-{}-{}-v{}",
        source_id_of(&input.source_ref),
        input.kind.as_str(),
        source_version
    );
    let source_ref_json =
        js_json_stringify_of(&input.source_ref).expect("sourceRef js_json_stringify_of");
    let payload = RecordItemPayload {
        source_version,
        operation: match input.operation.clone() {
            Some(operation) => operation,
            None => operation_intent(input.kind, &input.source_ref),
        },
        derivations: input.derivations.clone().unwrap_or_default(),
    };
    let payload_json = js_json_stringify_of(&payload).expect("payload js_json_stringify_of");
    db.prepare(
        "INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)",
    )
    .run(&[
        SqlParam::from(work_item_id.as_str()),
        SqlParam::from(input.owner.as_str()),
        SqlParam::from(input.kind.as_str()),
        SqlParam::from(source_ref_json.as_str()),
        SqlParam::from(queued_at),
        SqlParam::from(payload_json.as_str()),
    ]);
    WorkItemRecord {
        work_item_id,
        owner: input.owner,
        kind: input.kind,
        source_ref: input.source_ref,
        status: WorkItemRecordStatus::Queued,
        queued_at: queued_at.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnqueueInput {
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub derivations: Vec<EnqueueDerivationTarget>,
    pub operation: Option<DurableWorkOperation>,
    pub source_version: Option<i64>,
}

/// TS `ImmediateDerivationBoundary` — `exists: false` | `exists: true` + state/version.
#[derive(Debug, Clone, PartialEq)]
pub enum ImmediateDerivationBoundary {
    Missing {
        subject_kind: SubjectKind,
        subject_id: String,
        derivation_type: String,
    },
    Present {
        subject_kind: SubjectKind,
        subject_id: String,
        derivation_type: String,
        state: String,
        source_version: i64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImmediateClaimInput {
    pub owner: WorkOwner,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub derivations: Vec<EnqueueDerivationTarget>,
    pub expected_derivations: Vec<ImmediateDerivationBoundary>,
    pub operation: Option<DurableWorkOperation>,
    pub source_version: Option<i64>,
}

/// TS `{ now; leaseDurationMs }`.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimTiming {
    pub now: String,
    pub lease_duration_ms: i64,
}

/// TS `ImmediateClaimOutcome` — discriminated on `outcome` (in-memory; no serde).
#[derive(Debug, Clone, PartialEq)]
pub enum ImmediateClaimOutcome {
    Claimed { item: ClaimedWorkItem },
    Expired { item: ClaimedWorkItem },
    Queued { work_item_id: String },
    InFlight { work_item_id: String },
}

/// The one way work is scheduled: work row + pending derivation + poke.
pub fn enqueue(transaction: &DbWriteTransaction<'_>, input: EnqueueInput) -> WorkItemRecord {
    let queued_at = to_iso_string((transaction.clock)());
    let item = record_item(
        transaction.db,
        WorkItemInput {
            owner: input.owner,
            kind: input.kind,
            source_ref: input.source_ref.clone(),
            operation: input.operation.clone(),
            source_version: input.source_version,
            derivations: Some(input.derivations.clone()),
        },
        &queued_at,
    );
    let source_version = input.source_version.unwrap_or(1);
    let upsert = transaction.db.prepare(
        "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
           state = 'pending', content = NULL, reason = NULL, metadata = NULL,
           gaps = NULL, derived_at = NULL, source_version = excluded.source_version",
    );
    for target in &input.derivations {
        upsert.run(&[
            SqlParam::from(target.subject_kind.as_str()),
            SqlParam::from(target.subject_id.as_str()),
            SqlParam::from(target.derivation_type.as_str()),
            SqlParam::from(source_version),
        ]);
    }
    let poke = Arc::clone(&transaction.poke);
    let thread_id = transaction.thread_id.clone();
    (transaction.post_commit_hook.add)(Box::new(move || poke(&thread_id)));
    item
}

pub fn create_or_claim_immediate_work_item(
    db: &Db,
    input: ImmediateClaimInput,
    claim_timing: ClaimTiming,
) -> ImmediateClaimOutcome {
    let source_version = input.source_version.unwrap_or(1);
    let queued_at = claim_timing.now.clone();
    let claim_expires_at = iso_plus_ms(&claim_timing.now, claim_timing.lease_duration_ms);
    let source_ref =
        js_json_stringify_of(&input.source_ref).expect("sourceRef js_json_stringify_of");
    let work_item_id = format!(
        "w-{}-{}-v{}",
        source_id_of(&input.source_ref),
        input.kind.as_str(),
        source_version
    );
    let current_boundary = db.prepare(
        "SELECT state, source_version
         FROM derivation
         WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?",
    );
    let boundaries_match = || -> bool {
        for target in &input.expected_derivations {
            let (subject_kind, subject_id, derivation_type) = match target {
                ImmediateDerivationBoundary::Missing {
                    subject_kind,
                    subject_id,
                    derivation_type,
                }
                | ImmediateDerivationBoundary::Present {
                    subject_kind,
                    subject_id,
                    derivation_type,
                    ..
                } => (*subject_kind, subject_id.as_str(), derivation_type.as_str()),
            };
            let row = current_boundary.get_params(&[
                SqlParam::from(subject_kind.as_str()),
                SqlParam::from(subject_id),
                SqlParam::from(derivation_type),
            ]);
            match target {
                ImmediateDerivationBoundary::Missing { .. } => {
                    if row.is_some() {
                        return false;
                    }
                }
                ImmediateDerivationBoundary::Present {
                    state,
                    source_version: expected_version,
                    ..
                } => {
                    let Some(row) = row else {
                        return false;
                    };
                    let row_state = map_required_str(&row, "state");
                    let row_version = map_i64(&row, "source_version");
                    if row_state != *state || row_version != *expected_version {
                        return false;
                    }
                }
            }
        }
        true
    };
    let upsert_pending = || {
        let upsert = db.prepare(
            "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
             VALUES (?, ?, ?, 'pending', ?)
             ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
               state = 'pending', content = NULL, reason = NULL, metadata = NULL,
               gaps = NULL, derived_at = NULL, source_version = excluded.source_version",
        );
        for target in &input.derivations {
            upsert.run(&[
                SqlParam::from(target.subject_kind.as_str()),
                SqlParam::from(target.subject_id.as_str()),
                SqlParam::from(target.derivation_type.as_str()),
                SqlParam::from(source_version),
            ]);
        }
    };
    let exact_live = || -> Option<String> {
        db.prepare(
            "SELECT work_item_id
             FROM work_item
             WHERE status IN ('queued', 'claimed') AND owner = ? AND kind = ? AND source_ref = ?
               AND COALESCE(json_extract(payload, '$.sourceVersion'), 1) = ?
             LIMIT 1",
        )
        .get_params(&[
            SqlParam::from(input.owner.as_str()),
            SqlParam::from(input.kind.as_str()),
            SqlParam::from(source_ref.as_str()),
            SqlParam::from(source_version),
        ])
        .map(|row| map_required_str(&row, "work_item_id"))
    };

    db.exec("BEGIN IMMEDIATE;");
    let result = catch_unwind(AssertUnwindSafe(|| {
        let head = db
            .prepare(
                "SELECT work_item_id, owner, kind, source_ref, status, queued_at, claim_expires_at, payload
                 FROM work_item
                 WHERE status IN ('queued', 'claimed')
                 ORDER BY rowid LIMIT 1",
            )
            .get();
        if let Some(head) = head {
            let head_status = map_required_str(&head, "status");
            let head_claim_expires_at = map_optional_str(&head, "claim_expires_at");
            let head_row = raw_claim_row_from_map(&head);
            let head_source_version = parse_work_payload(&head_row).source_version.unwrap_or(1);
            let is_exact_operation = head_row.owner == input.owner.as_str()
                && head_row.kind == input.kind.as_str()
                && head_row.source_ref == source_ref
                && head_source_version == source_version;
            if !is_exact_operation {
                if let Some(live) = exact_live() {
                    db.exec("COMMIT;");
                    return ImmediateClaimOutcome::InFlight { work_item_id: live };
                }
                if !boundaries_match() {
                    db.exec("COMMIT;");
                    return ImmediateClaimOutcome::InFlight {
                        work_item_id: work_item_id.clone(),
                    };
                }
                let item = record_item(
                    db,
                    WorkItemInput {
                        owner: input.owner,
                        kind: input.kind,
                        source_ref: input.source_ref.clone(),
                        operation: input.operation.clone(),
                        source_version: Some(source_version),
                        derivations: Some(input.derivations.clone()),
                    },
                    &queued_at,
                );
                upsert_pending();
                db.exec("COMMIT;");
                return ImmediateClaimOutcome::Queued {
                    work_item_id: item.work_item_id,
                };
            }
            if !boundaries_match() {
                db.exec("COMMIT;");
                return ImmediateClaimOutcome::InFlight {
                    work_item_id: head_row.work_item_id,
                };
            }
            if head_status == "claimed" {
                if lease_is_expired(
                    head_claim_expires_at.as_deref().unwrap_or(""),
                    &claim_timing.now,
                ) {
                    let item = to_claimed_item(head_row);
                    db.exec("COMMIT;");
                    return ImmediateClaimOutcome::Expired { item };
                }
                db.exec("COMMIT;");
                return ImmediateClaimOutcome::InFlight {
                    work_item_id: head_row.work_item_id,
                };
            }
            let claimed = db
                .prepare(
                    "UPDATE work_item
                     SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
                     WHERE work_item_id = ? AND status = 'queued'
                     RETURNING work_item_id, owner, kind, source_ref, queued_at, payload",
                )
                .get_params(&[
                    SqlParam::from(claim_timing.now.as_str()),
                    SqlParam::from(claim_expires_at.as_str()),
                    SqlParam::from(head_row.work_item_id.as_str()),
                ]);
            if claimed.is_none() {
                db.exec("COMMIT;");
                return ImmediateClaimOutcome::InFlight {
                    work_item_id: head_row.work_item_id,
                };
            }
            let item = to_claimed_item(raw_claim_row_from_map(&claimed.unwrap()));
            db.exec("COMMIT;");
            return ImmediateClaimOutcome::Claimed { item };
        }

        if !boundaries_match() {
            db.exec("COMMIT;");
            return ImmediateClaimOutcome::InFlight {
                work_item_id: work_item_id.clone(),
            };
        }

        let item = record_item(
            db,
            WorkItemInput {
                owner: input.owner,
                kind: input.kind,
                source_ref: input.source_ref.clone(),
                operation: input.operation.clone(),
                source_version: Some(source_version),
                derivations: Some(input.derivations.clone()),
            },
            &queued_at,
        );
        upsert_pending();

        let claimed = db
            .prepare(
                "UPDATE work_item
                 SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
                 WHERE work_item_id = ? AND status = 'queued'
                 RETURNING work_item_id, owner, kind, source_ref, queued_at, payload",
            )
            .get_params(&[
                SqlParam::from(claim_timing.now.as_str()),
                SqlParam::from(claim_expires_at.as_str()),
                SqlParam::from(item.work_item_id.as_str()),
            ]);
        let Some(claimed) = claimed else {
            panic!("failed to claim immediate work item {}", item.work_item_id);
        };
        let claimed_item = to_claimed_item(raw_claim_row_from_map(&claimed));
        db.exec("COMMIT;");
        ImmediateClaimOutcome::Claimed { item: claimed_item }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(cause) => {
            db.exec("ROLLBACK;");
            resume_unwind(cause);
        }
    }
}

/// TS private `RawWorkItemRow` — listItems SELECT shape (no payload).
#[allow(dead_code)]
struct RawWorkItemRow {
    work_item_id: String,
    owner: String,
    kind: String,
    source_ref: String,
    queued_at: String,
}

/// Claimed row as the drain holds it. `kind` is a plain string — a raw row
/// with an unregistered kind must still be claimable so the drain can land it
/// failed_terminal instead of skipping it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedWorkItem {
    pub work_item_id: String,
    pub owner: WorkOwner,
    pub kind: String,
    pub source_ref: WorkSourceRef,
    pub queued_at: String,
    pub source_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<DurableWorkOperation>,
    pub derivations: Vec<EnqueueDerivationTarget>,
}

/// TS `ClaimOutcome` — discriminated on `outcome` (in-memory; no serde).
#[derive(Debug, Clone, PartialEq)]
pub enum ClaimOutcome {
    Claimed { item: ClaimedWorkItem },
    Expired { item: ClaimedWorkItem },
    Empty,
    InFlight { claim_expires_at: String },
}

struct RawClaimRow {
    work_item_id: String,
    owner: String,
    kind: String,
    source_ref: String,
    queued_at: String,
    payload: String,
}

/// TS private `WorkPayload` — optional fields when reading stored payload JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation: Option<DurableWorkOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    derivations: Option<Vec<EnqueueDerivationTarget>>,
}

fn parse_work_payload(row: &RawClaimRow) -> WorkPayload {
    serde_json::from_str(&row.payload).unwrap_or_else(|err| panic!("{err}"))
}

// IMPORT-CYCLE SEAM (Python): durable_work imports work_queue at load time;
// Phase 2 body lazily calls durable_work::operation_intent.
fn operation_intent_for_row(
    kind: &str,
    source_ref: &WorkSourceRef,
) -> Option<DurableWorkOperation> {
    let kind = WorkKind::from_wire(kind)?;
    Some(operation_intent(kind, source_ref))
}

fn to_claimed_item(row: RawClaimRow) -> ClaimedWorkItem {
    let source_ref: WorkSourceRef =
        serde_json::from_str(&row.source_ref).unwrap_or_else(|err| panic!("{err}"));
    let payload = parse_work_payload(&row);
    let operation = match payload.operation {
        Some(operation) => Some(operation),
        None => operation_intent_for_row(&row.kind, &source_ref),
    };
    ClaimedWorkItem {
        work_item_id: row.work_item_id,
        owner: work_owner_from_wire(&row.owner),
        kind: row.kind,
        source_ref,
        queued_at: row.queued_at,
        source_version: payload.source_version.unwrap_or(1),
        operation,
        derivations: payload.derivations.unwrap_or_default(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteClaimedItem {
    pub work_item_id: String,
}

pub fn delete_claimed_item(db: &Db, item: &DeleteClaimedItem) -> bool {
    db.exec("BEGIN IMMEDIATE;");
    let result = catch_unwind(AssertUnwindSafe(|| {
        let deleted = db
            .prepare("DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'")
            .run(&[SqlParam::from(item.work_item_id.as_str())]);
        db.exec("COMMIT;");
        deleted.changes > 0
    }));
    match result {
        Ok(changed) => changed,
        Err(cause) => {
            db.exec("ROLLBACK;");
            resume_unwind(cause);
        }
    }
}

pub fn claim_next(db: &Db, now: &str, lease_duration_ms: i64) -> ClaimOutcome {
    let expires_at = iso_plus_ms(now, lease_duration_ms);
    db.exec("BEGIN IMMEDIATE;");
    let result = catch_unwind(AssertUnwindSafe(|| {
        let head = db
            .prepare(
                "SELECT work_item_id, owner, kind, source_ref, status, queued_at, claim_expires_at, payload
                 FROM work_item WHERE status IN ('queued', 'claimed')
                 ORDER BY rowid LIMIT 1",
            )
            .get();
        let Some(head) = head else {
            db.exec("COMMIT;");
            return ClaimOutcome::Empty;
        };
        let status = map_required_str(&head, "status");
        let claim_expires_at = map_optional_str(&head, "claim_expires_at");
        let head_row = raw_claim_row_from_map(&head);
        if status == "claimed" {
            let item = to_claimed_item(head_row);
            db.exec("COMMIT;");
            if lease_is_expired(claim_expires_at.as_deref().unwrap_or(""), now) {
                return ClaimOutcome::Expired { item };
            }
            return ClaimOutcome::InFlight {
                claim_expires_at: claim_expires_at.unwrap_or_default(),
            };
        }
        let claimed = db
            .prepare(
                "UPDATE work_item
                 SET status = 'claimed', claimed_at = ?, claim_expires_at = ?
                 WHERE work_item_id = ? AND status = 'queued'
                 RETURNING work_item_id, owner, kind, source_ref, queued_at, payload",
            )
            .get_params(&[
                SqlParam::from(now),
                SqlParam::from(expires_at.as_str()),
                SqlParam::from(head_row.work_item_id.as_str()),
            ]);
        let Some(claimed) = claimed else {
            panic!("failed to claim queued work item {}", head_row.work_item_id);
        };
        let item = to_claimed_item(raw_claim_row_from_map(&claimed));
        db.exec("COMMIT;");
        ClaimOutcome::Claimed { item }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(cause) => {
            db.exec("ROLLBACK;");
            resume_unwind(cause);
        }
    }
}

/// TS `complete` return: `"done" | "stale_discarded" | "lost_lease"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompleteDisposition {
    Done,
    StaleDiscarded,
    LostLease,
}

impl CompleteDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            CompleteDisposition::Done => "done",
            CompleteDisposition::StaleDiscarded => "stale_discarded",
            CompleteDisposition::LostLease => "lost_lease",
        }
    }
}

pub fn complete(
    db: &Db,
    item: &ClaimedWorkItem,
    writes: &[HandlerDerivationWrite],
    derived_at: &str,
    on_applied: Option<Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>>,
) -> CompleteDisposition {
    let post_commit_hook = create_post_commit_hook_set();
    db.exec("BEGIN IMMEDIATE;");
    let result = catch_unwind(AssertUnwindSafe(move || {
        let owned = db
            .prepare("SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'")
            .get_params(&[SqlParam::from(item.work_item_id.as_str())]);
        if owned.is_none() {
            db.exec("COMMIT;");
            return CompleteDisposition::LostLease;
        }
        assert_exact_derivation_writes(&item.derivations, writes);
        let mut hits: i64 = 0;
        let mut misses: i64 = 0;
        let update = db.prepare(
            "UPDATE derivation
             SET state = 'ready', content = ?, reason = NULL, metadata = ?, gaps = NULL, derived_at = ?
             WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ? AND source_version = ?",
        );
        for write in writes {
            let metadata = match &write.metadata {
                None => SqlParam::Null,
                Some(metadata) => SqlParam::from(
                    js_json_stringify_of(metadata).expect("metadata js_json_stringify_of"),
                ),
            };
            let changed = update.run(&[
                SqlParam::from(write.content.as_str()),
                metadata,
                SqlParam::from(derived_at),
                SqlParam::from(write.subject_kind.as_str()),
                SqlParam::from(write.subject_id.as_str()),
                SqlParam::from(write.derivation_type.as_str()),
                SqlParam::from(item.source_version),
            ]);
            let count = changed.changes;
            if count == 0 {
                misses += 1;
            }
            if count > 1 {
                panic_any(DerivationCompletionError::new(format!(
                    "derivation completion write hit {count} rows for {} at sourceVersion {}",
                    target_key(write),
                    item.source_version
                )));
            }
            hits += count;
        }
        let stale = !writes.is_empty() && hits == 0;
        if !stale && misses > 0 {
            panic_any(DerivationCompletionError::new(format!(
                "derivation completion partially hit {hits} of {} rows at sourceVersion {}",
                writes.len(),
                item.source_version
            )));
        }
        let super::persist::PostCommitHookSet { add, flush } = post_commit_hook;
        if !stale {
            if let Some(on_applied) = on_applied {
                on_applied(CompletionTx {
                    db,
                    on_commit: Box::new(add),
                });
            }
        }
        db.prepare("DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'")
            .run(&[SqlParam::from(item.work_item_id.as_str())]);
        db.exec("COMMIT;");
        flush();
        if stale {
            CompleteDisposition::StaleDiscarded
        } else {
            CompleteDisposition::Done
        }
    }));
    match result {
        Ok(disposition) => disposition,
        Err(cause) => {
            db.exec("ROLLBACK;");
            resume_unwind(cause);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SupersedeTarget {
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
}

pub fn supersede_queued(db: &Db, targets: &[SupersedeTarget]) -> Vec<String> {
    let mut ids = Vec::new();
    let remove = db.prepare(
        "DELETE FROM work_item WHERE status = 'queued' AND kind = ? AND source_ref = ?
         RETURNING work_item_id",
    );
    for target in targets {
        let source_ref =
            js_json_stringify_of(&target.source_ref).expect("sourceRef js_json_stringify_of");
        let rows = remove.all(&[
            SqlParam::from(target.kind.as_str()),
            SqlParam::from(source_ref.as_str()),
        ]);
        for row in rows {
            ids.push(map_required_str(&row, "work_item_id"));
        }
    }
    ids
}

pub fn has_live_item(
    db: &Db,
    kind: WorkKind,
    source_ref: &WorkSourceRef,
    source_version: i64,
) -> bool {
    let source_ref_json = js_json_stringify_of(source_ref).expect("sourceRef js_json_stringify_of");
    let row = db
        .prepare(
            "SELECT 1 FROM work_item
             WHERE status IN ('queued', 'claimed') AND kind = ? AND source_ref = ?
               AND COALESCE(json_extract(payload, '$.sourceVersion'), 1) = ?
             LIMIT 1",
        )
        .get_params(&[
            SqlParam::from(kind.as_str()),
            SqlParam::from(source_ref_json.as_str()),
            SqlParam::from(source_version),
        ]);
    row.is_some()
}

/// Live items left in the queue; used by drain reporting and owner repair reports.
pub fn count_live_items(db: &Db) -> i64 {
    let row = db
        .prepare("SELECT COUNT(*) AS n FROM work_item WHERE status IN ('queued', 'claimed')")
        .get()
        .expect("count row");
    map_i64(&row, "n")
}

/// TS `status: "queued" | "claimed"` on live queue detail rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueLiveStatus {
    Queued,
    Claimed,
}

impl QueueLiveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            QueueLiveStatus::Queued => "queued",
            QueueLiveStatus::Claimed => "claimed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDetailRow {
    pub work_item_id: String,
    pub owner: WorkOwner,
    pub kind: String,
    pub source_ref: WorkSourceRef,
    pub status: QueueLiveStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claimed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_expires_at: Option<String>,
    pub queued_at: String,
    pub source_version: i64,
}

pub fn queue_detail(db: &Db) -> Vec<QueueDetailRow> {
    let rows = db
        .prepare(
            "SELECT work_item_id, owner, kind, source_ref, status, claimed_at,
                    claim_expires_at, queued_at, payload
             FROM work_item ORDER BY rowid",
        )
        .all(&[]);
    rows.into_iter()
        .map(|row| {
            let status = queue_live_status_from_wire(&map_required_str(&row, "status"));
            let claimed_at = map_optional_str(&row, "claimed_at");
            let claim_expires_at = map_optional_str(&row, "claim_expires_at");
            let item = to_claimed_item(raw_claim_row_from_map(&row));
            QueueDetailRow {
                work_item_id: item.work_item_id,
                owner: item.owner,
                kind: item.kind,
                source_ref: item.source_ref,
                status,
                claimed_at,
                claim_expires_at,
                queued_at: item.queued_at,
                source_version: item.source_version,
            }
        })
        .collect()
}

pub fn list_items(db: &Db, owner: WorkOwner) -> Vec<WorkItemRecord> {
    let rows = db
        .prepare(
            "SELECT work_item_id, owner, kind, source_ref, queued_at
             FROM work_item WHERE owner = ? ORDER BY rowid",
        )
        .all(&[SqlParam::from(owner.as_str())]);
    rows.into_iter()
        .map(|row| {
            let kind_str = map_required_str(&row, "kind");
            let kind = WorkKind::from_wire(&kind_str)
                .unwrap_or_else(|| panic!("invalid work kind: {kind_str}"));
            let source_ref: WorkSourceRef =
                serde_json::from_str(&map_required_str(&row, "source_ref"))
                    .unwrap_or_else(|err| panic!("{err}"));
            WorkItemRecord {
                work_item_id: map_required_str(&row, "work_item_id"),
                owner: work_owner_from_wire(&map_required_str(&row, "owner")),
                kind,
                source_ref,
                status: WorkItemRecordStatus::Queued,
                queued_at: map_required_str(&row, "queued_at"),
            }
        })
        .collect()
}

/// Mutation-sensitive serde coverage for the private `record_item` write payload.
/// Rust-only (no TS twin) — allowlist as `lib::shared_tech::work_queue::tests::*`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_tech::js_json::js_json_stringify_of;

    fn sample_write_payload() -> RecordItemPayload {
        RecordItemPayload {
            source_version: 1,
            operation: DurableWorkOperation::MessagesDerive {
                message_id: "m1".into(),
            },
            derivations: vec![EnqueueDerivationTarget {
                subject_kind: SubjectKind::Message,
                subject_id: "m1".into(),
                derivation_type: "prompt_smoothing".into(),
            }],
        }
    }

    #[test]
    fn record_item_write_payload_requires_source_version_operation_derivations_keys() {
        let bytes = js_json_stringify_of(&sample_write_payload()).expect("stringify");
        let value: serde_json::Value = serde_json::from_str(&bytes).expect("parse");
        let obj = value.as_object().expect("object");
        assert!(
            obj.contains_key("sourceVersion"),
            "missing sourceVersion: {bytes}"
        );
        assert!(obj.contains_key("operation"), "missing operation: {bytes}");
        assert!(
            obj.contains_key("derivations"),
            "missing derivations: {bytes}"
        );
        assert!(
            !obj.contains_key("source_version"),
            "snake_case leak: {bytes}"
        );
    }

    #[test]
    fn record_item_write_payload_serializes_camel_case_bytes() {
        let bytes = js_json_stringify_of(&sample_write_payload()).expect("stringify");
        assert!(
            bytes.contains("\"sourceVersion\":1"),
            "expected camelCase sourceVersion in {bytes}"
        );
        assert!(
            bytes.contains("\"subjectKind\":\"message\""),
            "expected camelCase subjectKind in {bytes}"
        );
        assert!(
            bytes.contains("\"subjectId\":\"m1\""),
            "expected camelCase subjectId in {bytes}"
        );
        assert!(
            bytes.contains("\"derivationType\":\"prompt_smoothing\""),
            "expected camelCase derivationType in {bytes}"
        );
        assert!(
            bytes.contains("\"messageId\":\"m1\""),
            "expected camelCase messageId in {bytes}"
        );
    }

    #[test]
    fn record_item_write_payload_rejects_unknown_subject_kind() {
        let bad = r#"{"sourceVersion":1,"operation":{"operation":"messages.derive","messageId":"m1"},"derivations":[{"subjectKind":"bogus","subjectId":"m1","derivationType":"prompt_smoothing"}]}"#;
        let err = serde_json::from_str::<RecordItemPayload>(bad).expect_err("bogus kind");
        let msg = err.to_string();
        assert!(
            msg.contains("bogus") || msg.contains("SubjectKind") || msg.contains("unknown"),
            "unexpected error: {msg}"
        );
    }

    /// Amendment D — Node >=24.17 `Date.parse` oracle for lease timestamps.
    #[test]
    fn date_parse_matches_node_oracle() {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct DateParseOracleRow {
            name: String,
            input: String,
            expected: String,
        }

        fn is_canonical_ms_utc_iso(s: &str) -> bool {
            let b = s.as_bytes();
            b.len() == 24
                && b[4] == b'-'
                && b[7] == b'-'
                && b[10] == b'T'
                && b[13] == b':'
                && b[16] == b':'
                && b[19] == b'.'
                && b[23] == b'Z'
                && b[0..4].iter().all(u8::is_ascii_digit)
                && b[5..7].iter().all(u8::is_ascii_digit)
                && b[8..10].iter().all(u8::is_ascii_digit)
                && b[11..13].iter().all(u8::is_ascii_digit)
                && b[14..16].iter().all(u8::is_ascii_digit)
                && b[17..19].iter().all(u8::is_ascii_digit)
                && b[20..23].iter().all(u8::is_ascii_digit)
        }

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/date-parse-cases.jsonl"
        );
        let body = std::fs::read_to_string(path).expect("read date-parse-cases.jsonl");
        let mut n = 0usize;
        let mut names = std::collections::HashSet::new();
        let mut inputs = std::collections::HashSet::new();
        for (line_no, line) in body.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let row: DateParseOracleRow =
                serde_json::from_str(line).unwrap_or_else(|e| panic!("line {}: {e}", line_no + 1));
            assert!(
                names.insert(row.name.clone()),
                "line {}: duplicate name {}",
                line_no + 1,
                row.name
            );
            assert!(
                inputs.insert(row.input.clone()),
                "line {}: duplicate input {:?}",
                line_no + 1,
                row.input
            );
            assert!(
                row.expected == "invalid" || is_canonical_ms_utc_iso(&row.expected),
                "line {}: expected must be \"invalid\" or canonical ms UTC ISO, got {:?}",
                line_no + 1,
                row.expected
            );
            n += 1;
            let parsed = date_parse_ms(&row.input);
            if row.expected == "invalid" {
                assert!(
                    parsed.is_none(),
                    "{}: expected invalid for {:?}, got {parsed:?}",
                    row.name,
                    row.input
                );
            } else {
                let ms = parsed
                    .unwrap_or_else(|| panic!("{}: expected {}, got None", row.name, row.expected));
                let rendered = unix_ms_to_iso(ms);
                assert_eq!(
                    rendered, row.expected,
                    "{}: input {:?} rendered {rendered}, oracle {}",
                    row.name, row.input, row.expected
                );
            }
        }
        assert!(
            n >= 80,
            "oracle truncated: only {n} cases (need a meaningful fixed-format matrix)"
        );
        assert_eq!(names.len(), n, "unique names must equal row count");
        assert_eq!(inputs.len(), n, "unique inputs must equal row count");
    }
}

//! Ported from packages/lhc/src/retrieval/index.ts.
//!
//! Retrieval: deterministic drill-down from band labels to full content.
//! `get_turns` serves rendered turns by turn id (`t…`); `get_messages` serves
//! verbatim message content by message id (`m…`). Both enforce a per-call token
//! budget with in-order serving. Oversized content is not refused: the item
//! that crosses the budget is served as an exact token slice with a receipt
//! (`slice`) naming the window and total, so the caller can continue via
//! `from_token`. Later ids past a spent budget get explicit "budget" receipts.
//! Every requested id writes one impression row — the durable usage log that
//! later ranking work reads. Retrieval never mutates record content; the only
//! write is the impression log.
//!
//! Host-facing tool result framing lives in [`format`] (R6): byte-stable
//! `<recalled-history>` envelope + out-of-envelope receipts / next-call text.

pub mod format;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::shared_tech::errors::{OpResult, storage_failure};
use crate::shared_tech::js_json::{js_json_stringify, js_json_stringify_pretty, js_len, js_slice};
use crate::shared_tech::persist::{create_db_read_transaction, create_db_write_transaction};
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::token_counting::{estimate_tokens, slice_tokens, slice_tokens_byte_capped};
use crate::threads::ThreadRef;
use crate::turns::internal::compose::{
    compose_rendering_input, compose_structured_turn_text, stored_rendering_has_turn_label,
};
use crate::turns::internal::derivations::{
    read_member_messages, read_message_derivation_rows, read_turn_source,
};

/// Whole-item budget for one retrieval call. Callers may override per call.
pub const DEFAULT_RETRIEVAL_TOKEN_BUDGET: i64 = 8_000;

/// A partial serve only starts when at least this much budget remains — a
/// smaller sliver teaches nothing. Explicit `from_token` continuations are
/// exempt: the caller asked for exactly that window.
pub const RETRIEVAL_SLICE_FLOOR: i64 = 256;

/// Hard cap on deduped ids per retrieval call. Bodies are token-budgeted,
/// but per-id receipts are not — this bounds the whole model-visible
/// result (validator P0, 2026-08-08 / TS `MAX_RETRIEVAL_IDS_PER_CALL`).
pub const MAX_RETRIEVAL_IDS_PER_CALL: usize = 32;

/// Valid retrieval id shape: `t` or `m` followed by 1–12 digits. Anything
/// else is refused per-id as `"invalid"` — ids are echoed into receipts and
/// impression rows, so shape validation is also a length bound (validator
/// P0, 2026-08-08 / TS `RETRIEVAL_ID_PATTERN`).
pub const RETRIEVAL_ID_PATTERN: &str = r"^[tm]\d{1,12}$";

/// Analytic ceiling on a model-visible retrieval assembly. Conservative
/// component derivation (validator, 2026-08-08) in `format` → sum 21_526 →
/// round up next 500 = **22_000**. Dominates every reachable case by
/// construction (no measurement treadmill). **Not** enforced by runtime
/// truncation (TS parity / Fable R6 analytic).
pub const MAX_RETRIEVAL_OUTPUT_TOKENS: i64 = 22_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<f64>,
    /// Optional per-call BYTE budget over served item text (UTF-8). Hosts
    /// whose runtimes enforce output limits in bytes (codex core truncates
    /// FunctionCallOutput at bytes/4-per-token approximations) pass their
    /// allowance here; serving slices to fit both budgets, so receipts and
    /// impressions describe exactly what the model can see (TS parity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_budget: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_token: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnservedReason {
    NotFound,
    Deleted,
    Budget,
    Invalid,
}

impl UnservedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            UnservedReason::NotFound => "not_found",
            UnservedReason::Deleted => "deleted",
            UnservedReason::Budget => "budget",
            UnservedReason::Invalid => "invalid",
        }
    }
}

/// Echo bound for invalid ids in receipts/impressions (TS `clampIdEcho`).
/// Counts **UTF-16 code units** so non-ASCII echoes are byte-identical with
/// TS `id.slice(0, 32) + "…"`.
pub fn clamp_id_echo(id: &str) -> String {
    if js_len(id) <= 32 {
        id.to_string()
    } else {
        format!("{}…", js_slice(id, 0, Some(32)))
    }
}

fn is_valid_retrieval_id(id: &str) -> bool {
    // ^[tm]\d{1,12}$ without a regex crate dependency.
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 13 {
        return false;
    }
    let first = bytes[0];
    if first != b't' && first != b'm' {
        return false;
    }
    let digits = &bytes[1..];
    if digits.is_empty() || digits.len() > 12 {
        return false;
    }
    digits.iter().all(|b| b.is_ascii_digit())
}

/// Window receipt on a partially served item: `[from_token, to_token)` of
/// `total_tokens` was served. Absent when the full text was served.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceReceipt {
    pub from_token: i64,
    pub to_token: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnservedEntity {
    pub id: String,
    pub reason: UnservedReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievedTurnSource {
    Stored,
    Composed,
}

impl RetrievedTurnSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RetrievedTurnSource::Stored => "stored",
            RetrievedTurnSource::Composed => "composed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedTurn {
    pub turn_id: String,
    /// Tagged rendering (`<tN>` wrap, `<mN>` message tags).
    pub text: String,
    pub tokens: i64,
    /// "stored" = ready turn_rendering derivation; "composed" = live fallback
    /// composition from current message forms (derivation not ready / legacy).
    pub source: RetrievedTurnSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slice: Option<SliceReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedMessage {
    pub message_id: String,
    pub turn_id: String,
    pub kind: String,
    /// Verbatim historical content (tool args/results as recorded).
    pub text: String,
    pub tokens: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slice: Option<SliceReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalReceipt<T> {
    /// Correlates the impression rows this call wrote.
    pub call_id: String,
    pub served: Vec<T>,
    pub unserved: Vec<UnservedEntity>,
    pub total_tokens: i64,
    pub token_budget: i64,
}

#[derive(Debug, Clone)]
struct ImpressionRow {
    entity_kind: &'static str,
    entity_id: String,
    request_idx: i64,
    served: bool,
    reason: Option<UnservedReason>,
    tokens: Option<i64>,
}

fn write_impressions(db: &Db, call_id: &str, surface: &str, rows: &[ImpressionRow]) {
    let insert = db.prepare(
        r#"INSERT INTO retrieval_impression
       (call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
    );
    for row in rows {
        insert.run(&[
            SqlParam::from(call_id),
            SqlParam::from(surface),
            SqlParam::from(row.entity_kind),
            SqlParam::from(row.entity_id.as_str()),
            SqlParam::from(row.request_idx),
            SqlParam::from(if row.served { 1i64 } else { 0i64 }),
            match &row.reason {
                Some(r) => SqlParam::from(r.as_str()),
                None => SqlParam::Null,
            },
            match row.tokens {
                Some(t) => SqlParam::from(t),
                None => SqlParam::Null,
            },
        ]);
    }
}

/// First occurrence wins; duplicate requests collapse to one serve/impression.
fn dedupe(ids: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
    }
    out
}

enum CandidateOutcome<T> {
    Servable { item: T, tokens: i64 },
    Unservable { reason: UnservedReason },
}

struct Candidate<T> {
    id: String,
    outcome: CandidateOutcome<T>,
}

/// In-order budget walk shared by both ops.
fn budget_walk<T: Clone>(
    candidates: &[Candidate<T>],
    entity_kind: &'static str,
    token_budget: i64,
    byte_budget: Option<usize>,
    from_token: i64,
    text_of: impl Fn(&T) -> &str,
    with_slice: impl Fn(T, String, i64, SliceReceipt) -> T,
) -> (Vec<T>, Vec<UnservedEntity>, i64, Vec<ImpressionRow>) {
    let mut served = Vec::new();
    let mut unserved = Vec::new();
    let mut impressions = Vec::new();
    let mut total_tokens = 0i64;
    let mut total_bytes = 0usize;

    for (request_idx, candidate) in candidates.iter().enumerate() {
        let request_idx = request_idx as i64;
        match &candidate.outcome {
            CandidateOutcome::Unservable { reason } => {
                unserved.push(UnservedEntity {
                    id: candidate.id.clone(),
                    reason: *reason,
                    tokens: None,
                });
                impressions.push(ImpressionRow {
                    entity_kind,
                    entity_id: candidate.id.clone(),
                    request_idx,
                    served: false,
                    reason: Some(*reason),
                    tokens: None,
                });
            }
            CandidateOutcome::Servable { item, tokens } => {
                let remaining = token_budget - total_tokens;
                let remaining_bytes = byte_budget.map(|budget| budget.saturating_sub(total_bytes));

                // Whole serve: no offset requested and the full text fits
                // BOTH budgets.
                if from_token == 0
                    && *tokens <= remaining
                    && remaining_bytes.is_none_or(|b| text_of(item).len() <= b)
                {
                    served.push(item.clone());
                    total_tokens += tokens;
                    total_bytes += text_of(item).len();
                    impressions.push(ImpressionRow {
                        entity_kind,
                        entity_id: candidate.id.clone(),
                        request_idx,
                        served: true,
                        reason: None,
                        tokens: Some(*tokens),
                    });
                    continue;
                }

                // Partial serve: explicit continuation always slices; a
                // budget-crossing item slices only when enough budget remains.
                if from_token > 0 || remaining >= RETRIEVAL_SLICE_FLOOR {
                    let window = match remaining_bytes {
                        Some(max_bytes) => slice_tokens_byte_capped(
                            text_of(item),
                            from_token,
                            remaining,
                            max_bytes,
                        ),
                        None => slice_tokens(text_of(item), from_token, remaining),
                    };
                    let served_tokens = window.to_token - window.from_token;
                    // Sub-floor serves under TOKEN pressure teach nothing —
                    // report "budget" so the model re-pulls alone. But when
                    // the BYTE budget bound the window, re-pulling alone
                    // cannot yield more: serve the byte-fit slice, however
                    // small. Explicit continuations serve whatever fits,
                    // including the empty past-the-end slice (its receipt IS
                    // the answer). (TS parity, A3 round-5 findings 1-2.)
                    let token_window =
                        remaining.min((window.total_tokens - window.from_token).max(0));
                    let byte_bound = remaining_bytes.is_some() && served_tokens < token_window;
                    let sliver = !byte_bound
                        && from_token == 0
                        && served_tokens < RETRIEVAL_SLICE_FLOOR.min(*tokens);
                    if sliver {
                        unserved.push(UnservedEntity {
                            id: candidate.id.clone(),
                            reason: UnservedReason::Budget,
                            tokens: Some(*tokens),
                        });
                        impressions.push(ImpressionRow {
                            entity_kind,
                            entity_id: candidate.id.clone(),
                            request_idx,
                            served: false,
                            reason: Some(UnservedReason::Budget),
                            tokens: Some(*tokens),
                        });
                        continue;
                    }
                    let receipt = SliceReceipt {
                        from_token: window.from_token,
                        to_token: window.to_token,
                        total_tokens: window.total_tokens,
                    };
                    total_bytes += window.text.len();
                    let sliced = with_slice(item.clone(), window.text, served_tokens, receipt);
                    served.push(sliced);
                    total_tokens += served_tokens;
                    impressions.push(ImpressionRow {
                        entity_kind,
                        entity_id: candidate.id.clone(),
                        request_idx,
                        served: true,
                        reason: None,
                        tokens: Some(served_tokens),
                    });
                    continue;
                }

                unserved.push(UnservedEntity {
                    id: candidate.id.clone(),
                    reason: UnservedReason::Budget,
                    tokens: Some(*tokens),
                });
                impressions.push(ImpressionRow {
                    entity_kind,
                    entity_id: candidate.id.clone(),
                    request_idx,
                    served: false,
                    reason: Some(UnservedReason::Budget),
                    tokens: Some(*tokens),
                });
            }
        }
    }

    (served, unserved, total_tokens, impressions)
}

fn resolve_budget(options: Option<&RetrievalOptions>) -> Result<i64, String> {
    let budget = options
        .and_then(|o| o.token_budget)
        .unwrap_or(DEFAULT_RETRIEVAL_TOKEN_BUDGET as f64);
    if !budget.is_finite() || budget <= 0.0 {
        return Err(format!(
            "retrieval tokenBudget must be a positive number, got {budget}"
        ));
    }
    // The default is also the ceiling: callers cannot raise the model-visible
    // bound above what the serving contract promises (validator P0).
    Ok((budget as i64).min(DEFAULT_RETRIEVAL_TOKEN_BUDGET))
}

fn resolve_byte_budget(options: Option<&RetrievalOptions>) -> Result<Option<usize>, String> {
    let Some(budget) = options.and_then(|o| o.byte_budget) else {
        return Ok(None);
    };
    if budget.is_nan() || budget <= 0.0 {
        return Err(format!(
            "retrieval byteBudget must be a positive number, got {budget}"
        ));
    }
    if budget.is_infinite() {
        return Ok(None);
    }
    Ok(Some(budget as usize))
}

fn resolve_from_token(options: Option<&RetrievalOptions>) -> Result<i64, String> {
    let from = options.and_then(|o| o.from_token).unwrap_or(0.0);
    if !from.is_finite() || from.fract() != 0.0 || from < 0.0 {
        return Err(format!(
            "retrieval fromToken must be a non-negative integer, got {from}"
        ));
    }
    Ok(from as i64)
}

fn turn_candidate(db: &Db, turn_id: &str) -> Candidate<RetrievedTurn> {
    let Some(source) = read_turn_source(db, turn_id) else {
        return Candidate {
            id: turn_id.to_string(),
            outcome: CandidateOutcome::Unservable {
                reason: UnservedReason::NotFound,
            },
        };
    };
    if source.deleted {
        return Candidate {
            id: turn_id.to_string(),
            outcome: CandidateOutcome::Unservable {
                reason: UnservedReason::Deleted,
            },
        };
    }

    let stored = db
        .prepare(
            r#"SELECT state, content FROM derivation
       WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'"#,
        )
        .get_params(&[SqlParam::from(turn_id)]);

    let stored_content = stored.and_then(|row| {
        let state = row.get("state").and_then(|v| v.as_str())?;
        if state != "ready" {
            return None;
        }
        match row.get("content") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        }
    });

    if let Some(ref content) = stored_content {
        if stored_rendering_has_turn_label(content, turn_id) {
            let tokens = estimate_tokens(content);
            return Candidate {
                id: turn_id.to_string(),
                outcome: CandidateOutcome::Servable {
                    item: RetrievedTurn {
                        turn_id: turn_id.to_string(),
                        text: content.clone(),
                        tokens,
                        source: RetrievedTurnSource::Stored,
                        slice: None,
                    },
                    tokens,
                },
            };
        }
    }

    // Live fallback: compose from current message forms (pure; no writes).
    // Also covers ready-but-legacy unlabeled stored renderings (R3 carry-over).
    let members = read_member_messages(db, turn_id);
    let message_ids: Vec<String> = members.iter().map(|m| m.message_id.clone()).collect();
    let derivations = read_message_derivation_rows(db, &message_ids);
    let composition = compose_rendering_input(&members, &derivations);
    let text = compose_structured_turn_text(&composition.parts, turn_id);
    let tokens = estimate_tokens(&text);
    Candidate {
        id: turn_id.to_string(),
        outcome: CandidateOutcome::Servable {
            item: RetrievedTurn {
                turn_id: turn_id.to_string(),
                text,
                tokens,
                source: RetrievedTurnSource::Composed,
                slice: None,
            },
            tokens,
        },
    }
}

/// Verbatim text of one message from its stored blocks — the historical
/// artifact as recorded, not a summary.
fn verbatim_text(blocks: &[(String, Map<String, Value>)]) -> String {
    let mut parts = Vec::new();
    for (block_type, content) in blocks {
        match block_type.as_str() {
            "text" => {
                let text = match content.get("text") {
                    Some(Value::String(s)) => s.clone(),
                    other => js_json_stringify(other.unwrap_or(&Value::Null)),
                };
                parts.push(text);
            }
            "tool_call" => {
                let name = match content.get("toolName") {
                    Some(Value::String(s)) => s.as_str(),
                    _ => "tool",
                };
                let call_id = match content.get("toolCallId") {
                    Some(Value::String(s)) => s.as_str(),
                    _ => "",
                };
                let args = content.get("arguments").cloned().unwrap_or(Value::Null);
                // TS JSON.stringify(…, null, 2)
                let args_pretty = js_json_stringify_pretty(&args);
                let id_part = if call_id.is_empty() {
                    String::new()
                } else {
                    format!(" {call_id}")
                };
                parts.push(format!("[tool_call {name}{id_part}]\n{args_pretty}"));
            }
            "tool_result" => {
                let call_id = match content.get("toolCallId") {
                    Some(Value::String(s)) => s.as_str(),
                    _ => "",
                };
                let is_error = matches!(content.get("isError"), Some(Value::Bool(true)));
                let body = match content.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    other => js_json_stringify(other.unwrap_or(&Value::Null)),
                };
                let id_part = if call_id.is_empty() {
                    String::new()
                } else {
                    format!(" {call_id}")
                };
                let err_part = if is_error { " ERROR" } else { "" };
                parts.push(format!("[tool_result{id_part}{err_part}]\n{body}"));
            }
            other => {
                parts.push(format!(
                    "[{other}]\n{}",
                    js_json_stringify_pretty(&Value::Object(content.clone()))
                ));
            }
        }
    }
    parts.join("\n")
}

fn message_candidate(db: &Db, message_id: &str) -> Candidate<RetrievedMessage> {
    let row = db
        .prepare("SELECT message_id, turn_id, kind, deleted_at FROM message WHERE message_id = ?")
        .get_params(&[SqlParam::from(message_id)]);
    let Some(row) = row else {
        return Candidate {
            id: message_id.to_string(),
            outcome: CandidateOutcome::Unservable {
                reason: UnservedReason::NotFound,
            },
        };
    };
    if !matches!(row.get("deleted_at"), None | Some(Value::Null)) {
        return Candidate {
            id: message_id.to_string(),
            outcome: CandidateOutcome::Unservable {
                reason: UnservedReason::Deleted,
            },
        };
    }
    let turn_id = row
        .get("turn_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let kind = row
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let block_rows = db
        .prepare(
            "SELECT block_type, content FROM message_block WHERE message_id = ? ORDER BY block_index",
        )
        .all(&[SqlParam::from(message_id)]);
    let mut blocks = Vec::new();
    for br in block_rows {
        let block_type = br
            .get("block_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let content_raw = br.get("content").and_then(|v| v.as_str()).unwrap_or("{}");
        let content_value: Value =
            serde_json::from_str(content_raw).unwrap_or_else(|err| panic!("{err}"));
        let content = match content_value {
            Value::Object(map) => map,
            other => panic!("message block content not object: {other}"),
        };
        blocks.push((block_type, content));
    }
    let text = verbatim_text(&blocks);
    let tokens = estimate_tokens(&text);
    Candidate {
        id: message_id.to_string(),
        outcome: CandidateOutcome::Servable {
            item: RetrievedMessage {
                message_id: message_id.to_string(),
                turn_id,
                kind,
                text,
                tokens,
                slice: None,
            },
            tokens,
        },
    }
}

fn generate_call_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("generate retrieval call id entropy");
    // UUID v4-ish hex with dashes (format not load-bearing; uniqueness is).
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        (bytes[6] & 0x0f) | 0x40,
        bytes[7],
        (bytes[8] & 0x3f) | 0x80,
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

async fn retrieve<T: Clone + Send + 'static>(
    ref_: ThreadRef,
    ids: &[String],
    options: Option<RetrievalOptions>,
    default_surface: &'static str,
    entity_kind: &'static str,
    candidate_of: fn(&Db, &str) -> Candidate<T>,
    text_of: fn(&T) -> &str,
    with_slice: fn(T, String, i64, SliceReceipt) -> T,
) -> OpResult<RetrievalReceipt<T>> {
    let token_budget = match resolve_budget(options.as_ref()) {
        Ok(b) => b,
        Err(msg) => return storage_failure(&msg),
    };
    let byte_budget = match resolve_byte_budget(options.as_ref()) {
        Ok(b) => b,
        Err(msg) => return storage_failure(&msg),
    };
    let from_token = match resolve_from_token(options.as_ref()) {
        Ok(f) => f,
        Err(msg) => return storage_failure(&msg),
    };
    if ids.is_empty() {
        return storage_failure(&format!("{default_surface}: at least one id is required"));
    }
    // Hard bound on the whole model-visible result: bodies are budgeted, but
    // receipts/footers scale with id count — unbounded ids means unbounded
    // output. Refuse over-cap calls whole with a receipt naming the cap.
    let deduped_len = dedupe(ids).len();
    if deduped_len > MAX_RETRIEVAL_IDS_PER_CALL {
        return storage_failure(&format!(
            "{default_surface}: too many ids — {deduped_len} requested, cap is {MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request"
        ));
    }
    let surface = options
        .as_ref()
        .and_then(|o| o.surface.clone())
        .unwrap_or_else(|| default_surface.to_string());
    let call_id = generate_call_id();
    let ids: Vec<String> = ids.to_vec();

    match create_db_write_transaction(
        ref_,
        move |transaction| {
            Box::pin(async move {
                let candidates: Vec<Candidate<T>> = dedupe(&ids)
                    .into_iter()
                    .map(|id| {
                        if is_valid_retrieval_id(&id) {
                            candidate_of(transaction.db, &id)
                        } else {
                            Candidate {
                                id: clamp_id_echo(&id),
                                outcome: CandidateOutcome::Unservable {
                                    reason: UnservedReason::Invalid,
                                },
                            }
                        }
                    })
                    .collect();
                let (served, unserved, total_tokens, impressions) = budget_walk(
                    &candidates,
                    entity_kind,
                    token_budget,
                    byte_budget,
                    from_token,
                    text_of,
                    with_slice,
                );
                write_impressions(transaction.db, &call_id, &surface, &impressions);
                RetrievalReceipt {
                    call_id,
                    served,
                    unserved,
                    total_tokens,
                    token_budget,
                }
            })
        },
        None,
    )
    .await
    {
        OpResult::Ok { value } => OpResult::Ok { value },
        OpResult::Err { error } => {
            // Re-wrap with surface prefix when not already a caller budget error.
            if error.reason.starts_with("retrieval ") {
                OpResult::Err { error }
            } else {
                storage_failure(&format!("{default_surface} failed: {}", error.reason))
            }
        }
    }
}

fn turn_text(t: &RetrievedTurn) -> &str {
    &t.text
}

fn turn_with_slice(
    mut item: RetrievedTurn,
    text: String,
    tokens: i64,
    slice: SliceReceipt,
) -> RetrievedTurn {
    item.text = text;
    item.tokens = tokens;
    item.slice = Some(slice);
    item
}

fn message_text(m: &RetrievedMessage) -> &str {
    &m.text
}

fn message_with_slice(
    mut item: RetrievedMessage,
    text: String,
    tokens: i64,
    slice: SliceReceipt,
) -> RetrievedMessage {
    item.text = text;
    item.tokens = tokens;
    item.slice = Some(slice);
    item
}

/// Rendered turns by turn id, in request order, under a whole-item budget.
pub async fn get_turns(
    ref_: ThreadRef,
    turn_ids: &[String],
    options: Option<RetrievalOptions>,
) -> OpResult<RetrievalReceipt<RetrievedTurn>> {
    retrieve(
        ref_,
        turn_ids,
        options,
        "get_turns",
        "turn",
        turn_candidate,
        turn_text,
        turn_with_slice,
    )
    .await
}

/// Verbatim messages by message id, in request order, under a whole-item budget.
pub async fn get_messages(
    ref_: ThreadRef,
    message_ids: &[String],
    options: Option<RetrievalOptions>,
) -> OpResult<RetrievalReceipt<RetrievedMessage>> {
    retrieve(
        ref_,
        message_ids,
        options,
        "get_messages",
        "message",
        message_candidate,
        message_text,
        message_with_slice,
    )
    .await
}

/// Impression read-back (inspection/test seam; ranking work reads this later).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpressionRecord {
    pub call_id: String,
    pub surface: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub request_idx: i64,
    pub served: bool,
    pub reason: Option<String>,
    pub tokens: Option<i64>,
    pub recorded_at: String,
}

pub async fn list_impressions(ref_: ThreadRef) -> OpResult<Vec<ImpressionRecord>> {
    match create_db_read_transaction(ref_, |transaction| {
        Box::pin(async move {
            let rows = transaction
                .db
                .prepare(
                    r#"SELECT call_id, surface, entity_kind, entity_id, request_idx, served, reason, tokens, recorded_at
           FROM retrieval_impression ORDER BY impression_id"#,
                )
                .all(&[]);
            rows.into_iter()
                .map(|row| ImpressionRecord {
                    call_id: row
                        .get("call_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    surface: row
                        .get("surface")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    entity_kind: row
                        .get("entity_kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    entity_id: row
                        .get("entity_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    request_idx: row
                        .get("request_idx")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    served: row.get("served").and_then(|v| v.as_i64()) == Some(1),
                    reason: match row.get("reason") {
                        Some(Value::String(s)) => Some(s.clone()),
                        _ => None,
                    },
                    tokens: match row.get("tokens") {
                        Some(Value::Number(n)) => n.as_i64(),
                        _ => None,
                    },
                    recorded_at: row
                        .get("recorded_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect::<Vec<_>>()
        })
    })
    .await
    {
        OpResult::Ok { value } => OpResult::Ok { value },
        OpResult::Err { error } => {
            storage_failure(&format!("impression read-back failed: {}", error.reason))
        }
    }
}

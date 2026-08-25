//! Shared helpers for the turn-parts suites (ported from the TS test files'
//! local helpers: step(), closedTurn(), stepSums(), params(), compact()).

use std::collections::HashMap;

use lhc::intake_stream::{EventKind, MessageEventInput};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::view::{
    CompactReceipt, LlmRequestContext, PartialViewProfilePercentages, ViewCompactParams,
};
use lhc::thread_view::internal::select::ArrangementEntry;
use lhc::thread_view::{
    self, CompactOpts, InstallPreparedOptions, PreparedCompact, install_prepared_compact,
    prepare_compact,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};
use serde_json::{Value, json};

use super::{TempStore, create_inference_callbacks_double, open_raw, valid_event_for_kind};

pub const PINNED_CREATED_AT: &str = "2026-08-24T00:00:00.000Z";

pub fn sdk_for() -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    })
}

pub fn file_ref(file_path: &str) -> ThreadRef {
    ThreadRef::file_path(file_path)
}

pub async fn new_thread(sdk: &Lhc, store: &TempStore) -> String {
    new_thread_named(sdk, store, None).await
}

pub async fn new_thread_named(sdk: &Lhc, store: &TempStore, name: Option<&str>) -> String {
    let file_path = store.thread_path(name).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    match created {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("thread creation failed: {}", error.reason),
    }
}

pub async fn send(sdk: &Lhc, file_path: &str, events: &[MessageEventInput]) {
    let sent = sdk
        .intake_stream
        .message_events(file_ref(file_path), events)
        .await;
    if let OpResult::Err { error } = sent {
        panic!("intake failed: {}", error.reason);
    }
}

pub fn event(kind: EventKind, payload: Value) -> MessageEventInput {
    let mut e = valid_event_for_kind(kind);
    e.payload = payload.as_object().expect("payload object").clone();
    e
}

pub fn prompt(text: &str) -> MessageEventInput {
    event(EventKind::UserPrompt, json!({ "text": text }))
}

pub fn turn_end() -> MessageEventInput {
    valid_event_for_kind(EventKind::TurnEnd)
}

/// One complete step: text, a call, its result. `stepIndex` is the host fact.
pub fn step(step_index: i64, label: &str) -> Vec<MessageEventInput> {
    step_weighted(step_index, label, 6)
}

pub fn step_weighted(step_index: i64, label: &str, weight: usize) -> Vec<MessageEventInput> {
    let body = format!("{label} ").repeat(weight).trim().to_string();
    vec![
        event(
            EventKind::AssistantText,
            json!({ "text": format!("step {step_index}: {body}"), "stepIndex": step_index }),
        ),
        event(
            EventKind::ToolCall,
            json!({
                "toolCallId": format!("c{step_index}-{label}"),
                "toolName": "read",
                "arguments": { "step": step_index },
                "stepIndex": step_index
            }),
        ),
        event(
            EventKind::ToolResult,
            json!({
                "toolCallId": format!("c{step_index}-{label}"),
                "content": format!("result {step_index}: {body}"),
                "stepIndex": step_index
            }),
        ),
    ]
}

/// Over the construction cap: an oversized message body.
pub fn giant() -> String {
    (0..300)
        .map(|i| format!("line {i} of a very long assistant message body"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn closed_turn(label: &str) -> Vec<MessageEventInput> {
    vec![
        prompt(&format!("{label} prompt")),
        event(
            EventKind::AssistantText,
            json!({ "text": format!("{label} answer") }),
        ),
        turn_end(),
    ]
}

pub fn closed_turn_weighted(label: &str, weight: usize) -> Vec<MessageEventInput> {
    let answer = format!("{label} answer ").repeat(weight).trim().to_string();
    vec![
        prompt(&format!("{label} prompt")),
        event(EventKind::AssistantText, json!({ "text": answer })),
        turn_end(),
    ]
}

pub struct Sums {
    /// token sum of live messages after each step's edge, by host step index
    pub after: HashMap<i64, i64>,
    pub edge: HashMap<i64, i64>,
}

pub fn step_sums(file_path: &str, turn_id: &str) -> Sums {
    let db = open_raw(file_path);
    let edges = db
        .prepare(
            "SELECT step_index AS s, MAX(source_event_order) AS edge FROM message
         WHERE turn_id = ? AND step_index IS NOT NULL GROUP BY step_index ORDER BY step_index",
        )
        .all(&[SqlParam::from(turn_id)]);
    let mut after = HashMap::new();
    let mut edge = HashMap::new();
    for row in edges {
        let s = row["s"].as_i64().expect("step");
        let e = row["edge"].as_i64().expect("edge");
        let sum = db
            .prepare(
                "SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE source_event_order > ? AND deleted_at IS NULL",
            )
            .get_params(&[SqlParam::from(e)])
            .and_then(|r| r["t"].as_i64())
            .unwrap_or(0);
        after.insert(s, sum);
        edge.insert(s, e);
    }
    db.close();
    Sums { after, edge }
}

pub fn tokens_after_step(file_path: &str, turn_id: &str, step_index: i64) -> i64 {
    *step_sums(file_path, turn_id)
        .after
        .get(&step_index)
        .expect("step present")
}

pub fn turn_tokens(file_path: &str, turn_id: &str) -> i64 {
    let db = open_raw(file_path);
    let t = db
        .prepare("SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE turn_id = ?")
        .get_params(&[SqlParam::from(turn_id)])
        .and_then(|r| r["t"].as_i64())
        .unwrap_or(0);
    db.close();
    t
}

pub fn scalar_i64(file_path: &str, sql: &str) -> i64 {
    let db = open_raw(file_path);
    let v = db
        .prepare(sql)
        .get()
        .and_then(|r| r.values().next().and_then(Value::as_i64))
        .unwrap_or(0);
    db.close();
    v
}

pub fn scalar_str(file_path: &str, sql: &str) -> Option<String> {
    let db = open_raw(file_path);
    let v = db.prepare(sql).get().and_then(|r| {
        r.values()
            .next()
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    db.close();
    v
}

/// Text whose stored estimate is exactly `tokens`.
pub fn fill(tokens: i64) -> String {
    let words = ["alpha", "beta", "gamma", "delta", "omega", "sigma"];
    let mut count = tokens;
    for _ in 0..200 {
        let text = (0..count)
            .map(|j| words[(j as usize) % words.len()])
            .collect::<Vec<_>>()
            .join(" ");
        let measured = estimate_tokens(&text);
        if measured == tokens {
            return text;
        }
        count += if measured < tokens { 1 } else { -1 };
    }
    panic!("fill({tokens}) did not converge");
}

pub fn shares(full: f64, smooth: f64, detailed: f64, brief: f64) -> PartialViewProfilePercentages {
    PartialViewProfilePercentages {
        full: Some(full),
        smooth: Some(smooth),
        detailed: Some(detailed),
        brief: Some(brief),
    }
}

/// The split rule is proven with newest-closed protection off (Flow 5 has its
/// own seam file); with it on, the tiny closed t1 plus the whole open turn
/// would fit the bound and the walk would rightly not split.
pub fn params(lower_bound: i64) -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(lower_bound as f64),
        percentages: Some(shares(50.0, 20.0, 15.0, 15.0)),
        newest_closed_protection: Some(0.0),
    }
}

pub fn opts(p: ViewCompactParams) -> CompactOpts {
    CompactOpts {
        profile: None,
        params: Some(p),
        signal: None,
        compact_point_upper_bound: None,
    }
}

pub struct Compacted {
    pub entries: Vec<ArrangementEntry>,
    pub receipt: CompactReceipt,
}

pub async fn prepare(file_path: &str, p: ViewCompactParams) -> PreparedCompact {
    match prepare_compact(file_ref(file_path), opts(p)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("prepare failed: {}", error.reason),
    }
}

/// prepare → install with a pinned createdAt (TS `compact()` helper).
pub async fn compact_pinned(file_path: &str, p: ViewCompactParams) -> Compacted {
    let prepared = prepare(file_path, p).await;
    let entries = prepared.selection.entries.clone();
    let receipt = install_prepared_compact(
        file_ref(file_path),
        prepared,
        InstallPreparedOptions {
            created_at: Some(PINNED_CREATED_AT.to_string()),
            ..InstallPreparedOptions::default()
        },
    )
    .await;
    match receipt {
        OpResult::Ok { value } => Compacted {
            entries,
            receipt: value,
        },
        OpResult::Err { error } => panic!("install failed: {}", error.reason),
    }
}

pub async fn compact(sdk: &Lhc, file_path: &str, p: ViewCompactParams) -> CompactReceipt {
    match sdk.thread_view.compact(file_ref(file_path), opts(p)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("compact failed: {}", error.reason),
    }
}

pub async fn describe(file_path: &str) -> lhc::shared_tech::view::StoredView {
    match thread_view::describe(file_ref(file_path)).await {
        OpResult::Ok { value } => value.expect("installed view"),
        OpResult::Err { error } => panic!("describe failed: {}", error.reason),
    }
}

pub async fn host_metadata(file_path: &str) -> lhc::shared_tech::view::HostMetadata {
    match thread_view::host_metadata(file_ref(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("host metadata failed: {}", error.reason),
    }
}

pub async fn context(file_path: &str) -> LlmRequestContext {
    match thread_view::get_llm_request_context(file_ref(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("context failed: {}", error.reason),
    }
}

pub fn context_texts(ctx: &LlmRequestContext) -> Vec<String> {
    ctx.messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .map(|c| c.text.as_str())
                .collect::<String>()
        })
        .collect()
}

pub async fn served_json(file_path: &str) -> String {
    lhc::shared_tech::js_json::js_json_stringify(
        &serde_json::to_value(&context(file_path).await.messages).expect("json"),
    )
}

pub async fn drain_to_zero(sdk: &Lhc, file_path: &str) {
    match sdk.work.drain(file_ref(file_path), None).await {
        OpResult::Ok { value } => assert_eq!(value.remaining, 0, "drain left work behind"),
        OpResult::Err { error } => panic!("drain failed: {}", error.reason),
    }
}

pub fn part_entry(entries: &[ArrangementEntry]) -> &ArrangementEntry {
    entries
        .iter()
        .find(|e| e.part.is_some())
        .expect("a part entry")
}

//! Ported from packages/lhc/test/fixtures/view-boundary.ts. Phase 1.
//!
//! Scripted turns for visibility-boundary intake and rendering tests.
//! Data-construction helpers are REAL; [`seed_turned_tool_results`] is
//! skeletal (SDK-calling).

use std::sync::atomic::{AtomicU64, Ordering};

use lhc::intake_stream::{self, MessageEventInput};
use lhc::sdk::Lhc;
use lhc::shared_tech::errors::OpResult;
use lhc::threads::ThreadRef;

use super::{
    ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload, TurnEndOverrides,
    UserPromptOverrides, UserPromptPayload, kind, valid_event,
};

/// "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
/// so a content of n joined "tok" words carries token_estimate n — the same
/// hand-derivable unit the boundary goldens use.
pub fn boundary_tokens(n: i64) -> String {
    // TS `Array(n).fill("tok").join(" ")`: zero → empty; negative throws
    // (mirrors JS `String.repeat` / `Array` RangeError — do not clamp).
    if n < 0 {
        panic!("Invalid count value: {n}");
    }
    if n == 0 {
        return String::new();
    }
    vec!["tok"; n as usize].join(" ")
}

static BOUNDARY_CALL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// One tool run: call + result with the given token count. If sent while a
/// turn is open, current intake stamps it with that turn.
pub fn boundary_tool_run(result_tokens: i64) -> Vec<MessageEventInput> {
    let n = BOUNDARY_CALL_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let tool_call_id = format!("call-tb-{n}");
    let mut args = serde_json::Map::new();
    args.insert(
        "path".into(),
        serde_json::Value::String(format!("tb-{n}.txt")),
    );
    vec![
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: tool_call_id.clone(),
                    tool_name: "read_file".into(),
                    arguments: args,
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id,
                    content: boundary_tokens(result_tokens),
                    is_error: Some(false),
                }),
                ..Default::default()
            },
        ),
    ]
}

/// One scripted turn's worth of tool results, sized in tokens.
///
/// `close: None` or `Some(true)` closes the turn; `Some(false)` leaves it
/// open (mid-turn legs). Matches TS `close?: boolean` with
/// `if (turn.close !== false)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnedToolResultsSpec {
    pub results: Vec<i64>,
    pub close: Option<bool>,
}

/// TS `turnedToolResultEvents`.
pub fn turned_tool_result_events(turns: &[TurnedToolResultsSpec]) -> Vec<MessageEventInput> {
    let mut events = Vec::new();
    for turn in turns {
        events.push(valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "scripted boundary turn".into(),
                }),
                ..Default::default()
            },
        ));
        for &n in &turn.results {
            events.extend(boundary_tool_run(n));
        }
        if turn.close != Some(false) {
            events.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
        }
    }
    events
}

/// TS `seedTurnedToolResults` — domain `intake_stream::message_events` is the
/// exact host-agnostic dependency (SDK intake wiring remains Wave 7).
pub async fn seed_turned_tool_results(
    _sdk: &Lhc,
    file_path: &str,
    turns: &[TurnedToolResultsSpec],
) {
    let result = intake_stream::message_events(
        ThreadRef::file_path(file_path),
        &turned_tool_result_events(turns),
    )
    .await;
    match result {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => {
            panic!("boundary seed intake failed: {}", error.reason);
        }
    }
}

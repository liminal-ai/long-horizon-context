//! Ported from packages/lhc/src/thread-view/internal/session-view.ts.

use serde_json::{Map, Value};

use super::render::TailRenderContext;
use super::snapshot::TailMessageRow;
use crate::shared_tech::storage::Db;
use crate::shared_tech::view::{
    Band, SessionAssistantPart, SessionThreadView, SessionThreadViewEntry,
    SessionThreadViewEntrySource,
};

// ── session-view literals (byte-exact from TS) ───────────────────

pub(crate) const LITERAL_CONTEXT_PREFIX: &str = "[context · ";
pub(crate) const LITERAL_CONTEXT_MID: &str = "]\n";
pub(crate) const LITERAL_UNKNOWN_TOOL: &str = "unknown_tool";
pub(crate) const LITERAL_RUNTIME_NOTE_PREFIX: &str = "[runtime note] ";

fn block_content(_message: &TailMessageRow) -> Map<String, Value> {
    todo!("phase 2")
}

fn text_of(_message: &TailMessageRow) -> String {
    todo!("phase 2")
}

fn entry_source(_message: &TailMessageRow) -> SessionThreadViewEntrySource {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedModelRef {
    provider: String,
    model_id: String,
}

fn parse_model_ref(_model: &str) -> Option<ParsedModelRef> {
    todo!("phase 2")
}

fn band_user_message(_band: Band, _rendered_text: &str) -> SessionThreadViewEntry {
    todo!("phase 2")
}

fn assistant_part_of(_message: &TailMessageRow) -> SessionAssistantPart {
    todo!("phase 2")
}

fn tool_result_of(_message: &TailMessageRow, _ctx: &TailRenderContext) -> SessionThreadViewEntry {
    todo!("phase 2")
}

fn model_change_of(_message: &TailMessageRow) -> Option<SessionThreadViewEntry> {
    todo!("phase 2")
}

fn thinking_level_change_of(_message: &TailMessageRow) -> SessionThreadViewEntry {
    todo!("phase 2")
}

/// TS nested `flushAssistant` inside `tailEntriesOf`.
fn flush_assistant(
    _pending: &mut Vec<SessionAssistantPart>,
    _pending_sources: &mut Vec<SessionThreadViewEntrySource>,
    _entries: &mut Vec<SessionThreadViewEntry>,
) {
    todo!("phase 2")
}

fn tail_entries_of(
    _rows: &[TailMessageRow],
    _boundary_position: i64,
) -> Vec<SessionThreadViewEntry> {
    todo!("phase 2")
}

pub fn build_session_thread_view(_db: &Db) -> SessionThreadView {
    todo!("phase 2")
}

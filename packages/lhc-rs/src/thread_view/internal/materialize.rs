//! Ported from packages/lhc/src/thread-view/internal/materialize.ts.
//!
//! PI session JSONL writer: the pure mapping from assembled entries to the
//! pinned PI session file format, plus the file write. This module never sees a
//! database handle; it renders what the serving assembly hands it, keeping
//! materialize/model-context parity structural.
//!
//! Format pin from repo-ref/pi/packages/coding-agent/src/core/session-manager.ts:
//! JSONL. Line 1 is the header `{ type: "session", version, id, timestamp,
//! cwd }`; each subsequent line is `{ type: "message", id, parentId, timestamp,
//! message: { role, content } }` with parentId chaining each entry to the
//! previous. Content is encoded as PI text blocks: user content may be a bare
//! string in PI, but assistant content must be a block array, so both roles use
//! the one block encoding.

use super::render::AssembledContextMessage;

/// CURRENT_SESSION_VERSION at the pin (PI coding agent 0.79.1) — see
/// test/fixtures/pi-session-structure.provenance.md.
pub const PI_SESSION_VERSION: i64 = 3;

/// One assembled entry with the metadata the file's generated fields derive from:
/// the entry id (message id for tail entries, viewId-band for band entries)
/// and the record-time timestamp (event recorded_at for tail entries, view
/// created-at for band entries). Never a write-time clock anywhere.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializeEntry {
    pub message: AssembledContextMessage,
    pub entry_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterializeInput {
    pub thread_id: String,
    /// The view's created-at, or the thread's created-at when never compacted
    /// (viewId null; the tail-only file still carries a valid header).
    pub header_timestamp: String,
    pub cwd: String,
    pub entries: Vec<MaterializeEntry>,
}

/// TS `writePiSessionFile` / `materialize` value `{ writtenPath: string }`.
/// One canonical type — re-exported from `thread_view` (not duplicated).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializeResult {
    pub written_path: String,
}

pub fn render_pi_session_lines(_input: &MaterializeInput) -> Vec<String> {
    todo!("phase 2")
}

pub fn write_pi_session_file(_input: &MaterializeInput, _path: &str) -> MaterializeResult {
    todo!("phase 2")
}

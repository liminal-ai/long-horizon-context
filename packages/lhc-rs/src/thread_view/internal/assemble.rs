//! Ported from packages/lhc/src/thread-view/internal/assemble.ts.

use super::boundary::read_boundary_position;
use super::render::{
    AssembledContextMessage, TailRenderContext, render_band_message, render_tail_message,
    tool_names_by_call_id,
};
use super::snapshot::{ViewSnapshot, read_tail_messages, read_view_snapshot};
use crate::shared_tech::storage::Db;

#[derive(Debug, Clone, PartialEq)]
pub struct AssembledViewEntry {
    pub message: AssembledContextMessage,
    pub entry_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssembledView {
    pub entries: Vec<AssembledViewEntry>,
    pub snapshot: Option<ViewSnapshot>,
}

pub fn assemble_view(db: &Db) -> AssembledView {
    let snapshot = read_view_snapshot(db);
    let compact_point = snapshot.as_ref().map(|s| s.compact_point).unwrap_or(0);
    let boundary_position = read_boundary_position(db);
    let tail_rows = read_tail_messages(db, compact_point);
    let render_ctx = TailRenderContext {
        boundary_position,
        tool_name_by_call_id: tool_names_by_call_id(&tail_rows),
    };

    let mut entries: Vec<AssembledViewEntry> = Vec::new();
    if let Some(ref snapshot) = snapshot {
        for band in &snapshot.bands {
            entries.push(AssembledViewEntry {
                message: render_band_message(band.band, &band.rendered_text),
                entry_id: format!("{}-{}", snapshot.view_id, band.band.as_str()),
                timestamp: snapshot.created_at.clone(),
            });
        }
    }
    for row in &tail_rows {
        entries.push(AssembledViewEntry {
            message: render_tail_message(row, &render_ctx),
            entry_id: row.message_id.clone(),
            timestamp: row.recorded_at.clone(),
        });
    }

    AssembledView { entries, snapshot }
}

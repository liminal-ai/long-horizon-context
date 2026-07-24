//! Ported from packages/lhc/src/thread-view/internal/assemble.ts.

use super::render::AssembledContextMessage;
use super::snapshot::ViewSnapshot;
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

pub fn assemble_view(_db: &Db) -> AssembledView {
    todo!("phase 2")
}

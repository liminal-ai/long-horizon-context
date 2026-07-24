//! Ported from packages/lhc/src/messages/internal/project.ts. Phase 1 skeleton.
//!
//! Event to message + typed blocks. Types REAL; `project_event` body todo.

use crate::messages::{Block, RecordedEvent};

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedMessage {
    pub blocks: Vec<Block>,
    pub token_estimate: i64,
}

/// turn_end is recorded in the event order but produces no message.
pub fn project_event(_event: &RecordedEvent) -> Option<ProjectedMessage> {
    todo!("phase 2")
}

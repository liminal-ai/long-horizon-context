//! Ported from packages/lhc/src/shared-tech/work-queue/index.ts.
//! Phase 1 PARTIAL stub — types Wave 1 tests need via BatchResult / count_live_items.
//! Full work-queue surface lands in a later wave.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::derivation::WorkHandler;
use super::storage::Db;

/// TS `WorkHandlerMap` = `Partial<Record<WorkKind, WorkHandler>>`.
pub type WorkHandlerMap = HashMap<WorkKind, WorkHandler>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

/// TS `countLiveItems(db)` — PARTIAL stub (later wave).
pub fn count_live_items(_db: &Db) -> i64 {
    todo!("phase 2")
}

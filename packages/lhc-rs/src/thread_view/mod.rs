//! Ported from packages/lhc/src/thread-view/index.ts.
//! Phase 1 PARTIAL stub — get_llm_request_context for Wave 1 tool-result-rendering.
//! Wave 4 test suites (messages-read) import `status` ahead of the thread-view
//! wave — minimal PARTIAL surface only; full thread-view wave fills the rest.
//! Wave 5 suites import [`CompactAbortSignal`] / [`CompactOpts`] / [`compact`].

use crate::shared_tech::errors::OpResult;
use crate::shared_tech::view::{CompactReceipt, LlmRequestContext, ViewCompactParams, ViewStatus};
use crate::threads::ThreadRef;

/// TS compact opts.signal — closed by-value Phase 1 snapshot `{ aborted: bool }`.
/// Mapped Wave 5 use is pre-aborted only; Phase 2 must audit live cancellation
/// semantics before behavior certification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactAbortSignal {
    pub aborted: bool,
}

/// Opts bag for compact / previewCompact — mirrors the TS inline object.
/// No `Default` derive (callers construct the closed shape directly).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactOpts {
    pub profile: Option<String>,
    pub params: Option<ViewCompactParams>,
    pub signal: Option<CompactAbortSignal>,
}

/// TS `getLlmRequestContext` — PARTIAL stub.
pub async fn get_llm_request_context(_ref: ThreadRef) -> OpResult<LlmRequestContext> {
    todo!("phase 2")
}

/// TS `status` — PARTIAL (Wave 4 messages-read DD-6 snapshot; full body later).
pub async fn status(_ref: ThreadRef) -> OpResult<ViewStatus> {
    todo!("phase 2")
}

/// TS `compact` — PARTIAL (Wave 5 chunk-compact-recovery).
pub async fn compact(_ref: ThreadRef, _opts: CompactOpts) -> OpResult<CompactReceipt> {
    todo!("phase 2")
}

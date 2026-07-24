//! Ported from packages/lhc/src/thread-view/index.ts.
//! Phase 1 PARTIAL stub — get_llm_request_context for Wave 1 tool-result-rendering.
//! Wave 4 test suites (messages-read) import `status` ahead of the thread-view
//! wave — minimal PARTIAL surface only; full thread-view wave fills the rest.

use crate::shared_tech::errors::OpResult;
use crate::shared_tech::view::{LlmRequestContext, ViewStatus};
use crate::threads::ThreadRef;

/// TS `getLlmRequestContext` — PARTIAL stub.
pub async fn get_llm_request_context(_ref: ThreadRef) -> OpResult<LlmRequestContext> {
    todo!("phase 2")
}

/// TS `status` — PARTIAL (Wave 4 messages-read DD-6 snapshot; full body later).
pub async fn status(_ref: ThreadRef) -> OpResult<ViewStatus> {
    todo!("phase 2")
}

//! Ported from packages/lhc/src/thread-view/index.ts.
//! Phase 1 PARTIAL stub — get_llm_request_context for Wave 1 tool-result-rendering.

use crate::shared_tech::errors::OpResult;
use crate::shared_tech::view::LlmRequestContext;
use crate::threads::ThreadRef;

/// TS `getLlmRequestContext` — PARTIAL stub.
pub async fn get_llm_request_context(_ref: ThreadRef) -> OpResult<LlmRequestContext> {
    todo!("phase 2")
}

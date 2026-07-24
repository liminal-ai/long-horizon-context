//! Ported from packages/lhc/test/fixtures/work-handlers.ts.
//!
//! Story 1's registered test handlers: one per work kind. Types, closed
//! [`WorkKind`] vocab, and callback signatures are REAL. Behavior bodies —
//! including [`register_test_work_handlers`] — are exact `todo!("phase 2")`.
//!
//! Python traps avoided: no `make_` rename; `onApplied` uses [`CompletionTx`]
//! (not an invented tx bag); no `Value` widening for kind/sourceRef; closed
//! [`WorkKind`] / [`DerivationType`] / inference subject vocab.

#![allow(dead_code)] // private helpers land ahead of Phase 2 bodies

use lhc::sdk::Lhc;
use lhc::shared_tech::derivation::{
    BoxFuture, CompletionTx, HandlerDerivationWrite, HandlerRunContext, InferenceCallbacks,
    InferenceResult,
};
use lhc::shared_tech::durable_work::{DurableWorkDispatcher, DurableWorkDispatcherMap};
use lhc::shared_tech::work_queue::{WorkHandlerMap, WorkKind};

use super::model_call::DerivationType;

/// Closed fixture work-kind list (TS `WORK_KINDS`). Insertion order matches TS.
const WORK_KINDS: &[WorkKind] = &[
    WorkKind::PromptSmoothing,
    WorkKind::ToolResultSummary,
    WorkKind::TurnDerivation,
    WorkKind::DetailedTurnCompression,
    WorkKind::ChunkSummaryDetailed,
    WorkKind::ChunkSummaryBrief,
];

/// TS `onHandlerStart` item: `{ workItemId; kind }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestHandlerStartItem {
    pub work_item_id: String,
    pub kind: String,
}

/// TS `TestHandlerHooks` — optional async `onHandlerStart`.
pub struct TestHandlerHooks {
    /// Fires when a handler begins running an item — i.e. after the item's
    /// claim committed and any earlier item's completion landed.
    pub on_handler_start: Option<Box<dyn Fn(TestHandlerStartItem) -> BoxFuture<()> + Send + Sync>>,
}

impl Default for TestHandlerHooks {
    fn default() -> Self {
        Self {
            on_handler_start: None,
        }
    }
}

/// TS `onApplied` callback — completion-tx hook (shared-tech [`CompletionTx`]).
type OnAppliedFn = Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>;

/// TS `deriveForTestWork` result union.
enum DeriveForTestWorkResult {
    Ok {
        derivations: Vec<HandlerDerivationWrite>,
        on_applied: Option<OnAppliedFn>,
    },
    Err {
        reason: String,
    },
}

/// TS `inferenceWrite` subjectKind: `"message" | "chunk"` — closed, no Turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InferenceWriteSubjectKind {
    Message,
    Chunk,
}

/// TS `inferenceWrite` result union.
enum InferenceWriteResult {
    Ok {
        derivations: Vec<HandlerDerivationWrite>,
    },
    Err {
        reason: String,
    },
}

/// TS `testWorkHandlers` — PARTIAL (Phase 1 exact todo).
pub fn test_work_handlers(
    _inference_callbacks: InferenceCallbacks,
    _hooks: Option<TestHandlerHooks>,
) -> WorkHandlerMap {
    todo!("phase 2")
}

/// TS `testWorkDispatchers` — PARTIAL (Phase 1 exact todo).
///
/// Exported from work-handlers.ts but not the fixtures barrel (`index.ts`).
pub fn test_work_dispatchers(
    _inference_callbacks: InferenceCallbacks,
    _hooks: Option<TestHandlerHooks>,
) -> DurableWorkDispatcherMap {
    todo!("phase 2")
}

/// TS `registerTestWorkHandlers` — PARTIAL (keep exact todo).
pub fn register_test_work_handlers(
    _sdk: &Lhc,
    _inference_callbacks: InferenceCallbacks,
    _hooks: Option<TestHandlerHooks>,
) {
    todo!("phase 2")
}

/// TS private `deriveForTestWork` — PARTIAL (Phase 1 exact todo).
async fn derive_for_test_work(
    _run: HandlerRunContext,
    _kind: WorkKind,
    _inference_callbacks: InferenceCallbacks,
    _source_id: String,
) -> DeriveForTestWorkResult {
    todo!("phase 2")
}

/// TS private `inferenceWrite` — PARTIAL (Phase 1 exact todo).
fn inference_write(
    _subject_kind: InferenceWriteSubjectKind,
    _subject_id: String,
    _derivation_type: DerivationType,
    _result: InferenceResult,
) -> InferenceWriteResult {
    todo!("phase 2")
}

/// TS private `wrap` closure factory — PARTIAL (Phase 1 exact todo).
fn wrap(_kind: WorkKind, _handlers: &WorkHandlerMap) -> DurableWorkDispatcher {
    todo!("phase 2")
}

/// TS private `wrapFromItem` — PARTIAL (Phase 1 exact todo).
fn wrap_from_item(_handlers: &WorkHandlerMap) -> DurableWorkDispatcher {
    todo!("phase 2")
}

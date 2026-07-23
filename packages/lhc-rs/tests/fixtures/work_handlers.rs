//! PARTIAL stub — faithful signature from packages/lhc/test/fixtures/work-handlers.ts.
//! Body lands with the work-handlers fixture wave.

use lhc::sdk::Lhc;
use lhc::shared_tech::derivation::{BoxFuture, InferenceCallbacks};

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

/// TS `registerTestWorkHandlers` — PARTIAL.
pub fn register_test_work_handlers(
    _sdk: &Lhc,
    _inference_callbacks: InferenceCallbacks,
    _hooks: Option<TestHandlerHooks>,
) {
    todo!("phase 2")
}

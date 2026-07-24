//! Ported from packages/lhc/src/inspect/internal/view-report.ts. Phase 1 skeleton.
//!
//! View-contents report composition uses only describe + model context. The
//! stored arrangement, gaps, config, per-band token counts, and source-state
//! provenance come from `threadView.describe`; serving cost comes from measuring
//! `threadView.getLlmRequestContext` messages with the shared estimator. Nothing
//! here recomputes selection, rendering, derivation choice, or boundary state.

#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use crate::shared_tech::errors::{OpResult, storage_failure};
use crate::shared_tech::inspect::ViewContentsReport;
#[allow(unused_imports)]
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::view::{Band, LlmRequestContextMessage};
#[allow(unused_imports)]
use crate::thread_view;
use crate::threads::ThreadRef;

/// TS private `BAND_ORDER` — brief → detailed → smooth served order.
#[allow(dead_code)]
const BAND_ORDER: &[Band] = &[Band::Brief, Band::Detailed, Band::Smooth];
// Inventory keepalive (const item, not a behavior body).

/// TS view-report cross-check diagnostic fragments — byte-exact.
///
/// Full message:
/// `view report cross-check failed: describe saw ${n} stored band(s) but model context produced ${m} band message(s); the view changed between reads`
#[allow(dead_code)]
const DIAG_VIEW_REPORT_CROSS_CHECK_PREFIX: &str = "view report cross-check failed: describe saw ";
#[allow(dead_code)]
const DIAG_VIEW_REPORT_CROSS_CHECK_MID: &str = " stored band(s) but model context produced ";
#[allow(dead_code)]
const DIAG_VIEW_REPORT_CROSS_CHECK_SUFFIX: &str =
    " band message(s); the view changed between reads";

fn message_text(_message: &LlmRequestContextMessage) -> String {
    todo!("phase 2")
}

fn measured_tokens(_messages: &[LlmRequestContextMessage]) -> i64 {
    todo!("phase 2")
}

pub async fn compose_view_report(_ref: ThreadRef) -> OpResult<ViewContentsReport> {
    todo!("phase 2")
}

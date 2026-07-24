//! Ported from packages/lhc/src/inspect/index.ts. Phase 1 skeleton.
//!
//! Inspect is a pure consumer of other public surfaces: it imports no internals,
//! owns no tables, calls no inference, and writes nothing. It reports repair
//! targets without executing repair; mutations stay on the owning surfaces.
//!
//! `view` reports the stored snapshot from `threadView.describe` plus the
//! serving cost measured from thread-view serving assembly, matching what agents
//! receive by construction.
//!
//! Reads-only is structural: every operation runs in the touch-suppressed scope,
//! so open announcements fired by composed surfaces cannot let background
//! scheduling hang catch-up work or inference off an inspect read.

pub mod internal;

use crate::shared_tech::errors::OpResult;
use crate::threads::ThreadRef;

#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use internal::health::compose_health;
#[allow(unused_imports)]
use internal::overview::compose_overview;
#[allow(unused_imports)]
use internal::view_report::compose_view_report;

pub use crate::shared_tech::inspect::{HealthReport, InspectOverview, ViewContentsReport};

pub async fn overview(_ref: ThreadRef) -> OpResult<InspectOverview> {
    todo!("phase 2")
}

pub async fn health(_ref: ThreadRef) -> OpResult<HealthReport> {
    todo!("phase 2")
}

pub async fn view(_ref: ThreadRef) -> OpResult<ViewContentsReport> {
    todo!("phase 2")
}

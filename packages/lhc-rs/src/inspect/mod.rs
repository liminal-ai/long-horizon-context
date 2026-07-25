//! Ported from packages/lhc/src/inspect/index.ts.
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

use internal::health::compose_health;
use internal::overview::compose_overview;
use internal::view_report::compose_view_report;

pub use crate::shared_tech::inspect::{HealthReport, InspectOverview, ViewContentsReport};

pub async fn overview(ref_: ThreadRef) -> OpResult<InspectOverview> {
    compose_overview(ref_).await
}

pub async fn health(ref_: ThreadRef) -> OpResult<HealthReport> {
    compose_health(ref_).await
}

pub async fn view(ref_: ThreadRef) -> OpResult<ViewContentsReport> {
    compose_view_report(ref_).await
}

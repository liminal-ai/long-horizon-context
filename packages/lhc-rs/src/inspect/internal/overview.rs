//! Ported from packages/lhc/src/inspect/internal/overview.ts. Phase 1 skeleton.
//!
//! Overview composition joins thread metadata, event/message/turn/chunk counts,
//! derivation state totals, and the active-view / visibility summary. Every
//! thread shape falls out of this one composition path: absent pieces normalize
//! to zeros/nulls, no shape-specific branch.

#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use crate::intake_stream;
#[allow(unused_imports)]
use crate::messages;
use crate::shared_tech::derivation::DerivationReportEntry;
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::inspect::{InspectOverview, InspectOverviewDerivation};
#[allow(unused_imports)]
use crate::thread_view;
#[allow(unused_imports)]
use crate::threads;
use crate::threads::ThreadRef;
#[allow(unused_imports)]
use crate::turns;

/// TS `bucketEntries` — one report entry's operational bucket. Unlike
/// ViewStatus, overview counts ready too. Exported in TS (used by tests /
/// same-module); keep crate-visible.
pub fn bucket_entries(_entries: &[DerivationReportEntry], _counts: &mut InspectOverviewDerivation) {
    todo!("phase 2")
}

pub async fn compose_overview(_ref: ThreadRef) -> OpResult<InspectOverview> {
    todo!("phase 2")
}

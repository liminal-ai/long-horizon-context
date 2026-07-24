//! Ported from packages/lhc/src/inspect/internal/health.ts. Phase 1 skeleton.
//!
//! Health composition joins owners' report surfaces into state counts,
//! actionable failure detail, a repair preview, and live queue visibility.
//! Message/turn derivation health comes from DerivationReportEntry rows; capture
//! gaps come from durable source-event markers recorded by capture.

#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use crate::intake_stream;
use crate::intake_stream::EventRecord;
#[allow(unused_imports)]
use crate::messages;
use crate::shared_tech::derivation::DerivationReportEntry;
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::inspect::{HealthFailure, HealthOwner, HealthOwnerCounts, HealthReport};
use crate::threads::ThreadRef;
#[allow(unused_imports)]
use crate::turns;

/// TS private `type Owner = "capture" | "messages" | "turns"`.
type Owner = HealthOwner;

/// Capture-gap runtime_note text prefix — byte-exact from TS.
const CAPTURE_GAP_TEXT_PREFIX: &str = "capture gap:";

/// Capture-gap owner/kind key and kind label — byte-exact from TS.
const CAPTURE_GAP_OWNER_KIND_KEY: &str = "capture:capture_gap";
const CAPTURE_GAP_KIND: &str = "capture_gap";

/// Capture-gap failure subjectKind — byte-exact from TS.
const CAPTURE_GAP_SUBJECT_KIND: &str = "event";

fn empty_counts() -> HealthOwnerCounts {
    todo!("phase 2")
}

fn capture_gap_text(_event: &EventRecord) -> Option<String> {
    todo!("phase 2")
}

fn failure_of(_owner: Owner, _entry: &DerivationReportEntry) -> HealthFailure {
    todo!("phase 2")
}

pub async fn compose_health(_ref: ThreadRef) -> OpResult<HealthReport> {
    todo!("phase 2")
}

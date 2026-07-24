//! Ported from packages/lhc/src/messages/internal/cascade.ts. Phase 1 PARTIAL.
//!
//! Wave 3 collection: `CascadeClear` type only (MutationResult surface).
//! Cascade behavior bodies land in Wave 4.

use serde::{Deserialize, Serialize};

use crate::shared_tech::derivation::SubjectKind;

/// TS `CascadeClear` — one cleared/dropped derivation target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CascadeClear {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
}

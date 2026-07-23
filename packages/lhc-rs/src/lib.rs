//! Ported from packages/lhc/src/index.ts. Phase 1 skeleton.
//!
//! Wave 0 exposes only the exemplar modules; the full re-export surface
//! (mirroring index.ts / sdk.ts) lands in Wave 7.

// Phase 1 only: skeleton private helpers are uncalled by design. Remove at
// the Phase 2 done-gate.
#![allow(dead_code)]

pub mod messages;
pub mod shared_tech;

//! Re-export of intake-stream pipeline test seams (TS fixtures index).
//!
//! Setters are REAL module-state seams in
//! `lhc::intake_stream::internal::pipeline`.

pub use lhc::intake_stream::internal::pipeline::{
    IntakeWalkHook, set_intake_clock, set_intake_walk_hook,
};

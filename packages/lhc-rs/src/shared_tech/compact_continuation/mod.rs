//! Compact-continuation contract v1 — pure whole-seam parity/receipt oracle.
//!
//! Ported from `packages/lhc/src/shared-tech/compact-continuation/`.
//!
//! ## Scope (LIM-62)
//!
//! This module ports the **pure, provider-neutral LIM-60 contract/oracle and
//! validation surface** only. It does **not** port the TypeScript live-thread
//! LIM-61 runtime, schema v7–v10 writer/boundary stores, prepared-source
//! fingerprints, or host governor. LIM-63 owns Codex integration/runtime
//! orchestration.
//!
//! ## Pure-function protocol
//!
//! [`decide_compact_continuation`] is a **whole-seam parity and receipt oracle**,
//! not a function a runtime can call once before applying every effect. A host
//! runtime executes stages in [`COMPACT_CONTINUATION_TRANSITION_ORDER`], gathers
//! pre-decision facts and attempt results into [`CompactContinuationInput`], then
//! uses this oracle to classify the completed seam and emit the durable receipt.
//!
//! ## Effects vs residual (LIM-63 note)
//!
//! The oracle `effects` list is the **prescribed whole-seam protocol** (what the
//! stage plan records as applied or attempted). Runtime `residual` / durable host
//! state records **what actually completed** on interruption/repair paths. Do
//! **not** reinterpret `effects` as proof that each action already committed.
//! Both fields must be ported and preserved byte-for-byte from this pure oracle.
//!
//! Parity fixtures live in `packages/lhc/fixtures/compact-continuation/v1/`
//! (canonical TypeScript store; Rust tests consume them in place).

mod contract;
mod decide;
mod validate;

pub use contract::*;
pub use decide::decide_compact_continuation;
pub use validate::{
    ValidationIssue, ValidationResult, as_compact_continuation_input, assert_decision_parity,
    validate_compact_continuation_decision, validate_compact_continuation_input,
    validate_compact_continuation_receipt,
};

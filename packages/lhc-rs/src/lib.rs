//! Ported from packages/lhc/src/index.ts. Phase 1 skeleton.
//!
//! Wave 0–1 module tree. Full re-export surface lands progressively; Wave 1
//! exposes what Wave 1 tests import (via sdk.rs re-exports + domain modules).

// Phase 1 only: skeleton private helpers are uncalled by design. Remove at the
// Phase 2 done-gate.
#![allow(dead_code)]

pub mod intake_stream;
pub mod messages;
pub mod sdk;
pub mod shared_tech;
pub mod thread_view;
pub mod threads;
pub mod turns;

// Crate-root surface mirrors `export * from "./sdk.js"`.
pub use sdk::*;

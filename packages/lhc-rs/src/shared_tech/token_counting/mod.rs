//! Ported from packages/lhc/src/shared-tech/token-counting/index.ts.
//!
//! TS uses js-tiktoken/lite with o200k_base ranks. Rust uses tiktoken-rs
//! o200k_base for byte-matching token counts.


use std::sync::OnceLock;

use tiktoken_rs::o200k_base_singleton;

pub const TOKEN_ESTIMATOR_ID: &str = "js-tiktoken:o200k_base";

static ENCODER_READY: OnceLock<()> = OnceLock::new();

/// TS `estimateTokens` — js-tiktoken `encode(text, "all")`: all special
/// tokens allowed. Captured text is data; a literal `<|endoftext|>` in a
/// transcript must count, never panic — counting sits on the capture path
/// and capture must be total. (Regression: grok-fork capture panic,
/// 2026-08-08; both TS and rs previously threw here.)
pub fn estimate_tokens(text: &str) -> i64 {
    ENCODER_READY.get_or_init(|| {
        let _ = o200k_base_singleton();
    });
    let bpe = o200k_base_singleton();
    bpe.encode_with_special_tokens(text).len() as i64
}

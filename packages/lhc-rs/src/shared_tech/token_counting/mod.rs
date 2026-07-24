//! Ported from packages/lhc/src/shared-tech/token-counting/index.ts.
//!
//! TS uses js-tiktoken/lite with o200k_base ranks. Rust uses tiktoken-rs
//! o200k_base for byte-matching token counts.

use std::collections::HashSet;
use std::sync::OnceLock;

use tiktoken_rs::o200k_base_singleton;

pub const TOKEN_ESTIMATOR_ID: &str = "js-tiktoken:o200k_base";

static ENCODER_READY: OnceLock<()> = OnceLock::new();

/// TS `estimateTokens` — js-tiktoken `encode` with default empty
/// `allowedSpecial` (disallowed specials throw).
pub fn estimate_tokens(text: &str) -> i64 {
    ENCODER_READY.get_or_init(|| {
        let _ = o200k_base_singleton();
    });
    let bpe = o200k_base_singleton();
    // js-tiktoken default rejects disallowed specials such as `<|endoftext|>`.
    // `encode_ordinary` would silently tokenize them — do not use it here.
    for special in bpe.special_tokens() {
        if text.contains(special) {
            panic!("The text contains a special token that is not allowed: {special}");
        }
    }
    let allowed: HashSet<&str> = HashSet::new();
    match bpe.encode(text, &allowed) {
        Ok((tokens, _)) => tokens.len() as i64,
        Err(err) => panic!("{err}"),
    }
}

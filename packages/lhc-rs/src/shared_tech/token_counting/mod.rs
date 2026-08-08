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

/// Exact token window of `text`: encode, slice `[from_token, from_token + max_tokens)`,
/// decode. A past-the-end offset returns an empty slice that preserves the
/// requested offset, so the caller's receipt can name what was actually asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenSlice {
    pub text: String,
    pub from_token: i64,
    pub to_token: i64,
    pub total_tokens: i64,
}

pub fn slice_tokens(text: &str, from_token: i64, max_tokens: i64) -> TokenSlice {
    ENCODER_READY.get_or_init(|| {
        let _ = o200k_base_singleton();
    });
    let bpe = o200k_base_singleton();
    let tokens = bpe.encode_with_special_tokens(text);
    let total_tokens = tokens.len() as i64;
    let from = from_token.max(0);
    let to = if from >= total_tokens {
        from
    } else {
        (from + max_tokens.max(0)).min(total_tokens)
    };
    let from_usize = (from as usize).min(tokens.len());
    let window = clean_tail_window(
        bpe,
        &tokens,
        from_usize,
        (to - from).max(0) as usize,
        to == total_tokens,
    );
    TokenSlice {
        text: window.0,
        from_token: from,
        to_token: from + window.1 as i64,
        total_tokens,
    }
}

/// Decode `tokens[from, from + count)` leniently and shrink `count` until
/// the decoded tail lands on a clean char boundary (TS `cleanTailWindow`
/// parity: lossy decode, step down while the text ends with U+FFFD). BPE
/// token boundaries can split a multi-byte char; a split tail would corrupt
/// verbatim text and leave the continuation offset pointing inside a char.
/// Windows reaching the text's end (`at_end`) cannot have a split tail.
fn clean_tail_window(
    bpe: &tiktoken_rs::CoreBPE,
    tokens: &[u32],
    from: usize,
    count: usize,
    at_end: bool,
) -> (String, usize) {
    let decode = |k: usize| -> String {
        let end = (from + k).min(tokens.len());
        let bytes = bpe
            .decode_bytes(&tokens[from..end])
            .unwrap_or_else(|err| panic!("slice decode_bytes: {err}"));
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let mut k = count;
    let mut text = decode(k);
    if at_end {
        return (text, k);
    }
    while k > 0 && text.ends_with('\u{FFFD}') {
        k -= 1;
        text = decode(k);
    }
    (text, k)
}

/// `slice_tokens` that also fits a UTF-8 byte allowance: encode ONCE, take
/// the token window, and when its bytes exceed `max_bytes` binary-search the
/// largest token count whose decoded slice fits (TS `sliceTokensByteCapped`
/// parity). Receipts stay token-denominated — bytes only shrink how much is
/// served now. Never re-encodes: long-run BPE pieces make that quadratic.
pub fn slice_tokens_byte_capped(
    text: &str,
    from_token: i64,
    max_tokens: i64,
    max_bytes: usize,
) -> TokenSlice {
    ENCODER_READY.get_or_init(|| {
        let _ = o200k_base_singleton();
    });
    let bpe = o200k_base_singleton();
    let tokens = bpe.encode_with_special_tokens(text);
    let total_tokens = tokens.len() as i64;
    let from = from_token.max(0);
    let to = if from >= total_tokens {
        from
    } else {
        (from + max_tokens.max(0)).min(total_tokens)
    };
    let from_usize = (from as usize).min(tokens.len());
    let decode_to = |k: usize| -> String {
        let end = (from_usize + k).min(tokens.len());
        let bytes = bpe
            .decode_bytes(&tokens[from_usize..end])
            .unwrap_or_else(|err| panic!("slice_tokens_byte_capped decode: {err}"));
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let full_count = (to - from).max(0) as usize;
    let mut count = full_count;
    if decode_to(count).len() > max_bytes {
        let mut low: usize = 0;
        let mut high: usize = count;
        while low < high {
            let mid = low + (high - low).div_ceil(2);
            if decode_to(mid).len() <= max_bytes {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        count = low;
    }
    let window = clean_tail_window(
        bpe,
        &tokens,
        from_usize,
        count,
        from + count as i64 == total_tokens,
    );
    TokenSlice {
        text: window.0,
        from_token: from,
        to_token: from + window.1 as i64,
        total_tokens,
    }
}

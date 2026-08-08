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
    let from_usize = from as usize;
    let to_usize = to as usize;
    let slice = &tokens[from_usize.min(tokens.len())..to_usize.min(tokens.len())];
    let text = bpe
        .decode(slice)
        .unwrap_or_else(|err| panic!("slice_tokens decode: {err}"));
    TokenSlice {
        text,
        from_token: from,
        to_token: to,
        total_tokens,
    }
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
    let decode_to = |end: usize| -> String {
        bpe.decode(&tokens[from_usize..end.min(tokens.len())])
            .unwrap_or_else(|err| panic!("slice_tokens_byte_capped decode: {err}"))
    };
    let text_full = decode_to(to as usize);
    if text_full.len() <= max_bytes {
        return TokenSlice {
            text: text_full,
            from_token: from,
            to_token: to,
            total_tokens,
        };
    }
    let mut low: usize = 0;
    let mut high: usize = (to - from) as usize;
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        if decode_to(from_usize + mid).len() <= max_bytes {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    TokenSlice {
        text: decode_to(from_usize + low),
        from_token: from,
        to_token: from + low as i64,
        total_tokens,
    }
}

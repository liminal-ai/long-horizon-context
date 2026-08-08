//! Captured text is data: literal special-token strings must count, never
//! panic. Regression for the 2026-08-08 grok-fork capture panic.

use lhc::shared_tech::token_counting::estimate_tokens;

#[test]
fn estimate_tokens_counts_literal_special_token_text() {
    let hostile = "before <|endoftext|> after <|fim_prefix|> tail";
    assert!(estimate_tokens(hostile) > 0);
}

#[test]
fn estimate_tokens_matches_plain_text_behavior_elsewhere() {
    assert_eq!(estimate_tokens(""), 0);
    assert!(estimate_tokens("ordinary text") > 0);
}

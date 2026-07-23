//! Conformance tests for shared_tech/js_json.rs against node-generated
//! fixtures (fixtures/js-json-cases.jsonl — see scripts/gen-js-json-fixtures.mjs).
//!
//! REAL PASSES IN PHASE 1 (gate-allowlisted): js_json is Wave 0
//! infrastructure, not ported behavior.

use serde_json::Value;

use lhc::shared_tech::js_json::{js_json_stringify, js_len, js_slice};

#[test]
fn stringify_matches_node_oracle_fixtures() {
    let raw = include_str!("../fixtures/js-json-cases.jsonl");
    let mut checked = 0;
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let case: Value = serde_json::from_str(line).expect("fixture line parses");
        let name = case["name"].as_str().expect("case name");
        let input: Value = serde_json::from_str(case["input"].as_str().expect("case input"))
            .expect("input parses");
        let expected = case["expected"].as_str().expect("case expected");
        let actual = js_json_stringify(&input);
        assert_eq!(actual, expected, "case {name}: stringify mismatch");
        checked += 1;
    }
    assert!(
        checked >= 30,
        "fixture file unexpectedly small: {checked} cases"
    );
}

#[test]
fn js_len_counts_utf16_code_units() {
    assert_eq!(js_len(""), 0);
    assert_eq!(js_len("abc"), 3);
    assert_eq!(js_len("café"), 4);
    // Astral chars are two UTF-16 units, matching JS "😀".length === 2.
    assert_eq!(js_len("😀"), 2);
    assert_eq!(js_len("a😀b"), 4);
}

#[test]
fn js_slice_matches_js_semantics_on_unit_boundaries() {
    assert_eq!(js_slice("hello", 1, Some(3)), "el");
    assert_eq!(js_slice("hello", 0, None), "hello");
    assert_eq!(js_slice("hello", -3, None), "llo");
    assert_eq!(js_slice("hello", 2, Some(-1)), "ll");
    assert_eq!(js_slice("hello", 4, Some(2)), "");
    assert_eq!(js_slice("hello", 0, Some(99)), "hello");
    // Whole astral char inside the slice survives intact.
    assert_eq!(js_slice("a😀b", 1, Some(3)), "😀");
}

#[test]
fn js_slice_drops_split_surrogate_pairs_documented_divergence() {
    // JS would keep a lone surrogate here; Rust strings cannot represent it.
    // The divergence ruling (PORT_STATUS.md): drop the split half.
    assert_eq!(js_slice("a😀b", 0, Some(2)), "a");
    assert_eq!(js_slice("a😀b", 2, None), "b");
}

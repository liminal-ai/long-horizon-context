//! Ported from packages/lhc/test/view-select-golden.test.ts. Phase 1.
//!
//! Epic 03 Story 2: selection goldens G1–G4. Exact arrangements against
//! committed JSON under `tests/goldens/` — NEVER regenerate or embed golden
//! literals as expected-output producers.
//!
//! Judgment: Rust has no async beforeAll — each golden test builds a fresh
//! `derived_thread_fixture` (acceptable isolation translation of TS
//! file-level `beforeAll`).

mod fixtures;

use std::path::PathBuf;

use fixtures::{
    ClosingDb, DerivedThreadFixture, DerivedThreadOptions, TempStore, derived_thread_fixture,
    temp_store,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::view::{PartialViewProfilePercentages, ViewCompactParams};
use lhc::thread_view::CompactOpts;
use lhc::threads::ThreadRef;
use serde::Deserialize;
use serde_json::Value;

/// Debug-only dump matching `JSON.stringify(value, null, 2)`.
/// Leaf spelling goes through [`js_json_stringify`] (no raw serde JSON stringify).
fn json_stringify_pretty_two_space(value: &Value) -> String {
    use lhc::shared_tech::js_json::js_json_stringify;
    fn write(out: &mut String, value: &Value, indent: usize) {
        let pad = |n: usize| "  ".repeat(n);
        match value {
            Value::Array(items) if items.is_empty() => out.push_str("[]"),
            Value::Array(items) => {
                out.push_str("[\n");
                for (i, item) in items.iter().enumerate() {
                    out.push_str(&pad(indent + 1));
                    write(out, item, indent + 1);
                    if i + 1 < items.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad(indent));
                out.push(']');
            }
            Value::Object(map) if map.is_empty() => out.push_str("{}"),
            Value::Object(map) => {
                out.push_str("{\n");
                let entries: Vec<_> = map.iter().collect();
                for (i, (key, item)) in entries.iter().enumerate() {
                    out.push_str(&pad(indent + 1));
                    out.push_str(&js_json_stringify(&Value::String((*key).clone())));
                    out.push_str(": ");
                    write(out, item, indent + 1);
                    if i + 1 < entries.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad(indent));
                out.push('}');
            }
            other => out.push_str(&js_json_stringify(other)),
        }
    }
    let mut out = String::new();
    write(&mut out, value, 0);
    out
}

fn goldens_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens")
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoldenArrangementEntry {
    band: String,
    subject_kind: String,
    subject_id: String,
    derivation_used: String,
    degraded: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoldenGap {
    band: String,
    subject_id: String,
    reason: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoldenParams {
    lower_bound: i64,
    percentages: GoldenPercentages,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct GoldenPercentages {
    full: i64,
    smooth: i64,
    detailed: i64,
    brief: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Golden {
    case: String,
    fixture: String,
    params: GoldenParams,
    compact_point: i64,
    covered_from: i64,
    arrangement: Vec<GoldenArrangementEntry>,
    gaps: Vec<GoldenGap>,
}

#[derive(Debug, Clone, PartialEq)]
struct StoredViewSnapshot {
    compact_point: i64,
    covered_from: i64,
    arrangement: Vec<GoldenArrangementEntry>,
    gaps: Vec<GoldenGap>,
}

fn load_golden(name: &str) -> Golden {
    let path = goldens_dir().join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn read_stored_view(file_path: &str) -> StoredViewSnapshot {
    let closing = ClosingDb::open(file_path);
    let db = closing.db();
    let row = db
        .prepare(
            "SELECT compact_point, covered_from, arrangement_json, gaps_json
         FROM thread_view WHERE singleton = 1",
        )
        .get()
        .expect("no view row after compact");
    let compact_point = row
        .get("compact_point")
        .and_then(|v| v.as_i64())
        .expect("compact_point");
    let covered_from = row
        .get("covered_from")
        .and_then(|v| v.as_i64())
        .expect("covered_from");
    let arrangement_json = row
        .get("arrangement_json")
        .and_then(|v| v.as_str())
        .expect("arrangement_json")
        .to_string();
    let gaps_json = row
        .get("gaps_json")
        .and_then(|v| v.as_str())
        .expect("gaps_json")
        .to_string();
    StoredViewSnapshot {
        compact_point,
        covered_from,
        arrangement: serde_json::from_str(&arrangement_json).expect("arrangement parse"),
        gaps: serde_json::from_str(&gaps_json).expect("gaps parse"),
    }
}

fn params_of(golden: &Golden) -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(golden.params.lower_bound),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(golden.params.percentages.full),
            smooth: Some(golden.params.percentages.smooth),
            detailed: Some(golden.params.percentages.detailed),
            brief: Some(golden.params.percentages.brief),
        }),
    }
}

async fn fresh_fixture() -> (TempStore, DerivedThreadFixture) {
    let store = temp_store();
    let fixture = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    (store, fixture)
}

async fn run_golden(fixture: &DerivedThreadFixture, golden: &Golden) -> StoredViewSnapshot {
    let receipt = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            CompactOpts {
                profile: None,
                params: Some(params_of(golden)),
                signal: None,
            },
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value } = receipt else {
        panic!("compact failed");
    };
    let stored = read_stored_view(&fixture.file_path);
    if std::env::var("GOLDEN_DUMP").as_deref() == Ok("1") {
        let dump = serde_json::json!({
            "compactPoint": stored.compact_point,
            "coveredFrom": stored.covered_from,
            "arrangement": Value::Array(
                stored
                    .arrangement
                    .iter()
                    .map(|e| {
                        serde_json::json!({
                            "band": e.band,
                            "subjectKind": e.subject_kind,
                            "subjectId": e.subject_id,
                            "derivationUsed": e.derivation_used,
                            "degraded": e.degraded,
                        })
                    })
                    .collect()
            ),
            "gaps": Value::Array(
                stored
                    .gaps
                    .iter()
                    .map(|g| {
                        serde_json::json!({
                            "band": g.band,
                            "subjectId": g.subject_id,
                            "reason": g.reason,
                        })
                    })
                    .collect()
            ),
        });
        eprintln!(
            "{}\n{}",
            golden.case,
            json_stringify_pretty_two_space(&dump)
        );
    }
    // Receipt and stored row agree (one selection, two reports).
    assert_eq!(value.compact_point, stored.compact_point);
    assert_eq!(value.covered_from, stored.covered_from);
    stored
}

fn expect_matches(stored: &StoredViewSnapshot, golden: &Golden) {
    assert_eq!(stored.compact_point, golden.compact_point);
    assert_eq!(stored.covered_from, golden.covered_from);
    assert_eq!(stored.arrangement, golden.arrangement);
    assert_eq!(stored.gaps, golden.gaps);
}

#[tokio::test]
async fn g1_proportions_shares_fill_the_full_gradient_as_committed() {
    let (_store, fixture) = fresh_fixture().await;
    let golden = load_golden("g1-proportions.json");
    expect_matches(&run_golden(&fixture, &golden).await, &golden);
}

#[tokio::test]
async fn g2a_budget_edge_a_turn_exactly_filling_the_smooth_remainder_is_included() {
    let (_store, fixture) = fresh_fixture().await;
    let golden = load_golden("g2-edge-inclusion.json");
    expect_matches(&run_golden(&fixture, &golden).await, &golden);
}

#[tokio::test]
async fn g2b_budget_edge_one_token_under_the_exact_fill_excludes_the_turn() {
    let (_store, fixture) = fresh_fixture().await;
    let golden = load_golden("g2-edge-exclusion.json");
    expect_matches(&run_golden(&fixture, &golden).await, &golden);
}

#[tokio::test]
async fn g3_oversized_loner_a_single_turn_larger_than_the_whole_smooth_budget() {
    let (_store, fixture) = fresh_fixture().await;
    let golden = load_golden("g3-oversized-loner.json");
    let stored = run_golden(&fixture, &golden).await;
    expect_matches(&stored, &golden);
    // The loner condition itself: exactly one non-gap smooth entry.
    assert_eq!(
        stored
            .arrangement
            .iter()
            .filter(|entry| entry.band == "smooth" && entry.derivation_used != "gap")
            .count(),
        1
    );
}

//! Ported from packages/lhc/test/view-fixture.test.ts. Phase 1.
//!
//! Epic 03 Story 0 foundation checks (FC-0.1–FC-0.6): view storage,
//! profile config validation through real initLhc construction, the
//! derived-thread fixture's state fidelity proven by read-back through the
//! owning report surfaces, the corruption variant, and the two-point test
//! injection facility.
//!
//! fix1: Drop/autouse teardown clears `compact-write` even on panic (TS afterEach /
//! Python autouse).
//!
//! Judgment: Rust has no async beforeAll — each test builds a fresh
//! `temp_store` / `derived_thread_fixture` (acceptable isolation translation
//! of TS file-level `beforeAll`).

mod fixtures;

use std::panic::AssertUnwindSafe;

use fixtures::{
    ClosingDb, DerivedThreadFixture, DerivedThreadOptions, TempStore, UserPromptOverrides,
    UserPromptPayload, ViewInjectionPoint, blocked_sibling_thread, corrupted_variant_thread,
    create_inference_callbacks_double, derived_thread_fixture, fire_view_injection, kind, open_raw,
    set_view_injection_hook, temp_store, valid_event,
};
use indexmap::IndexMap;
use serde_json::Value;

use lhc::messages::{self, MessageReportOpts};
use lhc::shared_tech::derivation::{DerivationState, SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::{
    CompactReceipt, PartialViewProfilePercentages, PartialVisibilityBudgets, SdkViewConfig,
    ViewCompactParams, ViewProfile, ViewProfileOverride, ViewProfilePercentages, VisibilityBudgets,
};
use lhc::thread_view::internal::profiles::profile_violation;
use lhc::thread_view::internal::render::DerivationSnapshot;
use lhc::thread_view::internal::select::{
    SelectionChunk, SelectionChunkStatus, SelectionConfig, SelectionInputs, SelectionMessage,
    SelectionResult, SelectionTurn, SelectionTurnStatus, select_arrangement,
};
use lhc::thread_view::{CompactOpts, compact, describe, resolve_view_config};
use lhc::threads::ThreadRef;
use lhc::threads::internal::create::create_thread_file;
use lhc::turns;
use lhc::{Lhc, init_lhc};

/// Clears compact-write injection on Drop (panic-safe) and serializes every
/// compact / injection interaction in this binary via a poison-recovering
/// process-global gate (TS `afterEach` + no shared mutable hook races under
/// default `cargo test` parallelism).
///
/// Logical lock (mutex + condvar) rather than a held `MutexGuard`: async tests
/// await while the guard is alive, and `std::sync::MutexGuard` is `!Send`.
static COMPACT_HOOK_HELD: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
static COMPACT_HOOK_CV: std::sync::Condvar = std::sync::Condvar::new();

struct ClearCompactWriteHook;

impl ClearCompactWriteHook {
    fn install() -> Self {
        let mut held = COMPACT_HOOK_HELD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while *held {
            held = COMPACT_HOOK_CV
                .wait(held)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *held = true;
        drop(held);
        set_view_injection_hook(ViewInjectionPoint::CompactWrite, None);
        Self
    }
}

impl Drop for ClearCompactWriteHook {
    fn drop(&mut self) {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            set_view_injection_hook(ViewInjectionPoint::CompactWrite, None);
        }));
        let mut held = COMPACT_HOOK_HELD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *held = false;
        COMPACT_HOOK_CV.notify_one();
    }
}

fn manual_sdk(view: Option<SdkViewConfig>) -> Lhc {
    init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view,
    })
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_else(|| "non-string panic payload".into())
}

fn expect_throw_matching(make: impl FnOnce(), needle: &str) {
    let result = std::panic::catch_unwind(AssertUnwindSafe(make));
    let Err(err) = result else {
        panic!("init_lhc must reject this config");
    };
    let msg = panic_message(err);
    if msg.contains("phase 2") || msg.contains("not yet implemented") {
        panic!("{msg}");
    }
    assert!(
        msg.contains(needle),
        "expected panic message to contain {needle:?}, got {msg}"
    );
}

async fn suite_fixture() -> (TempStore, DerivedThreadFixture) {
    let store = temp_store();
    let fixture = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    (store, fixture)
}

// ── FC-0.1 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn creates_the_three_view_tables_with_their_check_constraints_and_seeds_the_boundary_at_0() {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let closing = ClosingDb::open(&fixture.file_path);
    let db = closing.db();
    let version = db.prepare("PRAGMA user_version").get();
    let user_version = version
        .as_ref()
        .and_then(|row| row.get("user_version"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    assert_eq!(user_version, 4);

    let tables: Vec<String> = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN ('thread_view', 'thread_view_band', 'view_boundary') ORDER BY name",
        )
        .all(&[])
        .iter()
        .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    assert_eq!(
        tables,
        vec![
            "thread_view".to_string(),
            "thread_view_band".to_string(),
            "view_boundary".to_string()
        ]
    );

    let boundary = db
        .prepare("SELECT thread_singleton, position, updated_at FROM view_boundary")
        .all(&[]);
    assert_eq!(boundary.len(), 1);
    let row = &boundary[0];
    assert_eq!(
        row.get("thread_singleton").and_then(|v| v.as_i64()),
        Some(1)
    );
    assert_eq!(row.get("position").and_then(|v| v.as_i64()), Some(0));
    let updated_at = row
        .get("updated_at")
        .and_then(|v| v.as_str())
        .expect("view_boundary.updated_at");
    assert!(updated_at.len() > 0);

    let insert_view = std::panic::catch_unwind(AssertUnwindSafe(|| {
        db.prepare(
            "INSERT INTO thread_view (singleton, view_id, created_at, compact_point,
               covered_from, config_json, arrangement_json, gaps_json, source_state_json)
             VALUES (2, 'v1', 'now', 0, 0, '{}', '[]', '[]', '{}')",
        )
        .run(&[]);
    }));
    let Err(err) = insert_view else {
        panic!("second thread_view row must fail CHECK");
    };
    let msg = panic_message(err);
    assert!(msg.contains("CHECK"), "expected CHECK failure, got {msg}");

    let insert_boundary = std::panic::catch_unwind(AssertUnwindSafe(|| {
        db.prepare(
            "INSERT INTO view_boundary (thread_singleton, position, updated_at) VALUES (2, 0, 'now')",
        )
        .run(&[]);
    }));
    let Err(err) = insert_boundary else {
        panic!("second view_boundary row must fail CHECK");
    };
    let msg = panic_message(err);
    assert!(msg.contains("CHECK"), "expected CHECK failure, got {msg}");

    let band_ddl = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'thread_view_band'")
        .get()
        .and_then(|row| row.get("sql").and_then(|v| v.as_str()).map(str::to_string))
        .expect("thread_view_band ddl");
    assert!(band_ddl.contains("CHECK (band IN ('brief','detailed','smooth'))"));
    assert!(band_ddl.contains("ON DELETE CASCADE"));
}

// ── FC-0.2 ───────────────────────────────────────────────────────────

#[test]
fn rejects_a_profile_whose_band_percentages_do_not_sum_to_100() {
    let _hook_guard = ClearCompactWriteHook::install();
    expect_throw_matching(
        || {
            let _ = manual_sdk(Some(SdkViewConfig {
                profiles: Some(vec![ViewProfileOverride {
                    name: "skewed".into(),
                    lower_bound: Some(50000.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(30.0),
                        smooth: Some(35.0),
                        detailed: Some(20.0),
                        brief: Some(20.0),
                    }),
                }]),
                visibility: None,
                compact_threshold: None,
            }));
        },
        "profile \"skewed\": percentages must sum to 100, got 105",
    );
}

#[test]
fn rejects_visibility_budgets_violating_max_gt_target_naming_the_constraint() {
    let _hook_guard = ClearCompactWriteHook::install();
    expect_throw_matching(
        || {
            let _ = manual_sdk(Some(SdkViewConfig {
                profiles: None,
                visibility: Some(PartialVisibilityBudgets {
                    max_tokens: Some(24000.0),
                    target_tokens: Some(24000.0),
                }),
                compact_threshold: None,
            }));
        },
        "visibility.maxTokens (24000) must be greater than targetTokens (24000)",
    );
}

#[test]
fn rejects_a_non_positive_lower_bound() {
    let _hook_guard = ClearCompactWriteHook::install();
    expect_throw_matching(
        || {
            let _ = manual_sdk(Some(SdkViewConfig {
                profiles: Some(vec![ViewProfileOverride {
                    name: "hollow".into(),
                    lower_bound: Some(0.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(25.0),
                        smooth: Some(35.0),
                        detailed: Some(20.0),
                        brief: Some(20.0),
                    }),
                }]),
                visibility: None,
                compact_threshold: None,
            }));
        },
        "profile \"hollow\": lowerBound must be a positive number, got 0",
    );
}

#[test]
fn rejects_a_partial_profile_that_overrides_no_built_in_unknown_override_target() {
    let _hook_guard = ClearCompactWriteHook::install();
    expect_throw_matching(
        || {
            let _ = manual_sdk(Some(SdkViewConfig {
                profiles: Some(vec![ViewProfileOverride {
                    name: "mystery".into(),
                    lower_bound: Some(64000.0),
                    percentages: None,
                }]),
                visibility: None,
                compact_threshold: None,
            }));
        },
        "profile \"mystery\" is partial but overrides no built-in (unknown built-in override target)",
    );
}

#[test]
fn resolves_defaults_and_merges_a_built_in_override_field_wise() {
    let _hook_guard = ClearCompactWriteHook::install();
    let sdk = manual_sdk(Some(SdkViewConfig {
        profiles: Some(vec![ViewProfileOverride {
            name: "coding".into(),
            lower_bound: Some(64000.0),
            percentages: None,
        }]),
        visibility: None,
        compact_threshold: None,
    }));
    assert_eq!(
        sdk.config.view.visibility,
        VisibilityBudgets {
            max_tokens: 64000.0,
            target_tokens: 32000.0,
        }
    );
    assert_eq!(sdk.config.view.compact_threshold, 160000.0);
    assert_eq!(
        sdk.config.view.profiles.get("coding"),
        Some(&ViewProfile {
            name: "coding".into(),
            lower_bound: 64000.0,
            percentages: ViewProfilePercentages {
                full: 25.0,
                smooth: 35.0,
                detailed: 20.0,
                brief: 20.0,
            },
        })
    );
    assert_eq!(
        sdk.config.view.profiles.get("continuation"),
        Some(&ViewProfile {
            name: "continuation".into(),
            lower_bound: 120000.0,
            percentages: ViewProfilePercentages {
                full: 30.0,
                smooth: 30.0,
                detailed: 20.0,
                brief: 20.0,
            },
        })
    );
    assert_eq!(
        sdk.config
            .view
            .profiles
            .get("conversation")
            .map(|p| &p.percentages),
        Some(&ViewProfilePercentages {
            full: 12.0,
            smooth: 48.0,
            detailed: 20.0,
            brief: 20.0,
        })
    );
}

// ── FC-0.3 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn ready_every_turn_rendering_and_the_closed_chunks_summaries_read_back_ready_through_turns_report()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let report = turns::report(ThreadRef::file_path(&fixture.file_path), None).await;
    assert!(report.is_ok());
    let OpResult::Ok { value } = report else {
        return;
    };
    let renderings: Vec<_> = value
        .iter()
        .filter(|entry| entry.derivation_type == "turn_rendering")
        .collect();
    let mut got_ids: Vec<String> = renderings
        .iter()
        .map(|entry| entry.subject_id.clone())
        .collect();
    got_ids.sort();
    let mut expected = fixture.turn_ids.clone();
    expected.sort();
    assert_eq!(got_ids, expected);
    for rendering in &renderings {
        assert_eq!(rendering.state, DerivationState::Ready);
        assert!(rendering.content.is_some());
    }
    let shape: Vec<String> = fixture
        .chunks
        .chunks
        .iter()
        .map(|chunk| format!("{}:{}", chunk.chunk_id, chunk.status.as_str()))
        .collect();
    assert_eq!(
        shape,
        vec![
            "c1:closed".to_string(),
            "c2:closed".to_string(),
            "c3:closed".to_string(),
            "c4:open".to_string(),
        ]
    );
    for chunk_id in ["c1", "c2", "c3"] {
        for form in ["chunk_summary_detailed", "chunk_summary_brief"] {
            let summary = value
                .iter()
                .find(|entry| entry.subject_id == chunk_id && entry.derivation_type == form);
            assert_eq!(
                summary.map(|entry| entry.state),
                Some(DerivationState::Ready)
            );
        }
    }
}

#[tokio::test]
async fn failed_transient_and_failed_permanent_the_scripted_subjects_read_back_failed_through_messages_report()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let report = messages::report(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageReportOpts {
            not_ready: Some(true),
            message_id: None,
        }),
    )
    .await;
    assert!(report.is_ok());
    let OpResult::Ok { value } = report else {
        return;
    };
    let transient_id = fixture
        .failed_transient_message_id
        .as_deref()
        .expect("fixture failures enabled");
    let permanent_id = fixture
        .failed_permanent_message_id
        .as_deref()
        .expect("fixture failures enabled");
    let transient = value.iter().find(|entry| entry.subject_id == transient_id);
    let transient = transient.expect("transient failed subject");
    assert_eq!(transient.derivation_type, "tool_result_summary");
    assert_eq!(transient.state, DerivationState::Failed);
    let permanent = value.iter().find(|entry| entry.subject_id == permanent_id);
    let permanent = permanent.expect("permanent failed subject");
    assert_eq!(permanent.derivation_type, "tool_result_summary");
    assert_eq!(permanent.state, DerivationState::Failed);
    assert!(transient.queue.is_none());
    assert!(permanent.queue.is_none());
}

#[tokio::test]
async fn blocked_real_source_damage_on_the_sacrificial_sibling_lands_the_turn_forms_blocked() {
    let _hook_guard = ClearCompactWriteHook::install();
    let store = temp_store();
    let sibling = blocked_sibling_thread(&store).await;
    let report = turns::report(ThreadRef::file_path(&sibling.file_path), None).await;
    assert!(report.is_ok());
    let OpResult::Ok { value } = report else {
        return;
    };
    let blocked: Vec<_> = value
        .iter()
        .filter(|entry| {
            entry.subject_id == sibling.blocked_turn_id && entry.state == DerivationState::Blocked
        })
        .collect();
    let mut types: Vec<&str> = blocked
        .iter()
        .map(|entry| entry.derivation_type.as_str())
        .collect();
    types.sort();
    assert_eq!(types, vec!["pre_detailed_assembly", "turn_rendering"]);
    for entry in &blocked {
        let reason = entry.reason.as_deref().expect("blocked reason");
        assert!(
            reason.starts_with("source_damaged: turn state corrupt"),
            "reason={reason}"
        );
    }
}

// ── FC-0.4 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn failed_derivations_persist_the_attempts_reason_class() {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let report = messages::report(
        ThreadRef::file_path(&fixture.file_path),
        Some(MessageReportOpts {
            not_ready: Some(true),
            message_id: None,
        }),
    )
    .await;
    assert!(report.is_ok());
    let OpResult::Ok { value } = report else {
        return;
    };
    let transient_id = fixture
        .failed_transient_message_id
        .as_deref()
        .expect("fixture failures enabled");
    let permanent_id = fixture
        .failed_permanent_message_id
        .as_deref()
        .expect("fixture failures enabled");
    let transient = value
        .iter()
        .find(|entry| entry.subject_id == transient_id)
        .expect("transient");
    let permanent = value
        .iter()
        .find(|entry| entry.subject_id == permanent_id)
        .expect("permanent");

    assert_eq!(
        transient.reason.as_deref(),
        Some(fixtures::RATE_LIMIT_FAILURE_REASON)
    );
    assert!(
        transient
            .reason
            .as_deref()
            .expect("transient reason")
            .starts_with("rate_limit:")
    );

    assert_eq!(
        permanent.reason.as_deref(),
        Some(fixtures::PERMANENT_FAILURE_REASON)
    );
    assert!(
        permanent
            .reason
            .as_deref()
            .expect("permanent reason")
            .starts_with("content_refusal:")
    );

    assert_ne!(transient.reason, permanent.reason);
}

// ── FC-0.5 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn the_corruption_variant_refuses_canonical_consumption_with_state_corruption_naming_the_damage()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let store = temp_store();
    let corrupted = corrupted_variant_thread(&store).await;
    let refused = corrupted
        .sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&corrupted.file_path),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "after the damage".into(),
                    }),
                    ..Default::default()
                },
            )],
        )
        .await;
    assert!(!refused.is_ok());
    let OpResult::Err { error } = refused else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::StateCorruption);
    assert_eq!(error.code, ErrorCode::TurnStateCorrupt);
    assert!(
        error.reason.contains("open turns"),
        "reason={}",
        error.reason
    );
}

// ── FC-0.6 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn uninstalled_the_point_is_a_no_op() {
    let _hook_guard = ClearCompactWriteHook::install();
    fire_view_injection(ViewInjectionPoint::CompactWrite);

    // Amendment I — Node oracle for fractional lowerBound / percentages through
    // production resolve, violation, selection, and the real compact → SQLite /
    // describe / receipt chain. Inventory unchanged: same counted Wave 6 test.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/profile-number-cases.jsonl"
    );
    let body = std::fs::read_to_string(path).expect("read profile-number-cases.jsonl");
    let mut checked = 0usize;
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(line).expect("fixture jsonl row");
        let name = row.get("name").and_then(Value::as_str).expect("name");
        let kind = row.get("kind").and_then(Value::as_str).expect("kind");
        let input = row.get("input").expect("input");
        match kind {
            "resolve_profile" => {
                let expected = row
                    .get("expected")
                    .and_then(Value::as_str)
                    .expect("expected");
                let profiles = input
                    .get("profiles")
                    .and_then(Value::as_array)
                    .expect("profiles");
                let overrides: Vec<ViewProfileOverride> =
                    profiles.iter().map(profile_override_from_fixture).collect();
                let resolved = resolve_view_config(Some(&SdkViewConfig {
                    profiles: Some(overrides),
                    visibility: None,
                    compact_threshold: None,
                }));
                let profile_name = profiles[0]
                    .get("name")
                    .and_then(Value::as_str)
                    .expect("profile name");
                let profile = resolved
                    .profiles
                    .get(profile_name)
                    .unwrap_or_else(|| panic!("{name}: missing resolved profile"));
                let got = js_json_stringify_of(profile).expect("stringify profile");
                assert_eq!(got, expected, "{name}: resolve_view_config profile bytes");
                checked += 1;
            }
            "profile_violation" => {
                let expected = match row.get("expected") {
                    Some(Value::Null) => None,
                    Some(Value::String(s)) => Some(s.as_str()),
                    other => panic!("{name}: expected string|null, got {other:?}"),
                };
                let profile = view_profile_from_fixture(input);
                let got = profile_violation(&profile);
                assert_eq!(
                    got.as_deref(),
                    expected,
                    "{name}: profile_violation diagnostic"
                );
                checked += 1;
            }
            "stored_config_json"
            | "describe_config_json"
            | "receipt_config_json"
            | "inspect_meta_config_json" => {
                let expected = row
                    .get("expected")
                    .and_then(Value::as_str)
                    .expect("expected");
                let lower_bound = fixture_f64(input.get("lowerBound").expect("lowerBound"));
                let percentages = percentages_from_fixture(input.get("percentages").expect("pct"));
                let store = temp_store();
                let file_path = store.dir.join(format!("amendment-i-{kind}.sqlite"));
                let file_path = file_path.to_str().expect("utf8 path");
                seed_amendment_i_thread(file_path, false);
                let receipt = compact_with_profile(file_path, lower_bound, &percentages).await;

                if kind == "receipt_config_json" {
                    // Receipt shape is `{...percentages, lowerBound}` — not stored
                    // config_json key order (`lowerBound` then `percentages`).
                    let got = js_json_stringify_of(&receipt.config)
                        .expect("stringify CompactReceipt.config");
                    assert_eq!(got, expected, "{name}: compact receipt.config bytes");
                    checked += 1;
                    continue;
                }

                let db = open_raw(file_path);
                let raw = db
                    .prepare("SELECT config_json FROM thread_view LIMIT 1")
                    .get()
                    .expect("row");
                let raw_config = raw
                    .get("config_json")
                    .and_then(Value::as_str)
                    .expect("config_json text");
                assert_eq!(raw_config, expected, "{name}: raw SQLite config_json");
                db.close();

                let described = match describe(ThreadRef::file_path(file_path)).await {
                    OpResult::Ok { value: Some(v) } => v,
                    OpResult::Ok { value: None } => {
                        panic!("{name}: describe returned null after compact")
                    }
                    OpResult::Err { error } => panic!("{name}: describe {}", error.reason),
                };
                let describe_config =
                    js_json_stringify_of(&described.config).expect("stringify describe config");
                assert_eq!(
                    describe_config, expected,
                    "{name}: public describe StoredView.config"
                );

                if kind == "inspect_meta_config_json" {
                    // Wave 7: compose_view_report remains todo. Inspect
                    // meta.config is describe's StoredView.config (r1 note).
                    assert_eq!(
                        describe_config, expected,
                        "{name}: inspect meta.config via describe StoredView.config \
                         (compose_view_report remains Wave 7)"
                    );
                }
                checked += 1;
            }
            "source_state_json" => {
                let expected = row
                    .get("expected")
                    .and_then(Value::as_str)
                    .expect("expected");
                let store = temp_store();
                let file_path = store.dir.join("amendment-i-source.sqlite");
                let file_path = file_path.to_str().expect("utf8 path");
                seed_amendment_i_thread(file_path, true);
                let frac = ViewProfilePercentages {
                    full: 12.5,
                    smooth: 47.5,
                    detailed: 20.0,
                    brief: 20.0,
                };
                let _receipt = compact_with_profile(file_path, 12.5, &frac).await;

                let db = open_raw(file_path);
                let raw = db
                    .prepare("SELECT source_state_json FROM thread_view LIMIT 1")
                    .get()
                    .expect("row");
                let raw_ss = raw
                    .get("source_state_json")
                    .and_then(Value::as_str)
                    .expect("source_state_json text");
                assert_eq!(raw_ss, expected, "{name}: raw SQLite source_state_json");
                db.close();

                let described = match describe(ThreadRef::file_path(file_path)).await {
                    OpResult::Ok { value: Some(v) } => v,
                    OpResult::Ok { value: None } => {
                        panic!("{name}: describe returned null after compact")
                    }
                    OpResult::Err { error } => panic!("{name}: describe {}", error.reason),
                };
                let got =
                    js_json_stringify_of(&described.source_state).expect("stringify source_state");
                assert_eq!(got, expected, "{name}: describe source_state bytes");
                // Shape proof: multi-type × multi-state. Expected bytes are the
                // order authority (SQLite GROUP BY order may differ from hand maps).
                assert!(
                    described.source_state.derivation_counts.len() >= 2,
                    "{name}: expected ≥2 derivation types"
                );
                for (dtype, states) in &described.source_state.derivation_counts {
                    assert!(
                        states.len() >= 2,
                        "{name}: type {dtype} must keep multi-state map"
                    );
                }
                checked += 1;
            }
            "selection" => {
                let expected = row.get("expected").expect("expected");
                let lower_bound = fixture_f64(input.get("lowerBound").expect("lowerBound"));
                let inputs = selection_inputs_from_fixture(
                    input.get("selectionInputs").expect("selectionInputs"),
                );
                let has_dual =
                    expected.get("fractional").is_some() && expected.get("truncated").is_some();
                if has_dual {
                    let percentages =
                        percentages_from_fixture(input.get("percentages").expect("pct"));
                    let truncated_percentages = percentages_from_fixture(
                        input
                            .get("truncatedPercentages")
                            .expect("truncatedPercentages"),
                    );
                    let fractional = select_arrangement(
                        &inputs,
                        &SelectionConfig {
                            lower_bound,
                            percentages,
                        },
                    )
                    .expect("fractional selection arrangement");
                    let truncated = select_arrangement(
                        &inputs,
                        &SelectionConfig {
                            lower_bound,
                            percentages: truncated_percentages,
                        },
                    )
                    .expect("truncated selection arrangement");
                    assert_selection_projection(
                        name,
                        "fractional",
                        &fractional,
                        expected.get("fractional").expect("fractional"),
                    );
                    assert_selection_projection(
                        name,
                        "truncated",
                        &truncated,
                        expected.get("truncated").expect("truncated"),
                    );
                } else {
                    let percentages =
                        percentages_from_fixture(input.get("percentages").expect("pct"));
                    let got = select_arrangement(
                        &inputs,
                        &SelectionConfig {
                            lower_bound,
                            percentages,
                        },
                    )
                    .expect("selection arrangement");
                    assert_selection_projection(name, "", &got, expected);
                }
                checked += 1;
            }
            other => panic!("{name}: unknown Amendment I fixture kind {other}"),
        }
    }
    assert_eq!(checked, 26, "Amendment I fixture case count");
}

fn assert_selection_projection(name: &str, label: &str, got: &SelectionResult, expected: &Value) {
    let prefix = if label.is_empty() {
        name.to_string()
    } else {
        format!("{name}/{label}")
    };
    assert_eq!(
        got.compact_point,
        expected
            .get("compactPoint")
            .and_then(Value::as_i64)
            .expect("compactPoint"),
        "{prefix}: compact_point"
    );
    assert_eq!(
        got.covered_from,
        expected
            .get("coveredFrom")
            .and_then(Value::as_i64)
            .expect("coveredFrom"),
        "{prefix}: covered_from"
    );
    let want_entries = expected
        .get("entries")
        .and_then(Value::as_array)
        .expect("entries");
    assert_eq!(
        got.entries.len(),
        want_entries.len(),
        "{prefix}: entry count"
    );
    for (i, (entry, want)) in got.entries.iter().zip(want_entries.iter()).enumerate() {
        assert_eq!(
            entry.band.as_str(),
            want.get("band").and_then(Value::as_str).expect("band"),
            "{prefix}: entries[{i}].band"
        );
        assert_eq!(
            entry.subject_kind.as_str(),
            want.get("subjectKind")
                .and_then(Value::as_str)
                .expect("subjectKind"),
            "{prefix}: entries[{i}].subject_kind"
        );
        assert_eq!(
            entry.subject_id,
            want.get("subjectId")
                .and_then(Value::as_str)
                .expect("subjectId"),
            "{prefix}: entries[{i}].subject_id"
        );
        assert_eq!(
            entry.derivation_used,
            want.get("derivationUsed")
                .and_then(Value::as_str)
                .expect("derivationUsed"),
            "{prefix}: entries[{i}].derivation_used"
        );
        assert_eq!(
            entry.degraded,
            want.get("degraded")
                .and_then(Value::as_bool)
                .expect("degraded"),
            "{prefix}: entries[{i}].degraded"
        );
        assert_eq!(
            entry.gap,
            want.get("gap").and_then(Value::as_bool).expect("gap"),
            "{prefix}: entries[{i}].gap"
        );
        assert_eq!(
            entry.start_order,
            want.get("startOrder")
                .and_then(Value::as_i64)
                .expect("startOrder"),
            "{prefix}: entries[{i}].start_order"
        );
    }
}

/// Seed a compactable thread: closed t1 + user_prompt / assistant_text / turn_end.
/// When `seed_nested_derivations`, insert the five rows that yield multi-type ×
/// multi-state derivationCounts after compact.
fn seed_amendment_i_thread(file_path: &str, seed_nested_derivations: bool) {
    create_thread_file(file_path, "th_amend_i", "2020-01-01T00:00:00.000Z");
    let db = open_raw(file_path);
    let ts = "2020-01-01T00:00:00.000Z";
    db.prepare(
        "UPDATE turns SET status = 'closed', closed_at_event_order = 3 WHERE turn_id = 't1'",
    )
    .run(&[]);
    for (order, kind, key, payload) in [
        (1i64, "user_prompt", "k1", r#"{"text":"hello fractional"}"#),
        (2, "assistant_text", "k2", r#"{"text":"world"}"#),
        (3, "turn_end", "k3", "{}"),
    ] {
        db.prepare(
            "INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
             VALUES (?, ?, ?, 'oracle', 'profile-number', ?, ?)",
        )
        .run(&[
            SqlParam::from(order),
            SqlParam::from(kind),
            SqlParam::from(key),
            SqlParam::from(payload),
            SqlParam::from(ts),
        ]);
    }
    for (mid, order, kind, text) in [
        ("m1", 1i64, "user_prompt", "hello fractional"),
        ("m2", 2, "assistant_text", "world"),
    ] {
        db.prepare(
            "INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
             VALUES (?, ?, ?, 1, 'oracle', 'profile-number', 't1')",
        )
        .run(&[
            SqlParam::from(mid),
            SqlParam::from(order),
            SqlParam::from(kind),
        ]);
        let content = format!(r#"{{"text":"{text}"}}"#);
        db.prepare(
            "INSERT INTO message_block (message_id, block_index, block_type, content)
             VALUES (?, 0, 'text', ?)",
        )
        .run(&[SqlParam::from(mid), SqlParam::from(content.as_str())]);
    }
    if seed_nested_derivations {
        // smoothed_prompt ready×2 pending×1; detailed_turn_compression ready×1 failed×1
        for (sk, sid, dtype, state) in [
            ("message", "m1", "smoothed_prompt", "ready"),
            ("message", "m2", "smoothed_prompt", "ready"),
            ("message", "m3", "smoothed_prompt", "pending"),
            ("turn", "t1", "detailed_turn_compression", "ready"),
            ("turn", "t2", "detailed_turn_compression", "failed"),
        ] {
            db.prepare(
                "INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
                 VALUES (?, ?, ?, ?, 1)",
            )
            .run(&[
                SqlParam::from(sk),
                SqlParam::from(sid),
                SqlParam::from(dtype),
                SqlParam::from(state),
            ]);
        }
    }
    db.close();
}

async fn compact_with_profile(
    file_path: &str,
    lower_bound: f64,
    percentages: &ViewProfilePercentages,
) -> CompactReceipt {
    let result = compact(
        ThreadRef::file_path(file_path),
        CompactOpts {
            profile: None,
            params: Some(ViewCompactParams {
                lower_bound: Some(lower_bound),
                percentages: Some(PartialViewProfilePercentages {
                    full: Some(percentages.full),
                    smooth: Some(percentages.smooth),
                    detailed: Some(percentages.detailed),
                    brief: Some(percentages.brief),
                }),
            }),
            signal: None,
        },
    )
    .await;
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn fixture_f64(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().expect("finite number"),
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("unknown tagged f64 {other}"),
        },
        other => panic!("expected number|tagged string, got {other:?}"),
    }
}

fn percentages_from_fixture(value: &Value) -> ViewProfilePercentages {
    let obj = value.as_object().expect("percentages object");
    ViewProfilePercentages {
        full: fixture_f64(obj.get("full").expect("full")),
        smooth: fixture_f64(obj.get("smooth").expect("smooth")),
        detailed: fixture_f64(obj.get("detailed").expect("detailed")),
        brief: fixture_f64(obj.get("brief").expect("brief")),
    }
}

fn view_profile_from_fixture(value: &Value) -> ViewProfile {
    ViewProfile {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .expect("name")
            .to_string(),
        lower_bound: fixture_f64(value.get("lowerBound").expect("lowerBound")),
        percentages: percentages_from_fixture(value.get("percentages").expect("percentages")),
    }
}

fn profile_override_from_fixture(value: &Value) -> ViewProfileOverride {
    let percentages = value.get("percentages").map(|pct| {
        let obj = pct.as_object().expect("percentages object");
        PartialViewProfilePercentages {
            full: obj.get("full").map(fixture_f64),
            smooth: obj.get("smooth").map(fixture_f64),
            detailed: obj.get("detailed").map(fixture_f64),
            brief: obj.get("brief").map(fixture_f64),
        }
    });
    ViewProfileOverride {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .expect("name")
            .to_string(),
        lower_bound: value.get("lowerBound").map(fixture_f64),
        percentages,
    }
}

fn selection_inputs_from_fixture(value: &Value) -> SelectionInputs {
    let obj = value.as_object().expect("selectionInputs object");
    let messages = obj
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .map(|m| {
            let m = m.as_object().expect("message object");
            SelectionMessage {
                message_id: m
                    .get("messageId")
                    .and_then(Value::as_str)
                    .expect("messageId")
                    .to_string(),
                order: m.get("order").and_then(Value::as_i64).expect("order"),
                kind: m
                    .get("kind")
                    .and_then(Value::as_str)
                    .expect("kind")
                    .to_string(),
                token_estimate: m
                    .get("tokenEstimate")
                    .and_then(Value::as_i64)
                    .expect("tokenEstimate"),
                turn_id: m
                    .get("turnId")
                    .and_then(Value::as_str)
                    .expect("turnId")
                    .to_string(),
                text: m
                    .get("text")
                    .and_then(Value::as_str)
                    .expect("text")
                    .to_string(),
            }
        })
        .collect();
    let turns = obj
        .get("turns")
        .and_then(Value::as_array)
        .expect("turns")
        .iter()
        .map(|t| {
            let t = t.as_object().expect("turn object");
            let status = match t.get("status").and_then(Value::as_str).expect("status") {
                "closed" => SelectionTurnStatus::Closed,
                "open" => SelectionTurnStatus::Open,
                other => panic!("unknown turn status {other}"),
            };
            SelectionTurn {
                turn_id: t
                    .get("turnId")
                    .and_then(Value::as_str)
                    .expect("turnId")
                    .to_string(),
                turn_order: t
                    .get("turnOrder")
                    .and_then(Value::as_i64)
                    .expect("turnOrder"),
                status,
                opened_at: t.get("openedAt").and_then(Value::as_i64).expect("openedAt"),
                closed_at: match t.get("closedAt") {
                    Some(Value::Null) | None => None,
                    Some(v) => Some(v.as_i64().expect("closedAt")),
                },
            }
        })
        .collect();
    let chunks = obj
        .get("chunks")
        .and_then(Value::as_array)
        .expect("chunks")
        .iter()
        .map(|c| {
            let c = c.as_object().expect("chunk object");
            let status = match c.get("status").and_then(Value::as_str).expect("status") {
                "closed" => SelectionChunkStatus::Closed,
                "open" => SelectionChunkStatus::Open,
                other => panic!("unknown chunk status {other}"),
            };
            SelectionChunk {
                chunk_id: c
                    .get("chunkId")
                    .and_then(Value::as_str)
                    .expect("chunkId")
                    .to_string(),
                chunk_order: c
                    .get("chunkOrder")
                    .and_then(Value::as_i64)
                    .expect("chunkOrder"),
                status,
                member_turn_ids: c
                    .get("memberTurnIds")
                    .and_then(Value::as_array)
                    .expect("memberTurnIds")
                    .iter()
                    .map(|id| id.as_str().expect("memberTurnId").to_string())
                    .collect(),
            }
        })
        .collect();
    let mut derivations = IndexMap::new();
    if let Some(map) = obj.get("derivations").and_then(Value::as_object) {
        for (key, snap) in map {
            let snap = snap.as_object().expect("derivation snapshot");
            let state = match snap.get("state").and_then(Value::as_str).expect("state") {
                "pending" => DerivationState::Pending,
                "ready" => DerivationState::Ready,
                "failed" => DerivationState::Failed,
                "blocked" => DerivationState::Blocked,
                other => panic!("unknown derivation state {other}"),
            };
            derivations.insert(
                key.clone(),
                DerivationSnapshot {
                    state,
                    content: snap
                        .get("content")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    reason: snap
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            );
        }
    }
    let mut derivation_counts = IndexMap::new();
    if let Some(outer) = obj.get("derivationCounts").and_then(Value::as_object) {
        for (dtype, states) in outer {
            let mut inner = IndexMap::new();
            if let Some(states) = states.as_object() {
                for (state, count) in states {
                    inner.insert(state.clone(), count.as_i64().expect("count"));
                }
            }
            derivation_counts.insert(dtype.clone(), inner);
        }
    }
    SelectionInputs {
        messages,
        turns,
        chunks,
        derivations,
        compact_chunk_materials: None,
        max_event_order: obj
            .get("maxEventOrder")
            .and_then(Value::as_i64)
            .expect("maxEventOrder"),
        derivation_counts,
    }
}

#[test]
fn an_installed_hook_fires_its_throw_propagates_and_uninstalling_restores_the_no_op() {
    let _hook_guard = ClearCompactWriteHook::install();
    let fired = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let fired_hook = std::sync::Arc::clone(&fired);
    set_view_injection_hook(
        ViewInjectionPoint::CompactWrite,
        Some(std::sync::Arc::new(move || {
            fired_hook.lock().expect("fired").push("compact".into());
        })),
    );
    fire_view_injection(ViewInjectionPoint::CompactWrite);
    assert_eq!(
        fired.lock().expect("fired").clone(),
        vec!["compact".to_string()]
    );

    set_view_injection_hook(
        ViewInjectionPoint::CompactWrite,
        Some(std::sync::Arc::new(|| {
            panic!("injected crash between sweep and view write");
        })),
    );
    let threw = std::panic::catch_unwind(AssertUnwindSafe(|| {
        fire_view_injection(ViewInjectionPoint::CompactWrite);
    }));
    let Err(err) = threw else {
        panic!("installed crash hook must propagate");
    };
    let msg = panic_message(err);
    assert!(
        msg.contains("injected crash"),
        "expected injected crash, got {msg}"
    );

    set_view_injection_hook(ViewInjectionPoint::CompactWrite, None);
    fired.lock().expect("fired").clear();
    fire_view_injection(ViewInjectionPoint::CompactWrite);
    assert!(fired.lock().expect("fired").is_empty());
}

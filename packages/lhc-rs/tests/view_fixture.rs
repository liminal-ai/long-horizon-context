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
    create_inference_callbacks_double, derived_thread_fixture, fire_view_injection, kind,
    set_view_injection_hook, temp_store, valid_event,
};
use lhc::messages::{self, MessageReportOpts};
use lhc::shared_tech::derivation::{DerivationState, SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::view::{
    PartialViewProfilePercentages, PartialVisibilityBudgets, SdkViewConfig, ViewProfile,
    ViewProfileOverride, ViewProfilePercentages, VisibilityBudgets,
};
use lhc::threads::ThreadRef;
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
                    lower_bound: Some(50000),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(30),
                        smooth: Some(35),
                        detailed: Some(20),
                        brief: Some(20),
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
                    lower_bound: Some(0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(25),
                        smooth: Some(35),
                        detailed: Some(20),
                        brief: Some(20),
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
                    lower_bound: Some(64000),
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
            lower_bound: Some(64000),
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
            lower_bound: 64000,
            percentages: ViewProfilePercentages {
                full: 25,
                smooth: 35,
                detailed: 20,
                brief: 20,
            },
        })
    );
    assert_eq!(
        sdk.config.view.profiles.get("continuation"),
        Some(&ViewProfile {
            name: "continuation".into(),
            lower_bound: 120000,
            percentages: ViewProfilePercentages {
                full: 30,
                smooth: 30,
                detailed: 20,
                brief: 20,
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
            full: 12,
            smooth: 48,
            detailed: 20,
            brief: 20,
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

#[test]
fn uninstalled_the_point_is_a_no_op() {
    let _hook_guard = ClearCompactWriteHook::install();
    fire_view_injection(ViewInjectionPoint::CompactWrite);
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

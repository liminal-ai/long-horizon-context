//! Ported from packages/lhc/test/turn-parts-midturn.test.ts.
//!
//! Turn parts — the mid-turn entry point and mechanism exclusivity (epic
//! Flow 7, core side: AC-7.3 / TC-7.3a,b and AC-7.4 / TC-7.4a). Not a third
//! algorithm state: mid_turn_compact is the ordinary prepare → install compact
//! behind two typed refusals. Exclusivity is per thread, both directions, and
//! the forced-boundary runtime's compact-point clamp never meets a parts thread.
mod fixtures;

use fixtures::turn_parts::{
    closed_turn, describe, file_ref, host_metadata, new_thread, prompt, scalar_i64, scalar_str,
    sdk_for, send, shares, step, tokens_after_step, turn_end,
};
use fixtures::{open_raw, run_compact_continuation_for_tests, temp_store};
use lhc::compact_continuation::CompactContinuationHostFacts;
use lhc::shared_tech::compact_continuation::{
    CompactContinuationHostCapability, CompactContinuationPolicy, CompactContinuationSeam,
    PostMeasurementEstimate, ProviderUsageAuthority, ProviderUsageAvailable, WorkContinuation,
    WriterClaim,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::view::{PreviewCompactOutcome, ReceiptPart, ViewCompactParams};
use lhc::thread_view::{
    self, CompactOpts, MidTurnCompactOptions, MidTurnSeamAssertion, prepare_compact,
};
use lhc::{Lhc, intake_stream};

const SETTLED_SEAM: MidTurnSeamAssertion = MidTurnSeamAssertion {
    model_response_complete: true,
    requested_tools_settled: true,
    capture_flushed: true,
    before_next_provider_request: true,
};

// A thread under mid-turn pressure: one closed turn, then an open stamped
// turn of three complete steps.
async fn pressured_thread(sdk: &Lhc, store: &fixtures::TempStore) -> String {
    let file_path = new_thread(sdk, store).await;
    send(sdk, &file_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    events.extend(step(2, "charlie"));
    send(sdk, &file_path, &events).await;
    file_path
}

fn read_activation(file_path: &str) -> Option<String> {
    scalar_str(
        file_path,
        "SELECT parts_activated_at FROM thread_metadata WHERE id = 1",
    )
}

fn params(lower_bound: i64) -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(lower_bound as f64),
        percentages: Some(shares(50.0, 20.0, 15.0, 15.0)),
        newest_closed_protection: Some(0.0), // the split is the subject; Flow 5 has its own file
    }
}

fn mid_turn(seam: Option<MidTurnSeamAssertion>, p: ViewCompactParams) -> MidTurnCompactOptions {
    MidTurnCompactOptions {
        seam,
        profile: None,
        params: Some(p),
        signal: None,
        created_at: None,
    }
}

#[derive(Debug, PartialEq, Eq, Clone)]
struct Canonical {
    events: i64,
    turns: i64,
    view_id: Option<String>,
    writer_claim: String,
    boundaries: i64,
}

fn canonical(file_path: &str) -> Canonical {
    Canonical {
        events: scalar_i64(file_path, "SELECT COUNT(*) AS n FROM event"),
        turns: scalar_i64(file_path, "SELECT COUNT(*) AS n FROM turns"),
        view_id: scalar_str(
            file_path,
            "SELECT view_id FROM thread_view WHERE singleton = 1",
        ),
        writer_claim: scalar_str(
            file_path,
            "SELECT claim FROM compact_continuation_writer WHERE singleton = 1",
        )
        .expect("writer row"),
        boundaries: scalar_i64(
            file_path,
            "SELECT COUNT(*) AS n FROM compact_continuation_boundary",
        ),
    }
}

fn continuation_facts(attempt_id: &str) -> CompactContinuationHostFacts {
    CompactContinuationHostFacts {
        attempt_id: attempt_id.into(),
        seam: CompactContinuationSeam {
            model_response_complete: true,
            requested_tools_settled: true,
            capture_flushed: true,
            before_next_provider_request: true,
            inside_transport_retry: false,
            input_epoch_at_decision: 1,
            input_epoch_at_apply: 1,
        },
        provider_usage: ProviderUsageAuthority::Available(ProviderUsageAvailable {
            available: true,
            input_tokens: 90_000,
            cache_creation_tokens: 5_000,
            cache_read_tokens: 10_000,
            total: 105_000,
            domain: "provider_reported_input".into(),
        }),
        post_measurement_estimate: PostMeasurementEstimate {
            tokens: 2_000,
            source: "lhc_token_estimate".into(),
            domain: "source_labelled_estimate".into(),
        },
        policy: CompactContinuationPolicy {
            safe_runway_threshold_tokens: Some(200_000),
            safe_runway_threshold_source: Some("host_safe_runway".into()),
            upper_trigger_tokens: 100_000,
            lower_target_tokens: 400,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
            compact_retry_budget: None,
        },
        continuation: WorkContinuation::ActiveNonTool,
        writer_claim: WriterClaim::None,
        capture_complete: true,
        provider_identity_valid: true,
        single_open_turn: None,
        actor: "fixture-actor".into(),
        harness: "fixture-harness".into(),
        compact: Some(lhc::compact_continuation::HostCompactOpts {
            profile: None,
            params: Some(ViewCompactParams {
                lower_bound: Some(400.0),
                percentages: Some(shares(25.0, 25.0, 25.0, 25.0)),
                newest_closed_protection: None,
            }),
        }),
    }
}

fn part(turn_id: &str, from_step: i64, to_step: i64) -> ReceiptPart {
    ReceiptPart {
        turn_id: turn_id.into(),
        from_step,
        to_step,
    }
}

#[tokio::test]
async fn refuses_typed_on_an_absent_or_false_seam_assertion_and_touches_nothing_a_settled_seam_runs_the_ordinary_compact()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    let before = canonical(&file_path);
    let p = params(tokens_after_step(&file_path, "t2", 0) * 2);

    let in_flight = thread_view::mid_turn_compact(
        file_ref(&file_path),
        mid_turn(
            Some(MidTurnSeamAssertion {
                capture_flushed: false,
                ..SETTLED_SEAM
            }),
            p.clone(),
        ),
    )
    .await;
    match in_flight {
        OpResult::Err { error } => {
            assert_eq!(error.error_class, ErrorClass::CallerError);
            assert_eq!(error.code, ErrorCode::UnsettledCaptureSeam);
        }
        OpResult::Ok { .. } => panic!("expected refusal"),
    }
    let absent =
        thread_view::mid_turn_compact(file_ref(&file_path), mid_turn(None, p.clone())).await;
    match absent {
        OpResult::Err { error } => assert_eq!(error.code, ErrorCode::UnsettledCaptureSeam),
        OpResult::Ok { .. } => panic!("expected refusal"),
    }
    assert_eq!(canonical(&file_path), before);

    // Settled: the same receipt the ordinary compact API yields — parts and all.
    let preview = thread_view::preview_compact(
        file_ref(&file_path),
        CompactOpts {
            profile: None,
            params: Some(p.clone()),
            signal: None,
            compact_point_upper_bound: None,
        },
    )
    .await;
    let served = sdk
        .thread_view
        .mid_turn_compact(file_ref(&file_path), mid_turn(Some(SETTLED_SEAM), p))
        .await;
    let served = match served {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    let preview_point = match preview {
        OpResult::Ok {
            value: PreviewCompactOutcome::Ok { preview },
        } => preview.compact_point,
        other => panic!("preview: {other:?}"),
    };
    assert_eq!(served.parts, Some(vec![part("t2", 0, 0)]));
    assert_eq!(served.compact_point, preview_point);
    assert_eq!(
        canonical(&file_path),
        Canonical {
            view_id: Some(served.view_id.clone()),
            ..before
        }
    );
    store.cleanup();
}

#[tokio::test]
async fn tc_7_3b_a_forced_boundary_attempt_on_a_parts_thread_is_refused_typed_with_thread_state_unchanged()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    let split = sdk
        .thread_view
        .mid_turn_compact(
            file_ref(&file_path),
            mid_turn(
                Some(SETTLED_SEAM),
                params(tokens_after_step(&file_path, "t2", 0) * 2),
            ),
        )
        .await;
    let split = match split {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert_eq!(split.parts.map(|p| p.len()), Some(1));
    let before = canonical(&file_path);

    let forced = run_compact_continuation_for_tests(
        file_ref(&file_path),
        continuation_facts("attempt-on-parts"),
        None,
        None,
    )
    .await;
    match forced {
        OpResult::Err { error } => {
            assert_eq!(error.error_class, ErrorClass::CallerError);
            assert_eq!(error.code, ErrorCode::CompactContinuationPartsThread);
        }
        OpResult::Ok { .. } => panic!("expected refusal"),
    }
    assert_eq!(canonical(&file_path), before);
    assert_eq!(before.writer_claim, "none");
    assert_eq!(before.boundaries, 0);
    store.cleanup();
}

#[tokio::test]
async fn the_exclusivity_fact_is_durable_once_the_split_turn_has_closed_and_settled_a_forced_attempt_is_still_refused()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    let split = sdk
        .thread_view
        .mid_turn_compact(
            file_ref(&file_path),
            mid_turn(
                Some(SETTLED_SEAM),
                params(tokens_after_step(&file_path, "t2", 0) * 2),
            ),
        )
        .await;
    let split = match split {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert_eq!(split.parts.map(|p| p.len()), Some(1));
    let activated = read_activation(&file_path);
    assert!(activated.is_some());

    // t2 closes and t3 opens. Once t3 fills the full share, t2 settles and
    // the new snapshot carries no part at all.
    send(&sdk, &file_path, &[turn_end()]).await;
    let mut next = vec![prompt("next")];
    next.extend(step(0, "golf"));
    send(&sdk, &file_path, &next).await;
    let db = open_raw(&file_path);
    db.prepare("UPDATE message SET token_estimate = 25 WHERE turn_id = 't3'")
        .run(&[]);
    db.close();
    let settled = fixtures::turn_parts::compact(&sdk, &file_path, params(200)).await;
    assert_eq!(
        settled.settled.as_ref().map(|s| s.turn_id.as_str()),
        Some("t2")
    );
    assert_eq!(settled.parts, None);
    let described = describe(&file_path).await;
    assert!(described.arrangement.iter().all(|e| e.part.is_none()));
    assert_eq!(host_metadata(&file_path).await.unsettled_turn, None);
    // Settle did not touch the durable fact.
    assert_eq!(read_activation(&file_path), activated);

    let before = canonical(&file_path);
    let forced = run_compact_continuation_for_tests(
        file_ref(&file_path),
        continuation_facts("attempt-after-settle"),
        None,
        None,
    )
    .await;
    match forced {
        OpResult::Err { error } => {
            assert_eq!(error.error_class, ErrorClass::CallerError);
            assert_eq!(error.code, ErrorCode::CompactContinuationPartsThread);
        }
        OpResult::Ok { .. } => panic!("expected refusal"),
    }
    assert_eq!(canonical(&file_path), before);
    assert_eq!(before.writer_claim, "none");
    assert_eq!(before.boundaries, 0);
    store.cleanup();
}

#[tokio::test]
async fn a_forced_boundary_thread_is_never_served_parts_mid_turn_refuses_typed_and_the_ordinary_compact_walks_without_a_parts_source()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = pressured_thread(&sdk, &store).await;
    // Take the forced-boundary path first (real runtime, real boundary row).
    let forced = run_compact_continuation_for_tests(
        file_ref(&file_path),
        continuation_facts("attempt-forced"),
        None,
        None,
    )
    .await;
    let forced = match forced {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert!(forced.receipt.continuation.opened);
    assert_eq!(canonical(&file_path).boundaries, 1);

    // New stamped pressure on the continuation turn (t3), tight budget.
    let mut events = Vec::new();
    events.extend(step(0, "golf"));
    events.extend(step(1, "hotel"));
    events.extend(step(2, "india"));
    let sent = intake_stream::message_events(file_ref(&file_path), &events).await;
    assert!(matches!(sent, OpResult::Ok { .. }));
    let p = params(tokens_after_step(&file_path, "t3", 0) * 2);
    let before = canonical(&file_path);
    let refused = sdk
        .thread_view
        .mid_turn_compact(
            file_ref(&file_path),
            mid_turn(Some(SETTLED_SEAM), p.clone()),
        )
        .await;
    match refused {
        OpResult::Err { error } => {
            assert_eq!(error.error_class, ErrorClass::CallerError);
            assert_eq!(error.code, ErrorCode::ForcedBoundaryThread);
        }
        OpResult::Ok { .. } => panic!("expected refusal"),
    }
    assert_eq!(canonical(&file_path), before);

    let ordinary = fixtures::turn_parts::compact(&sdk, &file_path, p).await;
    assert_eq!(ordinary.parts, None);
    assert_eq!(ordinary.split_point, None);
    assert_eq!(host_metadata(&file_path).await.unsettled_turn, None);
    store.cleanup();
}

#[tokio::test]
async fn the_forced_boundary_clamp_never_meets_a_parts_thread_upper_bound_trips_the_invariant_and_suppresses_splitting_on_a_clean_thread()
 {
    let store = temp_store();
    let sdk = sdk_for();
    let clean = pressured_thread(&sdk, &store).await;
    let p = params(tokens_after_step(&clean, "t2", 0) * 2);
    let bounded = prepare_compact(
        file_ref(&clean),
        CompactOpts {
            profile: None,
            params: Some(p.clone()),
            signal: None,
            compact_point_upper_bound: Some(2),
        },
    )
    .await;
    let bounded = match bounded {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert_eq!(bounded.selection.parts, None);
    assert!(bounded.selection.compact_point <= 2);

    let parts = pressured_thread(&sdk, &store).await;
    let split = sdk
        .thread_view
        .mid_turn_compact(file_ref(&parts), mid_turn(Some(SETTLED_SEAM), p.clone()))
        .await;
    let split = match split {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert_eq!(split.parts.map(|p| p.len()), Some(1));
    let clamped = prepare_compact(
        file_ref(&parts),
        CompactOpts {
            profile: None,
            params: Some(p),
            signal: None,
            compact_point_upper_bound: Some(2),
        },
    )
    .await;
    match clamped {
        OpResult::Err { error } => {
            assert!(
                error.reason.contains("turn parts invariant violated"),
                "{}",
                error.reason
            );
        }
        OpResult::Ok { .. } => panic!("expected the invariant to trip"),
    }
    store.cleanup();
}

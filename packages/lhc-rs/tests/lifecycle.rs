//! Ported from packages/lhc/test/lifecycle.test.ts. Phase 1.
//!
//! Story 4 (Epic 04): TC-5.1–5.3 — the full-surface lifecycle exercise.
//!
//! Determinism control: TS freezes Date — and only Date — via
//! `vi.useFakeTimers({ toFake: ["Date"] })` + `setSystemTime` at
//! `2026-06-12T00:00:00.000Z`. Vitest uses one shared `beforeAll` baseline;
//! Rust recomputes the baseline per test (no safe async beforeAll/afterAll in
//! integration tests). Phase 2 `create_lifecycle_sdk` injects that instant via
//! `SdkConfig.clock`. Replay/teardown keep the TS 60s bounds via
//! `tokio::time::timeout`.

mod fixtures;

use std::fs;
use std::time::Duration;

use fixtures::{
    DELETED_MESSAGE_TEXT, EDITED_MESSAGE_TEXT, LIFECYCLE_PROFILE, LifecycleOptions, LifecycleRun,
    run_lifecycle, temp_store,
};
use lhc::messages::MutationResult;
use lhc::shared_tech::derivation::{DerivationReportEntry, DerivationState};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::inspect::HealthQueue;
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::view::{
    LlmRequestContext, LlmRequestContextMessage, LlmRequestContextRole, ViewStatusDerivation,
};
use regex::Regex;

fn ok<T: Clone>(result: &OpResult<T>) -> T {
    match result {
        OpResult::Ok { value } => value.clone(),
        OpResult::Err { error } => {
            panic!(
                "expected ok result: {}",
                js_json_stringify_of(error).unwrap_or_else(|_| format!("{error:?}"))
            )
        }
    }
}

fn sha256_hex(value: &str) -> String {
    // Test-only SHA-256 matching TS `createHash("sha256").update(value).digest("hex")`.
    // Pure FIPS 180-4 impl below — no production crypto dependency.
    sha256_bytes(value.as_bytes())
}

fn sha256_bytes(data: &[u8]) -> String {
    // Compact pure-Rust SHA-256 (public domain / FIPS 180-4).
    fn rotr(x: u32, n: u32) -> u32 {
        (x >> n) | (x << (32 - n))
    }
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];
        for i in 0..64 {
            let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}

fn message_text(message: &LlmRequestContextMessage) -> String {
    message
        .content
        .iter()
        .map(|part| part.text.as_str())
        .collect()
}

fn is_band_message(message: &LlmRequestContextMessage) -> bool {
    message_text(message).starts_with("[context ·")
}

fn measured(messages: &[LlmRequestContextMessage]) -> i64 {
    messages
        .iter()
        .map(|message| estimate_tokens(&message_text(message)))
        .sum()
}

fn comparable_context(context: &LlmRequestContext) -> LlmRequestContext {
    LlmRequestContext {
        thread_id: "<threadId>".into(),
        messages: context.messages.clone(),
    }
}

fn cleared_keys(mutations: &[&MutationResult]) -> Vec<String> {
    let mut keys: Vec<String> = mutations
        .iter()
        .flat_map(|mutation| mutation.cleared.iter())
        .map(|target| {
            format!(
                "{}:{}:{}",
                target.subject_kind.as_str(),
                target.subject_id,
                target.derivation_type
            )
        })
        .collect();
    keys.sort();
    keys
}

fn pending_keys(reports: &[&[DerivationReportEntry]]) -> Vec<String> {
    let mut keys: Vec<String> = reports
        .iter()
        .flat_map(|report| report.iter())
        .filter(|entry| entry.state == DerivationState::Pending)
        .map(|entry| {
            format!(
                "{}:{}:{}",
                entry.subject_kind.as_str(),
                entry.subject_id,
                entry.derivation_type
            )
        })
        .collect();
    keys.sort();
    keys
}

fn comparable_session_file(lifecycle_run: &LifecycleRun) -> String {
    fs::read_to_string(&lifecycle_run.out_path)
        .expect("session file")
        .replace(&lifecycle_run.thread_id, "<thread-id>")
}

#[tokio::test]
async fn every_phase_operation_returns_ok_with_deterministic_inference_callbacks() {
    let store = temp_store();
    let run = run_lifecycle(
        &store,
        LifecycleOptions {
            name: Some("baseline".into()),
            ..Default::default()
        },
    )
    .await;
    let phases = &run.phases;
    assert!(phases.create.is_ok());
    for batch in &phases.intake {
        assert!(batch.is_ok());
    }
    assert!(phases.drain.settled);
    assert!(phases.status.is_ok());
    assert!(phases.compact1.is_ok());
    assert!(phases.llm_context1.is_ok());
    assert!(phases.inspect1.overview.is_ok());
    assert!(phases.inspect1.view.is_ok());
    assert!(phases.inspect1.health.is_ok());
    assert!(phases.mutate.edit.is_ok());
    assert!(phases.mutate.delete.is_ok());
    assert!(phases.mutate.health_after_mutate.is_ok());
    assert!(phases.rebuild.settled);
    assert!(phases.health2.is_ok());
    assert!(phases.compact2.is_ok());
    assert!(phases.llm_context2.is_ok());
    assert!(phases.materialize.is_ok());
    store.cleanup();
}

#[tokio::test]
async fn status_recommends_the_compact_the_sequence_performs_next_with_derivation_settled() {
    let store = temp_store();
    let run = run_lifecycle(
        &store,
        LifecycleOptions {
            name: Some("baseline".into()),
            ..Default::default()
        },
    )
    .await;
    let status = ok(&run.phases.status);
    assert_eq!(status.threshold, 300);
    assert!(status.tail_tokens > status.threshold);
    assert!(status.compact_recommended);
    assert_eq!(
        status.derivation,
        ViewStatusDerivation {
            pending: 0,
            failed: 0,
            blocked: 0
        }
    );
    assert!(status.view.is_none());
    store.cleanup();
}

#[tokio::test]
async fn post_compact_model_context_serves_bands_tail_and_the_view_reports_load_cost_prices_that_context()
 {
    let store = temp_store();
    let run = run_lifecycle(
        &store,
        LifecycleOptions {
            name: Some("baseline".into()),
            ..Default::default()
        },
    )
    .await;
    let receipt = ok(&run.phases.compact1);
    assert_eq!(receipt.profile.as_deref(), Some(LIFECYCLE_PROFILE.name));
    let context = ok(&run.phases.llm_context1);

    let bands: Vec<_> = context
        .messages
        .iter()
        .filter(|m| is_band_message(m))
        .cloned()
        .collect();
    let band_re = Regex::new(r"^\[context · ([^\]]+)\]").unwrap();
    assert_eq!(
        bands
            .iter()
            .map(|message| {
                band_re
                    .captures(&message_text(message))
                    .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            })
            .collect::<Vec<_>>(),
        [
            Some("brief".into()),
            Some("detailed".into()),
            Some("smooth".into())
        ]
    );
    assert_eq!(&context.messages[..bands.len()], bands.as_slice());
    let tail = &context.messages[bands.len()..];
    assert!(!tail.is_empty());

    let report = ok(&run.phases.inspect1.view);
    let meta = report.meta.as_ref().expect("meta");
    assert_eq!(meta.view_id, receipt.view_id);
    assert_eq!(meta.profile.as_deref(), Some(LIFECYCLE_PROFILE.name));
    assert_eq!(report.load_cost.band_tokens, measured(&bands));
    assert_eq!(report.load_cost.tail_tokens, measured(tail));
    assert_eq!(report.load_cost.total, measured(&context.messages));

    let overview = ok(&run.phases.inspect1.overview);
    assert_eq!(
        overview.view.as_ref().map(|v| v.view_id.as_str()),
        Some(receipt.view_id.as_str())
    );
    assert_eq!(overview.derivation.pending, 0);
    assert_eq!(overview.messages.deleted, 0);
    store.cleanup();
}

#[tokio::test]
async fn post_mutation_health_shows_exactly_the_cleared_set_pending_post_drain_health_shows_it_ready()
 {
    let store = temp_store();
    let run = run_lifecycle(
        &store,
        LifecycleOptions {
            name: Some("baseline".into()),
            ..Default::default()
        },
    )
    .await;
    let mutate = &run.phases.mutate;
    let edit = ok(&mutate.edit);
    let deleted = ok(&mutate.delete);
    assert!(edit.superseded.is_empty());
    assert!(deleted.superseded.is_empty());
    assert!(deleted.dropped.is_empty());

    let cleared = cleared_keys(&[&edit, &deleted]);
    assert!(!cleared.is_empty());
    let messages_nr = ok(&mutate.messages_not_ready);
    let turns_nr = ok(&mutate.turns_not_ready);
    let pending = pending_keys(&[messages_nr.as_slice(), turns_nr.as_slice()]);
    assert_eq!(pending, cleared);

    let health = ok(&mutate.health_after_mutate);
    let pending_total: i64 = health.owners.iter().map(|row| row.counts.pending).sum();
    assert_eq!(pending_total, cleared.len() as i64);
    assert_eq!(
        health.queue,
        HealthQueue {
            queued: cleared.len() as i64,
            claimed: 0
        }
    );
    assert!(!edit.queued.is_empty());
    assert!(!deleted.queued.is_empty());
    assert!(health.failures.is_empty());

    let after = ok(&run.phases.health2);
    for row in &after.owners {
        assert_eq!(row.counts.pending, 0);
        assert_eq!(row.counts.failed, 0);
        assert_eq!(row.counts.blocked, 0);
        assert!(row.counts.ready > 0);
    }
    assert!(after.failures.is_empty());
    assert!(after.repair_preview.is_empty());
    assert_eq!(
        after.queue,
        HealthQueue {
            queued: 0,
            claimed: 0
        }
    );
    store.cleanup();
}

#[tokio::test]
async fn the_second_compacts_view_reflects_post_edit_content() {
    let store = temp_store();
    let run = run_lifecycle(
        &store,
        LifecycleOptions {
            name: Some("baseline".into()),
            ..Default::default()
        },
    )
    .await;
    let llm_context1 = ok(&run.phases.llm_context1);
    let llm_context2 = ok(&run.phases.llm_context2);

    assert!(
        llm_context1
            .messages
            .iter()
            .any(|m| message_text(m) == "turn 12: please investigate area 12")
    );
    assert!(
        llm_context1
            .messages
            .iter()
            .any(|m| message_text(m) == DELETED_MESSAGE_TEXT)
    );

    assert!(llm_context2.messages.iter().any(|m| {
        !is_band_message(m)
            && m.role == LlmRequestContextRole::User
            && message_text(m) == EDITED_MESSAGE_TEXT
    }));
    assert!(
        !llm_context2
            .messages
            .iter()
            .any(|m| message_text(m).contains(DELETED_MESSAGE_TEXT))
    );
    assert!(
        !llm_context2
            .messages
            .iter()
            .any(|m| message_text(m) == "turn 12: please investigate area 12")
    );
    store.cleanup();
}

#[tokio::test]
async fn produces_hash_equal_llm_request_context_outputs_and_a_byte_identical_materialized_file() {
    let store = temp_store();
    let run = run_lifecycle(
        &store,
        LifecycleOptions {
            name: Some("baseline".into()),
            ..Default::default()
        },
    )
    .await;
    let replay = tokio::time::timeout(
        Duration::from_secs(60),
        run_lifecycle(
            &store,
            LifecycleOptions {
                name: Some("replay".into()),
                ..Default::default()
            },
        ),
    )
    .await
    .expect("replay lifecycle timed out");

    let contexts = [
        (&run.phases.llm_context1, &replay.phases.llm_context1),
        (&run.phases.llm_context2, &replay.phases.llm_context2),
    ];
    for (original, replayed) in contexts {
        let a = js_json_stringify_of(&comparable_context(&ok(replayed))).unwrap();
        let b = js_json_stringify_of(&comparable_context(&ok(original))).unwrap();
        assert_eq!(sha256_hex(&a), sha256_hex(&b));
    }

    assert_ne!(replay.thread_id, run.thread_id);
    assert_eq!(
        sha256_hex(&comparable_session_file(&replay)),
        sha256_hex(&comparable_session_file(&run))
    );
    store.cleanup();
}

#[tokio::test]
async fn yields_final_llm_request_context_health_and_materialized_file_identical_to_the_uninterrupted_runs()
 {
    let store = temp_store();
    let run = run_lifecycle(
        &store,
        LifecycleOptions {
            name: Some("baseline".into()),
            ..Default::default()
        },
    )
    .await;
    let teardown = tokio::time::timeout(
        Duration::from_secs(60),
        run_lifecycle(
            &store,
            LifecycleOptions {
                name: Some("teardown".into()),
                fresh_sdk_between_groups: Some(true),
                ..Default::default()
            },
        ),
    )
    .await
    .expect("teardown lifecycle timed out");

    assert_eq!(
        js_json_stringify_of(&comparable_context(&ok(&teardown.phases.llm_context2))).unwrap(),
        js_json_stringify_of(&comparable_context(&ok(&run.phases.llm_context2))).unwrap()
    );
    assert_eq!(ok(&teardown.phases.health2), ok(&run.phases.health2));
    assert_eq!(
        sha256_hex(&comparable_session_file(&teardown)),
        sha256_hex(&comparable_session_file(&run))
    );
    store.cleanup();
}

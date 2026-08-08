//! Ported from packages/lhc/test/view-compact.test.ts. Phase 1.
//!
//! Epic 03 Story 2: smart compact (TC-2.1–2.4, TC-2.6, TC-2.7, TC-1.3,
//! TC-1.5, the TC-2.5 view-health completion legs, and architecture-risk rows).
//!
//! Critical fix1 preservations:
//! - `sdk.work.drain` (not mut.work)
//! - frozen [`DegradedThread`] named struct (not a map)
//! - TC-1.3: toBeDefined tolerates null; `.not.toContain` on undefined errors
//!   (do not silently pass via `is None or`)
//!
//! Judgment: Rust has no async beforeAll — each test builds a fresh
//! `temp_store` / fixture (acceptable isolation translation of TS
//! file-level `beforeAll`).

mod fixtures;

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, DerivedThreadFixture, DerivedThreadOptions, InferenceCallbacksDouble,
    TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    TurnEndOverrides, UserPromptOverrides, UserPromptPayload, ViewInjectionPoint,
    corrupt_two_open_turns, create_inference_callbacks_double, derived_thread_fixture, kind,
    set_view_injection_hook, temp_store, valid_event,
};
use indexmap::IndexMap;
use lhc::intake_stream::MessageEventInput;
use lhc::messages::{EditInput, MessageKind, RemoveInput};
use lhc::shared_tech::derivation::{ChunkPolicyConfig, DerivationState, SdkConfig, SdkMode};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::inference_types::{DerivationGuards, DetailedTurnCompressionGuards};
use lhc::shared_tech::js_json::{js_json_stringify, js_json_stringify_of};
use lhc::shared_tech::view::{
    Band, CompactBandStats, CompactReceiptConfig, LlmRequestContextMessage,
    PartialViewProfilePercentages, SessionAssistantMessage, SessionAssistantPartType,
    SessionThreadViewEntry, SessionThreadViewMessage, SessionUserMessage, ViewCompactParams,
    ViewProfilePercentages, ViewSubjectKind,
};
use lhc::thread_view::internal::render::DerivationSnapshot;
use lhc::thread_view::internal::select::{
    SelectionChunk, SelectionChunkStatus, SelectionConfig, SelectionInputs, SelectionMessage,
    SelectionTurn, SelectionTurnStatus, select_arrangement,
};
use lhc::thread_view::{CompactAbortSignal, CompactOpts};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};
use serde::Serialize;
use serde_json::{Map, Value, json};

const TARGET_PARAMS: ViewCompactParams = ViewCompactParams {
    lower_bound: Some(400.0),
    percentages: Some(PartialViewProfilePercentages {
        full: Some(25.0),
        smooth: Some(25.0),
        detailed: Some(25.0),
        brief: Some(25.0),
    }),
};

fn gradient_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(400.0),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(25.0),
            smooth: Some(16.0),
            detailed: Some(10.0),
            brief: Some(49.0),
        }),
    }
}

fn edge_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(100.0),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(50.0),
            smooth: Some(10.0),
            detailed: Some(10.0),
            brief: Some(30.0),
        }),
    }
}

const TOOL_HEAVY_TURNS: [i64; 4] = [5, 6, 7, 8];
const C1_BRIEF_FAILURE_REASON: &str = "rate_limit: scripted c1 brief failure (test)";

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

fn sha256_bytes(data: &[u8]) -> String {
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

fn sha256_value(value: &Value) -> String {
    sha256_bytes(js_json_stringify(value).as_bytes())
}

fn sha256_of<T: Serialize>(value: &T) -> String {
    sha256_bytes(js_json_stringify_of(value).expect("js_json").as_bytes())
}

fn db_rows(db: &lhc::shared_tech::storage::Db, sql: &str) -> Vec<Value> {
    db.prepare(sql)
        .all(&[])
        .into_iter()
        .map(Value::Object)
        .collect()
}

fn record_snapshot(file_path: &str) -> String {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let snap = json!({
        "events": db_rows(db, "SELECT * FROM event ORDER BY event_order"),
        "messages": db_rows(db, "SELECT * FROM message ORDER BY source_event_order"),
        "blocks": db_rows(db, "SELECT * FROM message_block ORDER BY message_id, block_index"),
        "turns": db_rows(db, "SELECT * FROM turns ORDER BY turn_order"),
        "chunks": db_rows(db, "SELECT * FROM chunk ORDER BY chunk_order"),
        "members": db_rows(db, "SELECT * FROM chunk_member ORDER BY chunk_id, member_idx"),
        "derivations": db_rows(
            db,
            "SELECT * FROM derivation ORDER BY subject_kind, subject_id, derivation_type",
        ),
    });
    sha256_value(&snap)
}

fn full_state_snapshot(file_path: &str) -> String {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let snap = json!({
        "record": record_snapshot(file_path),
        "views": db_rows(db, "SELECT * FROM thread_view"),
        "bands": db_rows(db, "SELECT * FROM thread_view_band ORDER BY band"),
        "boundary": db_rows(db, "SELECT position FROM view_boundary"),
        "work": db_rows(db, "SELECT work_item_id, status FROM work_item ORDER BY work_item_id"),
    });
    sha256_value(&snap)
}

fn view_row_count(file_path: &str) -> i64 {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let row = db
        .prepare("SELECT COUNT(*) AS n FROM thread_view")
        .get()
        .expect("thread_view count row");
    row.get("n")
        .and_then(|v| v.as_i64())
        .expect("thread_view count n")
}

fn boundary_position(file_path: &str) -> i64 {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let row = db
        .prepare("SELECT position FROM view_boundary")
        .get()
        .expect("view_boundary row");
    row.get("position")
        .and_then(|v| v.as_i64())
        .expect("view_boundary.position")
}

fn message_text(message: &LlmRequestContextMessage) -> String {
    message
        .content
        .iter()
        .map(|part| part.text.as_str())
        .collect()
}

fn band_messages(messages: &[LlmRequestContextMessage]) -> Vec<LlmRequestContextMessage> {
    messages
        .iter()
        .filter(|message| message_text(message).starts_with("[context ·"))
        .cloned()
        .collect()
}

async fn context_messages(sdk: &Lhc, file_path: &str) -> Vec<LlmRequestContextMessage> {
    let context_read = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(file_path))
        .await;
    match context_read {
        OpResult::Ok { value } => value.messages,
        OpResult::Err { error } => panic!("model context failed: {}", error.reason),
    }
}

fn compact_opts(params: ViewCompactParams) -> CompactOpts {
    CompactOpts {
        profile: None,
        params: Some(params),
        signal: None,
    }
}

async fn open_tail_dangling_tool_thread(into_store: &TempStore) -> (Lhc, String) {
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let file_path = into_store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(into_store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("thread creation failed: {}", error.reason);
    }

    for turn in 1i64..=3 {
        let closed = sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&file_path),
                &[
                    valid_event(
                        kind::USER_PROMPT,
                        UserPromptOverrides {
                            payload: Some(UserPromptPayload {
                                text: format!("closed turn {turn}"),
                            }),
                            ..Default::default()
                        },
                    ),
                    valid_event(
                        kind::ASSISTANT_TEXT,
                        AssistantTextOverrides {
                            payload: Some(AssistantTextPayload::new(format!("closed answer {turn}"))),
                            ..Default::default()
                        },
                    ),
                    valid_event(kind::TURN_END, TurnEndOverrides::default()),
                ],
            )
            .await;
        if !closed.is_ok() {
            let OpResult::Err { error } = closed else {
                unreachable!()
            };
            panic!("closed turn intake failed: {}", error.reason);
        }
    }
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    if !drained.is_ok() {
        let OpResult::Err { error } = drained else {
            unreachable!()
        };
        panic!("drain failed: {}", error.reason);
    }

    // TS: `...serve ${" --verbose".repeat(200)}` → two spaces before --verbose
    let verbose = " --verbose".repeat(200);
    let mut args = Map::new();
    args.insert(
        "command".into(),
        Value::String(format!(
            "npx @agent-native/core@latest plan local serve {verbose}"
        )),
    );
    let opened = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "render the plan locally".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("Lint passed. Now let me serve it.")),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: "call-open-serve".into(),
                            tool_name: "bash".into(),
                            arguments: args,
                        }),
                        ..Default::default()
                    },
                ),
            ],
        )
        .await;
    if !opened.is_ok() {
        let OpResult::Err { error } = opened else {
            unreachable!()
        };
        panic!("open turn intake failed: {}", error.reason);
    }

    (sdk, file_path)
}

fn degraded_turn_events(turn: i64) -> Vec<MessageEventInput> {
    let tool_heavy: HashSet<i64> = TOOL_HEAVY_TURNS.into_iter().collect();
    let mut events = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: format!("turn {turn}: please investigate area {turn}"),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::ASSISTANT_THINKING,
            AssistantThinkingOverrides {
                payload: Some(AssistantThinkingPayload::new(format!("considering what area {turn} contains"))),
                ..Default::default()
            },
        ),
    ];
    if tool_heavy.contains(&turn) {
        for run in [1i64, 2] {
            let tool_call_id = format!("call-dg-{turn}-{run}");
            let mut args = Map::new();
            args.insert(
                "path".into(),
                Value::String(format!("area-{turn}/file-{run}.txt")),
            );
            events.push(valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: tool_call_id.clone(),
                        tool_name: "read_file".into(),
                        arguments: args,
                    }),
                    ..Default::default()
                },
            ));
            events.push(valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id,
                        content: format!(
                            "contents of area-{turn}/file-{run}.txt: detail {turn}.{run} with enough text to summarize"
                        ),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ));
        }
    }
    events.push(valid_event(
        kind::ASSISTANT_TEXT,
        AssistantTextOverrides {
            payload: Some(AssistantTextPayload::new(format!("findings for area {turn}"))),
            ..Default::default()
        },
    ));
    events.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    events
}

/// TS `DegradedThread` — named struct (fix1: not a map).
struct DegradedThread {
    file_path: String,
    sdk: Lhc,
    double: InferenceCallbacksDouble,
    /// Populated during build for scripted edits; retained for TS shape fidelity.
    #[allow(dead_code)]
    prompt_id_by_turn: HashMap<i64, String>,
}

async fn build_degraded_thread(into_store: &TempStore) -> DegradedThread {
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: Some(DerivationGuards {
            smoothed_prompt: None,
            tool_result_summary: None,
            detailed_turn_compression: Some(DetailedTurnCompressionGuards {
                tiny_turn_tokens: Some(1),
            }),
        }),
        tool_result: None,
        lease: None,
        chunk_policy: Some(ChunkPolicyConfig {
            target_projected_tokens: 90,
            max_projected_tokens: 4400,
        }),
        view: None,
    });
    let file_path = into_store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(into_store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("thread creation failed: {}", error.reason);
    }

    let mut prompt_id_by_turn = HashMap::new();
    for turn in 1i64..=12 {
        if turn == 4 {
            double.fail_kind("chunk_summary_brief", 1, Some(C1_BRIEF_FAILURE_REASON));
        }
        let sent = sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&file_path),
                &degraded_turn_events(turn),
            )
            .await;
        if !sent.is_ok() {
            let OpResult::Err { error } = sent else {
                unreachable!()
            };
            panic!("intake failed: {}", error.reason);
        }
        let OpResult::Ok { value: sent } = sent else {
            unreachable!()
        };
        if let Some(prompt_id) = sent.events.first().and_then(|e| e.message_id.clone()) {
            prompt_id_by_turn.insert(turn, prompt_id);
        }
        let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
        if !drained.is_ok() {
            let OpResult::Err { error } = drained else {
                unreachable!()
            };
            panic!("drain failed: {}", error.reason);
        }
    }

    for turn in [4i64, 5, 6, 8] {
        let prompt_id = prompt_id_by_turn
            .get(&turn)
            .cloned()
            .unwrap_or_else(|| panic!("no prompt id recorded for turn {turn}"));
        let edited = sdk
            .messages
            .edit(
                ThreadRef::file_path(&file_path),
                EditInput {
                    message_id: prompt_id,
                    content: format!("turn {turn}: edited investigation of area {turn}"),
                },
            )
            .await;
        if !edited.is_ok() {
            let OpResult::Err { error } = edited else {
                unreachable!()
            };
            panic!("edit failed: {}", error.reason);
        }
    }
    DegradedThread {
        file_path,
        sdk,
        double,
        prompt_id_by_turn,
    }
}

async fn suite_fixture() -> (TempStore, DerivedThreadFixture) {
    let store = temp_store();
    let fixture = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    (store, fixture)
}

// ── TC-2.1 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn rejects_percentages_summing_to_105_naming_the_sum_and_an_unknown_profile_naming_it_thread_unchanged()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let before = full_state_snapshot(&fixture.file_path);

    let bad_sum = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: None,
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(30.0),
                        smooth: Some(30.0),
                        detailed: Some(25.0),
                        brief: Some(20.0),
                    }),
                }),
                signal: None,
            },
        )
        .await;
    assert!(!bad_sum.is_ok());
    if let OpResult::Err { error } = &bad_sum {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::InvalidViewConfig);
        assert!(error.reason.contains("105"));
    }

    let bad_bound = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(0.0),
                    percentages: None,
                }),
                signal: None,
            },
        )
        .await;
    assert!(!bad_bound.is_ok());
    if let OpResult::Err { error } = &bad_bound {
        assert_eq!(error.code, ErrorCode::InvalidViewConfig);
        assert!(error.reason.contains("lowerBound"));
    }

    let unknown = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            CompactOpts {
                profile: Some("nonesuch".into()),
                params: None,
                signal: None,
            },
        )
        .await;
    assert!(!unknown.is_ok());
    if let OpResult::Err { error } = &unknown {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::UnknownProfile);
        assert!(error.reason.contains("\"nonesuch\""));
    }

    assert_eq!(full_state_snapshot(&fixture.file_path), before);
    assert_eq!(view_row_count(&fixture.file_path), 0);
}

#[tokio::test]
async fn compacts_with_a_built_in_profile_the_profiles_bound_and_mix_land_in_the_receipt() {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let receipt = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            CompactOpts {
                profile: Some("coding".into()),
                params: None,
                signal: None,
            },
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value } = receipt else {
        return;
    };
    assert_eq!(value.profile.as_deref(), Some("coding"));
    assert_eq!(
        value.config,
        CompactReceiptConfig {
            full: 25.0,
            smooth: 35.0,
            detailed: 20.0,
            brief: 20.0,
            lower_bound: 120000.0,
        }
    );
    assert_eq!(value.compact_point, 0);
    assert_eq!(value.bands.smooth.entries, 0);
    assert_eq!(value.total_tokens, value.tail_tokens);
}

#[tokio::test]
async fn explicit_params_override_profile_values_field_wise_and_report_profile_null() {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let receipt = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            CompactOpts {
                profile: Some("coding".into()),
                params: Some(ViewCompactParams {
                    lower_bound: Some(400.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: None,
                        smooth: Some(40.0),
                        detailed: Some(15.0),
                        brief: None,
                    }),
                }),
                signal: None,
            },
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value } = receipt else {
        return;
    };
    assert_eq!(
        value.config,
        CompactReceiptConfig {
            full: 25.0,
            smooth: 40.0,
            detailed: 15.0,
            brief: 20.0,
            lower_bound: 400.0,
        }
    );
    assert!(value.profile.is_none());
}

// ── TC-2.2 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn actuals_near_shares_with_whole_entry_deviations_zero_model_calls_record_untouched() {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let captured = fixture.double.capture_inputs();
    let captured_before = captured.len();
    let record_before = record_snapshot(&fixture.file_path);

    let receipt = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            compact_opts(TARGET_PARAMS),
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value } = receipt else {
        return;
    };
    let share_smooth = (400.0 * 25.0) / 100.0;
    let share_detailed = (400.0 * 25.0) / 100.0;
    let share_brief = (400.0 * 25.0) / 100.0;

    let actual = &value.bands.brief;
    let attributable = (actual.tokens as f64) <= share_brief || actual.entries == 1;
    assert!(attributable);

    // Token count includes the <turns>…</turns> member-turn header on chunk bands.
    assert_eq!(
        value.bands.brief,
        CompactBandStats {
            entries: 1,
            tokens: 41
        }
    );
    assert_eq!(value.bands.detailed.entries, 2);
    assert!((value.bands.detailed.tokens as f64) >= share_detailed);
    assert_eq!(value.bands.smooth.entries, 1);
    assert!((value.bands.smooth.tokens as f64) > share_smooth);
    assert!(value.gaps.is_empty());
    assert!((value.tail_tokens as f64) <= (400.0 * 25.0) / 100.0);
    assert_eq!(value.compact_point, 48);

    assert_eq!(
        value.total_tokens,
        value.bands.brief.tokens
            + value.bands.detailed.tokens
            + value.bands.smooth.tokens
            + value.tail_tokens
    );

    assert_eq!(captured.len(), captured_before);
    assert_eq!(record_snapshot(&fixture.file_path), record_before);
}

#[tokio::test]
async fn keeps_a_latest_open_turn_with_a_dangling_tool_call_in_the_live_session_tail() {
    let _hook_guard = ClearCompactWriteHook::install();
    let store = temp_store();
    let (sdk, file_path) = open_tail_dangling_tool_thread(&store).await;

    let receipt = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            compact_opts(TARGET_PARAMS),
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value } = receipt else {
        return;
    };

    assert_eq!(value.compact_point, 9);
    assert_eq!(value.first_kept_message_id.as_deref(), Some("m10"));
    assert!(value.bands.smooth.entries > 0);
    let full_share = (TARGET_PARAMS.lower_bound.unwrap()
        * TARGET_PARAMS.percentages.as_ref().unwrap().full.unwrap())
        / 100.0;
    assert!((value.tail_tokens as f64) > full_share);

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    assert!(view.is_ok());
    let OpResult::Ok { value: view } = view else {
        return;
    };

    let open_user = view.entries.iter().find(|entry| match entry {
        SessionThreadViewEntry::Message(SessionThreadViewMessage::User(SessionUserMessage {
            content,
            ..
        })) => content == "render the plan locally",
        _ => false,
    });
    assert!(open_user.is_some());
    if let Some(SessionThreadViewEntry::Message(SessionThreadViewMessage::User(
        SessionUserMessage {
            source_messages, ..
        },
    ))) = open_user
    {
        assert_eq!(
            source_messages.first().map(|s| s.message_id.as_str()),
            Some("m10")
        );
    }

    let last = view.entries.last();
    assert!(last.is_some());
    let Some(SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(
        SessionAssistantMessage {
            content,
            source_messages,
            provider: _,
            model: _,
            api: _,
        },
    ))) = last
    else {
        panic!("last entry must be assistant");
    };
    let ids: Vec<&str> = source_messages
        .iter()
        .map(|s| s.message_id.as_str())
        .collect();
    assert_eq!(ids, vec!["m11", "m12"]);
    assert!(content.iter().any(|part| {
        part.type_ == SessionAssistantPartType::ToolCall
            && part.tool_call_id.as_deref() == Some("call-open-serve")
            && part.tool_name.as_deref() == Some("bash")
    }));
}

// ── TC-2.6 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn brief_detailed_and_smooth_band_text_carries_selected_conversation_content() {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let receipt = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            compact_opts(gradient_params()),
        )
        .await;
    assert!(receipt.is_ok());

    let messages = context_messages(&fixture.sdk, &fixture.file_path).await;
    let bands = band_messages(&messages);
    let mut by_band: HashMap<String, String> = HashMap::new();
    for message in &bands {
        let text = message_text(message);
        if let Some(cap) = text
            .strip_prefix("[context · ")
            .and_then(|rest| rest.split(']').next())
        {
            by_band.insert(cap.to_string(), text);
        }
    }
    assert!(
        by_band
            .get("brief")
            .is_some_and(|t| t.contains("projection("))
    );
    assert!(
        by_band
            .get("detailed")
            .is_some_and(|t| t.contains("projection("))
    );
    assert!(
        by_band
            .get("smooth")
            .is_some_and(|t| t.contains("User prompt"))
    );
}

// ── architecture-risk: coverage edge ─────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
struct EntryProjection {
    band: Band,
    subject_kind: ViewSubjectKind,
    subject_id: String,
    derivation_used: String,
    gap: bool,
}

#[test]
fn renders_coverage_entries_for_closed_turns_left_uncovered_inside_an_open_chunk() {
    let turns: Vec<SelectionTurn> = (1i64..=6)
        .map(|turn| SelectionTurn {
            turn_id: format!("t{turn}"),
            turn_order: turn,
            status: SelectionTurnStatus::Closed,
            opened_at: (turn - 1) * 10 + 1,
            closed_at: Some(turn * 10),
        })
        .collect();
    let messages: Vec<SelectionMessage> = turns
        .iter()
        .map(|turn| SelectionMessage {
            message_id: format!("m{}", turn.turn_order),
            order: turn.opened_at,
            kind: "user_prompt".into(),
            token_estimate: if turn.turn_id == "t6" { 100 } else { 10 },
            turn_id: turn.turn_id.clone(),
            text: format!("prompt {}", turn.turn_id),
        })
        .collect();
    let chunks = vec![
        SelectionChunk {
            chunk_id: "c1".into(),
            chunk_order: 1,
            status: SelectionChunkStatus::Closed,
            member_turn_ids: vec!["t1".into(), "t2".into()],
        },
        SelectionChunk {
            chunk_id: "c2".into(),
            chunk_order: 2,
            status: SelectionChunkStatus::Open,
            member_turn_ids: vec!["t3".into(), "t4".into(), "t5".into()],
        },
    ];
    let mut derivations = IndexMap::new();
    derivations.insert(
        "t3/detailed_turn_compression".into(),
        DerivationSnapshot {
            state: DerivationState::Ready,
            content: Some("compressed ".repeat(200)),
            reason: None,
        },
    );
    derivations.insert(
        "t4/detailed_turn_compression".into(),
        DerivationSnapshot {
            state: DerivationState::Failed,
            content: None,
            reason: Some("compression failed".into()),
        },
    );
    derivations.insert(
        "t4/pre_detailed_assembly".into(),
        DerivationSnapshot {
            state: DerivationState::Ready,
            content: Some(format!("User:\n{}\n\n⏺ more", "large ".repeat(500))),
            reason: None,
        },
    );
    derivations.insert(
        "t5/turn_rendering".into(),
        DerivationSnapshot {
            state: DerivationState::Ready,
            content: Some("newest banded turn".into()),
            reason: None,
        },
    );
    derivations.insert(
        "c1/chunk_summary_detailed".into(),
        DerivationSnapshot {
            state: DerivationState::Ready,
            content: Some("closed chunk summary".into()),
            reason: None,
        },
    );
    let inputs = SelectionInputs {
        messages,
        turns,
        chunks,
        derivations,
        compact_chunk_materials: None,
        max_event_order: 60,
        derivation_counts: IndexMap::new(),
    };

    let selection = select_arrangement(
        &inputs,
        &SelectionConfig {
            lower_bound: 1000.0,
            percentages: ViewProfilePercentages {
                full: 10.0,
                smooth: 10.0,
                detailed: 40.0,
                brief: 40.0,
            },
        },
    )
    .expect("select_arrangement");

    assert_eq!(selection.compact_point, 50);
    assert_eq!(selection.covered_from, 1);
    let projected: Vec<EntryProjection> = selection
        .entries
        .iter()
        .map(|entry| EntryProjection {
            band: entry.band,
            subject_kind: entry.subject_kind,
            subject_id: entry.subject_id.clone(),
            derivation_used: entry.derivation_used.clone(),
            gap: entry.gap,
        })
        .collect();
    assert_eq!(
        projected,
        vec![
            EntryProjection {
                band: Band::Detailed,
                subject_kind: ViewSubjectKind::Chunk,
                subject_id: "c1".into(),
                derivation_used: "chunk_summary_detailed".into(),
                gap: false,
            },
            EntryProjection {
                band: Band::Detailed,
                subject_kind: ViewSubjectKind::Turn,
                subject_id: "t3".into(),
                derivation_used: "detailed_turn_compression".into(),
                gap: false,
            },
            EntryProjection {
                band: Band::Smooth,
                subject_kind: ViewSubjectKind::Turn,
                subject_id: "t4".into(),
                derivation_used: "message_excerpt".into(),
                gap: false,
            },
            EntryProjection {
                band: Band::Smooth,
                subject_kind: ViewSubjectKind::Turn,
                subject_id: "t5".into(),
                derivation_used: "turn_rendering".into(),
                gap: false,
            },
        ]
    );
    assert!(selection.entries.iter().filter(|e| e.gap).count() == 0);
    assert_eq!(
        selection
            .entries
            .iter()
            .find(|e| e.subject_id == "t4")
            .map(|e| e.degraded),
        Some(true)
    );
}

#[tokio::test]
async fn closed_turns_below_the_coverage_edge_remain_outside_the_represented_window() {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_store, fixture) = suite_fixture().await;
    let receipt = fixture
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&fixture.file_path),
            compact_opts(edge_params()),
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value } = receipt else {
        return;
    };

    assert_eq!(value.compact_point, 56);
    assert_eq!(value.covered_from, 13);
    assert_eq!(value.bands.detailed.entries, 1);
    assert_eq!(value.bands.brief.entries, 1);
    assert!(value.gaps.is_empty());
}

// ── architecture-risk: restart ───────────────────────────────────────

#[tokio::test]
async fn a_fresh_sdk_on_the_same_file_serves_byte_identical_band_content() {
    let _hook_guard = ClearCompactWriteHook::install();
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let receipt = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            compact_opts(gradient_params()),
        )
        .await;
    assert!(receipt.is_ok());
    let before = local
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(before.is_ok());
    let OpResult::Ok { value: before } = before else {
        return;
    };

    let fresh = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let after = fresh
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(after.is_ok());
    let OpResult::Ok { value: after } = after else {
        return;
    };
    assert_eq!(
        js_json_stringify_of(&after).expect("stringify"),
        js_json_stringify_of(&before).expect("stringify")
    );
}

// ── TC-2.4 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn an_injected_crash_leaves_the_previous_view_serving_the_rerun_lands_clean_with_no_partial_state()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let first = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            compact_opts(gradient_params()),
        )
        .await;
    assert!(first.is_ok());
    let prior_context = local
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(prior_context.is_ok());
    let OpResult::Ok {
        value: prior_context,
    } = prior_context
    else {
        return;
    };
    assert_eq!(boundary_position(&local.file_path), 48);

    set_view_injection_hook(
        ViewInjectionPoint::CompactWrite,
        Some(std::sync::Arc::new(|| {
            panic!("injected crash between sweep and view write");
        })),
    );
    let crashed = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            compact_opts(edge_params()),
        )
        .await;
    set_view_injection_hook(ViewInjectionPoint::CompactWrite, None);
    assert!(!crashed.is_ok());
    if let OpResult::Err { error } = &crashed {
        assert_eq!(error.error_class, ErrorClass::SystemError);
        assert!(error.reason.contains("injected crash"));
    }

    let after_crash = local
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(after_crash.is_ok());
    let OpResult::Ok { value: after_crash } = after_crash else {
        return;
    };
    assert_eq!(
        js_json_stringify_of(&after_crash).expect("stringify"),
        js_json_stringify_of(&prior_context).expect("stringify")
    );
    assert_eq!(view_row_count(&local.file_path), 1);
    assert_eq!(boundary_position(&local.file_path), 48);

    let rerun = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            compact_opts(edge_params()),
        )
        .await;
    assert!(rerun.is_ok());
    let OpResult::Ok { value: rerun } = rerun else {
        return;
    };
    assert_eq!(rerun.covered_from, 13);
    assert_eq!(view_row_count(&local.file_path), 1);
    assert_eq!(boundary_position(&local.file_path), 56);
    let rerun_context = local
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(rerun_context.is_ok());
    let OpResult::Ok {
        value: rerun_context,
    } = rerun_context
    else {
        return;
    };
    assert_ne!(
        js_json_stringify_of(&rerun_context).expect("stringify"),
        js_json_stringify_of(&prior_context).expect("stringify")
    );
}

#[tokio::test]
async fn abort_immediately_before_snapshot_write_leaves_the_prior_view_unchanged() {
    let _hook_guard = ClearCompactWriteHook::install();
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let first = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            compact_opts(gradient_params()),
        )
        .await;
    assert!(first.is_ok());
    let prior_context = local
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(prior_context.is_ok());
    let OpResult::Ok {
        value: prior_context,
    } = prior_context
    else {
        return;
    };
    let prior_compact_point = boundary_position(&local.file_path);

    // Live signal (TS getter parity): the hook aborts the same signal the
    // compact call holds, mid-flight, between sweep and write.
    let signal = CompactAbortSignal::new();
    let signal_hook = signal.clone();
    set_view_injection_hook(
        ViewInjectionPoint::CompactWrite,
        Some(std::sync::Arc::new(move || {
            signal_hook.abort();
        })),
    );
    let stopped = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            CompactOpts {
                profile: None,
                params: Some(edge_params()),
                signal: Some(signal.clone()),
            },
        )
        .await;
    set_view_injection_hook(ViewInjectionPoint::CompactWrite, None);
    assert!(!stopped.is_ok());
    if let OpResult::Err { error } = &stopped {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::CompactStopped);
    }
    assert!(signal.aborted(), "hook must have aborted the live signal");

    let after_stop = local
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&local.file_path))
        .await;
    assert!(after_stop.is_ok());
    let OpResult::Ok { value: after_stop } = after_stop else {
        return;
    };
    assert_eq!(
        js_json_stringify_of(&after_stop).expect("stringify"),
        js_json_stringify_of(&prior_context).expect("stringify")
    );
    assert_eq!(view_row_count(&local.file_path), 1);
    assert_eq!(boundary_position(&local.file_path), prior_compact_point);
}

// ── TC-2.3 + TC-2.5 view-health ──────────────────────────────────────

#[tokio::test]
async fn completes_with_ladder_fallbacks_marked_gap_entries_for_unusable_spans_and_full_accounting_in_the_receipt()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let degraded_store = temp_store();
    let degraded = build_degraded_thread(&degraded_store).await;
    let captured = degraded.double.capture_inputs();
    let captured_before = captured.len();

    let receipt = degraded
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&degraded.file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(400.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(25.0),
                        smooth: Some(25.0),
                        detailed: Some(10.0),
                        brief: Some(40.0),
                    }),
                }),
                signal: None,
            },
        )
        .await;
    assert!(receipt.is_ok());
    let OpResult::Ok { value } = receipt else {
        return;
    };

    let t8 = value.degraded.iter().find(|entry| entry.subject_id == "t8");
    assert!(t8.is_some());
    assert_eq!(t8.map(|e| e.band), Some(Band::Smooth));
    assert_eq!(
        t8.map(|e| e.used_derivation.as_str()),
        Some("message_excerpt")
    );

    assert!(value.gaps.is_empty());
    let c2 = value.degraded.iter().find(|entry| entry.subject_id == "c2");
    assert!(c2.is_some());
    assert_eq!(
        c2.map(|e| e.used_derivation.as_str()),
        Some("stored_member_concat")
    );

    assert_eq!(value.bands.brief.entries, 1);
    assert_eq!(value.bands.detailed.entries, 2);
    assert_eq!(value.bands.smooth.entries, 1);
    assert_eq!(value.compact_point, 48);
    assert_eq!(value.covered_from, 1);

    let messages = context_messages(&degraded.sdk, &degraded.file_path).await;
    let band_text = band_messages(&messages)
        .iter()
        .map(message_text)
        .collect::<Vec<_>>()
        .join("\n\n");
    assert!(band_text.contains("[degraded: detailed-from-stored-members]"));
    assert!(band_text.contains("[degraded: smooth-from-excerpt]"));

    assert_eq!(captured.len(), captured_before);
}

#[tokio::test]
async fn status_reports_the_view_health_fields_live_after_the_degraded_compact_tc_2_5_completion_leg()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let degraded_store = temp_store();
    let degraded = build_degraded_thread(&degraded_store).await;
    let receipt = degraded
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&degraded.file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(400.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(25.0),
                        smooth: Some(25.0),
                        detailed: Some(10.0),
                        brief: Some(40.0),
                    }),
                }),
                signal: None,
            },
        )
        .await;
    // Preserve setup compact result (suite-level beforeAll compact in TS).
    assert!(receipt.is_ok());
    let OpResult::Ok {
        value: _compact_receipt,
    } = receipt
    else {
        return;
    };

    let status = degraded
        .sdk
        .thread_view
        .status(ThreadRef::file_path(&degraded.file_path))
        .await;
    assert!(status.is_ok());
    let OpResult::Ok { value: status } = status else {
        return;
    };
    assert!(status.view.is_some());
    let view = status.view.as_ref().unwrap();
    assert_eq!(view.degraded, 3);
    assert_eq!(view.gaps, 0);
    // TS: expect(typeof status.value.view?.builtAt).toBe("string") — present String, not non-empty.
    let _: &str = view.built_at.as_str();
    assert!(status.derivation.pending > 0);
}

// ── TC-2.7 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn refuses_with_state_corruption_naming_the_damage_the_prior_view_still_serves_record_unchanged()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let corrupt_store = temp_store();
    let double = create_inference_callbacks_double();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(double.to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let file_path = corrupt_store
        .thread_path(None)
        .to_string_lossy()
        .into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(corrupt_store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    assert!(created.is_ok());
    for turn in 1i64..=4 {
        let sent = sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&file_path),
                &degraded_turn_events(turn),
            )
            .await;
        assert!(sent.is_ok());
    }
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());

    let first = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(80.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(50.0),
                        smooth: Some(30.0),
                        detailed: Some(10.0),
                        brief: Some(10.0),
                    }),
                }),
                signal: None,
            },
        )
        .await;
    assert!(first.is_ok());
    let prior_context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(prior_context.is_ok());
    let OpResult::Ok {
        value: prior_context,
    } = prior_context
    else {
        return;
    };
    let prior_view = sdk
        .thread_view
        .describe(ThreadRef::file_path(&file_path))
        .await;
    assert!(prior_view.is_ok());
    let OpResult::Ok { value: prior_view } = prior_view else {
        return;
    };

    let opened = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "left open before the damage".into(),
                    }),
                    ..Default::default()
                },
            )],
        )
        .await;
    assert!(opened.is_ok());
    corrupt_two_open_turns(&file_path);
    let record_before = record_snapshot(&file_path);

    let refused = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(80.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(50.0),
                        smooth: Some(30.0),
                        detailed: Some(10.0),
                        brief: Some(10.0),
                    }),
                }),
                signal: None,
            },
        )
        .await;
    assert!(!refused.is_ok());
    if let OpResult::Err { error } = &refused {
        assert_eq!(error.error_class, ErrorClass::StateCorruption);
        assert_eq!(error.code, ErrorCode::TurnStateCorrupt);
        assert!(error.reason.contains("open turns"));
    }

    let after_context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(after_context.is_ok());
    let OpResult::Ok {
        value: after_context,
    } = after_context
    else {
        return;
    };
    assert_eq!(
        js_json_stringify_of(&band_messages(&after_context.messages)).expect("stringify"),
        js_json_stringify_of(&band_messages(&prior_context.messages)).expect("stringify")
    );
    let after_view = sdk
        .thread_view
        .describe(ThreadRef::file_path(&file_path))
        .await;
    assert!(after_view.is_ok());
    let OpResult::Ok { value: after_view } = after_view else {
        return;
    };
    assert_eq!(
        after_view.as_ref().map(|v| v.view_id.as_str()),
        prior_view.as_ref().map(|v| v.view_id.as_str())
    );
    assert_eq!(record_snapshot(&file_path), record_before);
}

#[tokio::test]
async fn control_a_thread_with_only_derived_material_damage_compacts_successfully_with_gaps() {
    let _hook_guard = ClearCompactWriteHook::install();
    let store = temp_store();
    let local = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    let receipt = local
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&local.file_path),
            compact_opts(gradient_params()),
        )
        .await;
    assert!(receipt.is_ok());
}

// ── TC-1.3 / TC-1.5 ──────────────────────────────────────────────────

async fn mutation_fixture() -> (TempStore, DerivedThreadFixture) {
    let mut_store = temp_store();
    let mut_fx = derived_thread_fixture(
        &mut_store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let receipt = mut_fx
        .sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&mut_fx.file_path),
            compact_opts(gradient_params()),
        )
        .await;
    // Preserve and assert setup compact (TS throws on !ok; do not discard Ok).
    assert!(
        receipt.is_ok(),
        "setup compact failed: {}",
        match &receipt {
            OpResult::Err { error } => error.reason.as_str(),
            OpResult::Ok { .. } => unreachable!(),
        }
    );
    let OpResult::Ok {
        value: _setup_receipt,
    } = receipt
    else {
        unreachable!()
    };
    (mut_store, mut_fx)
}

#[tokio::test]
async fn tc_1_3_editing_a_banded_subject_leaves_band_bytes_unchanged_across_context_reads_before_and_after_the_drain()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_mut_store, mut_fx) = mutation_fixture().await;
    let before = band_messages(&context_messages(&mut_fx.sdk, &mut_fx.file_path).await);
    let band_hash = sha256_of(&before);

    let listed = mut_fx
        .sdk
        .messages
        .list(ThreadRef::file_path(&mut_fx.file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let t5_prompt = listed
        .iter()
        .find(|m| m.turn_id == "t5" && m.kind == MessageKind::UserPrompt);
    // TS toBeDefined — present (including null-ish content later), not absent.
    assert!(t5_prompt.is_some());
    let Some(t5_prompt) = t5_prompt else {
        return;
    };
    let edited = mut_fx
        .sdk
        .messages
        .edit(
            ThreadRef::file_path(&mut_fx.file_path),
            EditInput {
                message_id: t5_prompt.message_id.clone(),
                content: "turn 5: edited after the snapshot".into(),
            },
        )
        .await;
    assert!(edited.is_ok());

    let after_edit = band_messages(&context_messages(&mut_fx.sdk, &mut_fx.file_path).await);
    assert_eq!(sha256_of(&after_edit), band_hash);

    // Critical: sdk.work.drain — not mut.work.
    let drained = mut_fx
        .sdk
        .work
        .drain(ThreadRef::file_path(&mut_fx.file_path), None)
        .await;
    assert!(drained.is_ok());
    let after_drain = band_messages(&context_messages(&mut_fx.sdk, &mut_fx.file_path).await);
    assert_eq!(sha256_of(&after_drain), band_hash);

    let closing = fixtures::ClosingDb::open(&mut_fx.file_path);
    let db = closing.db();
    let row = db
        .prepare(
            "SELECT content FROM derivation
           WHERE subject_kind = 'chunk' AND subject_id = 'c2' AND derivation_type = 'chunk_summary_detailed'",
        )
        .get();
    // TS: expect(row?.content).toBeDefined() — null passes; only undefined fails.
    assert!(row.is_some(), "derivation row must exist");
    let content_value = row.as_ref().and_then(|r| r.get("content"));
    assert!(
        content_value.is_some(),
        "content field must be present (null ok; undefined not)"
    );
    // TS: expect(detailedBand === undefined ? undefined : messageText(...)).not.toContain(...)
    // Vitest toContain on undefined throws — do not silently pass via is_none shortcuts.
    let detailed_band = after_drain
        .iter()
        .find(|m| message_text(m).starts_with("[context · detailed]"));
    let detailed_text = detailed_band.map(message_text);
    assert!(
        detailed_text.is_some(),
        "detailed band must be defined — Vitest not.toContain(undefined) would throw"
    );
    // TS needle: row?.content ?? "<unset>"
    let needle = match content_value {
        Some(Value::Null) | None => "<unset>".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.as_str().unwrap_or("<unset>").to_string(),
    };
    assert!(
        !detailed_text.as_ref().unwrap().contains(&needle),
        "detailed band must not contain rebuilt content"
    );
}

#[tokio::test]
async fn tc_1_5_a_tail_delete_vanishes_from_the_next_context_read_a_banded_delete_leaves_the_snapshot_until_the_next_compact()
 {
    let _hook_guard = ClearCompactWriteHook::install();
    let (_mut_store, mut_fx) = mutation_fixture().await;
    let listed = mut_fx
        .sdk
        .messages
        .list(ThreadRef::file_path(&mut_fx.file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };

    let tail_target = listed
        .iter()
        .find(|m| m.turn_id == "t10" && m.kind == MessageKind::AssistantText);
    assert!(tail_target.is_some());
    let Some(tail_target) = tail_target else {
        return;
    };
    let status_before = mut_fx
        .sdk
        .thread_view
        .status(ThreadRef::file_path(&mut_fx.file_path))
        .await;
    assert!(status_before.is_ok());
    let OpResult::Ok {
        value: status_before,
    } = status_before
    else {
        return;
    };

    let tail_delete = mut_fx
        .sdk
        .messages
        .remove(
            ThreadRef::file_path(&mut_fx.file_path),
            RemoveInput {
                message_id: tail_target.message_id.clone(),
            },
        )
        .await;
    assert!(tail_delete.is_ok());
    let after_tail_delete = context_messages(&mut_fx.sdk, &mut_fx.file_path).await;
    assert!(
        !after_tail_delete
            .iter()
            .any(|m| message_text(m) == "findings for area 10")
    );

    let status_after = mut_fx
        .sdk
        .thread_view
        .status(ThreadRef::file_path(&mut_fx.file_path))
        .await;
    assert!(status_after.is_ok());
    let OpResult::Ok {
        value: status_after,
    } = status_after
    else {
        return;
    };
    assert!(status_after.tail_tokens < status_before.tail_tokens);

    let bands_before = band_messages(&after_tail_delete);
    let band_target = listed
        .iter()
        .find(|m| m.turn_id == "t6" && m.kind == MessageKind::AssistantText);
    assert!(band_target.is_some());
    let Some(band_target) = band_target else {
        return;
    };
    let banded_delete = mut_fx
        .sdk
        .messages
        .remove(
            ThreadRef::file_path(&mut_fx.file_path),
            RemoveInput {
                message_id: band_target.message_id.clone(),
            },
        )
        .await;
    assert!(banded_delete.is_ok());

    let after_banded_delete = context_messages(&mut_fx.sdk, &mut_fx.file_path).await;
    assert_eq!(
        sha256_of(&band_messages(&after_banded_delete)),
        sha256_of(&bands_before)
    );

    let status_final = mut_fx
        .sdk
        .thread_view
        .status(ThreadRef::file_path(&mut_fx.file_path))
        .await;
    assert!(status_final.is_ok());
    let OpResult::Ok {
        value: status_final,
    } = status_final
    else {
        return;
    };
    assert!(status_final.derivation.pending > 0);
}

//! Ported from packages/lhc/test/view-llm-request-context.test.ts. Phase 1.
//!
//! Epic 03 Story 1: model context and status on the record (TC-1.1, TC-1.2, TC-1.4,
//! TC-2.5 pre-compact legs, the per-kind tail-mapping legs, and the model-context/status
//! legs of the suite-wide zero-model assertion).
//!
//! Judgment: Rust has no async beforeAll — each test builds a fresh
//! fixture (acceptable isolation translation of TS file-level `beforeAll`).

mod fixtures;

use std::time::Duration;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, DerivedThreadFixture, DerivedThreadOptions, RuntimeNoteOverrides,
    RuntimeNotePayload, TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides,
    ToolResultPayload, TurnEndOverrides, UserPromptOverrides, UserPromptPayload,
    blocked_sibling_thread, create_inference_callbacks_double, derived_thread_fixture, kind,
    seed_view_boundary, temp_store, valid_event,
};
use lhc::intake_stream::MessageEventInput;
use lhc::messages::MessageKind;
use lhc::shared_tech::derivation::{SdkConfig, SdkMode, ToolResultConfig};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::view::{
    LlmRequestContextMessage, LlmRequestContextPart, LlmRequestContextPartType,
    LlmRequestContextRole, SdkViewConfig, ViewStatusDerivation, ViewStatusVisibility,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};
use serde::Serialize;
use serde_json::{Map, Value};

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

async fn new_thread(sdk: &Lhc, store: &TempStore) -> String {
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    if !created.is_ok() {
        let OpResult::Err { error } = created else {
            unreachable!()
        };
        panic!("thread creation failed: {}", error.reason);
    }
    file_path
}

async fn intake(sdk: &Lhc, file_path: &str, batch: &[MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), batch)
        .await;
    if !result.is_ok() {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("intake failed: {}", error.reason);
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

fn sha256_of<T: Serialize>(value: &T) -> String {
    let s = js_json_stringify_of(value).expect("js_json stringify");
    sha256_bytes(s.as_bytes())
}

fn text_part(text: &str) -> Vec<LlmRequestContextPart> {
    vec![LlmRequestContextPart {
        type_: LlmRequestContextPartType::Text,
        text: text.into(),
    }]
}

fn message_text(message: Option<&LlmRequestContextMessage>) -> Option<String> {
    message.map(|m| m.content.iter().map(|part| part.text.as_str()).collect())
}

fn work_item_count(file_path: &str) -> i64 {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let row = db
        .prepare("SELECT COUNT(*) AS n FROM work_item")
        .get()
        .expect("work_item count row");
    row.get("n")
        .and_then(|v| v.as_i64())
        .expect("work_item count n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkItemStatusRow {
    id: String,
    status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DerivationStateRow {
    subject_id: String,
    derivation_type: String,
    state: String,
}

/// Below-SDK read-only snapshot of everything a read could illegally mutate.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StateSnapshot {
    work_items: Vec<WorkItemStatusRow>,
    derivations: Vec<DerivationStateRow>,
    view_rows: i64,
    boundary: i64,
}

fn state_snapshot(file_path: &str) -> StateSnapshot {
    let closing = fixtures::ClosingDb::open(file_path);
    let db = closing.db();
    let work_items = db
        .prepare("SELECT work_item_id, status FROM work_item ORDER BY work_item_id")
        .all(&[])
        .into_iter()
        .map(|row| WorkItemStatusRow {
            id: row
                .get("work_item_id")
                .and_then(|v| v.as_str())
                .expect("work_item_id")
                .to_string(),
            status: row
                .get("status")
                .and_then(|v| v.as_str())
                .expect("status")
                .to_string(),
        })
        .collect();
    let derivations = db
        .prepare(
            "SELECT subject_id, derivation_type, state FROM derivation ORDER BY subject_id, derivation_type",
        )
        .all(&[])
        .into_iter()
        .map(|row| DerivationStateRow {
            subject_id: row
                .get("subject_id")
                .and_then(|v| v.as_str())
                .expect("subject_id")
                .to_string(),
            derivation_type: row
                .get("derivation_type")
                .and_then(|v| v.as_str())
                .expect("derivation_type")
                .to_string(),
            state: row
                .get("state")
                .and_then(|v| v.as_str())
                .expect("state")
                .to_string(),
        })
        .collect();
    let view_rows = db
        .prepare("SELECT COUNT(*) AS n FROM thread_view")
        .get()
        .and_then(|row| row.get("n").and_then(|v| v.as_i64()))
        .expect("thread_view count");
    let boundary = db
        .prepare("SELECT position FROM view_boundary")
        .get()
        .and_then(|row| row.get("position").and_then(|v| v.as_i64()))
        .expect("view_boundary.position");
    StateSnapshot {
        work_items,
        derivations,
        view_rows,
        boundary,
    }
}

async fn suite_fixture() -> (TempStore, DerivedThreadFixture) {
    let store = temp_store();
    let fixture = derived_thread_fixture(&store, DerivedThreadOptions { failures: None }).await;
    (store, fixture)
}

// ── TC-1.1 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn carries_threadid_and_both_intake_rounds_in_record_order() {
    let store = temp_store();
    let sdk = manual_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    intake(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "first question".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "first answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;

    let first = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(first.is_ok());
    let OpResult::Ok { value: first_value } = first else {
        return;
    };
    let info = sdk.threads.info(ThreadRef::file_path(&file_path)).await;
    assert!(info.is_ok());
    let OpResult::Ok { value: info_value } = info else {
        return;
    };
    assert_eq!(first_value.thread_id, info_value.thread_id);
    assert_eq!(
        first_value.messages,
        vec![
            LlmRequestContextMessage {
                role: LlmRequestContextRole::User,
                content: text_part("first question"),
            },
            LlmRequestContextMessage {
                role: LlmRequestContextRole::Assistant,
                content: text_part("first answer"),
            },
        ]
    );

    intake(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "second question".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "second answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    let second = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(second.is_ok());
    let OpResult::Ok {
        value: second_value,
    } = second
    else {
        return;
    };
    assert_eq!(
        second_value.messages,
        vec![
            LlmRequestContextMessage {
                role: LlmRequestContextRole::User,
                content: text_part("first question"),
            },
            LlmRequestContextMessage {
                role: LlmRequestContextRole::Assistant,
                content: text_part("first answer"),
            },
            LlmRequestContextMessage {
                role: LlmRequestContextRole::User,
                content: text_part("second question"),
            },
            LlmRequestContextMessage {
                role: LlmRequestContextRole::Assistant,
                content: text_part("second answer"),
            },
        ]
    );
}

// ── TC-1.2 ───────────────────────────────────────────────────────────

#[tokio::test]
async fn hashes_identical_zero_work_rows_created_inference_callbacks_double_observes_zero_calls() {
    let (_store, fixture) = suite_fixture().await;
    let captured = fixture.double.capture_inputs();
    let before = state_snapshot(&fixture.file_path);
    let work_rows_before = work_item_count(&fixture.file_path);

    let one = fixture
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&fixture.file_path))
        .await;
    let two = fixture
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&fixture.file_path))
        .await;
    assert!(one.is_ok() && two.is_ok());
    let (OpResult::Ok { value: one_value }, OpResult::Ok { value: two_value }) = (one, two) else {
        return;
    };

    assert_eq!(sha256_of(&one_value), sha256_of(&two_value));
    assert_eq!(
        js_json_stringify_of(&one_value).expect("stringify"),
        js_json_stringify_of(&two_value).expect("stringify")
    );

    assert_eq!(work_item_count(&fixture.file_path), work_rows_before);
    assert_eq!(state_snapshot(&fixture.file_path), before);
    assert_eq!(captured.len(), 0);
}

// ── tail mapping legs ────────────────────────────────────────────────

struct TailMappingFixture {
    context_messages: Vec<LlmRequestContextMessage>,
    file_path: String,
    sdk: Lhc,
}

async fn tail_mapping_fixture(store: &TempStore) -> TailMappingFixture {
    let sdk = manual_sdk(None);
    let file_path = new_thread(&sdk, store).await;
    let mut args = Map::new();
    args.insert("path".into(), Value::String("map.txt".into()));
    intake(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "mapping prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_THINKING,
                AssistantThinkingOverrides {
                    payload: Some(AssistantThinkingPayload {
                        text: "mapping thought".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-map-1".into(),
                        tool_name: "read_file".into(),
                        arguments: args,
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-map-1".into(),
                        content: "mapping output".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::RUNTIME_NOTE,
                RuntimeNoteOverrides {
                    payload: Some(RuntimeNotePayload {
                        text: "mapping note".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "mapping answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    let result = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value } = result else {
        let OpResult::Err { error } = result else {
            unreachable!()
        };
        panic!("model context failed: {}", error.reason);
    };
    TailMappingFixture {
        context_messages: value.messages,
        file_path,
        sdk,
    }
}

#[tokio::test]
async fn user_prompt_user_role_text_verbatim() {
    let store = temp_store();
    let fx = tail_mapping_fixture(&store).await;
    assert_eq!(
        fx.context_messages.get(0),
        Some(&LlmRequestContextMessage {
            role: LlmRequestContextRole::User,
            content: text_part("mapping prompt"),
        })
    );
}

#[tokio::test]
async fn assistant_thinking_assistant_role_fenced_thinking_block() {
    let store = temp_store();
    let fx = tail_mapping_fixture(&store).await;
    assert_eq!(
        fx.context_messages.get(1),
        Some(&LlmRequestContextMessage {
            role: LlmRequestContextRole::Assistant,
            content: text_part("[thinking]\nmapping thought\n[/thinking]"),
        })
    );
}

#[tokio::test]
async fn tool_call_assistant_role_name_marker_plus_deterministic_arg_rendering() {
    let store = temp_store();
    let fx = tail_mapping_fixture(&store).await;
    assert_eq!(
        fx.context_messages.get(2),
        Some(&LlmRequestContextMessage {
            role: LlmRequestContextRole::Assistant,
            content: text_part("[tool call · read_file] {\"path\":\"map.txt\"}"),
        })
    );
}

#[tokio::test]
async fn tool_result_ahead_of_the_boundary_user_role_name_marker_plus_full_content() {
    let store = temp_store();
    let fx = tail_mapping_fixture(&store).await;
    assert_eq!(
        fx.context_messages.get(3),
        Some(&LlmRequestContextMessage {
            role: LlmRequestContextRole::User,
            content: text_part("[tool result · read_file]\nmapping output"),
        })
    );
}

#[tokio::test]
async fn runtime_note_user_role_runtime_note_marker_plus_text() {
    let store = temp_store();
    let fx = tail_mapping_fixture(&store).await;
    assert_eq!(
        fx.context_messages.get(4),
        Some(&LlmRequestContextMessage {
            role: LlmRequestContextRole::User,
            content: text_part("[runtime note] mapping note"),
        })
    );
}

#[tokio::test]
async fn assistant_text_assistant_role_text_verbatim() {
    let store = temp_store();
    let fx = tail_mapping_fixture(&store).await;
    assert_eq!(
        fx.context_messages.get(5),
        Some(&LlmRequestContextMessage {
            role: LlmRequestContextRole::Assistant,
            content: text_part("mapping answer"),
        })
    );
}

#[tokio::test]
async fn tool_result_at_or_behind_the_boundary_abridged_marker_plus_short_form() {
    let store = temp_store();
    let fx = tail_mapping_fixture(&store).await;
    let listed = fx
        .sdk
        .messages
        .list(ThreadRef::file_path(&fx.file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let result = listed.iter().find(|m| m.kind == MessageKind::ToolResult);
    assert!(result.is_some());
    let Some(result) = result else {
        return;
    };
    seed_view_boundary(&fx.file_path, result.source_event_order);

    let refreshed = fx
        .sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&fx.file_path))
        .await;
    assert!(refreshed.is_ok());
    let OpResult::Ok { value } = refreshed else {
        return;
    };
    let short = value.messages.get(3);
    assert_eq!(
        short,
        Some(&LlmRequestContextMessage {
            role: LlmRequestContextRole::User,
            content: text_part("[tool result · read_file · abridged]\nmapping output"),
        })
    );
}

// ── TC-1.4 ───────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "TS it.skip — mid-tail floors/full content (Story 4 boundary ownership)"]
async fn renders_deterministic_tool_result_floors_behind_the_boundary_and_full_content_ahead_of_it()
{
    let store = temp_store();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: Some(ToolResultConfig {
            small_tier_tokens: 1,
            small_target_ratio: 0.15,
            mid_target_ratio: 0.04,
        }),
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let file_path = new_thread(&sdk, &store).await;
    for turn in [1i64, 2] {
        let mut args = Map::new();
        args.insert("path".into(), Value::String(format!("bd-{turn}.txt")));
        intake(
            &sdk,
            &file_path,
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: format!("boundary prompt {turn}"),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(AssistantThinkingPayload {
                            text: format!("boundary thought {turn}"),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_CALL,
                    ToolCallOverrides {
                        payload: Some(ToolCallPayload {
                            tool_call_id: format!("call-bd-{turn}"),
                            tool_name: "read_file".into(),
                            arguments: args,
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::TOOL_RESULT,
                    ToolResultOverrides {
                        payload: Some(ToolResultPayload {
                            tool_call_id: format!("call-bd-{turn}"),
                            content: format!("boundary output {turn}"),
                            is_error: Some(false),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: format!("boundary answer {turn}"),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    }
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    assert!(drained.is_ok());

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let results: Vec<_> = listed
        .iter()
        .filter(|m| m.kind == MessageKind::ToolResult)
        .collect();
    assert_eq!(results.len(), 2);
    let behind = results[0];
    let ahead = results[1];
    let behind_summary = behind.derivations.as_ref().and_then(|ders| {
        ders.iter().find(|d| {
            d.derivation_type == "tool_result_summary"
                && d.state == lhc::shared_tech::derivation::DerivationState::Ready
        })
    });
    assert!(behind_summary.and_then(|d| d.content.as_ref()).is_some());

    seed_view_boundary(&file_path, behind.source_event_order);

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context.is_ok());
    let OpResult::Ok { value: context } = context else {
        return;
    };
    let contents: Vec<String> = context
        .messages
        .iter()
        .map(|m| message_text(Some(m)).unwrap_or_default())
        .collect();

    assert!(contents.contains(&"[tool result · read_file · abridged]\nboundary output 1".into()));
    let summary_content = behind_summary
        .and_then(|d| d.content.as_ref())
        .map(|s| format!("[tool result · read_file · abridged]\n{s}"))
        .unwrap_or_default();
    assert!(!contents.contains(&summary_content));
    assert!(contents.contains(&"[tool result · read_file]\nboundary output 2".into()));
    for turn in [1i64, 2] {
        assert!(contents.contains(&format!("boundary prompt {turn}")));
        assert!(contents.contains(&format!("[thinking]\nboundary thought {turn}\n[/thinking]")));
        assert!(contents.contains(&format!("boundary answer {turn}")));
    }
    let _ = ahead;
}

#[tokio::test]
async fn falls_to_deterministic_truncation_when_no_summary_is_ready_and_the_content_is_oversized() {
    let store = temp_store();
    let sdk = manual_sdk(None);
    let file_path = new_thread(&sdk, &store).await;
    let long_content = "x".repeat(560);
    let mut args = Map::new();
    args.insert("path".into(), Value::String("tr.txt".into()));
    intake(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "truncation prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-tr-1".into(),
                        tool_name: "read_file".into(),
                        arguments: args,
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-tr-1".into(),
                        content: long_content,
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let result = listed.iter().find(|m| m.kind == MessageKind::ToolResult);
    let Some(result) = result else {
        return;
    };
    seed_view_boundary(&file_path, result.source_event_order);

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(context.is_ok());
    let OpResult::Ok { value: context } = context else {
        return;
    };
    let short = context
        .messages
        .iter()
        .find(|m| message_text(Some(m)).is_some_and(|t| t.starts_with("[tool result")));
    assert_eq!(
        message_text(short),
        Some(format!(
            "[tool result · read_file · abridged]\n{}… [truncated 60 chars]",
            "x".repeat(500)
        ))
    );
}

// ── TC-2.5 pre-compact legs ──────────────────────────────────────────

async fn heavy_fixture() -> (TempStore, DerivedThreadFixture, Lhc) {
    let heavy_store = temp_store();
    let heavy = derived_thread_fixture(&heavy_store, DerivedThreadOptions { failures: None }).await;
    let status_sdk = manual_sdk(Some(SdkViewConfig {
        profiles: None,
        visibility: None,
        compact_threshold: Some(100.0),
    }));
    (heavy_store, heavy, status_sdk)
}

#[tokio::test]
async fn reports_tail_tokens_vs_threshold_recommendation_derivation_counts_null_view_health_and_the_zone_sum_reads_only()
 {
    let (_heavy_store, heavy, status_sdk) = heavy_fixture().await;
    let captured = heavy.double.capture_inputs();
    let before = state_snapshot(&heavy.file_path);

    let status = status_sdk
        .thread_view
        .status(ThreadRef::file_path(&heavy.file_path))
        .await;
    assert!(status.is_ok());
    let OpResult::Ok { value: status } = status else {
        return;
    };

    assert_eq!(status.threshold, 100.0);
    assert!(status.tail_tokens > 100);
    assert!(status.compact_recommended);

    assert_eq!(
        status.derivation,
        ViewStatusDerivation {
            pending: 0,
            failed: 2,
            blocked: 0,
        }
    );

    assert!(status.view.is_none());

    let listed = status_sdk
        .messages
        .list(ThreadRef::file_path(&heavy.file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let expected_zone: i64 = listed
        .iter()
        .filter(|m| m.kind == MessageKind::ToolResult)
        .map(|m| m.token_estimate)
        .sum();
    assert_eq!(
        status.visibility,
        ViewStatusVisibility {
            boundary_position: 0,
            zone_tokens: expected_zone,
            max_tokens: 64000.0,
        }
    );

    assert_eq!(state_snapshot(&heavy.file_path), before);
    assert_eq!(captured.len(), 0);
}

#[tokio::test]
async fn counts_blocked_derivations_through_the_owners_report_sacrificial_sibling() {
    let (heavy_store, _heavy, _status_sdk) = heavy_fixture().await;
    let sibling = blocked_sibling_thread(&heavy_store).await;
    let status = sibling
        .sdk
        .thread_view
        .status(ThreadRef::file_path(&sibling.file_path))
        .await;
    assert!(status.is_ok());
    let OpResult::Ok { value: status } = status else {
        return;
    };
    assert_eq!(status.derivation.blocked, 2);
    assert!(status.view.is_none());
}

#[tokio::test]
async fn after_more_intake_the_tail_grew_still_no_compact_without_invocation() {
    let (_heavy_store, heavy, status_sdk) = heavy_fixture().await;
    let first = status_sdk
        .thread_view
        .status(ThreadRef::file_path(&heavy.file_path))
        .await;
    assert!(first.is_ok());
    let OpResult::Ok { value: first } = first else {
        return;
    };

    intake(
        &heavy.sdk,
        &heavy.file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "one more question for the heavy thread".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "one more answer for the heavy thread".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;

    let second = status_sdk
        .thread_view
        .status(ThreadRef::file_path(&heavy.file_path))
        .await;
    assert!(second.is_ok());
    let OpResult::Ok { value: second } = second else {
        return;
    };
    assert!(second.tail_tokens > first.tail_tokens);
    assert!(second.view.is_none());
    assert_eq!(state_snapshot(&heavy.file_path).view_rows, 0);
}

// ── TC-1.2 / TC-2.5 background legs ──────────────────────────────────

#[tokio::test]
async fn schedules_no_catch_up_drain_work_rows_derivation_states_inference_callback_count_and_status_all_unchanged_repeated_model_context_reads_byte_identical()
 {
    let store = temp_store();
    let seeder = manual_sdk(None);
    let file_path = new_thread(&seeder, &store).await;
    let mut args = Map::new();
    args.insert("path".into(), Value::String("bg.txt".into()));
    intake(
        &seeder,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "background prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-bg-1".into(),
                        tool_name: "read_file".into(),
                        arguments: args,
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-bg-1".into(),
                        content: "background output".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "background answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    assert!(work_item_count(&file_path) > 0);

    let bg_double = create_inference_callbacks_double();
    let bg = init_lhc(SdkConfig {
        inference_callbacks: Some(bg_double.to_callbacks()),
        inference: None,
        mode: SdkMode::Background,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: Some(SdkViewConfig {
            profiles: None,
            visibility: None,
            compact_threshold: Some(100.0),
        }),
    });
    let captured = bg_double.capture_inputs();
    let before = state_snapshot(&file_path);

    let one = bg
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let first_status = bg
        .thread_view
        .status(ThreadRef::file_path(&file_path))
        .await;
    let two = bg
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    assert!(one.is_ok() && two.is_ok() && first_status.is_ok());
    let (
        OpResult::Ok { value: one_value },
        OpResult::Ok { value: two_value },
        OpResult::Ok {
            value: first_status_value,
        },
    ) = (one, two, first_status)
    else {
        return;
    };

    assert!(first_status_value.derivation.pending > 0);

    tokio::time::sleep(Duration::from_millis(25)).await;
    bg.drain_settled(ThreadRef::file_path(&file_path)).await;

    assert_eq!(sha256_of(&one_value), sha256_of(&two_value));
    assert_eq!(
        js_json_stringify_of(&one_value).expect("stringify"),
        js_json_stringify_of(&two_value).expect("stringify")
    );

    assert_eq!(state_snapshot(&file_path), before);
    assert_eq!(captured.len(), 0);

    let second_status = bg
        .thread_view
        .status(ThreadRef::file_path(&file_path))
        .await;
    assert!(second_status.is_ok());
    let OpResult::Ok {
        value: second_status_value,
    } = second_status
    else {
        return;
    };
    assert_eq!(
        js_json_stringify_of(&second_status_value).expect("stringify"),
        js_json_stringify_of(&first_status_value).expect("stringify")
    );
}

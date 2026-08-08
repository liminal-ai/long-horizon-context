//! Empty thinking husks (R1 / bu9): Anthropic models with omitted thinking
//! display emit assistant_thinking blocks with empty text. Serving exits skip
//! true husks (empty/whitespace text, no signature). Assembly also skips
//! signature-only thinking (text LLM path cannot carry the opaque token);
//! session export still emits signature-bearing thinking (R2 depends on it).
//! Capture is untouched — husk rows stay in the record.
//!
//! Ported from packages/lhc/test/empty-thinking-husk.test.ts (+ R1 ledger
//! validate: fixture with true husk, signature-only, signed-with-text).

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, AssistantThinkingOverrides,
    AssistantThinkingPayload, TempStore, TurnEndOverrides, UserPromptOverrides, UserPromptPayload,
    kind, open_raw, temp_store, valid_event,
};
use lhc::messages::MessageKind;
use lhc::shared_tech::derivation::{RenderingPartKind, SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::{
    PartialViewProfilePercentages, SessionAssistantPartType, SessionThreadViewEntry,
    SessionThreadViewMessage, ViewCompactParams,
};
use lhc::thread_view::CompactOpts;
use lhc::thread_view::internal::render::{has_thinking_text, is_empty_thinking_husk};
use lhc::thread_view::internal::snapshot::{TailMessageBlock, TailMessageRow};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, create_deterministic_inference_callbacks, init_lhc};
use serde_json::{Map, Value, json};

async fn new_thread(sdk: &Lhc, store: &TempStore) -> String {
    let path = store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    match created {
        OpResult::Ok { .. } => path,
        OpResult::Err { error } => panic!("{}", error.reason),
    }
}

fn manual_sdk() -> Lhc {
    init_lhc(SdkConfig {
        mode: SdkMode::Manual,
        inference_callbacks: Some(create_deterministic_inference_callbacks()),
        inference: None,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    })
}

fn thinking_row(content: Map<String, Value>) -> TailMessageRow {
    TailMessageRow {
        message_id: "m1".into(),
        source_event_order: 1,
        idempotency_key: Some("k1".into()),
        kind: RenderingPartKind::AssistantThinking,
        recorded_at: "2026-08-06T00:00:00.000Z".into(),
        blocks: vec![TailMessageBlock {
            block_type: "assistant_thinking".into(),
            content,
        }],
    }
}

fn object(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

// ── is_empty_thinking_husk / has_thinking_text ─────────────────────

#[test]
fn is_empty_thinking_husk_skips_empty_text_unsigned_thinking() {
    let row = thinking_row(object(&[("text", json!(""))]));
    assert!(is_empty_thinking_husk(&row));
}

#[test]
fn is_empty_thinking_husk_skips_whitespace_only_unsigned_thinking() {
    let row = thinking_row(object(&[("text", json!("  \n\t"))]));
    assert!(is_empty_thinking_husk(&row));
}

#[test]
fn is_empty_thinking_husk_serves_thinking_with_real_text() {
    let row = thinking_row(object(&[("text", json!("reasoning here"))]));
    assert!(!is_empty_thinking_husk(&row));
}

#[test]
fn is_empty_thinking_husk_serves_empty_text_with_signature() {
    assert!(!is_empty_thinking_husk(&thinking_row(object(&[
        ("text", json!("")),
        ("signature", json!("enc-abc123")),
    ]))));
    assert!(!is_empty_thinking_husk(&thinking_row(object(&[
        ("text", json!("")),
        ("thinkingSignature", json!("enc-abc123")),
    ]))));
}

#[test]
fn is_empty_thinking_husk_never_matches_non_thinking_kinds() {
    let mut row = thinking_row(object(&[("text", json!(""))]));
    row.kind = RenderingPartKind::AssistantText;
    assert!(!is_empty_thinking_husk(&row));
}

#[test]
fn has_thinking_text_true_only_for_nonempty_thinking_text() {
    let with_text = thinking_row(object(&[("text", json!("visible"))]));
    assert!(has_thinking_text(&with_text));
    let sig_only = thinking_row(object(&[
        ("text", json!("")),
        ("signature", json!("enc-only")),
    ]));
    assert!(!has_thinking_text(&sig_only));
    let whitespace = thinking_row(object(&[("text", json!("  "))]));
    assert!(!has_thinking_text(&whitespace));
    let mut non_thinking = thinking_row(object(&[("text", json!("x"))]));
    non_thinking.kind = RenderingPartKind::AssistantText;
    assert!(!has_thinking_text(&non_thinking));
}

// ── serving exits ──────────────────────────────────────────────────

async fn seed_turn_with_thinking(sdk: &Lhc, file_path: &str, thinking_text: &str) {
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "what is in the file?".into(),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(AssistantThinkingPayload::new(thinking_text)),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("The file holds three entries.")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(
        captured.is_ok(),
        "intake failed: {:?}",
        match &captured {
            OpResult::Err { error } => error.reason.as_str(),
            _ => "",
        }
    );
}

fn assistant_parts(
    entries: &[SessionThreadViewEntry],
) -> Vec<&lhc::shared_tech::view::SessionAssistantPart> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            SessionThreadViewEntry::Message(SessionThreadViewMessage::Assistant(a)) => {
                Some(a.content.as_slice())
            }
            _ => None,
        })
        .flatten()
        .collect()
}

#[tokio::test]
async fn get_llm_request_context_serves_no_thinking_husk() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_turn_with_thinking(&sdk, &file_path, "").await;

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value } = context else {
        panic!("serve failed");
    };
    let texts: Vec<String> = value
        .messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    assert!(!texts.iter().any(|t| t.contains("[thinking]")));
    assert!(
        texts
            .iter()
            .any(|t| t.contains("The file holds three entries."))
    );
}

#[tokio::test]
async fn get_session_thread_view_serves_no_empty_thinking_part() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_turn_with_thinking(&sdk, &file_path, "").await;

    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value } = view else {
        panic!("serve failed");
    };
    let parts = assistant_parts(&value.entries);
    assert!(!parts.iter().any(|p| p.type_ == SessionAssistantPartType::Thinking));
    assert!(parts.iter().any(|p| p.type_ == SessionAssistantPartType::Text));
}

#[tokio::test]
async fn non_empty_thinking_still_serves_through_both_exits() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_turn_with_thinking(&sdk, &file_path, "real reasoning text").await;

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let (OpResult::Ok { value: context }, OpResult::Ok { value: view }) = (context, view) else {
        panic!("serve failed");
    };
    let texts: Vec<String> = context
        .messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    assert!(
        texts
            .iter()
            .any(|t| t.contains("[thinking]\nreal reasoning text"))
    );
    let parts = assistant_parts(&view.entries);
    assert!(parts.iter().any(|p| {
        p.type_ == SessionAssistantPartType::Thinking
            && p.thinking.as_deref() == Some("real reasoning text")
    }));
}

#[tokio::test]
async fn the_record_keeps_the_husk_row_capture_untouched() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_turn_with_thinking(&sdk, &file_path, "").await;

    let detail = sdk.messages.list(ThreadRef::file_path(&file_path), None).await;
    let OpResult::Ok { value } = detail else {
        panic!("list failed");
    };
    let kinds: Vec<_> = value.iter().map(|m| m.kind).collect();
    assert!(kinds.contains(&MessageKind::AssistantThinking));
}

/// R1 validate: (i) true husk, (ii) signature-only, (iii) signed thinking with
/// text → export shows (ii)+(iii), never (i); assembly shows (iii)'s text only.
#[tokio::test]
async fn export_keeps_signature_only_assembly_skips_it_both_keep_signed_text() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    // Three thinking variants in one turn (plus user + assistant_text).
    let captured = sdk
        .intake_stream
        .message_events(
            ThreadRef::file_path(&file_path),
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: "tri-variant fixture".into(),
                        }),
                        ..Default::default()
                    },
                ),
                // (i) true husk — empty, unsigned
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(AssistantThinkingPayload::new("")),
                        idempotency_key: Some("think-husk".into()),
                        ..Default::default()
                    },
                ),
                // (ii) signature-only — empty text + signature (patched below)
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(AssistantThinkingPayload::new("")),
                        idempotency_key: Some("think-sig-only".into()),
                        ..Default::default()
                    },
                ),
                // (iii) signed thinking with text
                valid_event(
                    kind::ASSISTANT_THINKING,
                    AssistantThinkingOverrides {
                        payload: Some(AssistantThinkingPayload::new("visible signed reasoning")),
                        idempotency_key: Some("think-signed-text".into()),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload::new("final answer")),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
    assert!(captured.is_ok());

    // Patch (ii) and (iii) block content: signature-only + signature+text.
    // R1 does not extend intake; signature lives on the block for serve filters.
    {
        let db = open_raw(&file_path);
        // Order by source_event_order: (i) husk, (ii) sig-only, (iii) signed+text.
        let rows = db
            .prepare(
                "SELECT m.message_id FROM message m
                 WHERE m.kind = 'assistant_thinking' AND m.deleted_at IS NULL
                 ORDER BY m.source_event_order",
            )
            .all(&[]);
        assert_eq!(rows.len(), 3);
        let patches = [
            object(&[("text", json!(""))]),
            object(&[("text", json!("")), ("signature", json!("enc-sig-only"))]),
            object(&[
                ("text", json!("visible signed reasoning")),
                ("signature", json!("enc-sig-text")),
            ]),
        ];
        for (row, content) in rows.iter().zip(patches.into_iter()) {
            let message_id = row
                .get("message_id")
                .and_then(|v| match v {
                    Value::String(s) => Some(s.as_str()),
                    _ => None,
                })
                .expect("message_id");
            let content_json = js_json_stringify(&Value::Object(content));
            db.prepare(
                "UPDATE message_block SET content = ? WHERE message_id = ? AND block_index = 0",
            )
            .run(&[
                SqlParam::from(content_json.as_str()),
                SqlParam::from(message_id),
            ]);
        }
        db.close();
    }

    // Session export: (ii) + (iii), never (i).
    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: view } = view else {
        panic!("session view failed");
    };
    let parts = assistant_parts(&view.entries);
    let thinking_parts: Vec<_> = parts
        .iter()
        .filter(|p| p.type_ == SessionAssistantPartType::Thinking)
        .collect();
    assert_eq!(
        thinking_parts.len(),
        2,
        "export must show signature-only + signed-with-text, not the true husk"
    );
    assert!(thinking_parts.iter().any(|p| p.thinking.as_deref() == Some("")));
    assert!(
        thinking_parts
            .iter()
            .any(|p| p.thinking.as_deref() == Some("visible signed reasoning"))
    );

    // Assembly (LLM request path): (iii)'s text only — skip husk and signature-only.
    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: context } = context else {
        panic!("llm context failed");
    };
    let texts: Vec<String> = context
        .messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    let thinking_msgs: Vec<_> = texts
        .iter()
        .filter(|t| t.contains("[thinking]"))
        .collect();
    assert_eq!(
        thinking_msgs.len(),
        1,
        "assembly must emit only signed-with-text thinking"
    );
    assert!(thinking_msgs[0].contains("visible signed reasoning"));
    // Empty fenced husk would be "[thinking]\n\n[/thinking]" or similar — ensure
    // no empty thinking fence without the visible body.
    assert!(!texts.iter().any(|t| t == "[thinking]\n\n[/thinking]"
        || t == "[thinking]\n[/thinking]"
        || (t.contains("[thinking]") && !t.contains("visible signed reasoning"))));

    // Record retains all three thinking rows.
    let detail = sdk.messages.list(ThreadRef::file_path(&file_path), None).await;
    let OpResult::Ok { value: detail } = detail else {
        panic!("list failed");
    };
    let thinking_count = detail
        .iter()
        .filter(|m| m.kind == MessageKind::AssistantThinking)
        .count();
    assert_eq!(thinking_count, 3);
}

#[tokio::test]
async fn does_not_reintroduce_husks_through_compacted_smooth_band_rendering() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    for _ in 0..3 {
        seed_turn_with_thinking(&sdk, &file_path, "").await;
    }

    let drained = sdk
        .work
        .drain(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(drained.is_ok(), "drain failed");

    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(40.0),
                    percentages: Some(PartialViewProfilePercentages {
                        full: Some(25.0),
                        smooth: Some(75.0),
                        detailed: Some(0.0),
                        brief: Some(0.0),
                    }),
                }),
                signal: None,
            },
        )
        .await;
    let OpResult::Ok { value: receipt } = compacted else {
        panic!(
            "compact failed: {:?}",
            match compacted {
                OpResult::Err { error } => error.reason,
                _ => String::new(),
            }
        );
    };
    assert!(receipt.bands.smooth.entries > 0);

    let context = sdk
        .thread_view
        .get_llm_request_context(ThreadRef::file_path(&file_path))
        .await;
    let view = sdk
        .thread_view
        .get_session_thread_view(ThreadRef::file_path(&file_path))
        .await;
    let (OpResult::Ok { value: context }, OpResult::Ok { value: view }) = (context, view) else {
        panic!("serve failed after compact");
    };
    let context_text: String = context
        .messages
        .iter()
        .flat_map(|m| m.content.iter().map(|p| p.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    let session_text: String = view
        .entries
        .iter()
        .filter_map(|entry| match entry {
            SessionThreadViewEntry::Message(SessionThreadViewMessage::User(u)) => {
                Some(u.content.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!context_text.contains("Assistant thinking"));
    assert!(!session_text.contains("Assistant thinking"));
}

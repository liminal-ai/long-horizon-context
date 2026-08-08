//! Ported from packages/lhc/test/retrieval.test.ts.
//!
//! Retrieval ops: get_turns / get_messages, budget walk, slice continuation,
//! impression log, and legacy unlabeled turn_rendering recompose (R3 carry-over).

mod fixtures;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, TempStore, ToolCallOverrides, ToolCallPayload,
    ToolResultOverrides, ToolResultPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, kind, open_raw, temp_store, valid_event,
};
use lhc::messages::MessageKind;
use lhc::retrieval::{RetrievedTurnSource, UnservedReason};
use lhc::shared_tech::derivation::{SdkConfig, SdkMode};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, create_deterministic_inference_callbacks, init_lhc, retrieval};
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

async fn send(sdk: &Lhc, file_path: &str, events: &[lhc::intake_stream::MessageEventInput]) {
    let result = sdk
        .intake_stream
        .message_events(ThreadRef::file_path(file_path), events)
        .await;
    assert!(result.is_ok(), "intake failed");
}

async fn drain(sdk: &Lhc, file_path: &str) {
    let result = sdk.work.drain(ThreadRef::file_path(file_path), None).await;
    assert!(result.is_ok(), "drain failed");
}

async fn seed_big_turn(sdk: &Lhc, file_path: &str) {
    let big_body: String = (0..400)
        .map(|i| format!("line {i}: the quick brown fox jumps over the lazy dog"))
        .collect::<Vec<_>>()
        .join("\n");
    send(
        sdk,
        file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "dump the log please".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new(format!(
                        "full log follows\n{big_body}"
                    ))),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
}

async fn seed_two_turns(sdk: &Lhc, file_path: &str) {
    let mut args = Map::new();
    args.insert("path".into(), json!("notes.txt"));
    send(
        sdk,
        file_path,
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
                    payload: Some(AssistantTextPayload::new("first answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "read the file please".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-1".into(),
                        tool_name: "read".into(),
                        arguments: args,
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-1".into(),
                        content: "the file says hello".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("done reading")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
}

// ── get_turns ──────────────────────────────────────────────────────

#[tokio::test]
async fn get_turns_serves_stored_tagged_renderings_after_drain_in_request_order() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t2".into(), "t1".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed");
    };
    assert_eq!(
        receipt
            .served
            .iter()
            .map(|t| t.turn_id.as_str())
            .collect::<Vec<_>>(),
        ["t2", "t1"]
    );
    assert!(receipt.unserved.is_empty());
    let t2 = &receipt.served[0];
    assert_eq!(t2.source, RetrievedTurnSource::Stored);
    assert!(t2.text.contains("<t2>"));
    assert!(t2.text.contains("</t2>"));
    assert!(t2.text.contains("read the file please"));
    assert!(t2.text.contains("<m"));
    let sum: i64 = receipt.served.iter().map(|t| t.tokens).sum();
    assert_eq!(receipt.total_tokens, sum);
}

#[tokio::test]
async fn get_turns_composes_live_fallback_when_rendering_not_ready() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    // No drain: turn_rendering pending.

    let result = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &["t1".into()], None)
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed");
    };
    let turn = &receipt.served[0];
    assert_eq!(turn.source, RetrievedTurnSource::Composed);
    assert!(turn.text.contains("<t1>"));
    assert!(turn.text.contains("first question"));
}

#[tokio::test]
async fn get_turns_composes_tagged_fallback_for_ready_legacy_unlabeled_rendering() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    {
        let db = open_raw(&file_path);
        db.prepare(
            "UPDATE derivation SET content = 'legacy untagged rendering'
             WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'turn_rendering'",
        )
        .run(&[]);
        db.close();
    }

    let result = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &["t1".into()], None)
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed");
    };
    let turn = &receipt.served[0];
    assert_eq!(turn.source, RetrievedTurnSource::Composed);
    assert!(turn.text.contains("<t1>"));
    assert!(turn.text.contains("<m1>"));
    assert!(!turn.text.contains("legacy untagged rendering"));
}

#[tokio::test]
async fn get_turns_reports_unknown_ids_as_not_found_without_charging_budget() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t99".into(), "t1".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed");
    };
    assert_eq!(receipt.unserved.len(), 1);
    assert_eq!(receipt.unserved[0].id, "t99");
    assert_eq!(receipt.unserved[0].reason, UnservedReason::NotFound);
    assert_eq!(
        receipt
            .served
            .iter()
            .map(|t| t.turn_id.as_str())
            .collect::<Vec<_>>(),
        ["t1"]
    );
}

#[tokio::test]
async fn get_turns_reports_budget_when_too_little_remains_to_slice() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let full = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t2".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: full } = full else {
        panic!("full failed");
    };
    let t2_tokens = full.served[1].tokens;

    let partial = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t2".into()],
            Some(lhc::RetrievalOptions {
                token_budget: Some(t2_tokens as f64),
                byte_budget: None,
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: partial } = partial else {
        panic!("partial failed");
    };
    assert_eq!(
        partial
            .served
            .iter()
            .map(|t| t.turn_id.as_str())
            .collect::<Vec<_>>(),
        ["t1"]
    );
    assert!(partial.served[0].slice.is_none());
    assert_eq!(partial.unserved.len(), 1);
    assert_eq!(partial.unserved[0].id, "t2");
    assert_eq!(partial.unserved[0].reason, UnservedReason::Budget);
    assert!(partial.unserved[0].tokens.unwrap_or(0) > 0);
}

#[tokio::test]
async fn get_turns_slices_oversized_turn_to_budget_with_continuation_receipt() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_big_turn(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into()],
            Some(lhc::RetrievalOptions {
                token_budget: Some(500.0),
                byte_budget: None,
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed");
    };
    let turn = &receipt.served[0];
    let slice = turn.slice.as_ref().expect("slice");
    assert_eq!(slice.from_token, 0);
    assert_eq!(slice.to_token, 500);
    assert!(slice.total_tokens > 500);
    assert_eq!(turn.tokens, 500);
    assert_eq!(receipt.total_tokens, 500);
}

#[tokio::test]
async fn get_turns_from_token_continuation_slices_reassemble_full_text() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_big_turn(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let whole = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &["t1".into()], None)
        .await;
    let OpResult::Ok { value: whole } = whole else {
        panic!("whole failed");
    };
    let full_text = whole.served[0].text.clone();

    let mut assembled = String::new();
    let mut from = 0i64;
    for _ in 0..20 {
        let part = sdk
            .retrieval
            .get_turns(
                ThreadRef::file_path(&file_path),
                &["t1".into()],
                Some(lhc::RetrievalOptions {
                    token_budget: Some(400.0),
                    byte_budget: None,
                    from_token: Some(from as f64),
                    surface: None,
                }),
            )
            .await;
        let OpResult::Ok { value: part } = part else {
            panic!("part failed");
        };
        let slice_item = &part.served[0];
        let slice = slice_item.slice.as_ref().expect("slice");
        assembled.push_str(&slice_item.text);
        from = slice.to_token;
        if from >= slice.total_tokens {
            break;
        }
    }
    assert_eq!(assembled, full_text);
}

#[tokio::test]
async fn get_turns_serves_crossing_item_sliced_and_later_items_with_budget_receipts() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_big_turn(&sdk, &file_path).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "small follow-up".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("small answer")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path).await;

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t2".into()],
            Some(lhc::RetrievalOptions {
                token_budget: Some(500.0),
                byte_budget: None,
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed");
    };
    assert_eq!(receipt.served.len(), 1);
    assert_eq!(receipt.served[0].turn_id, "t1");
    assert!(receipt.served[0].slice.is_some());
    assert_eq!(receipt.unserved.len(), 1);
    assert_eq!(receipt.unserved[0].id, "t2");
    assert_eq!(receipt.unserved[0].reason, UnservedReason::Budget);
    assert!(receipt.unserved[0].tokens.is_some());
}

#[tokio::test]
async fn get_turns_rejects_negative_or_fractional_from_token() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;

    let negative = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into()],
            Some(lhc::RetrievalOptions {
                token_budget: None,
                byte_budget: None,
                from_token: Some(-1.0),
                surface: None,
            }),
        )
        .await;
    assert!(!negative.is_ok());
    let fractional = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into()],
            Some(lhc::RetrievalOptions {
                token_budget: None,
                byte_budget: None,
                from_token: Some(1.5),
                surface: None,
            }),
        )
        .await;
    assert!(!fractional.is_ok());
}

#[tokio::test]
async fn get_turns_collapses_duplicate_ids_to_one_serve() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let result = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t1".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_turns failed");
    };
    assert_eq!(receipt.served.len(), 1);

    // Dedupe is first-occurrence-wins for impressions too: exactly one row.
    let impressions = sdk
        .retrieval
        .list_impressions(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: impressions } = impressions else {
        panic!("list_impressions failed");
    };
    assert_eq!(
        impressions.len(),
        1,
        "duplicate request ids must write exactly one impression"
    );
    assert_eq!(impressions[0].entity_id, "t1");
    assert_eq!(impressions[0].request_idx, 0);
    assert!(impressions[0].served);
    assert_eq!(impressions[0].call_id, receipt.call_id);
}

#[tokio::test]
async fn get_turns_rejects_empty_id_list_and_non_positive_budget() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;

    let empty = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &[], None)
        .await;
    assert!(!empty.is_ok());
    let bad = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into()],
            Some(lhc::RetrievalOptions {
                token_budget: Some(0.0),
                byte_budget: None,
                from_token: None,
                surface: None,
            }),
        )
        .await;
    assert!(!bad.is_ok());
}

// ── get_messages ───────────────────────────────────────────────────

#[tokio::test]
async fn get_messages_serves_verbatim_text_tool_calls_and_results() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("list failed");
    };
    let first_of = |kind: MessageKind| {
        listed
            .iter()
            .find(|r| r.kind == kind)
            .map(|r| r.message_id.clone())
            .expect("kind present")
    };
    let prompt_id = first_of(MessageKind::UserPrompt);
    let call_id = first_of(MessageKind::ToolCall);
    let result_id = first_of(MessageKind::ToolResult);

    let result = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &[prompt_id, call_id, result_id],
            None,
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_messages failed");
    };
    assert_eq!(receipt.served[0].text, "first question");
    assert_eq!(receipt.served[0].kind, "user_prompt");
    assert_eq!(receipt.served[0].turn_id, "t1");
    assert!(receipt.served[1].text.contains("[tool_call read call-1]"));
    assert!(
        receipt.served[1].text.contains("\"path\": \"notes.txt\"")
            || receipt.served[1].text.contains("\"path\":\"notes.txt\"")
    );
    assert!(receipt.served[2].text.contains("[tool_result call-1]"));
    assert!(receipt.served[2].text.contains("the file says hello"));
}

#[tokio::test]
async fn get_messages_reports_unknown_ids_as_not_found() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;

    let result = sdk
        .retrieval
        .get_messages(ThreadRef::file_path(&file_path), &["m999".into()], None)
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_messages failed");
    };
    assert!(receipt.served.is_empty());
    assert_eq!(receipt.unserved.len(), 1);
    assert_eq!(receipt.unserved[0].id, "m999");
    assert_eq!(receipt.unserved[0].reason, UnservedReason::NotFound);
}

#[tokio::test]
async fn get_messages_enforces_token_budget_across_messages_in_order() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("list failed");
    };
    let prompts: Vec<String> = listed
        .iter()
        .filter(|r| r.kind == MessageKind::UserPrompt)
        .map(|r| r.message_id.clone())
        .collect();
    let budget = estimate_tokens("read the file please");

    let result = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &prompts,
            Some(lhc::RetrievalOptions {
                token_budget: Some(budget as f64),
                byte_budget: None,
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_messages failed");
    };
    assert_eq!(receipt.served.len(), 1);
    assert_eq!(receipt.unserved[0].reason, UnservedReason::Budget);
}

// ── impression log ─────────────────────────────────────────────────

#[tokio::test]
async fn impression_log_writes_one_row_per_requested_id() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let first = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t99".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: first } = first else {
        panic!("first failed");
    };

    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("list failed");
    };
    let prompt_id = listed
        .iter()
        .find(|r| r.kind == MessageKind::UserPrompt)
        .map(|r| r.message_id.clone())
        .expect("prompt");

    let second = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &[prompt_id.clone()],
            Some(lhc::RetrievalOptions {
                token_budget: None,
                byte_budget: None,
                from_token: None,
                surface: Some("board".into()),
            }),
        )
        .await;
    let OpResult::Ok { value: second } = second else {
        panic!("second failed");
    };

    let impressions = sdk
        .retrieval
        .list_impressions(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: impressions } = impressions else {
        panic!("list_impressions failed");
    };
    assert_eq!(impressions.len(), 3);

    assert_eq!(impressions[0].call_id, first.call_id);
    assert_eq!(impressions[0].surface, "get_turns");
    assert_eq!(impressions[0].entity_kind, "turn");
    assert_eq!(impressions[0].entity_id, "t1");
    assert_eq!(impressions[0].request_idx, 0);
    assert!(impressions[0].served);
    assert!(impressions[0].tokens.unwrap_or(0) > 0);

    assert_eq!(impressions[1].entity_id, "t99");
    assert!(!impressions[1].served);
    assert_eq!(impressions[1].reason.as_deref(), Some("not_found"));

    assert_eq!(impressions[2].call_id, second.call_id);
    assert_eq!(impressions[2].surface, "board");
    assert_eq!(impressions[2].entity_kind, "message");
    assert_eq!(impressions[2].entity_id, prompt_id);
    assert!(impressions[2].served);
}

#[tokio::test]
async fn impression_log_persists_deleted_and_budget_outcomes() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    // Soft-delete a closed-turn message so get_messages reports "deleted".
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("list failed");
    };
    let prompt_id = listed
        .iter()
        .find(|r| r.kind == MessageKind::UserPrompt)
        .map(|r| r.message_id.clone())
        .expect("prompt");
    // Soft-delete via SQL (same seam as mutations tests) — closed-turn
    // messages can be deleted; retrieval must report "deleted" from the row.
    {
        let db = open_raw(&file_path);
        db.prepare("UPDATE message SET deleted_at = ? WHERE message_id = ?")
            .run(&[
                SqlParam::from("2026-08-08T00:00:00.000Z"),
                SqlParam::from(prompt_id.as_str()),
            ]);
        db.close();
    }

    let deleted_call = sdk
        .retrieval
        .get_messages(ThreadRef::file_path(&file_path), &[prompt_id.clone()], None)
        .await;
    let OpResult::Ok {
        value: deleted_call,
    } = deleted_call
    else {
        panic!("get_messages failed");
    };
    assert!(deleted_call.served.is_empty());
    assert_eq!(deleted_call.unserved.len(), 1);
    assert_eq!(deleted_call.unserved[0].reason, UnservedReason::Deleted);

    // Budget outcome: two turns, budget only fits the first (leftover << slice floor).
    let full = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t2".into()],
            None,
        )
        .await;
    let OpResult::Ok { value: full } = full else {
        panic!("full get_turns failed");
    };
    let t2_tokens = full.served[1].tokens;
    let budget_call = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t2".into()],
            Some(lhc::RetrievalOptions {
                token_budget: Some(t2_tokens as f64),
                byte_budget: None,
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: budget_call } = budget_call else {
        panic!("budget get_turns failed");
    };
    assert_eq!(budget_call.unserved.len(), 1);
    assert_eq!(budget_call.unserved[0].reason, UnservedReason::Budget);

    let impressions = sdk
        .retrieval
        .list_impressions(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: impressions } = impressions else {
        panic!("list_impressions failed");
    };

    let deleted_row = impressions
        .iter()
        .find(|r| r.call_id == deleted_call.call_id && r.entity_id == prompt_id)
        .expect("deleted impression");
    assert!(!deleted_row.served);
    assert_eq!(deleted_row.reason.as_deref(), Some("deleted"));
    assert_eq!(deleted_row.entity_kind, "message");

    let budget_row = impressions
        .iter()
        .find(|r| r.call_id == budget_call.call_id && r.entity_id == "t2")
        .expect("budget impression");
    assert!(!budget_row.served);
    assert_eq!(budget_row.reason.as_deref(), Some("budget"));
    assert_eq!(budget_row.entity_kind, "turn");
    assert!(budget_row.tokens.unwrap_or(0) > 0);
}

#[tokio::test]
async fn from_token_slices_every_requested_id_from_offset() {
    // fromToken > 0 is the single-id continuation contract applied to EVERY
    // requested item — not only the first.
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_big_turn(&sdk, &file_path).await;
    send(
        &sdk,
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "second dump".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new(
                        (0..400)
                            .map(|i| format!("t2 line {i}: lorem ipsum dolor sit amet"))
                            .collect::<Vec<_>>()
                            .join("\n"),
                    )),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    drain(&sdk, &file_path).await;

    let whole_t1 = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &["t1".into()], None)
        .await;
    let OpResult::Ok { value: whole_t1 } = whole_t1 else {
        panic!("whole t1");
    };
    let whole_t2 = sdk
        .retrieval
        .get_turns(ThreadRef::file_path(&file_path), &["t2".into()], None)
        .await;
    let OpResult::Ok { value: whole_t2 } = whole_t2 else {
        panic!("whole t2");
    };
    let full_t1 = whole_t1.served[0].text.clone();
    let full_t2 = whole_t2.served[0].text.clone();

    let from = 50i64;
    // Cap each window so both multi-id items serve under a shared budget while
    // still proving every id is sliced from the same fromToken offset.
    let window = 200i64;
    let multi = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t2".into()],
            Some(lhc::RetrievalOptions {
                // Enough for two 200-token windows after shared fromToken.
                token_budget: Some((window * 2) as f64),
                byte_budget: None,
                from_token: Some(from as f64),
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: multi } = multi else {
        panic!("multi fromToken failed");
    };
    assert_eq!(
        multi.served.len(),
        2,
        "both ids must be served (fromToken path does not stop at the first)"
    );
    assert_eq!(multi.served[0].turn_id, "t1");
    assert_eq!(multi.served[1].turn_id, "t2");

    // Walk remaining budget the same way budget_walk does: first item takes
    // min(window_budget_remaining, rest_of_text); second uses what is left.
    let mut remaining = window * 2;
    for (served, full) in multi.served.iter().zip([&full_t1, &full_t2]) {
        let slice = served
            .slice
            .as_ref()
            .expect("every item must carry a slice");
        assert_eq!(
            slice.from_token, from,
            "every requested id is sliced from fromToken (not only the first)"
        );
        assert!(slice.total_tokens > from);
        let expected = lhc::slice_tokens(full, from, remaining);
        assert_eq!(slice.to_token, expected.to_token);
        assert_eq!(served.text, expected.text);
        assert_eq!(served.tokens, expected.to_token - expected.from_token);
        remaining -= served.tokens;
    }
    assert!(remaining >= 0);

    let impressions = sdk
        .retrieval
        .list_impressions(ThreadRef::file_path(&file_path))
        .await;
    let OpResult::Ok { value: impressions } = impressions else {
        panic!("impressions");
    };
    let multi_rows: Vec<_> = impressions
        .iter()
        .filter(|r| r.call_id == multi.call_id)
        .collect();
    assert_eq!(multi_rows.len(), 2);
    assert!(multi_rows.iter().all(|r| r.served));
    assert_eq!(multi_rows[0].entity_id, "t1");
    assert_eq!(multi_rows[1].entity_id, "t2");
}

#[tokio::test]
async fn retrieval_writes_nothing_to_record_tables() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    drain(&sdk, &file_path).await;

    let before = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let OpResult::Ok { value: before } = before else {
        panic!("list failed");
    };

    let _ = sdk
        .retrieval
        .get_turns(
            ThreadRef::file_path(&file_path),
            &["t1".into(), "t2".into()],
            None,
        )
        .await;
    let _ = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &[before[0].message_id.clone()],
            None,
        )
        .await;

    let after = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let OpResult::Ok { value: after } = after else {
        panic!("list failed");
    };
    assert_eq!(after, before);

    let _ = retrieval::DEFAULT_RETRIEVAL_TOKEN_BUDGET;
    let _ = SqlParam::from("");
    let _ = Value::Null;
}

// ── byteBudget (TS parity: retrieval.test.ts "byteBudget") ─────────

fn dense_lines(count: usize) -> String {
    format!("{}\n", "=".repeat(80)).repeat(count)
}

async fn seed_dense(sdk: &Lhc, file_path: &str, texts: &[&str]) -> Vec<String> {
    let mut events = vec![valid_event(
        kind::USER_PROMPT,
        UserPromptOverrides {
            payload: Some(UserPromptPayload {
                text: "dump".into(),
            }),
            ..Default::default()
        },
    )];
    for text in texts {
        events.push(valid_event(
            kind::ASSISTANT_TEXT,
            AssistantTextOverrides {
                payload: Some(AssistantTextPayload::new(*text)),
                ..Default::default()
            },
        ));
    }
    events.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    send(sdk, file_path, &events).await;
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("list failed");
    };
    listed
        .iter()
        .filter(|r| r.kind == MessageKind::AssistantText)
        .map(|r| r.message_id.clone())
        .collect()
}

fn byte_options(byte_budget: f64, from_token: Option<f64>) -> Option<lhc::RetrievalOptions> {
    Some(lhc::RetrievalOptions {
        token_budget: None,
        byte_budget: Some(byte_budget),
        from_token,
        surface: None,
    })
}

/// Token-cheap byte-heavy content slices to fit the byte allowance, and the
/// token-denominated receipt continues correctly, still byte-fit.
#[tokio::test]
async fn byte_budget_slices_byte_heavy_content() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    let dense = dense_lines(1_500);
    let ids = seed_dense(&sdk, &file_path, &[&dense]).await;

    let byte_budget = 12_000usize;
    let result = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &ids,
            byte_options(byte_budget as f64, None),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_messages failed");
    };
    assert_eq!(receipt.served.len(), 1);
    let served = &receipt.served[0];
    assert!(
        served.text.len() <= byte_budget,
        "bytes {}",
        served.text.len()
    );
    let slice = served.slice.as_ref().expect("slice receipt");
    assert_eq!(slice.from_token, 0);
    assert_eq!(slice.to_token, served.tokens);
    assert!(slice.to_token < slice.total_tokens);

    let next = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &ids,
            byte_options(byte_budget as f64, Some(slice.to_token as f64)),
        )
        .await;
    let OpResult::Ok { value: next } = next else {
        panic!("continuation failed");
    };
    let next_served = &next.served[0];
    let next_slice = next_served.slice.as_ref().expect("slice receipt");
    assert_eq!(next_slice.from_token, slice.to_token);
    assert!(next_served.text.len() <= byte_budget);
}

/// Bytes that fit whole-serve without a slice; non-positive byteBudget is
/// rejected as a storage failure.
#[tokio::test]
async fn byte_budget_whole_serve_and_validation() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    seed_two_turns(&sdk, &file_path).await;
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("list failed");
    };
    let prompt_id = vec![
        listed
            .iter()
            .find(|r| r.kind == MessageKind::UserPrompt)
            .expect("prompt")
            .message_id
            .clone(),
    ];

    let whole = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &prompt_id,
            byte_options(1_000_000.0, None),
        )
        .await;
    let OpResult::Ok { value: whole } = whole else {
        panic!("whole serve failed");
    };
    assert!(whole.served[0].slice.is_none());

    let bad = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &prompt_id,
            byte_options(0.0, None),
        )
        .await;
    assert!(
        matches!(bad, OpResult::Err { .. }),
        "byteBudget 0 must fail"
    );
}

/// A byte-spent budget serves later items as byte-bound slices, never
/// refusals (byte-bound serves are exempt from the sliver floor:
/// re-pulling alone cannot yield more bytes).
#[tokio::test]
async fn byte_spent_budget_serves_byte_bound_slices() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    let first = dense_lines(900);
    let second = dense_lines(40);
    let ids = seed_dense(&sdk, &file_path, &[&first, &second]).await;

    let result = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &ids,
            byte_options(8_000.0, None),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_messages failed");
    };
    assert_eq!(receipt.served.len(), 2);
    assert!(
        receipt.served[1].slice.is_some(),
        "second item byte-bound slice"
    );
    let served_bytes: usize = receipt.served.iter().map(|s| s.text.len()).sum();
    assert!(served_bytes <= 8_000, "served {served_bytes} bytes");
}

/// Multi-byte content never splits a char at the slice tail: byte caps that
/// land inside a char shrink to the clean boundary — no U+FFFD, no mid-char
/// continuation offset (A3 round-5 finding 1).
#[tokio::test]
async fn multi_byte_content_never_splits_a_char() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    let crabs = format!("{}\n", "\u{1F980}".repeat(20)).repeat(200);
    let ids = seed_dense(&sdk, &file_path, &[&crabs]).await;

    let mut from: i64 = 0;
    let mut reassembled = String::new();
    for _ in 0..40 {
        let page = sdk
            .retrieval
            .get_messages(
                ThreadRef::file_path(&file_path),
                &ids,
                byte_options(1_001.0, if from == 0 { None } else { Some(from as f64) }),
            )
            .await;
        let OpResult::Ok { value: page } = page else {
            panic!("page failed");
        };
        let served = &page.served[0];
        assert!(!served.text.contains('\u{FFFD}'), "replacement char served");
        assert!(
            served.text.len() <= 1_001,
            "page bytes {}",
            served.text.len()
        );
        reassembled.push_str(&served.text);
        match &served.slice {
            Some(slice) if slice.to_token < slice.total_tokens => {
                assert!(slice.to_token > from, "no progress");
                from = slice.to_token;
            }
            _ => break,
        }
    }
    assert!(reassembled.starts_with('\u{1F980}'));
    assert!(!reassembled.contains('\u{FFFD}'));
}

/// Byte-dense content stays retrievable when bytes bind below the token
/// floor (A3 round-5 finding 2): the byte-fit window serves with a
/// continuation receipt instead of an unprogressable budget refusal.
#[tokio::test]
async fn byte_dense_single_id_stays_retrievable() {
    let store = temp_store();
    let sdk = manual_sdk();
    let file_path = new_thread(&sdk, &store).await;
    let dense = dense_lines(900);
    let ids = seed_dense(&sdk, &file_path, &[&dense]).await;

    let result = sdk
        .retrieval
        .get_messages(
            ThreadRef::file_path(&file_path),
            &ids,
            byte_options(8_000.0, None),
        )
        .await;
    let OpResult::Ok { value: receipt } = result else {
        panic!("get_messages failed");
    };
    assert_eq!(receipt.served.len(), 1);
    let served = &receipt.served[0];
    assert!(served.text.len() <= 8_000);
    let slice = served.slice.as_ref().expect("continuation receipt");
    assert!(slice.to_token > 0, "must make progress");
}

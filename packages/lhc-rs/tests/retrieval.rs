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
use lhc::retrieval::{
    RetrievedTurnSource, UnservedReason,
};
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
        receipt.served.iter().map(|t| t.turn_id.as_str()).collect::<Vec<_>>(),
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
        receipt.served.iter().map(|t| t.turn_id.as_str()).collect::<Vec<_>>(),
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
                from_token: None,
                surface: None,
            }),
        )
        .await;
    let OpResult::Ok { value: partial } = partial else {
        panic!("partial failed");
    };
    assert_eq!(
        partial.served.iter().map(|t| t.turn_id.as_str()).collect::<Vec<_>>(),
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
    assert!(receipt.served[1].text.contains("\"path\": \"notes.txt\"") || receipt.served[1].text.contains("\"path\":\"notes.txt\""));
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

//! Ported from packages/lhc/test/validation.test.ts. Phase 1 skeleton-expected.

mod fixtures;

use std::fs;
use std::path::PathBuf;

use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads::{self, NewThreadInput};
use lhc::{EventRecord, MessageEventInput, ThreadRef, intake_stream};
use serde_json::{Map, Value, json};

use fixtures::{
    AssistantThinkingOverrides, TempStore, TurnEndOverrides, UserPromptOverrides,
    conversation_turn, event_batch, kind, temp_store, valid_event, valid_event_for_kind,
};
use lhc::intake_stream::EventKind;

async fn create_thread(store: &TempStore) -> String {
    let file_path = store.thread_path(None);
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    match created {
        OpResult::Ok { value } => value.file_path,
        OpResult::Err { error } => panic!("fixture thread creation failed: {}", error.reason),
    }
}

async fn read_back(file_path: &str) -> Vec<EventRecord> {
    match intake_stream::list_events(ThreadRef::file_path(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("read-back failed: {}", error.reason),
    }
}

fn with_extra(mut event: MessageEventInput, key: &str, value: Value) -> MessageEventInput {
    event.extra.insert(key.to_string(), value);
    event
}

fn with_kind(mut event: MessageEventInput, kind: &str) -> MessageEventInput {
    event.event_kind = kind.to_string();
    event
}

fn without_key(mut event: MessageEventInput) -> MessageEventInput {
    event.idempotency_key = None;
    event
}

fn with_payload(mut event: MessageEventInput, payload: Map<String, Value>) -> MessageEventInput {
    event.payload = payload;
    event
}

#[tokio::test]
async fn tc_4_1_four_invalidity_categories_each_rejected_whole_with_a_named_reason() {
    let store = temp_store();
    let file_path = create_thread(&store).await;

    let unknown_kind = with_kind(valid_event_for_kind(EventKind::UserPrompt), "mystery_kind");
    let missing_key = without_key(valid_event_for_kind(EventKind::UserPrompt));
    let server_field = with_extra(
        valid_event_for_kind(EventKind::UserPrompt),
        "eventOrder",
        json!(7),
    );
    let turn_end_with_payload = with_payload(
        valid_event_for_kind(EventKind::TurnEnd),
        json!({"text": "should not be here"})
            .as_object()
            .unwrap()
            .clone(),
    );

    // turn_end may carry optional host facts, but unknown keys stay closed.
    // TS reason: /"text".*unexpected|unexpected.*"text"/
    let cases: Vec<(Vec<MessageEventInput>, &str)> = vec![
        (vec![unknown_kind], "unknown event kind"),
        (vec![missing_key], "idempotencyKey"),
        (vec![server_field], "eventOrder"),
        (vec![turn_end_with_payload], "text"),
    ];

    for (batch, reason) in cases {
        let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
        assert!(!result.is_ok());
        if let OpResult::Err { error } = result {
            assert_eq!(error.error_class, ErrorClass::CallerError);
            assert_eq!(error.code, ErrorCode::InvalidEvent);
            assert_eq!(error.event_index, Some(0));
            // TS: /server-generated.*eventOrder/ — "server-generated" before "eventOrder".
            if reason == "eventOrder" {
                let sg = error
                    .reason
                    .find("server-generated")
                    .expect("reason must contain server-generated");
                let eo = error
                    .reason
                    .find("eventOrder")
                    .expect("reason must contain eventOrder");
                assert!(
                    sg < eo,
                    "expected server-generated before eventOrder in reason={}",
                    error.reason
                );
            } else if reason == "text" {
                // Unknown key on closed turn_end payload.
                assert!(
                    error.reason.contains("\"text\"") && error.reason.contains("unexpected"),
                    "reason={} expected \"text\" unexpected",
                    error.reason
                );
            } else {
                assert!(
                    error.reason.contains(reason),
                    "reason={} expected substring {reason}",
                    error.reason
                );
            }
        }
    }

    assert!(read_back(&file_path).await.is_empty());
    store.cleanup();
}

#[tokio::test]
async fn tc_4_2_first_failure_names_index_2_valid_earlier_events_did_not_land() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let batch = vec![
        valid_event_for_kind(EventKind::UserPrompt),
        valid_event_for_kind(EventKind::AssistantText),
        valid_event(
            kind::ASSISTANT_THINKING,
            AssistantThinkingOverrides {
                actor: Some(String::new()),
                ..Default::default()
            },
        ),
    ];
    let result = intake_stream::message_events(ThreadRef::file_path(&file_path), &batch).await;
    assert!(!result.is_ok());
    if let OpResult::Err { error } = result {
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert_eq!(error.event_index, Some(2));
    }
    assert!(read_back(&file_path).await.is_empty());
    store.cleanup();
}

#[tokio::test]
async fn tc_4_3_after_rejection_thread_reads_back_logically_identical_to_baseline() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let recorded =
        intake_stream::message_events(ThreadRef::file_path(&file_path), &conversation_turn()).await;
    assert!(recorded.is_ok());
    let baseline = read_back(&file_path).await;
    assert_eq!(baseline.len(), 5);

    let rejected = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            with_payload(
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
                json!({"oops": 1}).as_object().unwrap().clone(),
            ),
        ],
    )
    .await;
    assert!(!rejected.is_ok());
    assert_eq!(read_back(&file_path).await, baseline);
    store.cleanup();
}

#[tokio::test]
async fn tc_4_4_caller_system_legs_error_classes_separate() {
    let store = temp_store();
    let file_path = create_thread(&store).await;

    let caller_leg = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[with_kind(
            valid_event_for_kind(EventKind::UserPrompt),
            "bogus",
        )],
    )
    .await;
    assert!(!caller_leg.is_ok());
    let caller_err = match caller_leg {
        OpResult::Err { error } => error,
        OpResult::Ok { .. } => unreachable!(),
    };
    assert_eq!(caller_err.error_class, ErrorClass::CallerError);
    assert_eq!(caller_err.code, ErrorCode::InvalidEvent);

    let blocker: PathBuf = store.dir.join("blocker-file");
    fs::write(&blocker, "regular file standing where a directory must be").unwrap();
    let system_leg = threads::new_thread(NewThreadInput {
        file_path: store.thread_path(None).to_string_lossy().into_owned(),
        title: None,
        cwd: None,
        registry_path: Some(
            blocker
                .join("registry.sqlite")
                .to_string_lossy()
                .into_owned(),
        ),
    })
    .await;
    assert!(!system_leg.is_ok());
    let system_err = match system_leg {
        OpResult::Err { error } => error,
        OpResult::Ok { .. } => unreachable!(),
    };
    assert_eq!(system_err.error_class, ErrorClass::SystemError);
    assert_eq!(system_err.code, ErrorCode::StorageFailure);
    assert_ne!(caller_err.error_class, system_err.error_class);
    store.cleanup();
}

#[tokio::test]
async fn tc_4_5_batch_mixing_new_duplicate_and_invalid_rejected_whole() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let original = event_batch(&[EventKind::UserPrompt, EventKind::AssistantText]);
    let recorded = intake_stream::message_events(ThreadRef::file_path(&file_path), &original).await;
    assert!(recorded.is_ok());
    let baseline = read_back(&file_path).await;
    assert_eq!(baseline.len(), 2);

    let mixed = vec![
        valid_event_for_kind(EventKind::ToolCall),
        original[0].clone(),
        with_payload(
            valid_event_for_kind(EventKind::TurnEnd),
            json!({"bad": true}).as_object().unwrap().clone(),
        ),
    ];
    let rejected = intake_stream::message_events(ThreadRef::file_path(&file_path), &mixed).await;
    assert!(!rejected.is_ok());
    if let OpResult::Err { error } = rejected {
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert_eq!(error.event_index, Some(2));
    }
    assert_eq!(read_back(&file_path).await, baseline);
    store.cleanup();
}

#[tokio::test]
async fn strictness_unknown_fields_rejected_at_envelope_event_and_payload_levels() {
    // TS `as unknown as ThreadRef` with `{ filePath, surprise: true }`.
    // Public API stays closed `ThreadRef`; the cast-through-invalid-object
    // call is represented by rejection at the serde boundary
    // (custom Deserialize → unknown_field naming the bad key).
    // Exercised before thread creation so Phase 1 hits this wire check
    // without requiring `new_thread` behavior.
    let envelope_wire = json!({"filePath": "/tmp/lhc-envelope-probe.sqlite", "surprise": true});
    let envelope_err = serde_json::from_value::<ThreadRef>(envelope_wire)
        .expect_err("unknown envelope field must fail ThreadRef deserialize");
    let envelope_msg = envelope_err.to_string();
    assert!(
        envelope_msg.contains("surprise") || envelope_msg.to_lowercase().contains("unknown field"),
        "serde rejection must name surprise/unknown field, got {envelope_msg}"
    );

    let store = temp_store();
    let file_path = create_thread(&store).await;

    let event_probe = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[with_extra(
            valid_event_for_kind(EventKind::UserPrompt),
            "surprise",
            json!(true),
        )],
    )
    .await;
    assert!(!event_probe.is_ok());
    if let OpResult::Err { error } = event_probe {
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert!(error.reason.contains("event"));
        assert!(error.reason.contains("surprise"));
    }

    let payload_probe = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[with_payload(
            valid_event_for_kind(EventKind::UserPrompt),
            json!({"text": "hello", "surprise": true})
                .as_object()
                .unwrap()
                .clone(),
        )],
    )
    .await;
    assert!(!payload_probe.is_ok());
    if let OpResult::Err { error } = payload_probe {
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert!(error.reason.contains("payload"));
        assert!(error.reason.contains("surprise"));
    }
    assert!(read_back(&file_path).await.is_empty());
    store.cleanup();
}

#[tokio::test]
async fn strictness_empty_actor_and_empty_harness_are_rejected() {
    let store = temp_store();
    let file_path = create_thread(&store).await;

    let empty_actor = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                actor: Some(String::new()),
                ..Default::default()
            },
        )],
    )
    .await;
    assert!(!empty_actor.is_ok());
    if let OpResult::Err { error } = empty_actor {
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert!(error.reason.contains("actor"));
    }

    let empty_harness = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                harness: Some(String::new()),
                ..Default::default()
            },
        )],
    )
    .await;
    assert!(!empty_harness.is_ok());
    if let OpResult::Err { error } = empty_harness {
        assert_eq!(error.code, ErrorCode::InvalidEvent);
        assert!(error.reason.contains("harness"));
    }
    assert!(read_back(&file_path).await.is_empty());
    store.cleanup();
}

//! Ported from packages/lhc/test/turns.test.ts. Phase 1.
//!
//! Story 4 (Flow 3): turn boundaries through the production walk. TC-3.1
//! through TC-3.8 (the work-item halves of TC-3.3/TC-3.6 are Story 5's named
//! debt), TC-4.4's three-way class assertion, TC-5.4's no-transition clause
//! re-asserted now that turns exist, and the corruption rung of the rollback
//! ladder. Everything enters through the SDK (the CLI surface retired with Epic 05
//! Story 1).

mod fixtures;

use std::fs;

use fixtures::{TempStore, corrupt_two_open_turns, open_raw, temp_store, valid_event_for_kind};
use lhc::intake_stream::{
    BatchEventOutcome, BatchResult, EventKind, MessageEventInput, TurnTransition,
    TurnTransitionAction,
};
use lhc::messages::MessageRecord;
use lhc::shared_tech::derivation::{Derivation, DerivationState, SubjectKind};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::turns::{TurnRecord, TurnStatus};
use lhc::{intake_stream, messages, threads, turns};

async fn create_thread(store: &TempStore) -> String {
    let file_path = store.thread_path(None).to_string_lossy().into_owned();
    let created = threads::new_thread(NewThreadInput {
        file_path: file_path.clone(),
        title: None,
        cwd: None,
        registry_path: Some(store.registry_path.to_string_lossy().into_owned()),
    })
    .await;
    match created {
        OpResult::Ok { .. } => file_path,
        OpResult::Err { error } => {
            panic!("fixture thread creation failed: {}", error.reason)
        }
    }
}

async fn send(file_path: &str, batch: &[MessageEventInput]) -> BatchResult {
    match intake_stream::message_events(ThreadRef::file_path(file_path), batch).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("fixture batch failed: {}", error.reason),
    }
}

async fn read_turns(file_path: &str) -> Vec<TurnRecord> {
    match turns::list_turns(ThreadRef::file_path(file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("turn read-back failed: {}", error.reason),
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ReadBack {
    events: Vec<lhc::intake_stream::EventRecord>,
    messages: Vec<MessageRecord>,
    turns: Vec<TurnRecord>,
}

async fn read_back(file_path: &str) -> ReadBack {
    let events = intake_stream::list_events(ThreadRef::file_path(file_path)).await;
    let projected = messages::list(ThreadRef::file_path(file_path), None).await;
    let turn_records = turns::list_turns(ThreadRef::file_path(file_path)).await;
    match (events, projected, turn_records) {
        (
            OpResult::Ok { value: events },
            OpResult::Ok { value: messages },
            OpResult::Ok { value: turns },
        ) => ReadBack {
            events,
            messages,
            turns,
        },
        _ => panic!("read-back failed"),
    }
}

fn pending_turn_derivations(turn_id: &str) -> Vec<Derivation> {
    vec![
        Derivation {
            subject_kind: SubjectKind::Turn,
            subject_id: turn_id.into(),
            derivation_type: "pre_detailed_assembly".into(),
            state: DerivationState::Pending,
            content: None,
            reason: None,
            source_version: 1,
            gaps: None,
            metadata: None,
            derived_at: None,
        },
        Derivation {
            subject_kind: SubjectKind::Turn,
            subject_id: turn_id.into(),
            derivation_type: "turn_rendering".into(),
            state: DerivationState::Pending,
            content: None,
            reason: None,
            source_version: 1,
            gaps: None,
            metadata: None,
            derived_at: None,
        },
    ]
}

fn open_turn(turn_id: &str, turn_order: i64, members: Vec<&str>, opened: i64) -> TurnRecord {
    TurnRecord {
        turn_id: turn_id.into(),
        turn_order,
        status: TurnStatus::Open,
        member_message_ids: members.into_iter().map(str::to_string).collect(),
        opened_at_event_order: opened,
        closed_at_event_order: None,
        chunk_id: None,
        member_idx: None,
        derivations: None,
    }
}

fn closed_turn(
    turn_id: &str,
    turn_order: i64,
    members: Vec<&str>,
    opened: i64,
    closed: i64,
) -> TurnRecord {
    TurnRecord {
        turn_id: turn_id.into(),
        turn_order,
        status: TurnStatus::Closed,
        member_message_ids: members.into_iter().map(str::to_string).collect(),
        opened_at_event_order: opened,
        closed_at_event_order: Some(closed),
        chunk_id: None,
        member_idx: None,
        derivations: Some(pending_turn_derivations(turn_id)),
    }
}

#[tokio::test]
async fn new_thread_creation_initializes_exactly_one_empty_open_turn() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    assert_eq!(
        read_turns(&file_path).await,
        vec![open_turn("t1", 1, vec![], 0)]
    );
}

#[tokio::test]
async fn tc_3_1_a_prompt_attaches_to_the_empty_open_turn_and_the_whole_activity_stamps_to_it_ac_3_1_ac_3_2()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::ToolCall),
            valid_event_for_kind(EventKind::ToolResult),
        ],
    )
    .await;
    assert_eq!(result.turn_transitions, Vec::<TurnTransition>::new());

    let turn_records = read_turns(&file_path).await;
    assert_eq!(
        turn_records,
        vec![open_turn("t1", 1, vec!["m1", "m2", "m3", "m4"], 0)]
    );

    let projected = messages::list(ThreadRef::file_path(&file_path), None).await;
    assert!(projected.is_ok());
    let OpResult::Ok { value } = projected else {
        return;
    };
    assert_eq!(
        value.iter().map(|m| m.turn_id.as_str()).collect::<Vec<_>>(),
        ["t1", "t1", "t1", "t1"]
    );
}

#[tokio::test]
async fn tc_3_2_a_second_prompt_closes_the_open_turn_and_opens_a_new_one_holding_only_the_prompt_ac_3_3()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
        ],
    )
    .await;

    let second = send(&file_path, &[valid_event_for_kind(EventKind::UserPrompt)]).await;
    assert_eq!(
        second.turn_transitions,
        vec![
            TurnTransition {
                action: TurnTransitionAction::Closed,
                turn_id: "t1".into(),
            },
            TurnTransition {
                action: TurnTransitionAction::Opened,
                turn_id: "t2".into(),
            },
        ]
    );

    assert_eq!(
        read_turns(&file_path).await,
        vec![
            closed_turn("t1", 1, vec!["m1", "m2"], 0, 3),
            open_turn("t2", 2, vec!["m3"], 3),
        ]
    );
}

#[tokio::test]
async fn tc_3_3_transition_membership_half_turn_end_closes_a_non_empty_turn_and_opens_the_next_empty_turn_ac_3_4()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    assert_eq!(
        result.turn_transitions,
        vec![
            TurnTransition {
                action: TurnTransitionAction::Closed,
                turn_id: "t1".into(),
            },
            TurnTransition {
                action: TurnTransitionAction::Opened,
                turn_id: "t2".into(),
            },
        ]
    );

    assert_eq!(
        read_turns(&file_path).await,
        vec![
            closed_turn("t1", 1, vec!["m1", "m2"], 0, 3),
            open_turn("t2", 2, vec![], 3),
        ]
    );
}

#[tokio::test]
async fn tc_3_4_turn_end_on_an_empty_open_turn_is_recorded_but_inert_the_next_prompt_uses_that_turn_ac_3_5()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let orphan = send(&file_path, &[valid_event_for_kind(EventKind::TurnEnd)]).await;
    assert_eq!(orphan.turn_transitions, Vec::<TurnTransition>::new());
    assert_eq!(orphan.events[0].outcome, BatchEventOutcome::Recorded);

    let events = intake_stream::list_events(ThreadRef::file_path(&file_path)).await;
    assert!(events.is_ok());
    let OpResult::Ok { value } = events else {
        return;
    };
    assert_eq!(value.len(), 1);
    assert_eq!(value[0].event_order(), 1);

    assert_eq!(
        read_turns(&file_path).await,
        vec![open_turn("t1", 1, vec![], 0)]
    );

    let next = send(&file_path, &[valid_event_for_kind(EventKind::UserPrompt)]).await;
    assert_eq!(next.turn_transitions, Vec::<TurnTransition>::new());
    assert_eq!(
        read_turns(&file_path).await,
        vec![open_turn("t1", 1, vec!["m2"], 0)]
    );
}

#[tokio::test]
async fn tc_3_5_post_close_messages_attach_to_the_current_empty_turn_ac_3_7_ac_3_8() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    let closed_before = read_turns(&file_path).await.into_iter().next().unwrap();

    send(
        &file_path,
        &[valid_event_for_kind(EventKind::AssistantText)],
    )
    .await;
    send(&file_path, &[valid_event_for_kind(EventKind::UserPrompt)]).await;

    let projected = messages::list(ThreadRef::file_path(&file_path), None).await;
    assert!(projected.is_ok());
    let OpResult::Ok { value } = projected else {
        return;
    };
    assert_eq!(
        value.iter().map(|m| m.turn_id.as_str()).collect::<Vec<_>>(),
        ["t1", "t1", "t2", "t3"]
    );

    let turn_records = read_turns(&file_path).await;
    assert_eq!(turn_records[0], closed_before);
    assert_eq!(turn_records[1], closed_turn("t2", 2, vec!["m4"], 3, 5));
    assert_eq!(turn_records[2], open_turn("t3", 3, vec!["m5"], 5));
}

#[tokio::test]
async fn tc_3_6_transition_half_implicit_close_behaves_exactly_like_explicit_close_work_parity_is_story_5s()
 {
    let store = temp_store();
    let explicit_path = create_thread(&store).await;
    send(
        &explicit_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
        ],
    )
    .await;
    let explicit_close = send(&explicit_path, &[valid_event_for_kind(EventKind::TurnEnd)]).await;

    let implicit_path = create_thread(&store).await;
    send(
        &implicit_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
        ],
    )
    .await;
    let implicit_close = send(
        &implicit_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;

    assert_eq!(
        explicit_close.turn_transitions[0],
        TurnTransition {
            action: TurnTransitionAction::Closed,
            turn_id: "t1".into(),
        }
    );
    assert_eq!(
        implicit_close.turn_transitions[0],
        TurnTransition {
            action: TurnTransitionAction::Closed,
            turn_id: "t1".into(),
        }
    );
    let explicit_t1 = read_turns(&explicit_path).await.into_iter().next();
    let implicit_t1 = read_turns(&implicit_path).await.into_iter().next();
    assert_eq!(explicit_t1, implicit_t1);
}

#[tokio::test]
async fn tc_3_7_two_open_turns_fail_any_batch_with_turn_state_corrupt_and_the_batch_records_nothing_ac_3_9()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
        ],
    )
    .await;
    corrupt_two_open_turns(&file_path);

    let baseline = read_back(&file_path).await;

    let failed = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
        ],
    )
    .await;
    assert!(!failed.is_ok());
    let OpResult::Err { error } = failed else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::StateCorruption);
    assert_eq!(error.code, ErrorCode::TurnStateCorrupt);

    assert_eq!(read_back(&file_path).await, baseline);
}

#[tokio::test]
async fn zero_open_turns_fail_any_batch_with_turn_state_corrupt_and_the_batch_records_nothing_ac_3_9()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let db = open_raw(&file_path);
    db.prepare(
        "UPDATE turns SET status = 'closed', closed_at_event_order = 0 WHERE status = 'open'",
    )
    .run(&[]);
    db.close();
    let baseline = read_back(&file_path).await;
    let failed = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[valid_event_for_kind(EventKind::AssistantText)],
    )
    .await;
    assert!(!failed.is_ok());
    let OpResult::Err { error } = failed else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::StateCorruption);
    assert_eq!(error.code, ErrorCode::TurnStateCorrupt);
    assert_eq!(read_back(&file_path).await, baseline);
}

#[tokio::test]
async fn tc_3_8_one_batch_with_two_prompts_and_a_turn_end_yields_two_closed_turns_with_correct_membership_ac_3_3()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;

    assert_eq!(
        result.turn_transitions,
        vec![
            TurnTransition {
                action: TurnTransitionAction::Closed,
                turn_id: "t1".into(),
            },
            TurnTransition {
                action: TurnTransitionAction::Opened,
                turn_id: "t2".into(),
            },
            TurnTransition {
                action: TurnTransitionAction::Closed,
                turn_id: "t2".into(),
            },
            TurnTransition {
                action: TurnTransitionAction::Opened,
                turn_id: "t3".into(),
            },
        ]
    );

    assert_eq!(
        read_turns(&file_path).await,
        vec![
            closed_turn("t1", 1, vec!["m1", "m2"], 0, 3),
            closed_turn("t2", 2, vec!["m3", "m4"], 3, 5),
            open_turn("t3", 3, vec![], 5),
        ]
    );
}

#[tokio::test]
async fn tc_5_4_no_transition_clause_resending_recorded_events_causes_no_transition_and_leaves_turn_state_unchanged_ac_5_4()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let prompt = valid_event_for_kind(EventKind::UserPrompt);
    let end = valid_event_for_kind(EventKind::TurnEnd);
    send(
        &file_path,
        &[
            prompt.clone(),
            valid_event_for_kind(EventKind::AssistantText),
            end.clone(),
        ],
    )
    .await;
    send(&file_path, &[valid_event_for_kind(EventKind::UserPrompt)]).await;
    let baseline = read_back(&file_path).await;

    let resend = send(&file_path, &[prompt, end]).await;
    assert_eq!(
        resend.events.iter().map(|e| e.outcome).collect::<Vec<_>>(),
        [BatchEventOutcome::Skipped, BatchEventOutcome::Skipped]
    );
    assert_eq!(resend.turn_transitions, Vec::<TurnTransition>::new());
    assert_eq!(read_back(&file_path).await, baseline);
}

#[tokio::test]
async fn validation_corruption_and_storage_failures_carry_three_distinct_classes_with_stable_codes()
{
    let store = temp_store();

    let caller_path = create_thread(&store).await;
    let mut bogus = valid_event_for_kind(EventKind::UserPrompt);
    bogus.event_kind = "bogus".into();
    let caller_leg =
        intake_stream::message_events(ThreadRef::file_path(&caller_path), &[bogus]).await;
    assert!(!caller_leg.is_ok());
    let OpResult::Err { error: caller_err } = caller_leg else {
        return;
    };
    assert_eq!(caller_err.error_class, ErrorClass::CallerError);
    assert_eq!(caller_err.code, ErrorCode::InvalidEvent);

    let corrupt_path = create_thread(&store).await;
    send(
        &corrupt_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;
    corrupt_two_open_turns(&corrupt_path);
    let corruption_leg = intake_stream::message_events(
        ThreadRef::file_path(&corrupt_path),
        &[valid_event_for_kind(EventKind::AssistantText)],
    )
    .await;
    assert!(!corruption_leg.is_ok());
    let OpResult::Err {
        error: corruption_err,
    } = corruption_leg
    else {
        return;
    };
    assert_eq!(corruption_err.error_class, ErrorClass::StateCorruption);
    assert_eq!(corruption_err.code, ErrorCode::TurnStateCorrupt);

    let blocker = store.dir.join("blocker-file");
    fs::write(&blocker, "regular file standing where a directory must be").expect("write blocker");
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
    let OpResult::Err { error: system_err } = system_leg else {
        return;
    };
    assert_eq!(system_err.error_class, ErrorClass::SystemError);
    assert_eq!(system_err.code, ErrorCode::StorageFailure);

    let mut classes = vec![
        caller_err.error_class,
        corruption_err.error_class,
        system_err.error_class,
    ];
    classes.sort_by_key(|c| format!("{c:?}"));
    classes.dedup();
    assert_eq!(classes.len(), 3);
}

//! Ported from packages/lhc/test/work-queue.test.ts. Phase 1.
//!
//! Story 5 (Chunk 5): derivation work queueing. TC-2.6 (complete batch
//! result), TC-2.7/TC-2.9 (message-owned work and its kind gate), the work
//! halves of TC-3.3/TC-3.6 (Story 4's named debt, paid here), TC-3.8's
//! two-work-items assertion, TC-5.4's no-work-item clause, and the two
//! architecture-risk regressions: restart survival extended to work items and
//! the complete-surface rollback. Work items are asserted below the SDK with
//! direct queue reads — never through the batch result alone.

mod fixtures;

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::FutureExt;
use indexmap::IndexMap;

use fixtures::{
    TempStore, UserPromptOverrides, kind, open_raw, read_derived_forms, set_intake_clock,
    set_intake_walk_hook, temp_store, valid_event, valid_event_for_kind,
};
use lhc::intake_stream::{
    BatchEventOutcome, BatchEventResult, BatchSkipReason, EventKind, QueuedWorkItem,
    ThreadPosition, TurnTransition, TurnTransitionAction,
};
use lhc::shared_tech::derivation::{HandlerOutcome, SubjectKind, WorkHandler};
use lhc::shared_tech::durable_work::{
    DurableWorkDispatchResult, DurableWorkDispatcher, DurableWorkOperation,
    DurableWorkSettledDisposition,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::persist::create_db_write_transaction;
use lhc::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, SourceRefKey, WorkItemRecord, WorkItemRecordStatus,
    WorkKind, WorkKindRegistryEntry, WorkOwner, WorkSourceRef, enqueue, list_items,
    work_kind_registry,
};
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{
    intake_stream, lookup_work_dispatcher, lookup_work_handler, map_work_q_handlers, messages,
    set_scheduler_poke, threads, turns,
};

const FIXED_INSTANT: &str = "2026-06-10T12:00:00.000Z";
/// 2026-06-10T12:00:00.000Z as unix millis.
const FIXED_INSTANT_MS: u64 = 1_781_092_800_000;

fn fixed_system_time() -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(FIXED_INSTANT_MS)
}

fn cleanup_seams() {
    set_intake_clock(None);
    set_scheduler_poke(None);
    set_intake_walk_hook(None);
}

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

async fn send(
    file_path: &str,
    batch: &[lhc::MessageEventInput],
) -> lhc::intake_stream::BatchResult {
    let result = intake_stream::message_events(ThreadRef::file_path(file_path), batch).await;
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("fixture batch failed: {}", error.reason),
    }
}

fn queued_for(file_path: &str, owner: WorkOwner) -> Vec<WorkItemRecord> {
    let db = open_raw(file_path);
    let items = list_items(&db, owner);
    db.close();
    items
}

/// Below-SDK count of durable work-item rows: the batch result alone is not
/// proof of durability (anti-shim requirement).
fn raw_work_item_count(file_path: &str) -> i64 {
    let db = open_raw(file_path);
    let row = db.prepare("SELECT COUNT(*) AS n FROM work_item").get();
    let n = row
        .as_ref()
        .and_then(|r| r.get("n"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    db.close();
    n
}

#[derive(Debug, PartialEq)]
struct ReadBack {
    events: Vec<lhc::EventRecord>,
    messages: Vec<lhc::MessageRecord>,
    turns: Vec<lhc::TurnRecord>,
    message_work: Vec<WorkItemRecord>,
    turn_work: Vec<WorkItemRecord>,
}

/// Full logical read-back across every record kind the epic owns — the
/// complete-surface rollback regression compares this whole.
async fn read_back(file_path: &str) -> ReadBack {
    let events = intake_stream::list_events(ThreadRef::file_path(file_path)).await;
    let projected = messages::list(ThreadRef::file_path(file_path), None).await;
    let turn_records = turns::list_turns(ThreadRef::file_path(file_path)).await;
    let message_work = queued_for(file_path, WorkOwner::Messages);
    let turn_work = queued_for(file_path, WorkOwner::Turns);
    match (events, projected, turn_records) {
        (
            OpResult::Ok { value: events },
            OpResult::Ok { value: messages },
            OpResult::Ok { value: turns },
        ) => ReadBack {
            events,
            messages,
            turns,
            message_work,
            turn_work,
        },
        _ => panic!("read-back failed"),
    }
}

/// Below-SDK read of derivation rows — enqueue's pending rows are asserted
/// durably, not through the batch result.
fn raw_form_rows(file_path: &str) -> Vec<(String, String)> {
    let db = open_raw(file_path);
    let rows = db
        .prepare(
            "SELECT subject_kind || '/' || subject_id || '/' || derivation_type AS key, state
             FROM derivation ORDER BY key",
        )
        .all(&[]);
    let out = rows
        .into_iter()
        .map(|row| {
            (
                row.get("key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                row.get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
        })
        .collect();
    db.close();
    out
}

#[tokio::test]
async fn tc_2_7_a_prompt_and_a_tool_result_each_durably_queue_their_kind_owner_messages() {
    let store = temp_store();
    set_intake_clock(Some(Box::new(fixed_system_time)));
    let file_path = create_thread(&store).await;
    let result = send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::ToolResult),
        ],
    )
    .await;

    // The batch result reports both items with full identity.
    assert!(result.queued_work.contains(&QueuedWorkItem {
        work_item_id: "w-m1-prompt_smoothing-v1".into(),
        owner: WorkOwner::Messages,
        kind: WorkKind::PromptSmoothing,
        source_ref: WorkSourceRef::Message {
            message_id: "m1".into(),
        },
    }));
    assert!(result.queued_work.contains(&QueuedWorkItem {
        work_item_id: "w-m2-tool_result_summary-v1".into(),
        owner: WorkOwner::Messages,
        kind: WorkKind::ToolResultSummary,
        source_ref: WorkSourceRef::Message {
            message_id: "m2".into(),
        },
    }));

    // Durable read-back through the owning domain: deterministic ids, status
    // queued, queuedAt from the injected clock.
    assert_eq!(
        queued_for(&file_path, WorkOwner::Messages),
        vec![
            WorkItemRecord {
                work_item_id: "w-m1-prompt_smoothing-v1".into(),
                owner: WorkOwner::Messages,
                kind: WorkKind::PromptSmoothing,
                source_ref: WorkSourceRef::Message {
                    message_id: "m1".into(),
                },
                status: WorkItemRecordStatus::Queued,
                queued_at: FIXED_INSTANT.into(),
            },
            WorkItemRecord {
                work_item_id: "w-m2-tool_result_summary-v1".into(),
                owner: WorkOwner::Messages,
                kind: WorkKind::ToolResultSummary,
                source_ref: WorkSourceRef::Message {
                    message_id: "m2".into(),
                },
                status: WorkItemRecordStatus::Queued,
                queued_at: FIXED_INSTANT.into(),
            },
        ]
    );

    // The prompt opened a turn that is still open: no turn-owned work yet,
    // and each domain reads back only its own items.
    assert_eq!(queued_for(&file_path, WorkOwner::Turns), vec![]);
    assert_eq!(raw_work_item_count(&file_path), 2);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_2_9_text_thinking_and_note_messages_queue_nothing_the_kind_gate_is_exact() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let result = send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::AssistantThinking),
            valid_event_for_kind(EventKind::RuntimeNote),
        ],
    )
    .await;
    assert_eq!(result.queued_work, vec![]);
    assert_eq!(queued_for(&file_path, WorkOwner::Messages), vec![]);
    assert_eq!(queued_for(&file_path, WorkOwner::Turns), vec![]);
    assert_eq!(raw_work_item_count(&file_path), 0);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_2_6_a_mixed_batchs_result_is_complete() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let original = valid_event_for_kind(EventKind::UserPrompt);
    send(&file_path, &[original.clone()]).await;

    let result = send(
        &file_path,
        &[
            original.clone(), // duplicate: skipped
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;

    // TS `expect(result.events).toEqual([..., ..., ...])` — exact length 3.
    assert_eq!(result.events.len(), 3);
    assert_eq!(
        result.events[0],
        BatchEventResult {
            idempotency_key: original.idempotency_key.clone().unwrap(),
            outcome: BatchEventOutcome::Skipped,
            message_id: None,
            skip_reason: Some(BatchSkipReason::DuplicateIdempotencyKey),
        }
    );
    assert_eq!(result.events[1].outcome, BatchEventOutcome::Recorded);
    assert_eq!(result.events[1].message_id.as_deref(), Some("m2"));
    assert_eq!(result.events[2].outcome, BatchEventOutcome::Recorded);
    // turn_end produces no message.
    assert_eq!(result.events[2].message_id, None);
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
        result.queued_work,
        vec![QueuedWorkItem {
            work_item_id: "w-t1-turn_derivation-v1".into(),
            owner: WorkOwner::Turns,
            kind: WorkKind::TurnDerivation,
            source_ref: WorkSourceRef::Turn {
                turn_id: "t1".into(),
            },
        }]
    );
    assert_eq!(
        result.thread_position,
        ThreadPosition {
            last_event_order: 3
        }
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_3_3_work_half_explicit_close_durably_queues_turn_derivation_owner_turns() {
    let store = temp_store();
    set_intake_clock(Some(Box::new(fixed_system_time)));
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

    assert!(result.queued_work.contains(&QueuedWorkItem {
        work_item_id: "w-t1-turn_derivation-v1".into(),
        owner: WorkOwner::Turns,
        kind: WorkKind::TurnDerivation,
        source_ref: WorkSourceRef::Turn {
            turn_id: "t1".into(),
        },
    }));
    assert_eq!(
        queued_for(&file_path, WorkOwner::Turns),
        vec![WorkItemRecord {
            work_item_id: "w-t1-turn_derivation-v1".into(),
            owner: WorkOwner::Turns,
            kind: WorkKind::TurnDerivation,
            source_ref: WorkSourceRef::Turn {
                turn_id: "t1".into(),
            },
            status: WorkItemRecordStatus::Queued,
            queued_at: FIXED_INSTANT.into(),
        }]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_3_6_work_half_implicit_close_queues_the_same_work_item_contract() {
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
    send(&explicit_path, &[valid_event_for_kind(EventKind::TurnEnd)]).await;

    let implicit_path = create_thread(&store).await;
    send(
        &implicit_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
        ],
    )
    .await;
    send(
        &implicit_path,
        &[valid_event_for_kind(EventKind::UserPrompt)],
    )
    .await;

    let explicit_items = queued_for(&explicit_path, WorkOwner::Turns);
    let implicit_items = queued_for(&implicit_path, WorkOwner::Turns);
    assert_eq!(explicit_items.len(), 1);

    // Same item contract modulo queuedAt (wall clock differs between runs).
    fn contract(items: &[WorkItemRecord]) -> Vec<WorkItemRecord> {
        items
            .iter()
            .map(|item| {
                let mut c = item.clone();
                c.queued_at.clear();
                c
            })
            .collect()
    }

    assert_eq!(contract(&implicit_items), contract(&explicit_items));
    assert_eq!(
        contract(&explicit_items),
        vec![WorkItemRecord {
            work_item_id: "w-t1-turn_derivation-v1".into(),
            owner: WorkOwner::Turns,
            kind: WorkKind::TurnDerivation,
            source_ref: WorkSourceRef::Turn {
                turn_id: "t1".into(),
            },
            status: WorkItemRecordStatus::Queued,
            queued_at: String::new(),
        }]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_3_8_work_count_a_multi_turn_batch_queues_one_turn_derivation_item_per_closed_turn() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
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

    let turn_work = queued_for(&file_path, WorkOwner::Turns);
    assert_eq!(
        turn_work
            .iter()
            .map(|item| item.work_item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["w-t1-turn_derivation-v1", "w-t2-turn_derivation-v1"]
    );
    assert!(
        turn_work
            .iter()
            .all(|item| item.kind == WorkKind::TurnDerivation)
    );
    assert!(
        turn_work
            .iter()
            .all(|item| item.status == WorkItemRecordStatus::Queued)
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn tc_5_4_no_work_item_clause_a_skipped_event_queues_nothing() {
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
    send(&file_path, &[valid_event_for_kind(EventKind::UserPrompt)]).await; // t2 now open
    let baseline = read_back(&file_path).await;
    let baseline_count = raw_work_item_count(&file_path);

    let resend = send(&file_path, &[prompt, end]).await;
    assert_eq!(
        resend
            .events
            .iter()
            .map(|entry| entry.outcome)
            .collect::<Vec<_>>(),
        vec![BatchEventOutcome::Skipped, BatchEventOutcome::Skipped]
    );
    assert_eq!(resend.queued_work, vec![]);
    assert_eq!(read_back(&file_path).await, baseline);
    assert_eq!(raw_work_item_count(&file_path), baseline_count);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn restart_survival_a_reopened_thread_file_holds_its_work_items_intact() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::ToolCall),
            valid_event_for_kind(EventKind::ToolResult),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    let before = read_back(&file_path).await;
    assert_eq!(before.message_work.len(), 2);
    assert_eq!(before.turn_work.len(), 1);

    // Every SDK operation opens and closes its own handle, so a fresh
    // read-back is a real reopen of the real file. The raw scan proves the
    // rows live in the thread file itself — not an in-memory queue.
    let db = open_raw(&file_path);
    let rows = db
        .prepare("SELECT work_item_id, status FROM work_item ORDER BY work_item_id")
        .all(&[]);
    assert_eq!(
        rows.iter()
            .map(|r| {
                (
                    r.get("work_item_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    r.get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            })
            .collect::<Vec<_>>(),
        vec![
            ("w-m1-prompt_smoothing-v1".into(), "queued".into(),),
            ("w-m3-tool_result_summary-v1".into(), "queued".into(),),
            ("w-t1-turn_derivation-v1".into(), "queued".into()),
        ]
    );
    db.close();
    assert_eq!(read_back(&file_path).await, before);
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn complete_surface_rollback_a_rejected_batch_leaves_records_at_baseline() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::ToolResult),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    let baseline = read_back(&file_path).await;
    let baseline_count = raw_work_item_count(&file_path);

    // A valid prefix that would queue work, then one invalid event: the
    // batch must reject whole and queue nothing.
    let mut bogus = valid_event_for_kind(EventKind::UserPrompt);
    bogus.event_kind = "bogus".into();
    let rejected = intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[valid_event_for_kind(EventKind::UserPrompt), bogus],
    )
    .await;
    assert!(!rejected.is_ok());
    if let OpResult::Err { error } = rejected {
        assert_eq!(error.code, ErrorCode::InvalidEvent);
    }

    assert_eq!(read_back(&file_path).await, baseline);
    assert_eq!(raw_work_item_count(&file_path), baseline_count);
    cleanup_seams();
    store.cleanup();
}

// ── Story 0 (Epic 02): work-kind registry, handler-map assembly, and the
// enqueue wrapper's atomicity.

#[test]
fn the_registry_covers_all_six_kinds_with_owner_and_sourceref_semantics() {
    assert_eq!(
        work_kind_registry(WorkKind::PromptSmoothing),
        WorkKindRegistryEntry {
            owner: WorkOwner::Messages,
            source_ref_key: SourceRefKey::MessageId,
        }
    );
    assert_eq!(
        work_kind_registry(WorkKind::ToolResultSummary),
        WorkKindRegistryEntry {
            owner: WorkOwner::Messages,
            source_ref_key: SourceRefKey::MessageId,
        }
    );
    assert_eq!(
        work_kind_registry(WorkKind::TurnDerivation),
        WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::TurnId,
        }
    );
    assert_eq!(
        work_kind_registry(WorkKind::DetailedTurnCompression),
        WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::TurnId,
        }
    );
    assert_eq!(
        work_kind_registry(WorkKind::ChunkSummaryDetailed),
        WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::ChunkId,
        }
    );
    assert_eq!(
        work_kind_registry(WorkKind::ChunkSummaryBrief),
        WorkKindRegistryEntry {
            owner: WorkOwner::Turns,
            source_ref_key: SourceRefKey::ChunkId,
        }
    );
}

#[test]
fn dispatcher_lookup_reports_an_unregistered_kind_as_a_structured_miss() {
    let dispatcher: DurableWorkDispatcher = Arc::new(|_run, _item| {
        Box::pin(async {
            DurableWorkDispatchResult::Settled {
                disposition: DurableWorkSettledDisposition::Done,
            }
        })
    });
    let mut map = std::collections::HashMap::new();
    map.insert(
        lhc::shared_tech::durable_work::DurableWorkOperationName::MessagesDerive,
        dispatcher,
    );
    let op = DurableWorkOperation::MessagesDerive {
        message_id: "m1".into(),
    };
    let found = lookup_work_dispatcher(&map, Some(&op), "prompt_smoothing");
    assert!(found.is_ok());
    let missed = lookup_work_dispatcher(&std::collections::HashMap::new(), Some(&op), "bogus_kind");
    assert!(!missed.is_ok());
    if let OpResult::Err { error } = missed {
        assert_eq!(error.error_class, ErrorClass::StateCorruption);
        assert_eq!(error.code, ErrorCode::UnknownWorkKind);
        assert!(error.reason.contains("bogus_kind"));
    }
}

fn noop_work_handler() -> WorkHandler {
    Arc::new(|_run, _item| {
        Box::pin(async {
            HandlerOutcome::Ok {
                derivations: None,
                on_applied: None,
            }
        })
    })
}

#[test]
fn assembly_merges_per_domain_tables_dispatch_finds_a_handler_and_a_doubly_claimed_kind_is_refused()
{
    let handler = noop_work_handler();
    let mut g1 = IndexMap::new();
    g1.insert(WorkKind::PromptSmoothing, Arc::clone(&handler));
    let mut g2 = IndexMap::new();
    g2.insert(WorkKind::TurnDerivation, Arc::clone(&handler));
    let map = map_work_q_handlers(&[g1, g2]);
    let found = lookup_work_handler(&map, "prompt_smoothing");
    assert!(found.is_ok());
    if let OpResult::Ok { value } = found {
        // TS `expect(found.value).toBe(handler)` — same Arc registration identity.
        assert!(Arc::ptr_eq(&value, &handler));
    }
    let missed = lookup_work_handler(&map, "chunk_summary_brief");
    assert!(!missed.is_ok());
    // One owner per kind: a second table claiming the same kind is a wiring
    // bug surfaced at construction (TS `toThrow(/prompt_smoothing/)`).
    let mut d1 = IndexMap::new();
    d1.insert(WorkKind::PromptSmoothing, noop_work_handler());
    let mut d2 = IndexMap::new();
    d2.insert(WorkKind::PromptSmoothing, noop_work_handler());
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        map_work_q_handlers(&[d1, d2]);
    }));
    let Err(payload) = refused else {
        panic!("expected duplicate kind registration to refuse");
    };
    let msg = payload
        .downcast_ref::<String>()
        .map(|s| s.as_str())
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(
        msg.contains("prompt_smoothing"),
        "duplicate-kind refusal must name the kind; got {msg:?}"
    );
}

#[tokio::test]
async fn a_committed_intake_batch_durably_writes_work_rows_pending_forms_and_pokes_once_per_enqueue()
 {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let pokes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let pokes_for_seam = Arc::clone(&pokes);
    set_scheduler_poke(Some(Box::new(move |thread_id| {
        pokes_for_seam
            .lock()
            .expect("pokes")
            .push(thread_id.to_string());
    })));

    let result = send(
        &file_path,
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
            valid_event_for_kind(EventKind::TurnEnd),
        ],
    )
    .await;
    // Two enqueues (prompt smoothing + turn derivation) → two pokes, both
    // carrying the thread's resolved id, fired only after COMMIT.
    let poke_list = pokes.lock().expect("pokes").clone();
    assert_eq!(poke_list.len(), 2);
    assert_eq!(
        poke_list
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        1
    );
    assert!(poke_list[0].starts_with("th_"));
    assert_eq!(result.queued_work.len(), 2);

    // The pending state rows rode the same transaction (DD-5): one for the
    // prompt's derivation, two for the turn's rendering + pre-detailed assembly.
    assert_eq!(
        raw_form_rows(&file_path),
        vec![
            ("message/m1/smoothed_prompt".into(), "pending".into()),
            ("turn/t1/pre_detailed_assembly".into(), "pending".into()),
            ("turn/t1/turn_rendering".into(), "pending".into()),
        ]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn an_induced_rollback_after_enqueue_drops_the_work_row_form_row_and_poke() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let pokes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let pokes_for_seam = Arc::clone(&pokes);
    set_scheduler_poke(Some(Box::new(move |thread_id| {
        pokes_for_seam
            .lock()
            .expect("pokes")
            .push(thread_id.to_string());
    })));

    // The prompt's enqueue has already run inside the walk when the hook
    // fires on the second event and rejects the batch (production rollback
    // path, same seam Epic 01's atomicity tests use).
    // Hook remains a void callback; its panic is the Rust mapping of TS
    // `throw new Error(...)` — catch/assert, do not discard the transaction result.
    set_intake_walk_hook(Some(Box::new(|_db, event_index| {
        if event_index == 1 {
            panic!("induced mid-walk failure after enqueue");
        }
    })));
    let rejected = AssertUnwindSafe(intake_stream::message_events(
        ThreadRef::file_path(&file_path),
        &[
            valid_event_for_kind(EventKind::UserPrompt),
            valid_event_for_kind(EventKind::AssistantText),
        ],
    ))
    .catch_unwind()
    .await;
    match rejected {
        Ok(OpResult::Err { error }) => {
            assert!(
                error
                    .reason
                    .contains("induced mid-walk failure after enqueue"),
                "expected hook panic mapped into OpResult::Err; got {}",
                error.reason
            );
        }
        Err(payload) => {
            let msg = payload
                .downcast_ref::<String>()
                .map(|s| s.as_str())
                .or_else(|| payload.downcast_ref::<&str>().copied())
                .unwrap_or("");
            assert!(
                msg.contains("induced mid-walk failure after enqueue"),
                "expected walk-hook panic message; got {msg:?}"
            );
        }
        Ok(OpResult::Ok { .. }) => panic!("expected batch rejection from walk-hook failure"),
    }

    assert_eq!(raw_work_item_count(&file_path), 0);
    assert_eq!(raw_form_rows(&file_path), vec![]);
    assert_eq!(*pokes.lock().expect("pokes"), Vec::<String>::new());
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn enqueue_via_create_db_write_transaction_rollback_drops_effects_commit_lands_them() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let pokes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let pokes_for_seam = Arc::clone(&pokes);
    set_scheduler_poke(Some(Box::new(move |thread_id| {
        pokes_for_seam
            .lock()
            .expect("pokes")
            .push(thread_id.to_string());
    })));
    let clock = || fixed_system_time();

    // Rollback leg: the body enqueues, then throws (TS `.rejects.toThrow("induced rollback")`).
    let rolled = AssertUnwindSafe(create_db_write_transaction(
        ThreadRef::file_path(&file_path),
        |transaction| {
            Box::pin(async move {
                enqueue(
                    transaction,
                    EnqueueInput {
                        owner: WorkOwner::Turns,
                        kind: WorkKind::ChunkSummaryBrief,
                        source_ref: WorkSourceRef::Chunk {
                            chunk_id: "c1".into(),
                        },
                        derivations: vec![EnqueueDerivationTarget {
                            subject_kind: SubjectKind::Chunk,
                            subject_id: "c1".into(),
                            derivation_type: "chunk_summary_brief".into(),
                        }],
                        operation: None,
                        source_version: None,
                    },
                );
                panic!("induced rollback");
            })
        },
        Some(Box::new(clock)),
    ))
    .catch_unwind()
    .await;
    let Err(payload) = rolled else {
        panic!("expected induced rollback panic");
    };
    let msg = payload
        .downcast_ref::<String>()
        .map(|s| s.as_str())
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(
        msg.contains("induced rollback"),
        "rollback reason must contain 'induced rollback'; got {msg:?}"
    );
    // Exact database change counts after rollback (work row, form row, poke).
    assert_eq!(raw_work_item_count(&file_path), 0);
    assert_eq!(raw_form_rows(&file_path), vec![]);
    assert_eq!(*pokes.lock().expect("pokes"), Vec::<String>::new());

    // Commit leg: same enqueue, no failure — and the poke fires after the
    // body, not inside it.
    let pokes_check = Arc::clone(&pokes);
    let committed = create_db_write_transaction(
        ThreadRef::file_path(&file_path),
        |transaction| {
            let pokes_check = Arc::clone(&pokes_check);
            Box::pin(async move {
                let record = enqueue(
                    transaction,
                    EnqueueInput {
                        owner: WorkOwner::Turns,
                        kind: WorkKind::ChunkSummaryBrief,
                        source_ref: WorkSourceRef::Chunk {
                            chunk_id: "c1".into(),
                        },
                        derivations: vec![EnqueueDerivationTarget {
                            subject_kind: SubjectKind::Chunk,
                            subject_id: "c1".into(),
                            derivation_type: "chunk_summary_brief".into(),
                        }],
                        operation: None,
                        source_version: None,
                    },
                );
                assert_eq!(*pokes_check.lock().expect("pokes"), Vec::<String>::new());
                record
            })
        },
        Some(Box::new(clock)),
    )
    .await;
    assert!(committed.is_ok());
    if let OpResult::Ok { value } = committed {
        assert_eq!(value.work_item_id, "w-c1-chunk_summary_brief-v1");
    }
    let poke_list = pokes.lock().expect("pokes").clone();
    assert_eq!(poke_list.len(), 1);
    assert!(poke_list[0].starts_with("th_"));
    assert_eq!(
        raw_form_rows(&file_path),
        vec![("chunk/c1/chunk_summary_brief".into(), "pending".into())]
    );
    cleanup_seams();
    store.cleanup();
}

#[tokio::test]
async fn re_enqueueing_at_a_later_source_version_resets_the_form_row_to_pending() {
    let store = temp_store();
    let file_path = create_thread(&store).await;
    let clock = || fixed_system_time();

    let queued = create_db_write_transaction(
        ThreadRef::file_path(&file_path),
        |transaction| {
            Box::pin(async move {
                enqueue(
                    transaction,
                    EnqueueInput {
                        owner: WorkOwner::Messages,
                        kind: WorkKind::PromptSmoothing,
                        source_ref: WorkSourceRef::Message {
                            message_id: "mx".into(),
                        },
                        derivations: vec![EnqueueDerivationTarget {
                            subject_kind: SubjectKind::Message,
                            subject_id: "mx".into(),
                            derivation_type: "smoothed_prompt".into(),
                        }],
                        operation: None,
                        source_version: None,
                    },
                );
            })
        },
        Some(Box::new(clock)),
    )
    .await;
    assert!(queued.is_ok());

    // Versioned ids let the replacement coexist with (not collide into)
    // the version-1 item (DD-1/DD-3).
    let replacement = create_db_write_transaction(
        ThreadRef::file_path(&file_path),
        |transaction| {
            Box::pin(async move {
                enqueue(
                    transaction,
                    EnqueueInput {
                        owner: WorkOwner::Messages,
                        kind: WorkKind::PromptSmoothing,
                        source_ref: WorkSourceRef::Message {
                            message_id: "mx".into(),
                        },
                        derivations: vec![EnqueueDerivationTarget {
                            subject_kind: SubjectKind::Message,
                            subject_id: "mx".into(),
                            derivation_type: "smoothed_prompt".into(),
                        }],
                        operation: None,
                        source_version: Some(2),
                    },
                )
            })
        },
        Some(Box::new(clock)),
    )
    .await;
    assert!(replacement.is_ok());
    if let OpResult::Ok { value } = replacement {
        assert_eq!(value.work_item_id, "w-mx-prompt_smoothing-v2");
    }
    let forms = read_derived_forms(&file_path);
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0].subject_kind, SubjectKind::Message);
    assert_eq!(forms[0].subject_id, "mx");
    assert_eq!(forms[0].derivation_type, "smoothed_prompt");
    assert_eq!(
        forms[0].state,
        lhc::shared_tech::derivation::DerivationState::Pending
    );
    assert_eq!(forms[0].source_version, 2);
    assert_eq!(raw_work_item_count(&file_path), 2);
    cleanup_seams();
    store.cleanup();
}

// Silence unused import warning for kind::* helpers reserved for payload overrides.
#[allow(dead_code)]
fn _kind_token_anchor() {
    let _ = kind::USER_PROMPT;
    let _ = valid_event::<UserPromptOverrides>;
}

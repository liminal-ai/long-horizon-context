//! Ported from packages/lhc/test/fixtures/work-handlers.ts.
//!
//! Story 1's registered test handlers: one per work kind. Types, closed
//! [`WorkKind`] vocab, and callback signatures are REAL. Behavior bodies match
//! the TS fixture (Wave 2).
//!
//! Python traps avoided: no `make_` rename; `onApplied` uses [`CompletionTx`]
//! (not an invented tx bag); no `Value` widening for kind/sourceRef; closed
//! [`WorkKind`] / [`DerivationType`] / inference subject vocab.

#![allow(dead_code)] // private helpers + hooks surface land ahead of suite call sites

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde_json::json;

use lhc::sdk::{Lhc, TestingWorkRegistration, register_testing_work};
use lhc::shared_tech::derivation::{
    BoxFuture, CompletionTx, CompressDetailedTurnInput, HandlerDerivationWrite, HandlerOutcome,
    HandlerRunContext, InferenceCallbacks, InferenceResult, SmoothPromptInput, SubjectKind,
    SummarizeChunkBriefInput, SummarizeToolResultInput, WorkHandler, WorkItemRef,
};
use lhc::shared_tech::deterministic::{DeterministicOpName, deterministic_text};
use lhc::shared_tech::durable_work::{
    ApplyDerivationSuccessDisposition, DerivationAttempt, DurableWorkDispatchResult,
    DurableWorkDispatcher, DurableWorkDispatcherMap, DurableWorkOperationName,
    DurableWorkSettledDisposition, apply_derivation_success,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::persist::{DbWriteTransaction, PostCommitHook};
use lhc::shared_tech::work_queue::{
    EnqueueDerivationTarget, EnqueueInput, WorkHandlerMap, WorkKind, WorkOwner, WorkSourceRef,
    enqueue,
};

use super::model_call::DerivationType;

/// Closed fixture work-kind list (TS `WORK_KINDS`). Insertion order matches TS.
const WORK_KINDS: &[WorkKind] = &[
    WorkKind::PromptSmoothing,
    WorkKind::ToolResultSummary,
    WorkKind::TurnDerivation,
    WorkKind::DetailedTurnCompression,
    WorkKind::ChunkSummaryDetailed,
    WorkKind::ChunkSummaryBrief,
];

/// TS `onHandlerStart` item: `{ workItemId; kind }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestHandlerStartItem {
    pub work_item_id: String,
    pub kind: String,
}

/// TS `TestHandlerHooks` — optional async `onHandlerStart`.
///
/// `Arc` so [`register_test_work_handlers`] can hand the same hooks to both
/// the handlers map and the dispatchers map (TS object reference sharing).
#[derive(Clone, Default)]
pub struct TestHandlerHooks {
    /// Fires when a handler begins running an item — i.e. after the item's
    /// claim committed and any earlier item's completion landed.
    pub on_handler_start: Option<Arc<dyn Fn(TestHandlerStartItem) -> BoxFuture<()> + Send + Sync>>,
}

/// TS `onApplied` callback — completion-tx hook (shared-tech [`CompletionTx`]).
type OnAppliedFn = Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>;

/// TS `deriveForTestWork` result union.
enum DeriveForTestWorkResult {
    Ok {
        derivations: Vec<HandlerDerivationWrite>,
        on_applied: Option<OnAppliedFn>,
    },
    Err {
        reason: String,
    },
}

/// TS `inferenceWrite` subjectKind: `"message" | "chunk"` — closed, no Turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InferenceWriteSubjectKind {
    Message,
    Chunk,
}

/// TS `inferenceWrite` result union.
enum InferenceWriteResult {
    Ok {
        derivations: Vec<HandlerDerivationWrite>,
    },
    Err {
        reason: String,
    },
}

/// TS `Date.prototype.toISOString()` — UTC with millisecond precision.
fn system_time_to_iso(time: SystemTime) -> String {
    let ms = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64;
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Howard Hinnant civil_from_days (days since Unix epoch → Y-M-D).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

fn map_success_disposition(d: ApplyDerivationSuccessDisposition) -> DurableWorkSettledDisposition {
    match d {
        ApplyDerivationSuccessDisposition::Done => DurableWorkSettledDisposition::Done,
        ApplyDerivationSuccessDisposition::StaleDiscarded => {
            DurableWorkSettledDisposition::StaleDiscarded
        }
        ApplyDerivationSuccessDisposition::LostLease => DurableWorkSettledDisposition::LostLease,
    }
}

fn source_ref_to_index_map(source_ref: &WorkSourceRef) -> IndexMap<String, String> {
    let mut map = IndexMap::new();
    match source_ref {
        WorkSourceRef::Message { message_id } => {
            map.insert("messageId".to_string(), message_id.clone());
        }
        WorkSourceRef::Turn { turn_id } => {
            map.insert("turnId".to_string(), turn_id.clone());
        }
        WorkSourceRef::Chunk { chunk_id } => {
            map.insert("chunkId".to_string(), chunk_id.clone());
        }
    }
    map
}

/// Build a synthetic [`DbWriteTransaction`] over a borrowed [`CompletionTx`] db
/// (TS structural `{ db, onCommit, ... }` bag) and run `body`. The completion
/// controller owns the connection; the bag only borrows `&Db`.
fn with_completion_write_txn<R>(
    tx: CompletionTx<'_>,
    thread_id: String,
    file_path: String,
    clock: lhc::shared_tech::derivation::Clock,
    body: impl FnOnce(&DbWriteTransaction<'_>) -> R,
) -> R {
    let CompletionTx { db, on_commit } = tx;
    let txn = DbWriteTransaction {
        db,
        thread_id,
        file_path,
        clock,
        post_commit_hook: PostCommitHook {
            add: Box::new(move |op| on_commit(op)),
        },
        poke: Arc::new(|_thread_id: &str| {}),
    };
    body(&txn)
}

/// TS `testWorkHandlers`.
pub fn test_work_handlers(
    inference_callbacks: InferenceCallbacks,
    hooks: Option<TestHandlerHooks>,
) -> WorkHandlerMap {
    let hooks = hooks.unwrap_or_default();
    let mut map = IndexMap::new();
    for &kind in WORK_KINDS {
        let inference_callbacks = inference_callbacks.clone();
        let hooks = hooks.clone();
        let handler: WorkHandler = Arc::new(move |run, item| {
            let inference_callbacks = inference_callbacks.clone();
            let hooks = hooks.clone();
            Box::pin(async move {
                if let Some(ref on_start) = hooks.on_handler_start {
                    on_start(TestHandlerStartItem {
                        work_item_id: item.work_item_id.clone(),
                        kind: item.kind.clone(),
                    })
                    .await;
                }
                let source_id = item
                    .source_ref
                    .get("messageId")
                    .or_else(|| item.source_ref.get("turnId"))
                    .or_else(|| item.source_ref.get("chunkId"))
                    .cloned();
                let Some(source_id) = source_id else {
                    return HandlerOutcome::Failed {
                        reason: "test handler: unrecognized sourceRef".to_string(),
                    };
                };
                match derive_for_test_work(run, kind, inference_callbacks, source_id).await {
                    DeriveForTestWorkResult::Ok {
                        derivations,
                        on_applied,
                    } => HandlerOutcome::Ok {
                        derivations: Some(derivations),
                        on_applied,
                    },
                    DeriveForTestWorkResult::Err { reason } => HandlerOutcome::Failed { reason },
                }
            })
        });
        map.insert(kind, handler);
    }
    map
}

/// TS `testWorkDispatchers`.
///
/// Exported from work-handlers.ts but not the fixtures barrel (`index.ts`).
pub fn test_work_dispatchers(
    inference_callbacks: InferenceCallbacks,
    hooks: Option<TestHandlerHooks>,
) -> DurableWorkDispatcherMap {
    let handlers = Arc::new(test_work_handlers(inference_callbacks, hooks));
    let mut map = HashMap::new();
    map.insert(
        DurableWorkOperationName::MessagesDerive,
        wrap_from_item(Arc::clone(&handlers)),
    );
    map.insert(
        DurableWorkOperationName::TurnsDeriveTurn,
        wrap(WorkKind::TurnDerivation, Arc::clone(&handlers)),
    );
    map.insert(
        DurableWorkOperationName::TurnsDeriveDetailedTurnCompression,
        wrap(WorkKind::DetailedTurnCompression, Arc::clone(&handlers)),
    );
    map.insert(
        DurableWorkOperationName::TurnsDeriveDetailedChunk,
        wrap(WorkKind::ChunkSummaryDetailed, Arc::clone(&handlers)),
    );
    map.insert(
        DurableWorkOperationName::TurnsDeriveBriefChunk,
        wrap(WorkKind::ChunkSummaryBrief, handlers),
    );
    map
}

/// TS `registerTestWorkHandlers`.
pub fn register_test_work_handlers(
    sdk: &Lhc,
    inference_callbacks: InferenceCallbacks,
    hooks: Option<TestHandlerHooks>,
) {
    register_testing_work(
        sdk,
        TestingWorkRegistration {
            handlers: Some(test_work_handlers(
                inference_callbacks.clone(),
                hooks.clone(),
            )),
            dispatchers: Some(test_work_dispatchers(inference_callbacks, hooks)),
        },
    );
}

/// TS private `deriveForTestWork`.
async fn derive_for_test_work(
    run: HandlerRunContext,
    kind: WorkKind,
    inference_callbacks: InferenceCallbacks,
    source_id: String,
) -> DeriveForTestWorkResult {
    match kind {
        WorkKind::PromptSmoothing => {
            let result = (inference_callbacks.smooth_prompt)(SmoothPromptInput {
                text: format!("prompt:{source_id}"),
            })
            .await;
            match inference_write(
                InferenceWriteSubjectKind::Message,
                source_id,
                DerivationType::SmoothedPrompt,
                result,
            ) {
                InferenceWriteResult::Ok { derivations } => DeriveForTestWorkResult::Ok {
                    derivations,
                    on_applied: None,
                },
                InferenceWriteResult::Err { reason } => DeriveForTestWorkResult::Err { reason },
            }
        }
        WorkKind::ToolResultSummary => {
            let result = (inference_callbacks.summarize_tool_result)(SummarizeToolResultInput {
                tool_name: "fixture".to_string(),
                content: format!("result:{source_id}"),
                outcome: None,
                target_tokens: None,
                operation_class: None,
                response_shape: None,
                prompt_mode: None,
                facts: None,
            })
            .await;
            match inference_write(
                InferenceWriteSubjectKind::Message,
                source_id,
                DerivationType::ToolResultSummary,
                result,
            ) {
                InferenceWriteResult::Ok { derivations } => DeriveForTestWorkResult::Ok {
                    derivations,
                    on_applied: None,
                },
                InferenceWriteResult::Err { reason } => DeriveForTestWorkResult::Err { reason },
            }
        }
        WorkKind::TurnDerivation => {
            let rendering_input = json!({
                "parts": [{
                    "messageId": source_id,
                    "kind": "user_prompt",
                    "text": format!("turn:{source_id}"),
                    "fallback": false,
                }]
            });
            let rendering_text = deterministic_text(
                DeterministicOpName::CompressDetailedTurn,
                &rendering_input,
                &format!("turn:{source_id}"),
            );
            let assembly_text = format!("User:\nturn:{source_id}\n\n⏺ findings for {source_id}");
            let thread_id = run.thread_id.clone();
            let file_path = run.file_path.clone();
            let clock = Arc::clone(&run.clock);
            let enqueue_source_id = source_id.clone();
            DeriveForTestWorkResult::Ok {
                derivations: vec![
                    HandlerDerivationWrite {
                        subject_kind: SubjectKind::Turn,
                        subject_id: source_id.clone(),
                        derivation_type: DerivationType::TurnRendering.as_str().to_string(),
                        content: rendering_text,
                        metadata: None,
                        gaps: None,
                    },
                    HandlerDerivationWrite {
                        subject_kind: SubjectKind::Turn,
                        subject_id: source_id,
                        derivation_type: DerivationType::PreDetailedAssembly.as_str().to_string(),
                        content: assembly_text,
                        metadata: None,
                        gaps: None,
                    },
                ],
                on_applied: Some(Box::new(move |tx: CompletionTx<'_>| {
                    with_completion_write_txn(tx, thread_id, file_path, clock, |transaction| {
                        enqueue(
                            transaction,
                            EnqueueInput {
                                owner: WorkOwner::Turns,
                                kind: WorkKind::DetailedTurnCompression,
                                source_ref: WorkSourceRef::Turn {
                                    turn_id: enqueue_source_id.clone(),
                                },
                                source_version: Some(1),
                                derivations: vec![EnqueueDerivationTarget {
                                    subject_kind: SubjectKind::Turn,
                                    subject_id: enqueue_source_id.clone(),
                                    derivation_type: DerivationType::DetailedTurnCompression
                                        .as_str()
                                        .to_string(),
                                }],
                                operation: None,
                            },
                        );
                    });
                })),
            }
        }
        WorkKind::DetailedTurnCompression => {
            let assembly_text = format!("User:\nturn:{source_id}\n\n⏺ findings for {source_id}");
            let compression =
                (inference_callbacks.compress_detailed_turn)(CompressDetailedTurnInput {
                    dialogue_text: assembly_text,
                    input_tokens: 10,
                    target_min_tokens: 4,
                    target_aim_tokens: 5,
                    target_max_tokens: 7,
                })
                .await;
            match compression {
                InferenceResult::Ok { text, .. } => DeriveForTestWorkResult::Ok {
                    derivations: vec![HandlerDerivationWrite {
                        subject_kind: SubjectKind::Turn,
                        subject_id: source_id,
                        derivation_type: DerivationType::DetailedTurnCompression
                            .as_str()
                            .to_string(),
                        content: text,
                        metadata: None,
                        gaps: None,
                    }],
                    on_applied: None,
                },
                InferenceResult::Err { reason, .. } => DeriveForTestWorkResult::Err { reason },
            }
        }
        WorkKind::ChunkSummaryDetailed => {
            let member_projections = vec![format!("chunk:{source_id}")];
            let joined = member_projections.join(" | ");
            let input = json!({ "memberProjections": member_projections });
            DeriveForTestWorkResult::Ok {
                derivations: vec![HandlerDerivationWrite {
                    subject_kind: SubjectKind::Chunk,
                    subject_id: source_id,
                    derivation_type: DerivationType::ChunkSummaryDetailed.as_str().to_string(),
                    content: deterministic_text(
                        DeterministicOpName::SummarizeChunkBrief,
                        &input,
                        &joined,
                    ),
                    metadata: None,
                    gaps: None,
                }],
                on_applied: None,
            }
        }
        WorkKind::ChunkSummaryBrief => {
            let result = (inference_callbacks.summarize_chunk_brief)(SummarizeChunkBriefInput {
                text: format!("chunk:{source_id}"),
                input_tokens: 10,
                target_min_tokens: 1,
                target_aim_tokens: 2,
                target_max_tokens: 3,
            })
            .await;
            match inference_write(
                InferenceWriteSubjectKind::Chunk,
                source_id,
                DerivationType::ChunkSummaryBrief,
                result,
            ) {
                InferenceWriteResult::Ok { derivations } => DeriveForTestWorkResult::Ok {
                    derivations,
                    on_applied: None,
                },
                InferenceWriteResult::Err { reason } => DeriveForTestWorkResult::Err { reason },
            }
        }
    }
}

/// TS private `inferenceWrite`.
fn inference_write(
    subject_kind: InferenceWriteSubjectKind,
    subject_id: String,
    derivation_type: DerivationType,
    result: InferenceResult,
) -> InferenceWriteResult {
    match result {
        InferenceResult::Err { reason, .. } => InferenceWriteResult::Err { reason },
        InferenceResult::Ok { text, .. } => InferenceWriteResult::Ok {
            derivations: vec![HandlerDerivationWrite {
                subject_kind: match subject_kind {
                    InferenceWriteSubjectKind::Message => SubjectKind::Message,
                    InferenceWriteSubjectKind::Chunk => SubjectKind::Chunk,
                },
                subject_id,
                derivation_type: derivation_type.as_str().to_string(),
                content: text,
                metadata: None,
                gaps: None,
            }],
        },
    }
}

/// TS private `wrap` closure factory.
fn wrap(kind: WorkKind, handlers: Arc<WorkHandlerMap>) -> DurableWorkDispatcher {
    Arc::new(move |run, item| {
        let handlers = Arc::clone(&handlers);
        Box::pin(async move {
            let Some(handler) = handlers.get(&kind) else {
                return DurableWorkDispatchResult::Failed {
                    reason: "missing_test_handler".to_string(),
                };
            };
            // HandlerRunContext is not Clone; keep open_db/clock for completion.
            let open_db = Arc::clone(&run.open_db);
            let clock = Arc::clone(&run.clock);
            let outcome = handler(
                run,
                WorkItemRef {
                    work_item_id: item.work_item_id.clone(),
                    kind: kind.as_str().to_string(),
                    source_ref: source_ref_to_index_map(&item.source_ref),
                },
            )
            .await;
            match outcome {
                HandlerOutcome::Ok {
                    derivations,
                    on_applied,
                } => {
                    let db = match open_db() {
                        OpResult::Ok { value } => value,
                        OpResult::Err { error } => {
                            return DurableWorkDispatchResult::Failed {
                                reason: error.reason,
                            };
                        }
                    };
                    let derived_at = system_time_to_iso(clock());
                    let writes = derivations.unwrap_or_default();
                    // TS try/finally: completion work then explicit close on
                    // success or panic (do not suppress close via `let _ = db`).
                    let apply_result = catch_unwind(AssertUnwindSafe(|| {
                        apply_derivation_success(
                            &db,
                            &DerivationAttempt {
                                source_version: item.source_version,
                                derivations: item.derivations.clone(),
                                work_item_id: Some(item.work_item_id.clone()),
                            },
                            &writes,
                            &derived_at,
                            on_applied,
                        )
                    }));
                    let close_result = catch_unwind(AssertUnwindSafe(|| db.close()));
                    match apply_result {
                        Ok(disposition) => {
                            if let Err(close_panic) = close_result {
                                resume_unwind(close_panic);
                            }
                            DurableWorkDispatchResult::Settled {
                                disposition: map_success_disposition(disposition),
                            }
                        }
                        Err(apply_panic) => {
                            let _ = close_result;
                            resume_unwind(apply_panic);
                        }
                    }
                }
                HandlerOutcome::Deferred { .. } => DurableWorkDispatchResult::Failed {
                    reason: "unsupported_deferred_test_handler".to_string(),
                },
                HandlerOutcome::Blocked { reason } => DurableWorkDispatchResult::Blocked { reason },
                HandlerOutcome::Failed { reason } => DurableWorkDispatchResult::Failed { reason },
            }
        })
    })
}

/// TS private `wrapFromItem`.
fn wrap_from_item(handlers: Arc<WorkHandlerMap>) -> DurableWorkDispatcher {
    Arc::new(move |run, item| {
        let handlers = Arc::clone(&handlers);
        Box::pin(async move {
            let Some(kind) = WorkKind::from_wire(&item.kind) else {
                return DurableWorkDispatchResult::Failed {
                    reason: "missing_test_handler".to_string(),
                };
            };
            if !handlers.contains_key(&kind) {
                return DurableWorkDispatchResult::Failed {
                    reason: "missing_test_handler".to_string(),
                };
            }
            wrap(kind, handlers)(run, item).await
        })
    })
}

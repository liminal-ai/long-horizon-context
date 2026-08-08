//! Ported from packages/lhc/test/inspect-view.test.ts. Phase 1.
//!
//! Story 3 (Epic 04), default suite: TC-2.1–2.3 — view-contents report +
//! describe legs. 6 semantic tests.

mod fixtures;

use std::collections::HashMap;
use std::sync::Arc;

use fixtures::{
    AssistantTextOverrides, AssistantTextPayload, DerivedThreadFixture, DerivedThreadOptions,
    TempStore, ToolCallOverrides, ToolCallPayload, ToolResultOverrides, ToolResultPayload,
    TurnEndOverrides, UserPromptOverrides, UserPromptPayload, create_inference_callbacks_double,
    derived_thread_fixture, expect_read_only, kind, open_raw, seed_view_boundary, temp_store,
    valid_event,
};
use indexmap::IndexMap;
use lhc::messages::{EditInput, MessageKind};
use lhc::shared_tech::derivation::{
    BoxFuture, CompressDetailedTurnInput, InferenceCallbacks, InferenceResult, SdkConfig, SdkMode,
    SmoothPromptInput, SummarizeChunkBriefInput, SummarizeToolResultInput,
};
use lhc::shared_tech::errors::{ErrorClass, ErrorCode, OpResult};
use lhc::shared_tech::inspect::{
    ViewContentsBand, ViewContentsBandEntry, ViewContentsGap, ViewContentsMeta,
    ViewContentsMetaConfig, ViewContentsReport,
};
use lhc::shared_tech::token_counting::estimate_tokens;
use lhc::shared_tech::view::{
    Band, LlmRequestContext, LlmRequestContextMessage, PartialViewProfilePercentages,
    PartialVisibilityBudgets, SdkViewConfig, StoredView, StoredViewArrangementEntry,
    StoredViewBand, StoredViewConfig, StoredViewGap, StoredViewSourceState, ViewCompactParams,
};
use lhc::thread_view::CompactOpts;
use lhc::threads::{NewThreadInput, ThreadRef};
use lhc::{Lhc, init_lhc};

struct Cleanup {
    store: TempStore,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.store.cleanup();
    }
}

fn setup() -> Cleanup {
    Cleanup {
        store: temp_store(),
    }
}

fn result_value<T>(result: OpResult<T>) -> T {
    match result {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("expected ok result: {:?}", error),
    }
}

fn served_text(message: &LlmRequestContextMessage) -> String {
    message
        .content
        .iter()
        .map(|part| part.text.as_str())
        .collect::<Vec<_>>()
        .join("")
}

fn is_band_message(message: &LlmRequestContextMessage) -> bool {
    served_text(message).starts_with("[context ·")
}

fn measured(messages: &[LlmRequestContextMessage]) -> i64 {
    messages
        .iter()
        .map(|m| estimate_tokens(&served_text(m)))
        .sum()
}

fn read_raw_stored_view(file_path: &str) -> Option<StoredView> {
    let db = open_raw(file_path);
    let header = db
        .prepare(
            "SELECT view_id, created_at, compact_point, covered_from, profile_name,
                config_json, arrangement_json, gaps_json, source_state_json
         FROM thread_view WHERE singleton = 1",
        )
        .get();
    let Some(header) = header else {
        db.close();
        return None;
    };
    let view_id = header
        .get("view_id")
        .and_then(|v| v.as_str())
        .expect("view_id")
        .to_string();
    let band_rows = db
        .prepare("SELECT band, token_count FROM thread_view_band WHERE view_id = ?")
        .all(&[lhc::shared_tech::storage::SqlParam::Text(view_id.clone())]);
    let by_band: HashMap<String, i64> = band_rows
        .iter()
        .filter_map(|row| {
            let band = row.get("band")?.as_str()?.to_string();
            let tokens = row.get("token_count")?.as_i64()?;
            Some((band, tokens))
        })
        .collect();
    // Rebuild via typed fields — arrangement/gaps/config/source_state from JSON.
    let config: StoredViewConfig =
        serde_json::from_str(header.get("config_json").and_then(|v| v.as_str()).unwrap())
            .expect("config");
    let arrangement: Vec<StoredViewArrangementEntry> = serde_json::from_str(
        header
            .get("arrangement_json")
            .and_then(|v| v.as_str())
            .unwrap(),
    )
    .expect("arrangement");
    let gaps: Vec<StoredViewGap> =
        serde_json::from_str(header.get("gaps_json").and_then(|v| v.as_str()).unwrap())
            .expect("gaps");
    let source_state: StoredViewSourceState = serde_json::from_str(
        header
            .get("source_state_json")
            .and_then(|v| v.as_str())
            .unwrap(),
    )
    .expect("source_state");
    let bands = [Band::Brief, Band::Detailed, Band::Smooth]
        .into_iter()
        .filter_map(|band| {
            let stored_tokens = *by_band.get(band.as_str())?;
            Some(StoredViewBand {
                band,
                stored_tokens,
            })
        })
        .collect();
    let stored = StoredView {
        view_id,
        created_at: header
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap()
            .into(),
        compact_point: header
            .get("compact_point")
            .and_then(|v| v.as_i64())
            .unwrap(),
        covered_from: header.get("covered_from").and_then(|v| v.as_i64()).unwrap(),
        profile_name: header
            .get("profile_name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        config,
        arrangement,
        gaps,
        source_state,
        bands,
    };
    db.close();
    Some(stored)
}

fn bands_from_raw(raw: &StoredView) -> Vec<ViewContentsBand> {
    [Band::Brief, Band::Detailed, Band::Smooth]
        .into_iter()
        .filter_map(|band| {
            let entries: Vec<ViewContentsBandEntry> = raw
                .arrangement
                .iter()
                .filter(|e| e.band == band)
                .map(|e| ViewContentsBandEntry {
                    subject_kind: e.subject_kind,
                    subject_id: e.subject_id.clone(),
                    derivation_used: e.derivation_used.clone(),
                    degraded: e.degraded,
                })
                .collect();
            let stored = raw.bands.iter().find(|row| row.band == band);
            if entries.is_empty() && stored.is_none() {
                return None;
            }
            Some(ViewContentsBand {
                band,
                entries,
                stored_tokens: stored.map(|s| s.stored_tokens).unwrap_or(0),
            })
        })
        .collect()
}

fn degraded_compact_params() -> ViewCompactParams {
    ViewCompactParams {
        lower_bound: Some(400.0),
        percentages: Some(PartialViewProfilePercentages {
            full: Some(25.0),
            smooth: Some(25.0),
            detailed: Some(10.0),
            brief: Some(40.0),
        }),
    }
}

async fn degraded_compacted_thread(store: &TempStore) -> DerivedThreadFixture {
    let fixture = derived_thread_fixture(
        store,
        DerivedThreadOptions {
            failures: Some(false),
        },
    )
    .await;
    let sdk = &fixture.sdk;
    let file_path = &fixture.file_path;
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(file_path), None)
        .await;
    let OpResult::Ok { value: listed } = listed else {
        panic!("fixture list failed");
    };
    for turn in ["t4", "t5", "t6", "t8"] {
        let target = listed
            .iter()
            .find(|r| r.kind == MessageKind::UserPrompt && r.turn_id == turn);
        let Some(target) = target else {
            panic!("fixture invariant: no prompt in {turn}");
        };
        let edited = sdk
            .messages
            .edit(
                ThreadRef::file_path(file_path),
                EditInput {
                    message_id: target.message_id.clone(),
                    content: format!("{turn} revised: investigate the area again"),
                },
            )
            .await;
        if !edited.is_ok() {
            panic!("fixture edit failed");
        }
    }
    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(file_path),
            CompactOpts {
                profile: None,
                params: Some(degraded_compact_params()),
                signal: None,
            },
        )
        .await;
    if !compacted.is_ok() {
        panic!("fixture compact failed");
    }
    fixture
}

async fn never_compacted_thread(store: &TempStore) -> (String, Lhc) {
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
        panic!("fixture thread creation failed");
    }
    let batches = [
        vec![
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "please read notes.txt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("reading it now")),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-iv-1".into(),
                        tool_name: "read_file".into(),
                        arguments: serde_json::json!({"path": "notes.txt"})
                            .as_object()
                            .unwrap()
                            .clone(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_RESULT,
                ToolResultOverrides {
                    payload: Some(ToolResultPayload {
                        tool_call_id: "call-iv-1".into(),
                        content: "contents of notes.txt".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
        vec![
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "summarize what you read".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload::new("here is the summary")),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    ];
    for batch in &batches {
        let sent = sdk
            .intake_stream
            .message_events(ThreadRef::file_path(&file_path), batch)
            .await;
        if !sent.is_ok() {
            panic!("fixture batch failed");
        }
    }
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    match &drained {
        OpResult::Ok { value } if value.remaining == 0 => {}
        _ => panic!("fixture drain left work behind"),
    }
    (file_path, sdk)
}

fn tokens(n: usize) -> String {
    std::iter::repeat_n("tok", n).collect::<Vec<_>>().join(" ")
}

#[tokio::test]
async fn report_entries_derivations_degraded_flags_gap_reasons_config_and_provenance_equal_describe_output_and_the_stored_row()
 {
    let ctx = setup();
    let fixture = degraded_compacted_thread(&ctx.store).await;
    let file_path = &fixture.file_path;
    let sdk = &fixture.sdk;
    let raw = read_raw_stored_view(file_path);
    assert!(raw.is_some());
    let Some(raw) = raw else {
        return;
    };

    let described = result_value(
        sdk.thread_view
            .describe(ThreadRef::file_path(file_path))
            .await,
    );
    assert_eq!(described.as_ref(), Some(&raw));

    let report: ViewContentsReport =
        result_value(sdk.inspect.view(ThreadRef::file_path(file_path)).await);
    let mut percentages = IndexMap::new();
    percentages.insert("full".into(), 25.0);
    percentages.insert("smooth".into(), 25.0);
    percentages.insert("detailed".into(), 10.0);
    percentages.insert("brief".into(), 40.0);
    assert_eq!(
        report.meta,
        Some(ViewContentsMeta {
            view_id: raw.view_id.clone(),
            created_at: raw.created_at.clone(),
            profile: None,
            config: ViewContentsMetaConfig {
                lower_bound: 400.0,
                percentages: percentages.clone(),
            },
            compact_point: raw.compact_point,
            covered_from: raw.covered_from,
        })
    );
    assert_eq!(
        report.meta.as_ref().map(|m| &m.config),
        Some(&ViewContentsMetaConfig {
            lower_bound: raw.config.lower_bound,
            percentages: raw.config.percentages.clone(),
        })
    );

    assert_eq!(report.bands, bands_from_raw(&raw));
    assert_eq!(
        report.gaps,
        raw.gaps
            .iter()
            .map(|g| ViewContentsGap {
                band: g.band,
                subject_id: g.subject_id.clone(),
                reason: g.reason.clone(),
            })
            .collect::<Vec<_>>()
    );
    let source = report.source_state.as_ref().expect("source_state");
    assert_eq!(source.max_event_order, raw.source_state.max_event_order);
    assert_eq!(source.derivation_counts, raw.source_state.derivation_counts);

    let entries: Vec<_> = report.bands.iter().flat_map(|b| b.entries.iter()).collect();
    assert!(entries.iter().any(|e| e.subject_id == "t8" && e.degraded));
    assert_eq!(report.gaps.len(), 0);
    assert!(entries.iter().any(|e| e.subject_id == "c2" && e.degraded));

    let context_read: LlmRequestContext = result_value(
        sdk.thread_view
            .get_llm_request_context(ThreadRef::file_path(file_path))
            .await,
    );
    assert_eq!(report.load_cost.total, measured(&context_read.messages));
    let band_msgs: Vec<_> = context_read
        .messages
        .iter()
        .filter(|m| is_band_message(m))
        .cloned()
        .collect();
    assert_eq!(report.load_cost.band_tokens, measured(&band_msgs));
    assert_eq!(
        report.load_cost.total,
        report.load_cost.band_tokens + report.load_cost.tail_tokens
    );
    assert_eq!(
        report.tail.message_count,
        context_read
            .messages
            .iter()
            .filter(|m| !is_band_message(m))
            .count() as i64
    );
}

#[tokio::test]
async fn describe_returns_ok_null_on_a_never_compacted_thread_and_thread_not_found_on_a_missing_one()
 {
    let ctx = setup();
    let (file_path, sdk) = never_compacted_thread(&ctx.store).await;
    let described = sdk
        .thread_view
        .describe(ThreadRef::file_path(&file_path))
        .await;
    assert!(described.is_ok());
    if let OpResult::Ok { value } = &described {
        assert!(value.is_none());
    }
    assert!(read_raw_stored_view(&file_path).is_none());

    let missing = sdk
        .thread_view
        .describe(ThreadRef::file_path(
            ctx.store
                .thread_path(Some("missing"))
                .to_string_lossy()
                .as_ref(),
        ))
        .await;
    assert!(!missing.is_ok());
    if let OpResult::Err { error } = missing {
        assert_eq!(error.error_class, ErrorClass::CallerError);
        assert_eq!(error.code, ErrorCode::ThreadNotFound);
    }
}

#[tokio::test]
async fn tail_costs_short_forms_short_and_total_equals_an_independent_context_read_re_measured() {
    let ctx = setup();
    let sdk = init_lhc(SdkConfig {
        inference_callbacks: Some(create_inference_callbacks_double().to_callbacks()),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: Some(SdkViewConfig {
            profiles: None,
            visibility: Some(PartialVisibilityBudgets {
                max_tokens: Some(100.0),
                target_tokens: Some(60.0),
            }),
            compact_threshold: None,
        }),
    });
    let file_path = ctx.store.thread_path(None).to_string_lossy().into_owned();
    let created = sdk
        .threads
        .new_thread(NewThreadInput {
            file_path: file_path.clone(),
            title: None,
            cwd: None,
            registry_path: Some(ctx.store.registry_path.to_string_lossy().into_owned()),
        })
        .await;
    if !created.is_ok() {
        panic!("thread creation failed");
    }

    for turn in 1..=6 {
        let sent = sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&file_path),
                &[
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
                        kind::ASSISTANT_TEXT,
                        AssistantTextOverrides {
                            payload: Some(AssistantTextPayload::new(format!(
                                "findings for area {turn}"
                            ))),
                            ..Default::default()
                        },
                    ),
                    valid_event(kind::TURN_END, TurnEndOverrides::default()),
                ],
            )
            .await;
        if !sent.is_ok() {
            panic!("intake failed");
        }
        let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
        if !drained.is_ok() {
            panic!("drain failed");
        }
    }
    let compacted = sdk
        .thread_view
        .compact(
            ThreadRef::file_path(&file_path),
            CompactOpts {
                profile: None,
                params: Some(ViewCompactParams {
                    lower_bound: Some(60.0),
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
    assert!(compacted.is_ok());
    let OpResult::Ok { value: compacted } = compacted else {
        return;
    };

    for run in 1..=2 {
        let sent = sdk
            .intake_stream
            .message_events(
                ThreadRef::file_path(&file_path),
                &[
                    valid_event(
                        kind::USER_PROMPT,
                        UserPromptOverrides {
                            payload: Some(UserPromptPayload {
                                text: format!("post-compact tool run {run}"),
                            }),
                            ..Default::default()
                        },
                    ),
                    valid_event(
                        kind::TOOL_CALL,
                        ToolCallOverrides {
                            payload: Some(ToolCallPayload {
                                tool_call_id: format!("call-adv-{run}"),
                                tool_name: "read_file".into(),
                                arguments: serde_json::json!({"path": format!("adv-{run}.txt")})
                                    .as_object()
                                    .unwrap()
                                    .clone(),
                            }),
                            ..Default::default()
                        },
                    ),
                    valid_event(
                        kind::TOOL_RESULT,
                        ToolResultOverrides {
                            payload: Some(ToolResultPayload {
                                tool_call_id: format!("call-adv-{run}"),
                                content: tokens(150),
                                is_error: Some(false),
                            }),
                            ..Default::default()
                        },
                    ),
                    valid_event(kind::TURN_END, TurnEndOverrides::default()),
                ],
            )
            .await;
        if !sent.is_ok() {
            panic!("intake failed");
        }
    }
    let listed = sdk
        .messages
        .list(ThreadRef::file_path(&file_path), None)
        .await;
    assert!(listed.is_ok());
    let OpResult::Ok { value: listed } = listed else {
        return;
    };
    let mut tail_results: Vec<_> = listed
        .iter()
        .filter(|m| {
            m.kind == MessageKind::ToolResult && m.source_event_order > compacted.compact_point
        })
        .cloned()
        .collect();
    tail_results.sort_by_key(|m| m.source_event_order);
    assert_eq!(tail_results.len(), 2);
    seed_view_boundary(&file_path, tail_results[0].source_event_order);

    let context_read: LlmRequestContext = result_value(
        sdk.thread_view
            .get_llm_request_context(ThreadRef::file_path(&file_path))
            .await,
    );
    let db = open_raw(&file_path);
    let boundary_position = db
        .prepare("SELECT position FROM view_boundary")
        .get()
        .expect("boundary")
        .get("position")
        .and_then(|v| v.as_i64())
        .expect("position");
    db.close();
    assert!(boundary_position > compacted.compact_point);
    let tail_served: Vec<_> = context_read
        .messages
        .iter()
        .filter(|m| !is_band_message(m))
        .cloned()
        .collect();
    let abridged: Vec<_> = tail_served
        .iter()
        .filter(|m| served_text(m).contains(" · abridged]"))
        .collect();
    let full_results: Vec<_> = tail_served
        .iter()
        .filter(|m| {
            let t = served_text(m);
            t.starts_with("[tool result · ") && !t.contains(" · abridged]")
        })
        .collect();
    assert_eq!(abridged.len(), 1);
    assert_eq!(full_results.len(), 1);
    assert!(
        estimate_tokens(&served_text(abridged[0])) < estimate_tokens(&served_text(full_results[0]))
    );

    let report: ViewContentsReport =
        result_value(sdk.inspect.view(ThreadRef::file_path(&file_path)).await);
    assert_eq!(report.tail.message_count, tail_served.len() as i64);
    assert_eq!(report.tail.tokens, measured(&tail_served));
    assert_eq!(report.load_cost.tail_tokens, report.tail.tokens);
    assert_eq!(report.load_cost.total, measured(&context_read.messages));
    assert_eq!(
        report.load_cost.total,
        report.load_cost.band_tokens + report.load_cost.tail_tokens
    );
}

#[tokio::test]
async fn meta_null_bands_empty_tail_spans_the_record_cost_parity_holds() {
    let ctx = setup();
    let (file_path, sdk) = never_compacted_thread(&ctx.store).await;
    let report: ViewContentsReport =
        result_value(sdk.inspect.view(ThreadRef::file_path(&file_path)).await);
    assert!(report.meta.is_none());
    assert_eq!(report.bands, Vec::<ViewContentsBand>::new());
    assert_eq!(report.gaps, Vec::<ViewContentsGap>::new());
    assert!(report.source_state.is_none());
    assert_eq!(report.load_cost.band_tokens, 0);

    let context_read: LlmRequestContext = result_value(
        sdk.thread_view
            .get_llm_request_context(ThreadRef::file_path(&file_path))
            .await,
    );
    assert!(context_read.messages.iter().all(|m| !is_band_message(m)));
    assert_eq!(
        report.tail.message_count,
        context_read.messages.len() as i64
    );
    assert_eq!(report.tail.message_count, 6);
    assert_eq!(report.tail.tokens, measured(&context_read.messages));
    assert_eq!(report.load_cost.tail_tokens, report.tail.tokens);
    assert_eq!(report.load_cost.total, measured(&context_read.messages));
}

#[tokio::test]
async fn repeated_calls_are_deep_equal_leave_no_delta_and_call_no_model_including_under_a_throwing_inference_callback()
 {
    let ctx = setup();
    let fixture = degraded_compacted_thread(&ctx.store).await;
    let file_path = fixture.file_path.clone();
    let sdk = &fixture.sdk;
    let captured = fixture.double.capture_inputs();

    let first = expect_read_only(&file_path, || {
        sdk.inspect.view(ThreadRef::file_path(&file_path))
    })
    .await;
    let second = expect_read_only(&file_path, || {
        sdk.inspect.view(ThreadRef::file_path(&file_path))
    })
    .await;
    let described_once = expect_read_only(&file_path, || {
        sdk.thread_view.describe(ThreadRef::file_path(&file_path))
    })
    .await;
    assert!(first.is_ok() && second.is_ok() && described_once.is_ok());
    assert_eq!(second, first);
    assert_eq!(captured.len(), 0);

    let refuse = || -> BoxFuture<InferenceResult> {
        Box::pin(async {
            panic!("inference callbacks must never be called by a read operation");
        })
    };
    let throwing = InferenceCallbacks {
        smooth_prompt: Arc::new(move |_i: SmoothPromptInput| refuse()),
        summarize_tool_result: Arc::new(move |_i: SummarizeToolResultInput| refuse()),
        compress_detailed_turn: Arc::new(move |_i: CompressDetailedTurnInput| refuse()),
        summarize_chunk_brief: Arc::new(move |_i: SummarizeChunkBriefInput| refuse()),
    };
    let reader = init_lhc(SdkConfig {
        inference_callbacks: Some(throwing),
        inference: None,
        mode: SdkMode::Manual,
        clock: None,
        guards: None,
        tool_result: None,
        lease: None,
        chunk_policy: None,
        view: None,
    });
    let viewed = expect_read_only(&file_path, || {
        reader.inspect.view(ThreadRef::file_path(&file_path))
    })
    .await;
    let described = expect_read_only(&file_path, || {
        reader
            .thread_view
            .describe(ThreadRef::file_path(&file_path))
    })
    .await;
    assert!(viewed.is_ok() && described.is_ok());
}

#[tokio::test]
async fn inspect_view_on_a_missing_thread_is_thread_not_found_not_a_shape_error() {
    let ctx = setup();
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
    let missing = sdk
        .inspect
        .view(ThreadRef::file_path(
            ctx.store
                .thread_path(Some("missing"))
                .to_string_lossy()
                .as_ref(),
        ))
        .await;
    assert!(!missing.is_ok());
    let OpResult::Err { error } = missing else {
        return;
    };
    assert_eq!(error.error_class, ErrorClass::CallerError);
    assert_eq!(error.code, ErrorCode::ThreadNotFound);
}

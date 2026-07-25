//! Ported from packages/lhc/test/fixtures/threads.ts.
//!
//! [`read_derived_forms`] / [`read_chunks`] / [`set_form_state`] are below-SDK
//! sqlite helpers — REAL. SDK-calling thread builders remain `todo!("phase 2")`.

use lhc::intake_stream::{self, MessageEventInput};
use lhc::sdk::Lhc;
use lhc::shared_tech::derivation::SizeDisposition;
use lhc::shared_tech::derivation::{
    DependencyGap, Derivation, DerivationMetadata, DerivationState, ProviderProvenance,
    SubjectKind, ToolOutcome,
};
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify_of;
use lhc::shared_tech::storage::{SqlParam, open_database};
use lhc::threads::{self, NewThreadInput, ThreadRef};
use lhc::turns::TurnStatus;

use super::TempStore;
use super::corrupt::corrupt_two_open_turns;
use super::inference_callbacks_double::InferenceCallbacksDouble;
use super::model_call::DerivationType;
use super::{
    AssistantTextOverrides, AssistantTextPayload, ToolCallOverrides, ToolCallPayload,
    ToolResultOverrides, ToolResultPayload, TurnEndOverrides, UserPromptOverrides,
    UserPromptPayload, kind, valid_event,
};

// ── chunk read-back (Story 3): raw rows for boundary assertions ──

/// One `chunk` table row projected for boundary assertions (TS inline map).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSnapshotChunk {
    pub chunk_id: String,
    pub chunk_order: i64,
    pub status: TurnStatus,
    pub accumulated_projected_tokens: i64,
}

/// One `chunk_member` row joined for boundary assertions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSnapshotMember {
    pub chunk_id: String,
    pub turn_id: String,
    pub member_idx: i64,
}

/// TS `ChunkSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkSnapshot {
    pub chunks: Vec<ChunkSnapshotChunk>,
    pub members: Vec<ChunkSnapshotMember>,
}

/// TS `readChunks` — REAL below-SDK chunk boundary read-back.
pub fn read_chunks(file_path: &str) -> ChunkSnapshot {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("read_chunks open failed: {}", error.reason),
    };
    let chunk_rows = db
        .prepare(
            "SELECT chunk_id, chunk_order, status, accumulated_projected_tokens
           FROM chunk ORDER BY chunk_order",
        )
        .all(&[]);
    let chunks = chunk_rows
        .iter()
        .map(|row| ChunkSnapshotChunk {
            chunk_id: req_str(row, "chunk_id").to_string(),
            chunk_order: req_i64(row, "chunk_order"),
            status: parse_turn_status(req_str(row, "status")),
            accumulated_projected_tokens: req_i64(row, "accumulated_projected_tokens"),
        })
        .collect();
    let member_rows = db
        .prepare(
            "SELECT cm.chunk_id, cm.turn_id, cm.member_idx FROM chunk_member cm
           JOIN chunk c ON c.chunk_id = cm.chunk_id
           ORDER BY c.chunk_order, cm.member_idx",
        )
        .all(&[]);
    let members = member_rows
        .iter()
        .map(|row| ChunkSnapshotMember {
            chunk_id: req_str(row, "chunk_id").to_string(),
            turn_id: req_str(row, "turn_id").to_string(),
            member_idx: req_i64(row, "member_idx"),
        })
        .collect();
    db.close();
    ChunkSnapshot { chunks, members }
}

fn parse_turn_status(s: &str) -> TurnStatus {
    match s {
        "open" => TurnStatus::Open,
        "closed" => TurnStatus::Closed,
        other => panic!("read_chunks: unknown status {other}"),
    }
}

/// Closed target for [`set_form_state`] (TS inline object).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormStateTarget {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: DerivationType,
}

/// Closed update bag for [`set_form_state`] — narrow Partial of derivation write fields.
#[derive(Debug, Clone, PartialEq)]
pub struct FormStateUpdate {
    pub state: DerivationState,
    pub content: Option<String>,
    pub reason: Option<String>,
    pub metadata: Option<DerivationMetadata>,
    pub derived_at: Option<String>,
}

/// TS `setFormState` — REAL below-SDK sanctioned state writer (UPDATE-only).
pub fn set_form_state(file_path: &str, target: &FormStateTarget, update: &FormStateUpdate) {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("set_form_state open failed: {}", error.reason),
    };
    let metadata = match &update.metadata {
        None => SqlParam::Null,
        Some(meta) => {
            SqlParam::Text(js_json_stringify_of(meta).expect("set_form_state: metadata stringify"))
        }
    };
    db.prepare(
        "UPDATE derivation
         SET state = ?, content = ?, reason = ?, metadata = ?, derived_at = ?
         WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?",
    )
    .run(&[
        SqlParam::from(update.state.as_str()),
        SqlParam::from(update.content.as_deref()),
        SqlParam::from(update.reason.as_deref()),
        metadata,
        SqlParam::from(update.derived_at.as_deref()),
        SqlParam::from(target.subject_kind.as_str()),
        SqlParam::from(target.subject_id.as_str()),
        SqlParam::from(target.derivation_type.as_str()),
    ]);
    let changed = db
        .prepare("SELECT changes() AS n")
        .get()
        .and_then(|row| row.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    if changed != 1 {
        panic!(
            "fixture setFormState hit {changed} rows for {}/{}/{}; expected the pending row from enqueue",
            target.subject_kind.as_str(),
            target.subject_id,
            target.derivation_type.as_str()
        );
    }
    db.close();
}

/// TS `readDerivedForms` — REAL below-SDK derivation read-back.
pub fn read_derived_forms(file_path: &str) -> Vec<Derivation> {
    let db = match open_database(file_path) {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("read_derived_forms open failed: {}", error.reason),
    };
    let rows = db
        .prepare(
            "SELECT subject_kind, subject_id, derivation_type, state, content, reason, metadata,
                source_version, gaps, derived_at
         FROM derivation ORDER BY subject_kind, subject_id, derivation_type",
        )
        .all(&[]);
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let subject_kind = parse_subject_kind(req_str(&row, "subject_kind"));
        let state = parse_derivation_state(req_str(&row, "state"));
        let metadata = match opt_str(&row, "metadata") {
            None => None,
            Some(raw) => Some(parse_metadata(&raw)),
        };
        let gaps = match opt_str(&row, "gaps") {
            None => None,
            Some(raw) => Some(parse_gaps(&raw)),
        };
        out.push(Derivation {
            subject_kind,
            subject_id: req_str(&row, "subject_id").to_string(),
            derivation_type: req_str(&row, "derivation_type").to_string(),
            state,
            content: opt_str(&row, "content").map(str::to_string),
            reason: opt_str(&row, "reason").map(str::to_string),
            source_version: req_i64(&row, "source_version"),
            gaps,
            metadata,
            derived_at: opt_str(&row, "derived_at").map(str::to_string),
        });
    }
    db.close();
    out
}

fn req_str<'a>(row: &'a serde_json::Map<String, serde_json::Value>, key: &str) -> &'a str {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("read_derived_forms: missing string column {key}"))
}

fn opt_str<'a>(row: &'a serde_json::Map<String, serde_json::Value>, key: &str) -> Option<&'a str> {
    match row.get(key)? {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.as_str()),
        other => panic!("read_derived_forms: column {key} expected string/null, got {other}"),
    }
}

fn req_i64(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> i64 {
    match row.get(key) {
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| panic!("read_derived_forms: non-integer {key}")),
        other => panic!("read_derived_forms: missing number column {key}: {other:?}"),
    }
}

fn parse_subject_kind(s: &str) -> SubjectKind {
    match s {
        "message" => SubjectKind::Message,
        "turn" => SubjectKind::Turn,
        "chunk" => SubjectKind::Chunk,
        other => panic!("read_derived_forms: unknown subject_kind {other}"),
    }
}

fn parse_derivation_state(s: &str) -> DerivationState {
    match s {
        "pending" => DerivationState::Pending,
        "ready" => DerivationState::Ready,
        "failed" => DerivationState::Failed,
        "blocked" => DerivationState::Blocked,
        other => panic!("read_derived_forms: unknown state {other}"),
    }
}

fn parse_metadata(raw: &str) -> DerivationMetadata {
    let value: serde_json::Value =
        serde_json::from_str(raw).expect("read_derived_forms: metadata JSON");
    let obj = value
        .as_object()
        .expect("read_derived_forms: metadata must be object");
    // TS casts `JSON.parse(...) as DerivationMetadata` — unknown keys are ignored,
    // not rejected.
    let provenance = match obj.get("provenance") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(p)) => Some(ProviderProvenance {
            provider: p
                .get("provider")
                .and_then(|v| v.as_str())
                .expect("provenance.provider")
                .to_string(),
            model: p
                .get("model")
                .and_then(|v| v.as_str())
                .expect("provenance.model")
                .to_string(),
            prompt: p
                .get("prompt")
                .and_then(|v| v.as_str())
                .expect("provenance.prompt")
                .to_string(),
        }),
        Some(other) => panic!("provenance must be object, got {other}"),
    };
    DerivationMetadata {
        outcome: obj
            .get("outcome")
            .and_then(|v| v.as_str())
            .map(parse_tool_outcome),
        last_error: obj
            .get("lastError")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        discard_reason: obj
            .get("discardReason")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        fallback_floor: obj
            .get("fallbackFloor")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        fallback_used: obj.get("fallbackUsed").and_then(|v| v.as_bool()),
        inference_attempted: obj.get("inferenceAttempted").and_then(|v| v.as_bool()),
        inference_succeeded: obj.get("inferenceSucceeded").and_then(|v| v.as_bool()),
        size_disposition: obj
            .get("sizeDisposition")
            .and_then(|v| v.as_str())
            .map(parse_size_disposition),
        provenance,
    }
}

fn parse_tool_outcome(s: &str) -> ToolOutcome {
    match s {
        "succeeded" => ToolOutcome::Succeeded,
        "failed" => ToolOutcome::Failed,
        "unknown" => ToolOutcome::Unknown,
        other => panic!("read_derived_forms: unknown outcome {other}"),
    }
}

fn parse_size_disposition(s: &str) -> SizeDisposition {
    match s {
        "in_range" => SizeDisposition::InRange,
        "under_min" => SizeDisposition::UnderMin,
        "over_max" => SizeDisposition::OverMax,
        other => panic!("read_derived_forms: unknown sizeDisposition {other}"),
    }
}

fn parse_gaps(raw: &str) -> Vec<DependencyGap> {
    let value: serde_json::Value =
        serde_json::from_str(raw).expect("read_derived_forms: gaps JSON");
    let arr = value
        .as_array()
        .expect("read_derived_forms: gaps must be array");
    arr.iter()
        .map(|gap| {
            let o = gap
                .as_object()
                .expect("read_derived_forms: gap entry must be object");
            DependencyGap {
                subject_kind: parse_subject_kind(
                    o.get("subjectKind")
                        .and_then(|v| v.as_str())
                        .expect("gap.subjectKind"),
                ),
                subject_id: o
                    .get("subjectId")
                    .and_then(|v| v.as_str())
                    .expect("gap.subjectId")
                    .to_string(),
                derivation_type: o
                    .get("derivationType")
                    .and_then(|v| v.as_str())
                    .expect("gap.derivationType")
                    .to_string(),
            }
        })
        .collect()
}

/// TS private `newThreadFile`.
#[allow(dead_code)]
async fn new_thread_file(store: &TempStore) -> String {
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

/// TS private `send`.
#[allow(dead_code)]
async fn send(file_path: &str, batch: &[MessageEventInput]) {
    let result = intake_stream::message_events(ThreadRef::file_path(file_path), batch).await;
    match result {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("fixture batch failed: {}", error.reason),
    }
}

/// TC-3.2's fallback-rendering state as one shared builder (coverage.md
/// cross-story debt: TC-4.4 consumes this exact scenario). Expects a
/// manual-mode SDK: scripts the prompt's smoothing to fail, then drains.
pub const GAPPED_SMOOTHING_REASON: &str = "provider_failure: scripted smoothing failure";

/// TS `GappedRenderingThread` return shape.
#[derive(Debug, Clone)]
pub struct GappedRenderingThreadResult {
    pub file_path: String,
    pub message_id: String,
    pub turn_id: String,
}

/// TS `gappedRenderingThread`.
pub async fn gapped_rendering_thread(
    store: &TempStore,
    sdk: &Lhc,
    double: &InferenceCallbacksDouble,
) -> GappedRenderingThreadResult {
    let file_path = new_thread_file(store).await;
    double.fail_kind("prompt_smoothing", 1, Some(GAPPED_SMOOTHING_REASON));
    send(
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "gapped prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "gapped answer".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    let drained = sdk.work.drain(ThreadRef::file_path(&file_path), None).await;
    match &drained {
        OpResult::Ok { .. } => {}
        OpResult::Err { error } => panic!("fixture drain failed: {}", error.reason),
    }
    set_form_state(
        &file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Message,
            subject_id: "m1".into(),
            derivation_type: DerivationType::SmoothedPrompt,
        },
        &FormStateUpdate {
            state: DerivationState::Failed,
            content: None,
            reason: Some(GAPPED_SMOOTHING_REASON.into()),
            metadata: None,
            derived_at: None,
        },
    );
    let forms = read_derived_forms(&file_path);
    let smoothing = forms
        .iter()
        .find(|form| form.subject_id == "m1" && form.derivation_type == "smoothed_prompt");
    let rendering = forms
        .iter()
        .find(|form| form.subject_id == "t1" && form.derivation_type == "turn_rendering");
    if smoothing.map(|s| s.state) != Some(DerivationState::Failed)
        || rendering.map(|r| r.state) != Some(DerivationState::Ready)
        || rendering.and_then(|r| r.gaps.as_ref()).is_some()
    {
        panic!("fixture invariant: failed smoothing under a ready fallback rendering expected");
    }
    GappedRenderingThreadResult {
        file_path,
        message_id: "m1".into(),
        turn_id: "t1".into(),
    }
}

/// TS `damagedSourceThread`.
pub async fn damaged_source_thread(store: &TempStore) -> DamagedSourceThreadResult {
    let built = thread_with_closed_turns(store, 1).await;
    let file_path = built.file_path;
    send(
        &file_path,
        &[valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "left open".into(),
                }),
                ..Default::default()
            },
        )],
    )
    .await;
    corrupt_two_open_turns(&file_path);
    let turn_id = built
        .turn_ids
        .first()
        .cloned()
        .expect("fixture invariant: one closed turn expected");
    DamagedSourceThreadResult { file_path, turn_id }
}

/// TS `multiStateThread`.
pub async fn multi_state_thread(store: &TempStore) -> MultiStateThreadResult {
    let file_path = new_thread_file(store).await;
    let mut args = serde_json::Map::new();
    args.insert("path".into(), serde_json::Value::String("a.txt".into()));
    send(
        &file_path,
        &[
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "first prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::ASSISTANT_TEXT,
                AssistantTextOverrides {
                    payload: Some(AssistantTextPayload {
                        text: "working on it".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(
                kind::TOOL_CALL,
                ToolCallOverrides {
                    payload: Some(ToolCallPayload {
                        tool_call_id: "call-ms-1".into(),
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
                        tool_call_id: "call-ms-1".into(),
                        content: "contents of a.txt".into(),
                        is_error: Some(false),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
            valid_event(
                kind::USER_PROMPT,
                UserPromptOverrides {
                    payload: Some(UserPromptPayload {
                        text: "second prompt".into(),
                    }),
                    ..Default::default()
                },
            ),
            valid_event(kind::TURN_END, TurnEndOverrides::default()),
        ],
    )
    .await;
    let derived_at = "2026-06-10T12:00:00.000Z";
    set_form_state(
        &file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Message,
            subject_id: "m1".into(),
            derivation_type: DerivationType::SmoothedPrompt,
        },
        &FormStateUpdate {
            state: DerivationState::Ready,
            content: Some("smoothed(fixture:first prompt)".into()),
            reason: None,
            metadata: None,
            derived_at: Some(derived_at.into()),
        },
    );
    set_form_state(
        &file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Message,
            subject_id: "m4".into(),
            derivation_type: DerivationType::ToolResultSummary,
        },
        &FormStateUpdate {
            state: DerivationState::Ready,
            content: Some("toolresult(fixture:contents of a.txt)".into()),
            reason: None,
            metadata: Some(DerivationMetadata {
                outcome: Some(ToolOutcome::Succeeded),
                last_error: None,
                discard_reason: None,
                fallback_floor: None,
                fallback_used: None,
                inference_attempted: None,
                inference_succeeded: None,
                size_disposition: None,
                provenance: None,
            }),
            derived_at: Some(derived_at.into()),
        },
    );
    set_form_state(
        &file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Turn,
            subject_id: "t1".into(),
            derivation_type: DerivationType::TurnRendering,
        },
        &FormStateUpdate {
            state: DerivationState::Failed,
            content: None,
            reason: Some("provider_failure: scripted failure (fixture)".into()),
            metadata: None,
            derived_at: None,
        },
    );
    set_form_state(
        &file_path,
        &FormStateTarget {
            subject_kind: SubjectKind::Turn,
            subject_id: "t2".into(),
            derivation_type: DerivationType::TurnRendering,
        },
        &FormStateUpdate {
            state: DerivationState::Blocked,
            content: None,
            reason: Some("source_damaged: manufactured damage (fixture)".into()),
            metadata: None,
            derived_at: None,
        },
    );
    let expected = vec![
        MultiStateClaim {
            subject_kind: SubjectKind::Message,
            subject_id: "m1".into(),
            derivation_type: DerivationType::SmoothedPrompt,
            state: DerivationState::Ready,
        },
        MultiStateClaim {
            subject_kind: SubjectKind::Message,
            subject_id: "m4".into(),
            derivation_type: DerivationType::ToolResultSummary,
            state: DerivationState::Ready,
        },
        MultiStateClaim {
            subject_kind: SubjectKind::Message,
            subject_id: "m6".into(),
            derivation_type: DerivationType::SmoothedPrompt,
            state: DerivationState::Pending,
        },
        MultiStateClaim {
            subject_kind: SubjectKind::Turn,
            subject_id: "t1".into(),
            derivation_type: DerivationType::TurnRendering,
            state: DerivationState::Failed,
        },
        MultiStateClaim {
            subject_kind: SubjectKind::Turn,
            subject_id: "t1".into(),
            derivation_type: DerivationType::PreDetailedAssembly,
            state: DerivationState::Pending,
        },
        MultiStateClaim {
            subject_kind: SubjectKind::Turn,
            subject_id: "t2".into(),
            derivation_type: DerivationType::TurnRendering,
            state: DerivationState::Blocked,
        },
        MultiStateClaim {
            subject_kind: SubjectKind::Turn,
            subject_id: "t2".into(),
            derivation_type: DerivationType::PreDetailedAssembly,
            state: DerivationState::Pending,
        },
    ];
    MultiStateThreadResult {
        file_path,
        expected,
    }
}

/// TS `threadWithClosedTurns`.
pub async fn thread_with_closed_turns(store: &TempStore, n: usize) -> ThreadWithClosedTurnsResult {
    let file_path = new_thread_file(store).await;
    let mut turn_ids = Vec::new();
    for i in 1..=n {
        send(
            &file_path,
            &[
                valid_event(
                    kind::USER_PROMPT,
                    UserPromptOverrides {
                        payload: Some(UserPromptPayload {
                            text: format!("prompt for turn {i}"),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(
                    kind::ASSISTANT_TEXT,
                    AssistantTextOverrides {
                        payload: Some(AssistantTextPayload {
                            text: format!("answer for turn {i}"),
                        }),
                        ..Default::default()
                    },
                ),
                valid_event(kind::TURN_END, TurnEndOverrides::default()),
            ],
        )
        .await;
        turn_ids.push(format!("t{i}"));
    }
    ThreadWithClosedTurnsResult {
        file_path,
        turn_ids,
    }
}

/// TS `threadWithToolRun`.
pub async fn thread_with_tool_run(
    store: &TempStore,
    opts: Option<ToolRunOpts>,
) -> ThreadWithToolRunResult {
    let opts = opts.unwrap_or_default();
    let file_path = new_thread_file(store).await;
    let mut args = serde_json::Map::new();
    args.insert("path".into(), serde_json::Value::String("notes.txt".into()));
    let mut batch = vec![
        valid_event(
            kind::USER_PROMPT,
            UserPromptOverrides {
                payload: Some(UserPromptPayload {
                    text: "please run the tool".into(),
                }),
                ..Default::default()
            },
        ),
        valid_event(
            kind::TOOL_CALL,
            ToolCallOverrides {
                payload: Some(ToolCallPayload {
                    tool_call_id: "call-fixture-1".into(),
                    tool_name: "read_file".into(),
                    arguments: args,
                }),
                ..Default::default()
            },
        ),
    ];
    if opts.missing_result != Some(true) {
        batch.push(valid_event(
            kind::TOOL_RESULT,
            ToolResultOverrides {
                payload: Some(ToolResultPayload {
                    tool_call_id: "call-fixture-1".into(),
                    content: opts
                        .result_content
                        .clone()
                        .unwrap_or_else(|| "contents of notes.txt".into()),
                    is_error: Some(opts.is_error.unwrap_or(false)),
                }),
                ..Default::default()
            },
        ));
    }
    batch.push(valid_event(kind::TURN_END, TurnEndOverrides::default()));
    send(&file_path, &batch).await;
    ThreadWithToolRunResult {
        file_path,
        turn_id: "t1".into(),
    }
}

#[derive(Debug, Clone)]
pub struct DamagedSourceThreadResult {
    pub file_path: String,
    pub turn_id: String,
}

#[derive(Debug, Clone)]
pub struct MultiStateClaim {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: DerivationType,
    pub state: DerivationState,
}

#[derive(Debug, Clone)]
pub struct MultiStateThreadResult {
    pub file_path: String,
    pub expected: Vec<MultiStateClaim>,
}

#[derive(Debug, Clone)]
pub struct ThreadWithClosedTurnsResult {
    pub file_path: String,
    pub turn_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolRunOpts {
    pub is_error: Option<bool>,
    pub missing_result: Option<bool>,
    pub result_content: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ThreadWithToolRunResult {
    pub file_path: String,
    pub turn_id: String,
}

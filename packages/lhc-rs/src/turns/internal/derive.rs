//! Ported from packages/lhc/src/turns/internal/derive.ts. Phase 1 skeleton.
//!
//! Turn derivation handlers + dispatch. Critical fidelity:
//! - `chunk_detailed_handler` / `chunk_brief_handler` are sync zero-arg factories
//!   returning [`WorkHandler`]; the handler table binds SEPARATE private handler
//!   stubs (not the factories as async handlers).
//! - `inference_failed` accepts only `{ reason: string }`.
//! - `source_damaged` / `inference_failed` / `dependency_not_ready` return
//!   [`NonOkHandlerOutcome`] (Deferred/Failed/Blocked only — never `Ok`).
//! - `DetailedChunkComposition` stays exhaustive over the same non-ok arms.
//!
//! SQL literals REAL; bodies exact `todo!("phase 2")`.

use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;

#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use crate::messages::internal::derive::write_message_derivation_floor_in_thread;
#[allow(unused_imports)]
use crate::shared_tech::context::resolve_instance_poke;
use crate::shared_tech::derivation::{
    BoxFuture, BriefTargets, CompletionTx, CompressionTargets, HandlerOutcome, HandlerRunContext,
    RenderingPart, RenderingPartKind, ResolvedSdkConfig, SizeDisposition, WorkHandler, WorkItemRef,
};
use crate::shared_tech::durable_work::DurableWorkDispatchResult;
use crate::shared_tech::errors::ErrorResult;
use crate::shared_tech::logging::LogEntry;
#[allow(unused_imports)]
use crate::shared_tech::persist::create_post_commit_hook_set;
use crate::shared_tech::storage::Db;
#[allow(unused_imports)]
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::work_queue::{
    EnqueueDerivationTarget, WorkHandlerMap, WorkKind, WorkSourceRef,
};

#[allow(unused_imports)] // Phase 2 bodies; mirror TS dependency graph
use super::chunks::{enqueue_chunk_summaries, place_turn};
#[allow(unused_imports)]
use super::compose::{compose_pre_detailed_assembly, compose_rendering_input};
#[allow(unused_imports)]
use super::derivations::{
    chunk_exists, read_chunk_summary_derivation, read_member_messages, read_member_projections,
    read_message_derivation_rows, read_turn_derivation_row, read_turn_source,
};
#[allow(unused_imports)]
use super::store::select_open_turn_ids;
#[allow(unused_imports)]
use crate::shared_tech::durable_work::{
    DerivationCompletionError, apply_derivation_success, apply_derivation_terminal_failure,
};
#[allow(unused_imports)]
use crate::shared_tech::logging::{append_derivation_log, write_log};
#[allow(unused_imports)]
use crate::shared_tech::work_queue::{create_or_claim_immediate_work_item, enqueue, has_live_item};

#[allow(dead_code)]
const SQL_SELECT_THREAD_ID: &str = r#"SELECT thread_id FROM thread_metadata WHERE id = 1"#;

#[allow(dead_code)]
const SQL_SELECT_CLAIMED_WORK_ITEM: &str =
    r#"SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed'"#;

#[allow(dead_code)]
const SQL_DELETE_CLAIMED_WORK_ITEM: &str =
    r#"DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed'"#;

/// TS `db.exec("BEGIN IMMEDIATE;")` — module-local transaction literal.
#[allow(dead_code)]
const SQL_BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE;";
/// TS `db.exec("COMMIT;")`.
#[allow(dead_code)]
const SQL_COMMIT: &str = "COMMIT;";
/// TS `db.exec("ROLLBACK;")`.
#[allow(dead_code)]
const SQL_ROLLBACK: &str = "ROLLBACK;";

/// TS `Extract<HandlerOutcome, { ok: false }>` — Deferred | Failed | Blocked
/// only (never admits `Ok`). Used by `sourceDamaged` / `inferenceFailed` /
/// `dependencyNotReady`; [`DetailedChunkComposition`] stays exhaustive over
/// the same non-ok arms.
enum NonOkHandlerOutcome {
    Deferred {
        reason: String,
        on_deferred: Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>,
    },
    Failed {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}

fn source_damaged(_reason: &str) -> NonOkHandlerOutcome {
    todo!("phase 2")
}

/// TS `inferenceFailed(result: { reason: string })` — narrow shape only.
#[derive(Debug, Clone, PartialEq, Eq)]
struct InferenceFailedReason {
    reason: String,
}

fn inference_failed(_result: &InferenceFailedReason) -> NonOkHandlerOutcome {
    todo!("phase 2")
}

fn dependency_not_ready(_reason: &str) -> NonOkHandlerOutcome {
    todo!("phase 2")
}

/// TS `renderingPartLabel` — closed vocab → exhaustive match (no wildcard).
fn rendering_part_label(kind: RenderingPartKind) -> &'static str {
    match kind {
        RenderingPartKind::UserPrompt => "User prompt",
        RenderingPartKind::AssistantText => "Assistant response",
        RenderingPartKind::AssistantThinking => "Assistant thinking",
        RenderingPartKind::RuntimeNote => "Runtime note",
        RenderingPartKind::ModelChange => "Model change",
        RenderingPartKind::ThinkingLevelChange => "Thinking level change",
        RenderingPartKind::ToolCall => "Tool call",
        RenderingPartKind::ToolResult => "Tool result",
    }
}

fn compose_structured_turn_text(_parts: &[RenderingPart]) -> String {
    todo!("phase 2")
}

fn compose_detailed_chunk_summary(_member_projections: &[String]) -> String {
    todo!("phase 2")
}

/// TS compression target token bag.
#[derive(Debug, Clone, PartialEq)]
struct CompressionTokenTargets {
    input_tokens: i64,
    target_min_tokens: i64,
    target_aim_tokens: i64,
    target_max_tokens: i64,
}

/// Closed borrowed representation of TS
/// `ResolvedSdkConfig["compressionTargets"] | ResolvedSdkConfig["briefTargets"]`.
enum CompressionRatioTargets<'a> {
    Compression(&'a CompressionTargets),
    Brief(&'a BriefTargets),
}

fn compression_target_tokens(
    _input_tokens: i64,
    _targets: CompressionRatioTargets<'_>,
) -> CompressionTokenTargets {
    todo!("phase 2")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SizeDispositionBounds {
    target_min_tokens: i64,
    target_max_tokens: i64,
}

fn size_disposition(_output_tokens: i64, _targets: SizeDispositionBounds) -> SizeDisposition {
    todo!("phase 2")
}

fn poke_thread_scheduler(_db: &Db) {
    todo!("phase 2")
}

/// TS `logFallback` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LogFallbackEntry {
    derivation_type: String,
    subject_id: String,
    reason: LogFallbackReason,
    floor_used: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogFallbackReason {
    NotReady,
    FailedFloor,
}

impl LogFallbackReason {
    fn as_str(self) -> &'static str {
        match self {
            LogFallbackReason::NotReady => "not_ready",
            LogFallbackReason::FailedFloor => "failed_floor",
        }
    }
}

fn log_fallback(_run: &HandlerRunContext, _entry: &LogFallbackEntry) {
    todo!("phase 2")
}

async fn turn_derivation_handler(_run: HandlerRunContext, _item: WorkItemRef) -> HandlerOutcome {
    todo!("phase 2")
}

async fn detailed_turn_compression_handler(
    _run: HandlerRunContext,
    _item: WorkItemRef,
) -> HandlerOutcome {
    todo!("phase 2")
}

/// TS `DetailedChunkComposition` — ok composition bag plus every
/// [`NonOkHandlerOutcome`] arm (Deferred / Failed / Blocked).
enum DetailedChunkComposition {
    Ok {
        text: String,
        fallback_logs: Vec<LogEntry>,
    },
    Deferred {
        reason: String,
        on_deferred: Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>,
    },
    Failed {
        reason: String,
    },
    Blocked {
        reason: String,
    },
}

fn compose_detailed_chunk_from_members(_db: &Db, _chunk_id: &str) -> DetailedChunkComposition {
    todo!("phase 2")
}

/// TS `function chunkDetailedHandler(): WorkHandler` — sync zero-arg factory.
fn chunk_detailed_handler() -> WorkHandler {
    todo!("phase 2")
}

/// TS `function chunkBriefHandler(): WorkHandler` — sync zero-arg factory.
fn chunk_brief_handler() -> WorkHandler {
    todo!("phase 2")
}

/// Private handler stub bound into [`TURN_WORK_HANDLERS`] for
/// `chunk_summary_detailed` (separate from the factory).
async fn chunk_summary_detailed_handler(
    _run: HandlerRunContext,
    _item: WorkItemRef,
) -> HandlerOutcome {
    todo!("phase 2")
}

/// Private handler stub bound into [`TURN_WORK_HANDLERS`] for
/// `chunk_summary_brief` (separate from the factory).
async fn chunk_summary_brief_handler(
    _run: HandlerRunContext,
    _item: WorkItemRef,
) -> HandlerOutcome {
    todo!("phase 2")
}

static TURN_DERIVATION_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { turn_derivation_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

static DETAILED_TURN_COMPRESSION_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { detailed_turn_compression_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// Exact Arc identity for the chunk_summary_detailed map entry (private seam).
/// Table binds this stub — not [`chunk_detailed_handler`] as an async handler.
static CHUNK_SUMMARY_DETAILED_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { chunk_summary_detailed_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// Exact Arc identity for the chunk_summary_brief map entry (private seam).
/// Table binds this stub — not [`chunk_brief_handler`] as an async handler.
static CHUNK_SUMMARY_BRIEF_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { chunk_summary_brief_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// TS `turnWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>>`.
/// Partial/open Record → [`IndexMap`]. Map skeleton REAL; handler bodies todo.
pub static TURN_WORK_HANDLERS: LazyLock<WorkHandlerMap> = LazyLock::new(|| {
    let mut map: WorkHandlerMap = IndexMap::new();
    map.insert(
        WorkKind::TurnDerivation,
        Arc::clone(&TURN_DERIVATION_WORK_HANDLER),
    );
    map.insert(
        WorkKind::DetailedTurnCompression,
        Arc::clone(&DETAILED_TURN_COMPRESSION_WORK_HANDLER),
    );
    // Factories exist as separate sync stubs; table binds handler seams
    // (not the factories themselves as async handlers).
    map.insert(
        WorkKind::ChunkSummaryDetailed,
        Arc::clone(&CHUNK_SUMMARY_DETAILED_WORK_HANDLER),
    );
    map.insert(
        WorkKind::ChunkSummaryBrief,
        Arc::clone(&CHUNK_SUMMARY_BRIEF_WORK_HANDLER),
    );
    map
});

/// TS `deferClaimedTurnWork` item: `{ workItemId: string }`.
struct DeferClaimedItem {
    work_item_id: String,
}

/// TS deferred txn narrow shape: `{ db, onCommit }`.
struct DeferTransaction<'a> {
    db: &'a Db,
    on_commit: Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync + 'a>,
}

fn defer_claimed_turn_work(
    _db: &Db,
    _item: &DeferClaimedItem,
    _on_deferred: Box<dyn for<'a> FnOnce(DeferTransaction<'a>) + Send>,
) -> bool {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DerivationRowForVersion {
    state: String,
    source_version: i64,
}

fn source_version_for_derive(_rows: &[DerivationRowForVersion]) -> i64 {
    todo!("phase 2")
}

/// Internal result of `deriveTurnOwnedInOpenDb` (no turnId/chunkId — caller stamps).
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOwnedDeriveResult {
    Derived { source_version: i64 },
    Failed { error: ErrorResult },
}

fn failed(_error: ErrorResult) -> TurnOwnedDeriveResult {
    todo!("phase 2")
}

fn source_ref_id(_source_ref: &WorkSourceRef) -> String {
    todo!("phase 2")
}

fn work_in_flight(
    _kind: WorkKind,
    _source_ref: &WorkSourceRef,
    _source_version: i64,
) -> TurnOwnedDeriveResult {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeriveTurnOwnedOpts {
    pub source_version: Option<i64>,
}

pub async fn derive_turn_owned_in_open_db(
    _db: &Db,
    _config: &ResolvedSdkConfig,
    _kind: WorkKind,
    _source_ref: &WorkSourceRef,
    _derivations: &[EnqueueDerivationTarget],
    _opts: Option<&DeriveTurnOwnedOpts>,
) -> TurnOwnedDeriveResult {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchTurnOwnedWorkItem {
    pub work_item_id: String,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub source_version: i64,
    pub derivations: Vec<EnqueueDerivationTarget>,
}

pub async fn dispatch_turn_owned_work(
    _run: &HandlerRunContext,
    _item: &DispatchTurnOwnedWorkItem,
) -> DurableWorkDispatchResult {
    todo!("phase 2")
}

// Keep REAL exhaustive label table + factory/handler seams referenced.
const _: fn(RenderingPartKind) -> &'static str = rendering_part_label;
const _: fn() -> WorkHandler = chunk_detailed_handler;
const _: fn() -> WorkHandler = chunk_brief_handler;
const _: fn(LogFallbackReason) -> &'static str = LogFallbackReason::as_str;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn turn_work_handlers_kinds_and_insertion_order() {
        let keys: Vec<_> = TURN_WORK_HANDLERS.keys().copied().collect();
        assert_eq!(
            keys,
            vec![
                WorkKind::TurnDerivation,
                WorkKind::DetailedTurnCompression,
                WorkKind::ChunkSummaryDetailed,
                WorkKind::ChunkSummaryBrief,
            ]
        );
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS.get(&WorkKind::TurnDerivation).unwrap(),
            &TURN_DERIVATION_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS
                .get(&WorkKind::DetailedTurnCompression)
                .unwrap(),
            &DETAILED_TURN_COMPRESSION_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS
                .get(&WorkKind::ChunkSummaryDetailed)
                .unwrap(),
            &CHUNK_SUMMARY_DETAILED_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            TURN_WORK_HANDLERS
                .get(&WorkKind::ChunkSummaryBrief)
                .unwrap(),
            &CHUNK_SUMMARY_BRIEF_WORK_HANDLER
        ));
    }
}

//! Ported from packages/lhc/src/shared-tech/derivation.ts. Phase 1 skeleton.
//!
//! Wave 0 PARTIAL types (classification + inference-callback vocab) are kept
//! unchanged. Wave 1 appends the rest of derivation.ts: state-machine read
//! shapes, metadata, SDK config, and the handler contract.
//!
//! Conventions set here (court of record):
//! - Closed TS string unions → Rust enums; serde rename matches the TS string
//!   values byte-for-byte (`snake_case` or `camelCase` per the TS source).
//! - Every vocabulary enum gets `as_str()` with an exhaustive match (no
//!   wildcard arm) — new variants force a mapping decision at compile time.
//! - `Record<string, unknown>` data bags → `serde_json::Map<String, Value>`
//!   (insertion-ordered via the preserve_order feature); keys stay verbatim
//!   camelCase — persisted data keys are bytes, not identifiers.
//! - TS interfaces of function fields (InferenceCallbacks) → structs of
//!   `Arc<dyn Fn... + Send + Sync>` async closures (clone shares Arc identity
//!   for SDK init + handler registration), matching the TS object-of-functions
//!   shape structurally.
//! - Inline TS callback input shapes → named `<Op>Input` structs.
//! - TS `() => Date` → [`Clock`] (`Box<dyn Fn() -> SystemTime + Send + Sync>`),
//!   matching Python's `Callable[[], datetime]` (lhc-py derivation.py).

use std::pin::Pin;
use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::inference_types::{DerivationGuards, InferenceConfig, ResolvedDerivationGuards};
use super::storage::Db;
use super::view::{ResolvedViewConfig, SdkViewConfig};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    Message,
    Turn,
    Chunk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivationState {
    Pending,
    Ready,
    Failed,
    Blocked,
}

impl DerivationState {
    pub fn as_str(self) -> &'static str {
        match self {
            DerivationState::Pending => "pending",
            DerivationState::Ready => "ready",
            DerivationState::Failed => "failed",
            DerivationState::Blocked => "blocked",
        }
    }
}

impl SubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Message => "message",
            SubjectKind::Turn => "turn",
            SubjectKind::Chunk => "chunk",
        }
    }
}

/// Outcome on tool-activity summaries — mechanically stamped from the record
/// (isError/presence), never authored by model text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome {
    Succeeded,
    Failed,
    Unknown,
}

impl ToolOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolOutcome::Succeeded => "succeeded",
            ToolOutcome::Failed => "failed",
            ToolOutcome::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProvenance {
    pub provider: String,
    pub model: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferenceRequestRole {
    System,
    User,
}

impl InferenceRequestRole {
    pub fn as_str(self) -> &'static str {
        match self {
            InferenceRequestRole::System => "system",
            InferenceRequestRole::User => "user",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InferenceRequestMessage {
    pub role: InferenceRequestRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InferenceResult {
    Ok {
        text: String,
        provenance: Option<ProviderProvenance>,
        request_messages: Option<Vec<InferenceRequestMessage>>,
        raw_response: Option<String>,
    },
    Err {
        reason: String,
        request_messages: Option<Vec<InferenceRequestMessage>>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultOperationClass {
    Read,
    MutationWrite,
    MutationEdit,
    Command,
    SearchOrListing,
    Verification,
    VcsInspection,
    FilesystemMutation,
    MultiTool,
    Unknown,
}

impl ToolResultOperationClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolResultOperationClass::Read => "read",
            ToolResultOperationClass::MutationWrite => "mutation_write",
            ToolResultOperationClass::MutationEdit => "mutation_edit",
            ToolResultOperationClass::Command => "command",
            ToolResultOperationClass::SearchOrListing => "search_or_listing",
            ToolResultOperationClass::Verification => "verification",
            ToolResultOperationClass::VcsInspection => "vcs_inspection",
            ToolResultOperationClass::FilesystemMutation => "filesystem_mutation",
            ToolResultOperationClass::MultiTool => "multi_tool",
            ToolResultOperationClass::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultResponseShape {
    StructuredReceipt,
    SimpleFailure,
    NoOutput,
    SearchResult,
    TestResult,
    FileContent,
    LargeFileContent,
    DiffOutput,
    LargeLog,
    MultiToolResult,
    UnknownContent,
}

impl ToolResultResponseShape {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolResultResponseShape::StructuredReceipt => "structured_receipt",
            ToolResultResponseShape::SimpleFailure => "simple_failure",
            ToolResultResponseShape::NoOutput => "no_output",
            ToolResultResponseShape::SearchResult => "search_result",
            ToolResultResponseShape::TestResult => "test_result",
            ToolResultResponseShape::FileContent => "file_content",
            ToolResultResponseShape::LargeFileContent => "large_file_content",
            ToolResultResponseShape::DiffOutput => "diff_output",
            ToolResultResponseShape::LargeLog => "large_log",
            ToolResultResponseShape::MultiToolResult => "multi_tool_result",
            ToolResultResponseShape::UnknownContent => "unknown_content",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultPromptMode {
    Receipt,
    Failure,
    NoOutput,
    SearchSummary,
    TestSummary,
    ContentSummary,
    DiffSummary,
    LargeLog,
    MultiToolSummary,
    GenericSummary,
}

impl ToolResultPromptMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolResultPromptMode::Receipt => "receipt",
            ToolResultPromptMode::Failure => "failure",
            ToolResultPromptMode::NoOutput => "no_output",
            ToolResultPromptMode::SearchSummary => "search_summary",
            ToolResultPromptMode::TestSummary => "test_summary",
            ToolResultPromptMode::ContentSummary => "content_summary",
            ToolResultPromptMode::DiffSummary => "diff_summary",
            ToolResultPromptMode::LargeLog => "large_log",
            ToolResultPromptMode::MultiToolSummary => "multi_tool_summary",
            ToolResultPromptMode::GenericSummary => "generic_summary",
        }
    }
}

/// `Record<string, unknown>` — verbatim camelCase keys, insertion-ordered.
pub type ToolResultFacts = serde_json::Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultClassification {
    pub operation_class: ToolResultOperationClass,
    pub response_shape: ToolResultResponseShape,
    pub prompt_mode: ToolResultPromptMode,
    pub facts: ToolResultFacts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmoothPromptInput {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeToolResultInput {
    pub tool_name: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ToolOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_class: Option<ToolResultOperationClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_shape: Option<ToolResultResponseShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_mode: Option<ToolResultPromptMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facts: Option<ToolResultFacts>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressDetailedTurnInput {
    pub dialogue_text: String,
    pub input_tokens: i64,
    pub target_min_tokens: i64,
    pub target_aim_tokens: i64,
    pub target_max_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeChunkBriefInput {
    pub text: String,
    pub input_tokens: i64,
    pub target_min_tokens: i64,
    pub target_aim_tokens: i64,
    pub target_max_tokens: i64,
}

/// TS `InferenceCallbacks` — an object of four async functions. Structs of
/// `Arc`-owned async closures mirror that shape; hosts construct with any
/// capture. `Clone` clones the Arcs (shared identity for init + handlers).
#[derive(Clone)]
pub struct InferenceCallbacks {
    pub smooth_prompt: Arc<dyn Fn(SmoothPromptInput) -> BoxFuture<InferenceResult> + Send + Sync>,
    pub summarize_tool_result:
        Arc<dyn Fn(SummarizeToolResultInput) -> BoxFuture<InferenceResult> + Send + Sync>,
    pub compress_detailed_turn:
        Arc<dyn Fn(CompressDetailedTurnInput) -> BoxFuture<InferenceResult> + Send + Sync>,
    pub summarize_chunk_brief:
        Arc<dyn Fn(SummarizeChunkBriefInput) -> BoxFuture<InferenceResult> + Send + Sync>,
}

pub const INFERENCE_CALLBACK_OPERATIONS: [&str; 4] = [
    "smoothPrompt",
    "summarizeToolResult",
    "compressDetailedTurn",
    "summarizeChunkBrief",
];

// ── types appended in Wave 1 (complete derivation.ts surface) ──────────────

/// TS `() => Date` — SystemTime is the Rust counterpart of a Date instant
/// (Python used `datetime`). ISO formatting is a Phase 2 concern at call sites.
pub type Clock = Box<dyn Fn() -> SystemTime + Send + Sync>;

/// A composed derivation's record of a dependency that fell back during composition:
/// names the source record and the derivation type that was not ready.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyGap {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
}

/// Mechanically stamped size outcome relative to the configured target range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SizeDisposition {
    InRange,
    UnderMin,
    OverMax,
}

impl SizeDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            SizeDisposition::InRange => "in_range",
            SizeDisposition::UnderMin => "under_min",
            SizeDisposition::OverMax => "over_max",
        }
    }
}

/// Mechanically stamped derivation metadata: tool outcomes, fallback detail,
/// and inference provenance. The queue is not an audit table; durable outcome
/// detail lives on the derivation and in derivation logs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ToolOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discard_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_floor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_attempted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_succeeded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_disposition: Option<SizeDisposition>,
    /// Which provider/model/prompt produced the content, copied from the
    /// InferenceResult's config-known strings, never authored from model output.
    /// Deterministic domain assembly never sets it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<ProviderProvenance>,
}

/// The read shape for one derivation's state row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Derivation {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
    pub state: DerivationState,
    /// ready only
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// failed | blocked
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// which version of the source this derivation derives from
    pub source_version: i64,
    /// composed derivations; landed-with-fallback record
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gaps: Option<Vec<DependencyGap>>,
    /// mechanically stamped fields; never model-authored
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DerivationMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    Queued,
    Claimed,
}

impl QueueStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            QueueStatus::Queued => "queued",
            QueueStatus::Claimed => "claimed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationReportQueue {
    pub status: QueueStatus,
}

/// One row of an owner's repair report: the derivation's durable state joined
/// with the queue's mechanical detail for the live item still working toward it,
/// if any.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationReportEntry {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
    pub state: DerivationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub source_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gaps: Option<Vec<DependencyGap>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DerivationMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<DerivationReportQueue>,
}

/// Message kinds a rendering part can carry — mirrors the intake event-kind
/// vocabulary minus turn_end (turn_end never projects a message). Mirrored
/// rather than imported: shared-tech/ may not import the domains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderingPartKind {
    UserPrompt,
    AssistantText,
    AssistantThinking,
    RuntimeNote,
    ModelChange,
    ThinkingLevelChange,
    ToolCall,
    ToolResult,
}

impl RenderingPartKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RenderingPartKind::UserPrompt => "user_prompt",
            RenderingPartKind::AssistantText => "assistant_text",
            RenderingPartKind::AssistantThinking => "assistant_thinking",
            RenderingPartKind::RuntimeNote => "runtime_note",
            RenderingPartKind::ModelChange => "model_change",
            RenderingPartKind::ThinkingLevelChange => "thinking_level_change",
            RenderingPartKind::ToolCall => "tool_call",
            RenderingPartKind::ToolResult => "tool_result",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderingPartBlock {
    pub block_type: String,
    pub content: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderingPart {
    pub message_id: String,
    pub kind: RenderingPartKind,
    /// ready derivation content, or raw/truncated fallback
    pub text: String,
    /// true ⇒ gap recorded
    pub fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<RenderingPartBlock>>,
    /// tool activity only
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ToolOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InferenceCallbackName {
    #[serde(rename = "smoothPrompt")]
    SmoothPrompt,
    #[serde(rename = "summarizeToolResult")]
    SummarizeToolResult,
    #[serde(rename = "compressDetailedTurn")]
    CompressDetailedTurn,
    #[serde(rename = "summarizeChunkBrief")]
    SummarizeChunkBrief,
}

impl InferenceCallbackName {
    pub fn as_str(self) -> &'static str {
        match self {
            InferenceCallbackName::SmoothPrompt => "smoothPrompt",
            InferenceCallbackName::SummarizeToolResult => "summarizeToolResult",
            InferenceCallbackName::CompressDetailedTurn => "compressDetailedTurn",
            InferenceCallbackName::SummarizeChunkBrief => "summarizeChunkBrief",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SdkMode {
    Background,
    Manual,
}

impl SdkMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SdkMode::Background => "background",
            SdkMode::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultConfig {
    pub small_tier_tokens: i64,
    pub small_target_ratio: f64,
    pub mid_target_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseConfig {
    pub duration_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkPolicyConfig {
    pub target_projected_tokens: i64,
    pub max_projected_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionTargets {
    pub min_ratio: f64,
    pub aim_ratio: f64,
    pub max_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefTargets {
    pub min_ratio: f64,
    pub aim_ratio: f64,
    pub max_ratio: f64,
}

/// LHC initialization config. Inference callbacks arrive exactly one way:
/// direct callback injection (`inference_callbacks`) or `inference` (host
/// model-call function + per-kind assignments).
///
/// No Debug/Clone/Serialize — holds Arc callbacks (same as InferenceCallbacks).
pub struct SdkConfig {
    pub inference_callbacks: Option<InferenceCallbacks>,
    pub inference: Option<InferenceConfig>,
    pub mode: SdkMode,
    pub clock: Option<Clock>,
    pub guards: Option<DerivationGuards>,
    /// defaults: 1000 / 0.15 / 0.04
    pub tool_result: Option<ToolResultConfig>,
    /// default: 120000
    pub lease: Option<LeaseConfig>,
    /// defaults: 2200 / 4400
    pub chunk_policy: Option<ChunkPolicyConfig>,
    /// profiles, visibility budgets, compact threshold
    pub view: Option<SdkViewConfig>,
}

/// Every optional filled by initLhc's central defaults.
///
/// No Debug/Clone/Serialize — holds boxed callbacks.
pub struct ResolvedSdkConfig {
    pub inference_callbacks: InferenceCallbacks,
    pub mode: SdkMode,
    pub clock: Clock,
    pub guards: ResolvedDerivationGuards,
    pub compression_targets: CompressionTargets,
    pub brief_targets: BriefTargets,
    pub tool_result: ToolResultConfig,
    pub lease: LeaseConfig,
    pub chunk_policy: ChunkPolicyConfig,
    pub view: ResolvedViewConfig,
}

// ── handler contract ─────────────────────────────────────────────

pub struct HandlerRunContext {
    pub thread_id: String,
    pub file_path: String,
    /// short-txn access; NEVER held across inference calls
    pub open_db: Box<dyn Fn() -> Db + Send + Sync>,
    pub inference_callbacks: InferenceCallbacks,
    pub clock: Clock,
    pub config: ResolvedSdkConfig,
}

/// A successful handler hands its derivation content back as data; the
/// drain's completion transaction performs the version-checked UPDATE and the
/// item-row deletion atomically. The handler never opens that transaction
/// itself, so the version check and the done/stale_discarded disposition stay in
/// one place: the queue util.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerDerivationWrite {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub derivation_type: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DerivationMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gaps: Option<Vec<DependencyGap>>,
}

/// TS `onCommit: (fn: () => void) => void` — registrar may be called multiple
/// times; each registered hook is one-shot (flushed once after COMMIT).
pub type OnCommitRegistration = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// Completion-transaction hook for work that must land atomically with
/// version-checked derivation writes: chunk placement and close→summary enqueues
/// above all. The queue util invokes it inside completion's BEGIN IMMEDIATE,
/// after derivation writes and only when they hit. A stale completion must not
/// place a turn or enqueue summaries. onCommit registrations flush after that
/// COMMIT succeeds and drop on rollback, so a crash leaves either a placed turn
/// with its enqueues or nothing, never a derived-but-unplaced turn.
///
/// `db` is borrowed from the outer completion transaction controller — never
/// moved out of that controller's ownership for COMMIT/ROLLBACK.
pub struct CompletionTx<'a> {
    pub db: &'a Db,
    pub on_commit: OnCommitRegistration,
}

/// In-memory handler result — carries closures, so no serde.
/// Shape matches the TS discriminated union on `ok` / `deferred` / `blocked`.
/// `onApplied` / `onDeferred` are one-shot in TS → `FnOnce`.
pub enum HandlerOutcome {
    Ok {
        derivations: Option<Vec<HandlerDerivationWrite>>,
        on_applied: Option<Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>>,
    },
    Deferred {
        reason: String,
        on_deferred: Box<dyn for<'a> FnOnce(CompletionTx<'a>) + Send>,
    },
    Failed {
        reason: String,
    },
    /// source damage → derivation blocked, item terminal
    Blocked {
        reason: String,
    },
}

/// item is the queue util's WorkItemRecord; typed structurally here so the
/// shared layer does not depend on the util's module (and vice versa stays
/// one-directional: tech-utils imports shared).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRef {
    pub work_item_id: String,
    pub kind: String,
    /// `Record<string, string>` — insertion-ordered (JSON.stringify contract).
    pub source_ref: indexmap::IndexMap<String, String>,
}

/// Cloneable handler registration (TS function reference identity via [`Arc::ptr_eq`]).
pub type WorkHandler =
    Arc<dyn Fn(HandlerRunContext, WorkItemRef) -> BoxFuture<HandlerOutcome> + Send + Sync>;

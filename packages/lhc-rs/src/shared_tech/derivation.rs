//! Ported from packages/lhc/src/shared-tech/derivation.ts. Phase 1 skeleton.
//!
//! Wave 0 PARTIAL: only the vocabulary the exemplar modules need — the
//! tool-result classification types, InferenceResult, and the
//! InferenceCallbacks boundary. Wave 1 EXTENDS this file with the rest of
//! derivation.ts (state machine, handler contract, metadata); do not reshape
//! what is here.
//!
//! Conventions set here (court of record):
//! - Closed TS string unions → Rust enums; serde rename matches the TS string
//!   values byte-for-byte (`snake_case` or `camelCase` per the TS source).
//! - Every vocabulary enum gets `as_str()` with an exhaustive match (no
//!   wildcard arm) — new variants force a mapping decision at compile time.
//! - `Record<string, unknown>` data bags → `serde_json::Map<String, Value>`
//!   (insertion-ordered via the preserve_order feature); keys stay verbatim
//!   camelCase — persisted data keys are bytes, not identifiers.
//! - TS interfaces of function fields (InferenceCallbacks) → structs of boxed
//!   async closures, matching the TS object-of-functions shape structurally.
//! - Inline TS callback input shapes → named `<Op>Input` structs.

use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
/// boxed async closures mirror that shape; hosts construct with any capture.
pub struct InferenceCallbacks {
    pub smooth_prompt: Box<dyn Fn(SmoothPromptInput) -> BoxFuture<InferenceResult> + Send + Sync>,
    pub summarize_tool_result:
        Box<dyn Fn(SummarizeToolResultInput) -> BoxFuture<InferenceResult> + Send + Sync>,
    pub compress_detailed_turn:
        Box<dyn Fn(CompressDetailedTurnInput) -> BoxFuture<InferenceResult> + Send + Sync>,
    pub summarize_chunk_brief:
        Box<dyn Fn(SummarizeChunkBriefInput) -> BoxFuture<InferenceResult> + Send + Sync>,
}

pub const INFERENCE_CALLBACK_OPERATIONS: [&str; 4] = [
    "smoothPrompt",
    "summarizeToolResult",
    "compressDetailedTurn",
    "summarizeChunkBrief",
];

//! Ported from packages/lhc/src/messages/internal/handlers.ts. Phase 1 skeleton.
//!
//! FORCE_TOOL_RESULT_SUMMARY_FALLBACK + MARKER_PROMPT_PATTERN private (TS
//! module-local). `MESSAGE_WORK_HANDLERS` exported map skeleton REAL; derive/
//! handler bodies `todo!("phase 2")`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Value};

use crate::shared_tech::derivation::{
    BoxFuture, HandlerDerivationWrite, HandlerOutcome, HandlerRunContext, InferenceRequestMessage,
    ResolvedSdkConfig, ToolOutcome, WorkHandler, WorkItemRef,
};
use crate::shared_tech::logging::LogEntry;
use crate::shared_tech::work_queue::{WorkHandlerMap, WorkKind};

use super::derivations::MessageSource;

/// TS `FORCE_TOOL_RESULT_SUMMARY_FALLBACK` — private.
#[allow(dead_code)]
const FORCE_TOOL_RESULT_SUMMARY_FALLBACK: bool = true;

/// TS `MARKER_PROMPT_PATTERN = /^\[[^\]]{1,80}\]$/` — private.
#[allow(dead_code)]
static MARKER_PROMPT_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[[^\]]{1,80}\]$").expect("MARKER_PROMPT_PATTERN"));

fn source_damaged(_reason: &str) -> HandlerOutcome {
    todo!("phase 2")
}

enum LoadSourceResult {
    Ok {
        message_id: String,
        source: MessageSource,
    },
    Err {
        outcome: HandlerOutcome,
    },
}

/// TS `loadSource` item: `{ sourceRef: Record<string, string> }` — narrower
/// than [`WorkItemRef`]; only `sourceRef` is in the helper contract.
struct LoadSourceItem {
    source_ref: HashMap<String, String>,
}

fn load_source(
    _run: &HandlerRunContext,
    _item: &LoadSourceItem,
    _expected_kind: &str,
) -> LoadSourceResult {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct SmoothedPromptDerivation {
    pub write: HandlerDerivationWrite,
    pub warning_log: Option<LogEntry>,
}

pub fn is_marker_prompt(_text: &str) -> bool {
    todo!("phase 2")
}

/// TS `deriveSmoothedPrompt` — derivation write or inference failure.
pub enum DeriveSmoothedPromptResult {
    Derived(SmoothedPromptDerivation),
    InferenceFailed {
        reason: String,
        request_messages: Option<Vec<InferenceRequestMessage>>,
    },
}

pub async fn derive_smoothed_prompt(
    _run: &HandlerRunContext,
    _message_id: &str,
    _text: &str,
) -> DeriveSmoothedPromptResult {
    todo!("phase 2")
}

async fn smooth_prompt_handler(_run: HandlerRunContext, _item: WorkItemRef) -> HandlerOutcome {
    todo!("phase 2")
}

pub fn tool_result_target_tokens(_tokens: i64, _config: &ResolvedSdkConfig) -> i64 {
    todo!("phase 2")
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultSummaryDerivation {
    pub write: HandlerDerivationWrite,
    pub request_messages: Option<Vec<InferenceRequestMessage>>,
    pub raw_response: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeriveToolResultSummaryInput {
    pub tool_name: String,
    pub tool_input: Option<Map<String, Value>>,
    pub content: String,
    pub outcome: ToolOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeriveToolResultSummaryOpts {
    pub use_inference: Option<bool>,
}

/// TS `deriveToolResultSummary` — derivation write or inference failure.
pub enum DeriveToolResultSummaryResult {
    Derived(ToolResultSummaryDerivation),
    InferenceFailed {
        reason: String,
        request_messages: Option<Vec<InferenceRequestMessage>>,
    },
}

pub async fn derive_tool_result_summary(
    _run: &HandlerRunContext,
    _message_id: &str,
    _input: &DeriveToolResultSummaryInput,
    _opts: Option<&DeriveToolResultSummaryOpts>,
) -> DeriveToolResultSummaryResult {
    todo!("phase 2")
}

async fn tool_result_summary_handler(
    _run: HandlerRunContext,
    _item: WorkItemRef,
) -> HandlerOutcome {
    todo!("phase 2")
}

/// Exact Arc identity for the PromptSmoothing map entry (private seam).
static SMOOTH_PROMPT_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { smooth_prompt_handler(run, item).await }) as BoxFuture<HandlerOutcome>
    })
});

/// Exact Arc identity for the ToolResultSummary map entry (private seam).
static TOOL_RESULT_SUMMARY_WORK_HANDLER: LazyLock<WorkHandler> = LazyLock::new(|| {
    Arc::new(|run, item| {
        Box::pin(async move { tool_result_summary_handler(run, item).await })
            as BoxFuture<HandlerOutcome>
    })
});

/// TS `messageWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>>`.
/// Map skeleton REAL (two domain kinds); handler bodies remain Phase 2 todos.
pub static MESSAGE_WORK_HANDLERS: LazyLock<WorkHandlerMap> = LazyLock::new(|| {
    let mut map: WorkHandlerMap = IndexMap::new();
    map.insert(
        WorkKind::PromptSmoothing,
        Arc::clone(&SMOOTH_PROMPT_WORK_HANDLER),
    );
    map.insert(
        WorkKind::ToolResultSummary,
        Arc::clone(&TOOL_RESULT_SUMMARY_WORK_HANDLER),
    );
    map
});

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn message_work_handlers_kinds_and_insertion_order() {
        let keys: Vec<_> = MESSAGE_WORK_HANDLERS.keys().copied().collect();
        assert_eq!(
            keys,
            vec![WorkKind::PromptSmoothing, WorkKind::ToolResultSummary]
        );
        assert!(Arc::ptr_eq(
            MESSAGE_WORK_HANDLERS
                .get(&WorkKind::PromptSmoothing)
                .unwrap(),
            &*SMOOTH_PROMPT_WORK_HANDLER
        ));
        assert!(Arc::ptr_eq(
            MESSAGE_WORK_HANDLERS
                .get(&WorkKind::ToolResultSummary)
                .unwrap(),
            &*TOOL_RESULT_SUMMARY_WORK_HANDLER
        ));
    }
}

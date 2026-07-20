"""Ported from packages/lhc/src/messages/internal/handlers.ts. Phase 1 skeleton.

Message-level derivation handlers share one shape: read the source message,
optionally join its call-id pair, and return derivation content through
HandlerOutcome. The drain's completion transaction does the version-checked
UPDATE-only write, so stale or deleted sources discard here exactly as
everywhere else. Tool-activity outcomes come from outcome.ts, never inference
text, and land in derivation metadata apart from content.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Union

from ...shared_tech.derivation import (
    HandlerDerivationWrite,
    HandlerOutcome,
    HandlerRunContext,
    InferenceErr,
    InferenceRequestMessage,
    ResolvedSdkConfig,
    ToolOutcome,
    WorkHandler,
    WorkItemRef,
)
from ...shared_tech.logging import LogEntry
from ...shared_tech.work_queue import WorkKind
from .derivations import MessageSource

_FORCE_TOOL_RESULT_SUMMARY_FALLBACK = True

# Harness marker prompts ("[Request interrupted by user]") are machine text:
# smoothing inference returns empty output on them, burning retries for a
# verbatim fallback. A prompt whose entire trimmed content is one short
# bracketed marker stores its cleaned text directly instead.
_MARKER_PROMPT_PATTERN = re.compile(r"^\[[^\]]{1,80}\]$")


# A handler that cannot read its source coherently has found source damage:
# terminal, derivation blocked with the reason (never a retry loop against a
# record that cannot improve). A *deleted* source never reaches this — its
# derivation row is gone and the completion write would discard — so a miss here
# is genuine corruption.
def _source_damaged(reason: str) -> HandlerOutcome:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class _LoadSourceOk:
    message_id: str
    source: MessageSource
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class _LoadSourceErr:
    outcome: HandlerOutcome
    ok: Literal[False] = False


_LoadSourceResult = Union[_LoadSourceOk, _LoadSourceErr]


# TS: loadSource(..., item: { sourceRef: Record<string, string> }, ...)
# Narrower than WorkItemRef — only sourceRef is required for this helper.
@dataclass(frozen=True, slots=True)
class _LoadSourceItem:
    source_ref: dict[str, str]


def _load_source(
    run: HandlerRunContext,
    item: _LoadSourceItem,
    expected_kind: str,
) -> _LoadSourceResult:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class SmoothedPromptDerivation:
    write: HandlerDerivationWrite
    warning_log: LogEntry | None = None


def is_marker_prompt(text: str) -> bool:
    raise NotImplementedError


async def derive_smoothed_prompt(
    run: HandlerRunContext,
    message_id: str,
    text: str,
) -> SmoothedPromptDerivation | InferenceErr:
    raise NotImplementedError


async def _smooth_prompt_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    raise NotImplementedError


def tool_result_target_tokens(tokens: int, config: ResolvedSdkConfig) -> int:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class ToolResultSummaryInput:
    tool_name: str
    content: str
    outcome: ToolOutcome
    tool_input: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class ToolResultSummaryOpts:
    use_inference: bool | None = None


@dataclass(frozen=True, slots=True)
class ToolResultSummaryDerivation:
    write: HandlerDerivationWrite
    request_messages: list[InferenceRequestMessage] | None = None
    raw_response: str | None = None


async def derive_tool_result_summary(
    run: HandlerRunContext,
    message_id: str,
    input: ToolResultSummaryInput,
    opts: ToolResultSummaryOpts | None = None,
) -> ToolResultSummaryDerivation | InferenceErr:
    raise NotImplementedError


async def _tool_result_summary_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    raise NotImplementedError


# The domain's handler table is merged into the SDK dispatch map at
# construction. Turn-owned kinds stay with the turns domain.
message_work_handlers: dict[WorkKind, WorkHandler] = {
    "prompt_smoothing": _smooth_prompt_handler,
    "tool_result_summary": _tool_result_summary_handler,
}

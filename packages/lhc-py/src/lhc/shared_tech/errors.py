"""Ported from packages/lhc/src/shared-tech/errors.ts. Phase 1 skeleton.

EXEMPLAR MODULE — canonical pattern for porting a types-and-constants file.
Union types become Literal aliases, interfaces become frozen dataclasses,
functions become NotImplementedError skeletons with full signatures.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, Literal, TypeVar, Union

ErrorClass = Literal["caller_error", "state_corruption", "system_error"]

ErrorCode = Literal[
    "path_exists",
    "thread_not_found",
    "ambiguous_thread_id",  # caller_error — a partial thread id matched more than one thread (A-8 partial-id resolve)
    "conflicting_lhc_launch_flags",  # caller_error — mutually exclusive pi-lhc extension launch flags set together
    "invalid_thread_ref",  # empty/blank file path or otherwise unusable reference
    "invalid_event",
    "empty_batch",
    "turn_state_corrupt",
    "storage_failure",
    # Message/turn mutation and derivation errors:
    "turn_open",  # caller_error — mutation against an open turn
    "message_initiates_turn",  # caller_error — delete refused toward turns.delete
    "message_not_found",  # caller_error
    "turn_not_found",  # caller_error
    "unknown_work_kind",  # state_corruption — unregistered kind at dispatch
    "provider_failure",  # system_error — inference failed; derivation.reason carries detail
    "source_damaged",  # state_corruption — handler found corrupt source; derivation blocked
    "inference_unavailable",  # caller_error — synchronous derivation called outside an SDK inference seam
    "derivation_work_in_flight",  # caller_error — synchronous derive refused because equivalent queued work is live
    "derivation_completion_mismatch",  # state_corruption — handler writes did not exactly match queued derivation targets
    # Surface-skeleton stub contract: machine-readable, never a throw on the
    # thread-view surface.
    "not_implemented",  # system_error — operation's story has not landed yet
    # Compact-time config rejection: unlike SDK construction, a bad compact
    # invocation is an operational caller error returned as a result.
    "unknown_profile",  # caller_error — named profile not configured
    "invalid_view_config",  # caller_error — band sum / bound violation, named
    "compact_stopped",  # caller_error — caller stopped compact before it wrote a view
    # materialize accepts pi-session only; an unknown format is a caller error
    # naming the accepted values.
    "unknown_format",  # caller_error — materialize format not supported
    # Bounded listing: a bad bounds option is an operational caller error
    # returned as a result, mirroring the compact-params precedent.
    "invalid_bounds",  # caller_error — list bounds option rejected
    "invalid_target_tokens",  # caller_error — prune targetTokens rejected
]


@dataclass(frozen=True, slots=True)
class ErrorResult:
    error_class: ErrorClass
    code: ErrorCode
    reason: str  # human-readable; machine logic switches on code
    event_index: int | None = None  # present on batch validation failures


T = TypeVar("T")


# Expected operational failures — caller errors, corruption, environment
# failures — are always returned as OpResult errors, never thrown.
# Programmer bugs inside lhc may still throw; callers are not expected
# to handle throws as contract outcomes.
@dataclass(frozen=True, slots=True)
class OpOk(Generic[T]):
    value: T
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class OpErr:
    error: ErrorResult
    ok: Literal[False] = False


OpResult = Union[OpOk[T], OpErr]


# Infrastructure failures (SQLite, fs) are expected operational outcomes,
# caught at the operation boundary and wrapped with the underlying detail.
def storage_failure(reason: str) -> OpErr:
    raise NotImplementedError

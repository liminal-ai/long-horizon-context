"""Ported from packages/lhc/test/fixtures/index.ts (+ sibling helpers). Phase 1.

Pure data-construction helpers (valid_event, temp_store, …) are REAL.
Helpers that call the SDK or open real DB seams are skeletons (or thin
wrappers that reach a skeleton).
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar, cast

from lhc.intake_stream import EventKind, MessageEventInput
from lhc.shared_tech.storage import Database, open_database

from .corrupt import (
    NOT_JSON,
    corrupt_two_open_turns,
    poison_message_block_json,
    poison_message_form_json,
)
from .inference_callbacks_double import (
    CapturedInput,
    InferenceCallbackOpName,
    InferenceCallbacksDouble,
    create_inference_callbacks_double,
)
from .intake_seam import IntakeWalkHook, set_intake_clock, set_intake_walk_hook
from .model_call import (
    DERIVATION_TYPES,
    FAKE_MODEL_PREFIX,
    FAKE_PROVIDER_PREFIX,
    INFERENCE_DERIVATION_TYPES,
    DerivationType,
    InferenceDerivationType,
    canned_responses,
    hanging_call,
    recording_call,
    scripted_call,
    throwing_call,
    valid_assignments,
)
from .read_only_delta import ObservableState, expect_read_only, observable_state
from .seam_conformance import (
    RoutingRunResult,
    assert_model_call_contract,
    assert_routing_through_sdk,
    probe_input,
)
from .threads import (
    GAPPED_SMOOTHING_REASON,
    damaged_source_thread,
    gapped_rendering_thread,
    multi_state_thread,
    read_chunks,
    read_derived_forms,
    set_form_state,
    thread_with_closed_turns,
    thread_with_tool_run,
)
from .work_handlers import (
    make_test_work_handlers,
    register_test_work_handlers,
)
from .lifecycle import (
    DELETE_TARGET,
    DELETED_MESSAGE_TEXT,
    EDIT_TARGET,
    EDITED_MESSAGE_TEXT,
    LIFECYCLE_PROFILE,
    LifecycleCheckpoint,
    LifecycleOptions,
    LifecyclePhases,
    LifecycleRun,
    create_lifecycle_sdk,
    run_lifecycle,
)
from .pi_session_format import (
    ParsedSession,
    assert_pi_session_conformance,
    load_pi_session_fixture,
)
from .view_boundary import (
    TurnedToolResultsSpec,
    boundary_tokens,
    boundary_tool_run,
    seed_turned_tool_results,
    turned_tool_result_events,
)
from .view_seam import (
    ViewInjectionHook,
    ViewInjectionPoint,
    fire_view_injection,
    seed_view_boundary,
    set_view_injection_hook,
)
from .view_thread import (
    PERMANENT_FAILURE_REASON,
    RATE_LIMIT_FAILURE_REASON,
    DerivedThreadFixture,
    DerivedThreadOptions,
    MixedStateFixture,
    MutationInFlightFixture,
    blocked_sibling_thread,
    corrupted_variant_thread,
    derived_thread_fixture,
    mixed_state_variant_thread,
    mutation_in_flight_variant,
)

K = TypeVar("K", bound=EventKind)

_key_counter = 0

_DEFAULT_PAYLOADS: dict[EventKind, Callable[[], dict[str, Any]]] = {
    "user_prompt": lambda: {"text": "please read the file"},
    "assistant_text": lambda: {"text": "here is what I found"},
    "assistant_thinking": lambda: {"text": "considering the file contents"},
    "runtime_note": lambda: {"text": "harness restarted mid-turn"},
    "model_change": lambda: {"previousModel": "gpt-5", "newModel": "gpt-5.1"},
    "thinking_level_change": lambda: {"previousLevel": "medium", "newLevel": "high"},
    "tool_call": lambda: {
        "toolCallId": "call-1",
        "toolName": "read_file",
        "arguments": {"path": "notes.txt"},
    },
    "tool_result": lambda: {
        "toolCallId": "call-1",
        "content": "contents of notes.txt",
        "isError": False,
    },
    "turn_end": lambda: {},
}


def valid_event(kind: K, overrides: dict[str, Any] | None = None) -> MessageEventInput:
    """Returns the discriminated MessageEventInput member for its kind.

    Pure data construction — real in Phase 1 so tests fail on SDK calls, not
    fixture construction.
    """
    global _key_counter
    _key_counter += 1
    base: dict[str, Any] = {
        "eventKind": kind,
        "idempotencyKey": f"fixture-key-{_key_counter}",
        "actor": "fixture-actor",
        "harness": "fixture-harness",
        "payload": _DEFAULT_PAYLOADS[kind](),
    }
    if overrides:
        base = {**base, **overrides}
        # If overrides include payload, it replaces; if nested merge desired,
        # callers pass the full payload (matches TS spread behavior).
    return cast(MessageEventInput, base)


def event_batch(kinds: list[EventKind] | tuple[EventKind, ...]) -> list[MessageEventInput]:
    return [valid_event(kind) for kind in kinds]


def conversation_turn() -> list[MessageEventInput]:
    return event_batch(
        ["user_prompt", "assistant_text", "tool_call", "tool_result", "turn_end"]
    )


@dataclass
class TempStore:
    dir: str
    registry_path: str
    _thread_counter: int = 0

    def thread_path(self, name: str | None = None) -> str:
        self._thread_counter += 1
        label = name if name is not None else f"thread-{self._thread_counter}"
        return str(Path(self.dir) / f"{label}.sqlite")

    def cleanup(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def temp_store() -> TempStore:
    dir_path = tempfile.mkdtemp(prefix="lhc-test-")
    return TempStore(dir=dir_path, registry_path=str(Path(dir_path) / "registry.sqlite"))


def open_raw(path: str) -> Database:
    """Direct sqlite handle for below-SDK assertions. Reaches open_database."""
    return open_database(path)


__all__ = [
    "DERIVATION_TYPES",
    "FAKE_MODEL_PREFIX",
    "FAKE_PROVIDER_PREFIX",
    "GAPPED_SMOOTHING_REASON",
    "INFERENCE_DERIVATION_TYPES",
    "LIFECYCLE_PROFILE",
    "NOT_JSON",
    "DELETE_TARGET",
    "DELETED_MESSAGE_TEXT",
    "EDIT_TARGET",
    "EDITED_MESSAGE_TEXT",
    "PERMANENT_FAILURE_REASON",
    "RATE_LIMIT_FAILURE_REASON",
    "CapturedInput",
    "DerivationType",
    "DerivedThreadFixture",
    "DerivedThreadOptions",
    "InferenceCallbackOpName",
    "InferenceCallbacksDouble",
    "InferenceDerivationType",
    "IntakeWalkHook",
    "LifecycleCheckpoint",
    "LifecycleOptions",
    "LifecyclePhases",
    "LifecycleRun",
    "MixedStateFixture",
    "MutationInFlightFixture",
    "ObservableState",
    "ParsedSession",
    "RoutingRunResult",
    "TempStore",
    "TurnedToolResultsSpec",
    "ViewInjectionHook",
    "ViewInjectionPoint",
    "assert_model_call_contract",
    "assert_pi_session_conformance",
    "assert_routing_through_sdk",
    "blocked_sibling_thread",
    "boundary_tokens",
    "boundary_tool_run",
    "canned_responses",
    "conversation_turn",
    "corrupt_two_open_turns",
    "corrupted_variant_thread",
    "create_inference_callbacks_double",
    "create_lifecycle_sdk",
    "damaged_source_thread",
    "derived_thread_fixture",
    "event_batch",
    "expect_read_only",
    "fire_view_injection",
    "gapped_rendering_thread",
    "hanging_call",
    "load_pi_session_fixture",
    "mixed_state_variant_thread",
    "multi_state_thread",
    "mutation_in_flight_variant",
    "observable_state",
    "open_raw",
    "poison_message_block_json",
    "poison_message_form_json",
    "probe_input",
    "read_chunks",
    "read_derived_forms",
    "recording_call",
    "make_test_work_handlers",
    "register_test_work_handlers",
    "run_lifecycle",
    "scripted_call",
    "seed_turned_tool_results",
    "seed_view_boundary",
    "set_form_state",
    "set_intake_clock",
    "set_intake_walk_hook",
    "set_view_injection_hook",
    "temp_store",
    "thread_with_closed_turns",
    "thread_with_tool_run",
    "throwing_call",
    "turned_tool_result_events",
    "valid_assignments",
    "valid_event",
]

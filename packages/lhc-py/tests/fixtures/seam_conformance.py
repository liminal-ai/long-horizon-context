"""Ported from packages/lhc/test/fixtures/seam-conformance.ts. Phase 1 skeleton.

Parameterized seam-contract assertions (Epic 05 DD-13): the same helpers run
against the scripted fakes (TC-1.2) and, unchanged, against the real
OpenRouter host (TC-4.3) — shared assertion code, never duplicated tests.

`probe_input` is pure data construction — real. The assertion helpers reach
the ModelCall boundary and the SDK, so they are skeletons.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from lhc.sdk import Lhc, NewThreadInput, init_lhc
from lhc.shared_tech.derivation import Derivation
from lhc.shared_tech.inference_types import (
    ModelAssignment,
    ModelCall,
    ModelCallInput,
    ModelCallMessage,
    ThinkingLevel,
)

from .model_call import (
    DERIVATION_TYPES,
    INFERENCE_DERIVATION_TYPES,
    InferenceDerivationType,
)
from .threads import read_derived_forms

if TYPE_CHECKING:
    from . import TempStore

# TS `const FAILURE_KINDS = new Set([...])` — private; never mutated after init.
# frozenset is fine (TS only calls `.has`); NOTE: mutable set would also match.
_FAILURE_KINDS = frozenset(
    {"rate_limit", "timeout", "network", "empty_output", "other", "auth", "invalid_request"}
)


class _ProbeInputOverrides(TypedDict, total=False):
    provider: str
    model: str
    messages: list[ModelCallMessage]
    thinking: ThinkingLevel | None


def probe_input(overrides: _ProbeInputOverrides | None = None) -> ModelCallInput:
    """Pure data construction — real. See `model-call.ts`'s validAssignments for the pattern."""
    fields: dict[str, object] = {
        "provider": "probe-provider",
        "model": "probe-model",
        "messages": [
            {"role": "system", "content": "You answer with one word."},
            {"role": "user", "content": "Say ok."},
        ],
    }
    if overrides:
        fields.update(overrides)
    return ModelCallInput(**fields)  # type: ignore[arg-type]


# AC-1.2's result contract on one probe call: a ModelCall resolves to either
# `{ok: True, text}` or `{ok: False, kind, message}` with `kind` from the
# failure vocabulary. Catches fixture (and real-host) drift from the
# boundary contract.
async def assert_model_call_contract(call: ModelCall, probe: ModelCallInput | None = None) -> None:
    result = await call(probe if probe is not None else probe_input())
    assert result is not None and (isinstance(result, dict) or hasattr(result, "ok")), (
        "ModelCall must resolve to a result object"
    )
    ok = result.get("ok") if isinstance(result, dict) else result.ok
    if ok is True:
        text = result.get("text") if isinstance(result, dict) else result.text
        assert isinstance(text, str), "success result must carry string text"
    elif ok is False:
        kind = result.get("kind") if isinstance(result, dict) else result.kind
        message = result.get("message") if isinstance(result, dict) else result.message
        assert kind in _FAILURE_KINDS, (
            f'failure kind "{kind}" is not in the failure vocabulary'
        )
        assert isinstance(message, str), "failure result must carry a string message"
    else:
        raise AssertionError("ModelCall result must discriminate on a boolean ok")


@dataclass(frozen=True, slots=True)
class RoutingRunResult:
    sdk: Lhc
    file_path: str
    derivations: list[Derivation]
    log: list[ModelCallInput]


async def _seed_all_seven_kinds(sdk: Lhc, store: "TempStore") -> str:
    # Imported lazily because fixtures.__init__ re-exports this module before
    # defining valid_event.
    from . import valid_event

    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    assert created.ok, "conformance fixture: thread creation failed"
    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event(
                "user_prompt",
                {"payload": {"text": "please inspect the fixture file"}},
            ),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-seam-1",
                        "toolName": "read_file",
                        "arguments": {"path": "fixture.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-seam-1",
                        "content": "contents of fixture.txt " * 1500,
                        "isError": False,
                    }
                },
            ),
            valid_event(
                "assistant_text",
                {"payload": {"text": "the fixture file holds fixture text"}},
            ),
            valid_event("turn_end"),
            valid_event(
                "user_prompt",
                {"payload": {"text": "thanks, now summarize it"}},
            ),
            valid_event("assistant_text", {"payload": {"text": "summarized"}}),
            valid_event("turn_end"),
        ],
    )
    assert result.ok, "conformance fixture: intake batch failed"
    return file_path


# TC-1.2's routing assertions, extracted so TC-4.3 runs them against the real
# host unchanged: construct an SDK on the inference path, drive all
# derivation kinds through a real intake -> drain, and assert (1) every kind
# lands ready, (2) every call that crossed the boundary carried exactly one
# inference kind's assigned provider/model routing keys, (3) each inference
# kind's lane was exercised, and (4) every messages value is single-turn
# shape (AC-1.2, AC-1.4).
async def assert_routing_through_sdk(
    call: ModelCall,
    assignments: dict[InferenceDerivationType, ModelAssignment],
    store: "TempStore",
) -> RoutingRunResult:
    log: list[ModelCallInput] = []

    async def logged(input: ModelCallInput):
        log.append(copy.deepcopy(input))
        return await call(input)

    sdk = init_lhc(
        {
            "inference": {"call": logged, "assignments": assignments},
            "mode": "manual",
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
            "chunkPolicy": {
                "targetProjectedTokens": 5,
                "maxProjectedTokens": 4400,
            },
        }
    )
    file_path = await _seed_all_seven_kinds(sdk, store)

    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok, "conformance drain failed"
    assert drained.value.stopped_because == "empty", (
        "conformance drain left work behind"
    )
    assert drained.value.remaining == 0, "conformance drain left items remaining"

    forms = read_derived_forms(file_path)
    for kind in DERIVATION_TYPES:
        assert any(
            form.derivation_type == kind and form.state == "ready"
            for form in forms
        ), f"expected at least one ready {kind} form after the drain"

    assert log, "no calls crossed the ModelCall boundary"
    for input in log:
        matched = [
            kind
            for kind in INFERENCE_DERIVATION_TYPES
            if assignments[kind].provider == input.provider
            and assignments[kind].model == input.model
        ]
        assert matched, (
            f'call carried provider/model "{input.provider}"/"{input.model}" '
            "matching no kind's assignment"
        )
        assert input.messages, "a call crossed the boundary with no messages"
        assert any(message["role"] == "user" for message in input.messages), (
            "single-turn shape requires a user message"
        )
        for message in input.messages:
            assert message["role"] in ("system", "user"), (
                f'message role "{message["role"]}" is outside the '
                "single-turn vocabulary"
            )
            assert isinstance(message["content"], str), (
                "message content must be a string"
            )
    for kind in INFERENCE_DERIVATION_TYPES:
        assert any(
            input.provider == assignments[kind].provider
            and input.model == assignments[kind].model
            for input in log
        ), f"no boundary call carried {kind}'s assigned provider/model lane"

    return RoutingRunResult(
        sdk=sdk,
        file_path=file_path,
        derivations=forms,
        log=log,
    )


__all__ = [
    "RoutingRunResult",
    "assert_model_call_contract",
    "assert_routing_through_sdk",
    "probe_input",
]

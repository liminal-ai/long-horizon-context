"""Ported from packages/lhc/test/fixtures/seam-conformance.ts. Phase 1 skeleton.

Parameterized seam-contract assertions (Epic 05 DD-13): the same helpers run
against the scripted fakes (TC-1.2) and, unchanged, against the real
OpenRouter host (TC-4.3) — shared assertion code, never duplicated tests.

`probe_input` is pure data construction — real. The assertion helpers reach
the ModelCall boundary and the SDK, so they are skeletons.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

from lhc.sdk import Lhc
from lhc.shared_tech.derivation import Derivation
from lhc.shared_tech.inference_types import (
    ModelAssignment,
    ModelCall,
    ModelCallInput,
    ModelCallMessage,
    ThinkingLevel,
)

from .model_call import InferenceDerivationType

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
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class RoutingRunResult:
    sdk: Lhc
    file_path: str
    derivations: list[Derivation]
    log: list[ModelCallInput]


async def _seed_all_seven_kinds(sdk: Lhc, store: "TempStore") -> str:
    raise NotImplementedError


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
    raise NotImplementedError


__all__ = [
    "RoutingRunResult",
    "assert_model_call_contract",
    "assert_routing_through_sdk",
    "probe_input",
]

"""Ported from packages/lhc/src/shared-tech/prompts/index.ts.

Name-keyed prompt registry: one module per template exporting
`{ name, render(input) → messages }`. Config selects by name, and dial-in
swaps by adding a module and editing config, with no handler, adapter, or
host changes. Versioning is in the name (`smoothing-v1`).

Intentional name shadow: after import, package attributes like
`chunk_brief_v2` are the template *instances*, not the submodules. The
submodules remain reachable via importlib / sys.modules
(`lhc.shared_tech.prompts.chunk_brief_v2` as a module path). See
tests/test_prompts_shadow.py.
"""

from __future__ import annotations

from typing import Generic, Protocol, TypeVar

from ..inference_types import ModelCallMessage
from .chunk_brief_v1 import chunk_brief_v1
from .chunk_brief_v2 import chunk_brief_v2
from .chunk_brief_v3 import chunk_brief_v3
from .detailed_turn_compression_v1 import detailed_turn_compression_v1
from .detailed_turn_compression_v2 import detailed_turn_compression_v2
from .detailed_turn_compression_v3 import detailed_turn_compression_v3
from .smoothing_v1 import smoothing_v1
from .tool_result_v1 import tool_result_v1
from .tool_result_v2 import tool_result_v2

I = TypeVar("I")


class PromptTemplate(Protocol, Generic[I]):
    name: str

    def render(self, input: I) -> list[ModelCallMessage]: ...


# Every config-selectable name. Rendering goes through the adapter, which owns
# the only kind→input pairing.
PROMPT_REGISTRY: dict[str, PromptTemplate[object]] = {
    smoothing_v1.name: smoothing_v1,  # type: ignore[dict-item]
    tool_result_v1.name: tool_result_v1,  # type: ignore[dict-item]
    tool_result_v2.name: tool_result_v2,  # type: ignore[dict-item]
    detailed_turn_compression_v1.name: detailed_turn_compression_v1,  # type: ignore[dict-item]
    detailed_turn_compression_v2.name: detailed_turn_compression_v2,  # type: ignore[dict-item]
    detailed_turn_compression_v3.name: detailed_turn_compression_v3,  # type: ignore[dict-item]
    chunk_brief_v1.name: chunk_brief_v1,  # type: ignore[dict-item]
    chunk_brief_v2.name: chunk_brief_v2,  # type: ignore[dict-item]
    chunk_brief_v3.name: chunk_brief_v3,  # type: ignore[dict-item]
}

# Every config-selectable prompt name — the catalog an operator's assignment
# config picks from. Exposed through the SDK surface so valid names are
# discoverable without reading source.
PROMPT_NAMES: tuple[str, ...] = tuple(PROMPT_REGISTRY.keys())

# The default template per derivation type — the defaults an operator's first
# config reaches for, and what test fixtures assign.
DEFAULT_PROMPT_NAMES: dict[str, str] = {
    "smoothed_prompt": smoothing_v1.name,
    "tool_result_summary": tool_result_v2.name,
    "detailed_turn_compression": detailed_turn_compression_v3.name,
    "chunk_summary_brief": chunk_brief_v3.name,
}

__all__ = [
    "DEFAULT_PROMPT_NAMES",
    "PROMPT_NAMES",
    "PROMPT_REGISTRY",
    "PromptTemplate",
    "chunk_brief_v1",
    "chunk_brief_v2",
    "chunk_brief_v3",
    "detailed_turn_compression_v1",
    "detailed_turn_compression_v2",
    "detailed_turn_compression_v3",
    "smoothing_v1",
    "tool_result_v1",
    "tool_result_v2",
]

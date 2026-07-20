"""Intentional prompt-name shadow: package attributes are template instances.

TS exports template objects under the same names as their source modules.
Python mirrors that: after `from lhc.shared_tech import prompts`,
`prompts.chunk_brief_v2` is the template instance, while the submodule remains
reachable via importlib / sys.modules.
"""

from __future__ import annotations

import importlib
import sys
from types import ModuleType

from lhc.shared_tech import prompts
from lhc.shared_tech.prompts.chunk_brief_v2 import chunk_brief_v2 as template_from_submodule


def test_chunk_brief_v2_package_attr_is_template_instance() -> None:
    assert prompts.chunk_brief_v2 is template_from_submodule
    assert getattr(prompts.chunk_brief_v2, "name", None) == "chunk-brief-v2"
    assert not isinstance(prompts.chunk_brief_v2, ModuleType)


def test_chunk_brief_v2_submodule_still_reachable_via_sys_modules() -> None:
    mod = importlib.import_module("lhc.shared_tech.prompts.chunk_brief_v2")
    assert sys.modules["lhc.shared_tech.prompts.chunk_brief_v2"] is mod
    assert isinstance(mod, ModuleType)
    assert mod.chunk_brief_v2 is prompts.chunk_brief_v2

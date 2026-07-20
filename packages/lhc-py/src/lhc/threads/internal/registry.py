"""Ported from packages/lhc/src/threads/internal/registry.ts. Phase 1 — PARTIAL (Wave 1 import seam).

Minimal surface for persist's registry helpers. Wave 3 completes this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ...shared_tech.storage import Database

DEFAULT_REGISTRY_PATH = str(Path.home() / ".lhc" / "registry.sqlite")


def resolve_registry_path(registry_path: str | None = None) -> str:
    raise NotImplementedError


def open_registry_for_write(registry_path: str) -> Database:
    raise NotImplementedError


def open_registry_for_read(registry_path: str) -> Database | None:
    raise NotImplementedError


@dataclass(frozen=True, slots=True)
class RegistryRow:
    thread_id: str
    file_path: str
    created_at: str
    title: str | None = None
    cwd: str | None = None


def insert_thread_row(db: Database, row: RegistryRow) -> None:
    raise NotImplementedError


def select_thread_row(db: Database, thread_id: str) -> RegistryRow | None:
    raise NotImplementedError


def select_thread_rows_by_prefix(db: Database, prefix: str) -> list[RegistryRow]:
    raise NotImplementedError


def select_all_thread_rows(db: Database, opts: dict[str, str] | None = None) -> list[RegistryRow]:
    raise NotImplementedError

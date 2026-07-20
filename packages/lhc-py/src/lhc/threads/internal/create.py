"""Ported from packages/lhc/src/threads/internal/create.ts. Phase 1 — PARTIAL (Wave 1 import seam).

Minimal surface for persist's open_thread_database import path. Wave 3
completes this module.
"""

from __future__ import annotations

from ...shared_tech.errors import OpResult
from ...shared_tech.storage import Database


def generate_thread_id() -> str:
    raise NotImplementedError


def open_thread_database(file_path: str) -> OpResult[Database]:
    raise NotImplementedError


def create_thread_file(file_path: str, thread_id: str, created_at: str) -> None:
    raise NotImplementedError


def delete_thread_file(file_path: str) -> None:
    raise NotImplementedError

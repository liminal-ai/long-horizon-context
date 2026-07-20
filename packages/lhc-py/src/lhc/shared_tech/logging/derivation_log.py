"""Ported from packages/lhc/src/shared-tech/logging/derivation-log.ts. Phase 1 skeleton.

Append-only execution history for inference-backed derivations. State stays
compact (pending | ready | failed | blocked); this table carries the story.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..derivation import SubjectKind
from ..persist import DbReadTransaction, DbWriteTransaction
from ..storage import Database

DerivationLogEventKind = Literal[
    "inference_failed",
    "inference_succeeded",
    "fallback_applied",
    "terminal_failed",
]


@dataclass(frozen=True, slots=True)
class DerivationLogTarget:
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str


@dataclass(frozen=True, slots=True)
class DerivationLogPayload:
    """Documentation of known payload keys (TS index signature allows extras).

    Call sites and DerivationLogEntry.payload use dict[str, object]; this
    dataclass documents the known optional keys only — do not pass it into
    append/query APIs.
    """

    reason: str | None = None
    fallback_floor: str | None = None
    provenance: dict[str, str] | None = None  # {provider, model, prompt}


@dataclass(frozen=True, slots=True)
class DerivationLogEntry:
    target: DerivationLogTarget
    event_kind: DerivationLogEventKind
    payload: dict[str, object]  # DerivationLogPayload + index signature


@dataclass(frozen=True, slots=True)
class StoredDerivationLogEntry:
    log_id: int
    subject_kind: SubjectKind
    subject_id: str
    derivation_type: str
    event_kind: DerivationLogEventKind
    payload: dict[str, object]
    recorded_at: str


@dataclass(frozen=True, slots=True)
class DerivationLogQuery:
    subject_kind: SubjectKind | None = None
    subject_id: str | None = None
    derivation_type: str | None = None
    event_kind: DerivationLogEventKind | None = None


def _insert_derivation_log(path: str, entry: DerivationLogEntry) -> None:
    raise NotImplementedError


def append_derivation_log(
    transaction: DbReadTransaction | DbWriteTransaction,
    entry: DerivationLogEntry,
) -> None:
    raise NotImplementedError


def query_derivation_log(db: Database, q: DerivationLogQuery) -> list[StoredDerivationLogEntry]:
    raise NotImplementedError

"""Ported from packages/lhc/test/fixtures/threads.ts. Phase 1 skeleton.

Thread builders for Epic 02 (test plan §Test Substrate). Types/constants are
real; SDK-calling and below-SDK DB helpers are skeletons.
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

from lhc import intake_stream, threads
from lhc.intake_stream import MessageEventInput
from lhc.sdk import Lhc
from lhc.shared_tech.derivation import (
    DependencyGap,
    Derivation,
    DerivationMetadata,
    DerivationState,
    ProviderProvenance,
    SubjectKind,
)
from lhc.shared_tech.storage import open_database
from .corrupt import corrupt_two_open_turns
from .inference_callbacks_double import InferenceCallbacksDouble
from .model_call import DerivationType

if TYPE_CHECKING:
    from . import TempStore


class ChunkRow(TypedDict):
    chunkId: str
    chunkOrder: int
    status: Literal["open", "closed"]
    accumulatedProjectedTokens: int


class ChunkMemberRow(TypedDict):
    chunkId: str
    turnId: str
    memberIdx: int


class ChunkSnapshot(TypedDict):
    chunks: list[ChunkRow]
    members: list[ChunkMemberRow]


class FormStateTarget(TypedDict):
    subjectKind: SubjectKind
    subjectId: str
    derivationType: DerivationType


class FormStateUpdate(TypedDict):
    state: DerivationState
    content: NotRequired[str]
    reason: NotRequired[str]
    metadata: NotRequired[DerivationMetadata]
    derivedAt: NotRequired[str]


class MultiStateClaim(TypedDict):
    subjectKind: SubjectKind
    subjectId: str
    derivationType: DerivationType
    state: DerivationState


class ThreadWithClosedTurnsResult(TypedDict):
    filePath: str
    turnIds: list[str]


class ThreadWithToolRunResult(TypedDict):
    filePath: str
    turnId: str


class MultiStateThreadResult(TypedDict):
    filePath: str
    expected: list[MultiStateClaim]


class DamagedSourceThreadResult(TypedDict):
    filePath: str
    turnId: str


class GappedRenderingThreadResult(TypedDict):
    filePath: str
    messageId: str
    turnId: str


class ToolRunOpts(TypedDict, total=False):
    isError: bool
    missingResult: bool
    resultContent: str


# TC-3.2's fallback-rendering state as one shared builder (coverage.md
# cross-story debt: TC-4.4 consumes this exact scenario; don't rebuild it by
# hand). Expects a manual-mode SDK:
# scripts the prompt's smoothing to fail, then drains — the smoothing lands
# failed (its work row deleted) and the
# turn rendering lands ready from the raw floor.
GAPPED_SMOOTHING_REASON = "provider_failure: scripted smoothing failure"


async def _new_thread_file(store: TempStore) -> str:
    file_path = store.thread_path()
    created = await threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    return file_path


async def _send(file_path: str, batch: list[MessageEventInput] | tuple[MessageEventInput, ...]) -> None:
    result = await intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(f"fixture batch failed: {result.error.reason}")


async def thread_with_closed_turns(
    store: TempStore,
    n: int,
) -> ThreadWithClosedTurnsResult:
    from . import valid_event

    file_path = await _new_thread_file(store)
    turn_ids: list[str] = []
    for i in range(1, n + 1):
        await _send(
            file_path,
            [
                valid_event(
                    "user_prompt",
                    {"payload": {"text": f"prompt for turn {i}"}},
                ),
                valid_event(
                    "assistant_text",
                    {"payload": {"text": f"answer for turn {i}"}},
                ),
                valid_event("turn_end"),
            ],
        )
        turn_ids.append(f"t{i}")
    return {"filePath": file_path, "turnIds": turn_ids}


async def thread_with_tool_run(
    store: TempStore,
    opts: ToolRunOpts | None = None,
) -> ThreadWithToolRunResult:
    from . import valid_event

    options = opts if opts is not None else {}
    file_path = await _new_thread_file(store)
    batch: list[MessageEventInput] = [
        valid_event(
            "user_prompt",
            {"payload": {"text": "please run the tool"}},
        ),
        valid_event(
            "tool_call",
            {
                "payload": {
                    "toolCallId": "call-fixture-1",
                    "toolName": "read_file",
                    "arguments": {"path": "notes.txt"},
                }
            },
        ),
    ]
    if options.get("missingResult") is not True:
        batch.append(
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-fixture-1",
                        "content": options.get(
                            "resultContent",
                            "contents of notes.txt",
                        ),
                        "isError": options.get("isError", False),
                    }
                },
            )
        )
    batch.append(valid_event("turn_end"))
    await _send(file_path, batch)
    return {"filePath": file_path, "turnId": "t1"}


# ── chunk read-back (Story 3): raw rows for boundary assertions ──


def read_chunks(file_path: str) -> ChunkSnapshot:
    db = open_database(file_path)
    try:
        chunk_rows = db.prepare(
            """SELECT chunk_id, chunk_order, status, accumulated_projected_tokens
               FROM chunk ORDER BY chunk_order"""
        ).all()
        chunks: list[ChunkRow] = [
            {
                "chunkId": str(row["chunk_id"]),
                "chunkOrder": int(row["chunk_order"]),
                "status": row["status"],
                "accumulatedProjectedTokens": int(
                    row["accumulated_projected_tokens"]
                ),
            }
            for row in chunk_rows
        ]
        member_rows = db.prepare(
            """SELECT cm.chunk_id, cm.turn_id, cm.member_idx
               FROM chunk_member cm
               JOIN chunk c ON c.chunk_id = cm.chunk_id
               ORDER BY c.chunk_order, cm.member_idx"""
        ).all()
        members: list[ChunkMemberRow] = [
            {
                "chunkId": str(row["chunk_id"]),
                "turnId": str(row["turn_id"]),
                "memberIdx": int(row["member_idx"]),
            }
            for row in member_rows
        ]
        return {"chunks": chunks, "members": members}
    finally:
        db.close()


# ── derivation read-back and the sanctioned state writer ───────


def read_derived_forms(file_path: str) -> list[Derivation]:
    db = open_database(file_path)
    try:
        rows = db.prepare(
            """SELECT subject_kind, subject_id, derivation_type, state, content,
                      reason, metadata, source_version, gaps, derived_at
               FROM derivation
               ORDER BY subject_kind, subject_id, derivation_type"""
        ).all()
        records: list[Derivation] = []
        for row in rows:
            metadata = None
            if row["metadata"] is not None:
                raw_metadata = json.loads(str(row["metadata"]))
                # Drift guard (TS surfaces parsed JSON verbatim, so unknown
                # keys fail deep-equality there; the dataclass rebuild here
                # would silently drop them without this check).
                _known = {
                    "outcome", "lastError", "discardReason", "fallbackFloor",
                    "fallbackUsed", "inferenceAttempted", "inferenceSucceeded",
                    "sizeDisposition", "provenance",
                }
                _extra = set(raw_metadata) - _known
                if _extra:
                    raise AssertionError(
                        f"derivation metadata carries undeclared keys: {sorted(_extra)}"
                    )
                provenance = raw_metadata.get("provenance")
                if isinstance(provenance, dict):
                    _pextra = set(provenance) - {"provider", "model", "prompt"}
                    if _pextra:
                        raise AssertionError(
                            f"provenance carries undeclared keys: {sorted(_pextra)}"
                        )
                metadata = DerivationMetadata(
                    outcome=raw_metadata.get("outcome"),
                    last_error=raw_metadata.get("lastError"),
                    discard_reason=raw_metadata.get("discardReason"),
                    fallback_floor=raw_metadata.get("fallbackFloor"),
                    fallback_used=raw_metadata.get("fallbackUsed"),
                    inference_attempted=raw_metadata.get("inferenceAttempted"),
                    inference_succeeded=raw_metadata.get("inferenceSucceeded"),
                    size_disposition=raw_metadata.get("sizeDisposition"),
                    provenance=(
                        ProviderProvenance(
                            provider=provenance["provider"],
                            model=provenance["model"],
                            prompt=provenance["prompt"],
                        )
                        if isinstance(provenance, dict)
                        else None
                    ),
                )
            gaps = None
            if row["gaps"] is not None:
                gaps = [
                    DependencyGap(
                        subject_kind=gap["subjectKind"],
                        subject_id=gap["subjectId"],
                        derivation_type=gap["derivationType"],
                    )
                    for gap in json.loads(str(row["gaps"]))
                ]
            records.append(
                Derivation(
                    subject_kind=row["subject_kind"],
                    subject_id=str(row["subject_id"]),
                    derivation_type=str(row["derivation_type"]),
                    state=row["state"],
                    source_version=int(row["source_version"]),
                    content=(
                        str(row["content"]) if row["content"] is not None else None
                    ),
                    reason=(
                        str(row["reason"]) if row["reason"] is not None else None
                    ),
                    metadata=metadata,
                    gaps=gaps,
                    derived_at=(
                        str(row["derived_at"])
                        if row["derived_at"] is not None
                        else None
                    ),
                )
            )
        return records
    finally:
        db.close()


def _metadata_json(value: DerivationMetadata | dict[str, object]) -> str:
    if isinstance(value, dict):
        data = value
    elif is_dataclass(value):
        snake = asdict(value)
        key_map = {
            "last_error": "lastError",
            "discard_reason": "discardReason",
            "fallback_floor": "fallbackFloor",
            "fallback_used": "fallbackUsed",
            "inference_attempted": "inferenceAttempted",
            "inference_succeeded": "inferenceSucceeded",
            "size_disposition": "sizeDisposition",
        }
        data = {
            key_map.get(key, key): item
            for key, item in snake.items()
            if item is not None
        }
    else:
        data = value
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


# Below-SDK state writer, sanctioned like corrupt.ts: ready/failed/blocked
# are unreachable through the SDK until the drain (Story 1) and handlers
# (Stories 2–3) land. UPDATE-only on purpose — the pending row exists from
# enqueue, mirroring the production completion contract.
def set_form_state(
    file_path: str,
    target: FormStateTarget,
    update: FormStateUpdate,
) -> None:
    db = open_database(file_path)
    try:
        metadata = update.get("metadata")
        changed = db.prepare(
            """UPDATE derivation
               SET state = ?, content = ?, reason = ?, metadata = ?, derived_at = ?
               WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?"""
        ).run(
            update["state"],
            update.get("content"),
            update.get("reason"),
            _metadata_json(metadata) if metadata is not None else None,
            update.get("derivedAt"),
            target["subjectKind"],
            target["subjectId"],
            target["derivationType"],
        )
        if int(changed.changes) != 1:
            raise RuntimeError(
                "fixture setFormState hit "
                f"{changed.changes} rows for "
                f'{target["subjectKind"]}/{target["subjectId"]}/{target["derivationType"]}; '
                "expected the pending row from enqueue"
            )
    finally:
        db.close()


# ── multi-state thread: every form state in one file ─────────────


async def multi_state_thread(store: TempStore) -> MultiStateThreadResult:
    from . import valid_event

    file_path = await _new_thread_file(store)
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "first prompt"}}),
            valid_event(
                "assistant_text",
                {"payload": {"text": "working on it"}},
            ),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-ms-1",
                        "toolName": "read_file",
                        "arguments": {"path": "a.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-ms-1",
                        "content": "contents of a.txt",
                        "isError": False,
                    }
                },
            ),
            valid_event("turn_end"),
            valid_event("user_prompt", {"payload": {"text": "second prompt"}}),
            valid_event("turn_end"),
        ],
    )
    derived_at = "2026-06-10T12:00:00.000Z"
    set_form_state(
        file_path,
        {
            "subjectKind": "message",
            "subjectId": "m1",
            "derivationType": "smoothed_prompt",
        },
        {
            "state": "ready",
            "content": "smoothed(fixture:first prompt)",
            "derivedAt": derived_at,
        },
    )
    set_form_state(
        file_path,
        {
            "subjectKind": "message",
            "subjectId": "m4",
            "derivationType": "tool_result_summary",
        },
        {
            "state": "ready",
            "content": "toolresult(fixture:contents of a.txt)",
            "metadata": {"outcome": "succeeded"},
            "derivedAt": derived_at,
        },
    )
    set_form_state(
        file_path,
        {
            "subjectKind": "turn",
            "subjectId": "t1",
            "derivationType": "turn_rendering",
        },
        {"state": "failed", "reason": "provider_failure: scripted failure (fixture)"},
    )
    set_form_state(
        file_path,
        {
            "subjectKind": "turn",
            "subjectId": "t2",
            "derivationType": "turn_rendering",
        },
        {
            "state": "blocked",
            "reason": "source_damaged: manufactured damage (fixture)",
        },
    )
    expected: list[MultiStateClaim] = [
        {"subjectKind": "message", "subjectId": "m1", "derivationType": "smoothed_prompt", "state": "ready"},
        {"subjectKind": "message", "subjectId": "m4", "derivationType": "tool_result_summary", "state": "ready"},
        {"subjectKind": "message", "subjectId": "m6", "derivationType": "smoothed_prompt", "state": "pending"},
        {"subjectKind": "turn", "subjectId": "t1", "derivationType": "turn_rendering", "state": "failed"},
        {"subjectKind": "turn", "subjectId": "t1", "derivationType": "pre_detailed_assembly", "state": "pending"},
        {"subjectKind": "turn", "subjectId": "t2", "derivationType": "turn_rendering", "state": "blocked"},
        {"subjectKind": "turn", "subjectId": "t2", "derivationType": "pre_detailed_assembly", "state": "pending"},
    ]
    return {"filePath": file_path, "expected": expected}


# ── damaged-source thread (Epic 01 corruption definition) ────────


async def damaged_source_thread(store: TempStore) -> DamagedSourceThreadResult:
    from . import valid_event

    built = await thread_with_closed_turns(store, 1)
    file_path = built["filePath"]
    await _send(
        file_path,
        [valid_event("user_prompt", {"payload": {"text": "left open"}})],
    )
    corrupt_two_open_turns(file_path)
    if not built["turnIds"]:
        raise RuntimeError("fixture invariant: one closed turn expected")
    return {"filePath": file_path, "turnId": built["turnIds"][0]}


# ── fallback-rendering thread (TC-3.2's state, shared) ─────────────


async def gapped_rendering_thread(
    store: TempStore,
    sdk: Lhc,
    double: InferenceCallbacksDouble,
) -> GappedRenderingThreadResult:
    from . import valid_event

    file_path = await _new_thread_file(store)
    double.fail_kind(
        "prompt_smoothing",
        1,
        {"reason": GAPPED_SMOOTHING_REASON},
    )
    await _send(
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "gapped prompt"}}),
            valid_event(
                "assistant_text",
                {"payload": {"text": "gapped answer"}},
            ),
            valid_event("turn_end"),
        ],
    )
    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok:
        raise RuntimeError(f"fixture drain failed: {drained.error.reason}")
    set_form_state(
        file_path,
        {
            "subjectKind": "message",
            "subjectId": "m1",
            "derivationType": "smoothed_prompt",
        },
        {"state": "failed", "reason": GAPPED_SMOOTHING_REASON},
    )
    forms = read_derived_forms(file_path)
    smoothing = next(
        (
            form
            for form in forms
            if form.subject_id == "m1"
            and form.derivation_type == "smoothed_prompt"
        ),
        None,
    )
    rendering = next(
        (
            form
            for form in forms
            if form.subject_id == "t1"
            and form.derivation_type == "turn_rendering"
        ),
        None,
    )
    if (
        smoothing is None
        or smoothing.state != "failed"
        or rendering is None
        or rendering.state != "ready"
        or rendering.gaps is not None
    ):
        raise RuntimeError(
            "fixture invariant: failed smoothing under a ready fallback rendering expected"
        )
    return {"filePath": file_path, "messageId": "m1", "turnId": "t1"}


__all__ = [
    "ChunkSnapshot",
    "DamagedSourceThreadResult",
    "GAPPED_SMOOTHING_REASON",
    "GappedRenderingThreadResult",
    "MultiStateClaim",
    "MultiStateThreadResult",
    "ThreadWithClosedTurnsResult",
    "ThreadWithToolRunResult",
    "damaged_source_thread",
    "gapped_rendering_thread",
    "multi_state_thread",
    "read_chunks",
    "read_derived_forms",
    "set_form_state",
    "thread_with_closed_turns",
    "thread_with_tool_run",
]

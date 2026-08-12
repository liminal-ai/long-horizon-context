"""Ported from packages/lhc/src/thread-view/internal/select.ts.

Band selection: compact point, smooth/detailed/brief fills, unchunked turns,
the coverage edge (covered_from), and
canonical-corruption detection. Two halves, deliberately split:

  - readSelectionInputs: the record/derivation reads, with the corruption check
    in the reads, before any transaction opens. A refusal here means nothing
    was written, so the prior view is trivially intact. Never moved inside
    the transaction.
  - selectArrangement: a pure function over those inputs. No DB handle, no
    clock, no inference: same inputs, same arrangement.

Tie-breakers: inclusion thresholds are <=; walks are newest-first everywhere;
chunk coverage is decided by the chunk's newest
member turn. Entry costs are the tokens of the rendered entry text itself,
so the budgeted tokens are the stored tokens — no second estimate.

Crossing behaviour differs by band: smooth and detailed stop at the first
entry that does not fit and hand the remainder down. Brief is the last band —
nothing below it catches the remainder — so it passes the entry over and keeps
walking to older candidates; one unrepresentable entry must never end
processing of everything older than it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal, TypeVar, cast

from ...messages import read_live_messages
from ...shared_tech.storage import Database
from ...shared_tech.token_counting import estimate_tokens
from ...shared_tech.view import Band, ViewProfilePercentages
from ...turns import read_turn_chunk_structure
from ...turns.internal.compose import (
    labeled_or_recomposed_turn_rendering,
    stored_rendering_has_turn_label,
)
from ...turns.internal.derivations import (
    read_member_messages,
    read_message_derivation_rows,
)
from .render import (
    CompactChunkMaterialSnapshot,
    DerivationSnapshot,
    ResolvedRepresentation,
    _ExcerptBlock,
    excerpt_line,
    render_arrangement_entry,
    resolve_brief_representation,
    resolve_detailed_representation,
    resolve_smooth_representation,
)

# Canonical source state needed to identify or read the compacted span is
# damaged: compact refuses with state_corruption. Derived-material damage never
# raises this; it degrades through the ladders instead.


class CanonicalCorruptionError(Exception):
    code: Literal["turn_state_corrupt", "source_damaged"]

    def __init__(self, code: Literal["turn_state_corrupt", "source_damaged"], reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.name = "CanonicalCorruptionError"


@dataclass(frozen=True, slots=True)
class SelectionMessage:
    message_id: str
    order: int  # source_event_order
    kind: str
    token_estimate: int
    turn_id: str
    text: str  # excerpt/note line (render.excerptLine)


@dataclass(frozen=True, slots=True)
class SelectionTurn:
    turn_id: str
    turn_order: int
    status: Literal["open", "closed"]
    opened_at: int
    closed_at: int | None


@dataclass(frozen=True, slots=True)
class SelectionChunk:
    chunk_id: str
    chunk_order: int
    status: Literal["open", "closed"]
    member_turn_ids: list[str]  # member order


@dataclass(frozen=True, slots=True)
class SelectionInputs:
    messages: list[SelectionMessage]  # live only, ascending order
    turns: list[SelectionTurn]  # ascending turnOrder
    chunks: list[SelectionChunk]  # ascending chunkOrder
    derivations: dict[str, DerivationSnapshot]  # `${subjectId}/${derivationType}` (turn/chunk subjects)
    max_event_order: int
    derivation_counts: dict[str, dict[str, int]]  # derivation type → state → count
    compact_chunk_materials: dict[str, CompactChunkMaterialSnapshot] | None = None
    empty_chunk_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ArrangementEntry:
    band: Band
    subject_kind: Literal["turn", "chunk"]
    subject_id: str
    derivation_used: str
    degraded: bool
    gap: bool
    start_order: int  # oldest event order the entry represents (notes included)
    text: str  # rendered entry text (the band stores this verbatim)
    tokens: int
    reason: str | None = None  # gap entries


@dataclass(frozen=True, slots=True)
class SelectionSkip:
    """A candidate the last band's walk passed over: no entry at all, a hole in
    the coverage window that the view reports as a gap."""

    band: Band
    subject_id: str
    tokens: int
    reason: str


@dataclass(frozen=True, slots=True)
class SelectionResult:
    compact_point: int
    covered_from: int
    # Gradient order (brief → detailed → smooth), oldest-first within band —
    # the order the bands render and the arrangement persists.
    entries: list[ArrangementEntry]
    skipped: list[SelectionSkip]


_SQL_DERIVATION_ROWS = (
    """SELECT subject_kind, subject_id, derivation_type, state, content, reason
       FROM derivation"""
)

_SQL_MAX_EVENT_ORDER = """SELECT COALESCE(MAX(event_order), 0) AS m FROM event"""

# ── reads (corruption check lives here, pre-transaction) ─────────


def read_selection_inputs(db: Database) -> SelectionInputs:
    # Message, turn, and chunk material comes from the owner domains, not direct
    # SQL against their tables (bad-code-log: domain-boundary leakage). The
    # owners return source-faithful structure — turns carry the deleted flag,
    # chunks carry raw membership — so thread-view keeps ownership of the
    # source-state corruption policy below. The derivation and event-aggregate
    # reads stay here as thread-view's own selection inputs.
    structure = read_turn_chunk_structure(db)
    # Referential checks compare against every turn row (a tombstoned turn is
    # a legitimate reference target, not damage); the selection walk itself
    # sees live turns only.
    turn_ids = {row.turn_id for row in structure.turns}
    turns: list[SelectionTurn] = [
        SelectionTurn(
            turn_id=row.turn_id,
            turn_order=row.turn_order,
            status=row.status,
            opened_at=row.opened_at_event_order,
            closed_at=row.closed_at_event_order,
        )
        for row in structure.turns
        if not row.deleted
    ]

    # Canonical damage the walk cannot select across: the turn-state invariant
    # (at most one open turn, open turns carry no close), and referential damage
    # between chunk/message rows and their turns.
    open_turns = [turn for turn in turns if turn.status == "open"]
    if len(open_turns) > 1:
        open_ids = ", ".join(turn.turn_id for turn in open_turns)
        raise CanonicalCorruptionError(
            "turn_state_corrupt",
            f"canonical turn state corrupt: {len(open_turns)} open turns ({open_ids}); "
            f"the compacted span cannot be identified",
        )
    for turn in turns:
        if turn.status == "closed" and turn.closed_at is None:
            raise CanonicalCorruptionError(
                "source_damaged",
                f"canonical turn state corrupt: closed turn {turn.turn_id} carries no close boundary",
            )

    messages: list[SelectionMessage] = []
    for record in read_live_messages(db):
        turn_id = record.turn_id
        if turn_id not in turn_ids:
            raise CanonicalCorruptionError(
                "source_damaged",
                f"canonical record corrupt: message {record.message_id} references missing turn {turn_id}",
            )
        excerpt_blocks = [
            _ExcerptBlock(block_type=block.block_type, content=block.content)
            for block in record.blocks
        ]
        messages.append(
            SelectionMessage(
                message_id=record.message_id,
                order=record.source_event_order,
                kind=record.kind,
                token_estimate=record.token_estimate,
                turn_id=turn_id,
                text=excerpt_line(record.kind, excerpt_blocks),
            )
        )

    live_turn_ids = {turn.turn_id for turn in turns}
    empty_chunk_ids: list[str] = []
    chunks: list[SelectionChunk] = []
    for row in structure.chunks:
        for member_turn_id in row.member_turn_ids:
            if member_turn_id not in turn_ids:
                raise CanonicalCorruptionError(
                    "source_damaged",
                    f"canonical record corrupt: chunk {row.chunk_id} membership "
                    f"references missing turn {member_turn_id}",
                )
        if not any(
            turn_id in live_turn_ids for turn_id in row.member_turn_ids
        ):
            empty_chunk_ids.append(row.chunk_id)
            continue
        chunks.append(
            SelectionChunk(
                chunk_id=row.chunk_id,
                chunk_order=row.chunk_order,
                status=row.status,
                member_turn_ids=row.member_turn_ids,
            )
        )

    derivation_rows = db.prepare(_SQL_DERIVATION_ROWS).all()
    derivations: dict[str, DerivationSnapshot] = {}
    empty_chunk_set = set(empty_chunk_ids)
    derivation_counts: dict[str, dict[str, int]] = {}
    for row in derivation_rows:
        subject_kind = str(row["subject_kind"])
        subject_id = str(row["subject_id"])
        if subject_kind == "chunk" and subject_id in empty_chunk_set:
            continue
        dtype = str(row["derivation_type"])
        state = str(row["state"])
        derivation_counts[dtype] = {
            **derivation_counts.get(dtype, {}),
            state: derivation_counts.get(dtype, {}).get(state, 0) + 1,
        }
        if subject_kind not in {"turn", "chunk"}:
            continue
        snapshot = DerivationSnapshot(
            state=cast(
                Literal["pending", "ready", "failed", "blocked"],
                str(row["state"]),
            ),
            content=None if row["content"] is None else str(row["content"]),
            reason=None if row["reason"] is None else str(row["reason"]),
        )
        derivations[f"{subject_id}/{dtype}"] = snapshot

    # R3 serve-time legacy fallback (TS retrieval turnCandidate algorithm):
    # ready turn_rendering without the outer <turnId> wrap is recomposed from
    # live members + message derivations before select prices/stores bands.
    # Labeled rows pass through verbatim. No DB write — snapshot rewrite only.
    _relabel_legacy_ready_turn_renderings(db, derivations)

    max_row = db.prepare(_SQL_MAX_EVENT_ORDER).get()
    assert max_row is not None
    return SelectionInputs(
        messages=messages,
        turns=turns,
        chunks=chunks,
        derivations=derivations,
        max_event_order=int(max_row["m"]),  # type: ignore[arg-type]
        derivation_counts=derivation_counts,
        empty_chunk_ids=empty_chunk_ids,
    )


def _relabel_legacy_ready_turn_renderings(
    db: Database,
    derivations: dict[str, DerivationSnapshot],
) -> None:
    """Rewrite ready unlabeled turn_rendering snapshots in place (read path).

    Mirrors packages/lhc/src/retrieval/index.ts ``turnCandidate`` at pin
    81cd48c: storedHasTurnLabel ⇒ verbatim; else composeRenderingInput +
    composeStructuredTurnText from canonical members. Applied here so the
    pure select walk prices and persists the labeled serve text without a
    retrieval API (R4 owns get_turns).
    """
    for key, snap in list(derivations.items()):
        if not key.endswith("/turn_rendering"):
            continue
        if snap.state != "ready" or not isinstance(snap.content, str):
            continue
        turn_id = key[: -len("/turn_rendering")]
        if stored_rendering_has_turn_label(snap.content, turn_id):
            continue
        members = read_member_messages(db, turn_id)
        message_ids = [message.message_id for message in members]
        message_derivations = read_message_derivation_rows(db, message_ids)
        labeled = labeled_or_recomposed_turn_rendering(
            turn_id,
            snap.content,
            members,
            message_derivations,
        )
        derivations[key] = DerivationSnapshot(
            state=snap.state,
            content=labeled,
            reason=snap.reason,
        )


# ── the pure walk ─────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SelectionConfig:
    lower_bound: int
    percentages: ViewProfilePercentages


PiMappableMessageKind = Literal[
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "tool_call",
    "tool_result",
    "model_change",
    "thinking_level_change",
]

# Message kinds that can anchor a host session rebuild past the compact point.
# Excludes runtime_note (and any future non-mappable kinds). Shared with the
# first-kept-message lookup in compact-compute so "empty tail" means the same
# thing in both places.
PI_MAPPABLE_MESSAGE_KINDS: tuple[PiMappableMessageKind, ...] = (
    "user_prompt",
    "assistant_text",
    "assistant_thinking",
    "tool_call",
    "tool_result",
    "model_change",
    "thinking_level_change",
)

_PI_MAPPABLE_KIND_SET: frozenset[str] = frozenset(PI_MAPPABLE_MESSAGE_KINDS)

_T = TypeVar("_T")


def _straddling_turn_stays_in_full(
    full_side_tokens: float,
    turn_tokens: float,
    eviction_would_empty_full: bool,
) -> bool:
    if eviction_would_empty_full:
        return True
    smooth_side_tokens = turn_tokens - full_side_tokens
    return full_side_tokens >= smooth_side_tokens


def select_arrangement(inputs: SelectionInputs, config: SelectionConfig) -> SelectionResult:
    messages = inputs.messages
    turns = inputs.turns
    chunks = inputs.chunks
    derivations = inputs.derivations

    def lookup(subject_id: str, derivation_type: str) -> DerivationSnapshot | None:
        return derivations.get(f"{subject_id}/{derivation_type}")

    def chunk_material(
        chunk_id: str,
        derivation_type: Literal["chunk_summary_detailed", "chunk_summary_brief"],
    ) -> CompactChunkMaterialSnapshot | None:
        materials = inputs.compact_chunk_materials
        if materials is None:
            return None
        return materials.get(f"{chunk_id}/{derivation_type}")

    def budget(share: int) -> float:
        return (config.lower_bound * share) / 100

    turns_by_id = {turn.turn_id: turn for turn in turns}
    messages_by_turn: dict[str, list[SelectionMessage]] = {}
    for message in messages:
        lst = messages_by_turn.get(message.turn_id)
        if lst is None:
            lst = []
            messages_by_turn[message.turn_id] = lst
        lst.append(message)

    # The oldest event order a turn's entry represents: its oldest live
    # message, falling back to its open boundary.
    def turn_start_order(turn: SelectionTurn) -> int:
        candidates = [message.order for message in messages_by_turn.get(turn.turn_id, [])]
        return turn.opened_at if len(candidates) == 0 else min(candidates)

    # Rule 1 — compact point: messages newest-first until the estimate sum
    # first reaches the full share; the point snaps to a turn boundary so the
    # tail never begins mid-turn. Open-turn messages always land in the tail.
    full_budget = budget(config.percentages.full)
    closed_turns = [turn for turn in turns if turn.status == "closed"]
    compact_point = 0
    if len(closed_turns) > 0 and len(messages) > 0:
        total = 0
        crossing: SelectionMessage | None = None
        for i in range(len(messages) - 1, -1, -1):
            message = messages[i]
            total += message.token_estimate
            if total >= full_budget:
                crossing = message
                break

        # Budget never reached ⇒ the whole record fits the full share:
        # everything is tail, no bands.
        compact_point = 0 if crossing is None else _snap_compact_point(
            crossing,
            turns_by_id=turns_by_id,
            closed_turns=closed_turns,
            messages=messages,
            messages_by_turn=messages_by_turn,
            turn_start_order=turn_start_order,
            full_budget=full_budget,
        )

    # Band candidates: closed turns wholly behind the compact point. Rule 5 is
    # structural here — chunked or not, a banded turn is a smooth candidate
    # (bands are defined by representation, not strict time strata).
    banded_turns = [
        turn for turn in closed_turns if turn.closed_at is not None and turn.closed_at <= compact_point
    ]
    banded_turn_ids = {turn.turn_id for turn in banded_turns}

    def build_turn_entry(turn: SelectionTurn) -> ArrangementEntry:
        turn_messages = messages_by_turn.get(turn.turn_id, [])
        excerpt = None if len(turn_messages) == 0 else "\n".join(message.text for message in turn_messages)
        rep = resolve_smooth_representation(turn.turn_id, lookup, excerpt)
        text = render_arrangement_entry("turn", turn.turn_id, rep, [])
        return ArrangementEntry(
            band="smooth",
            subject_kind="turn",
            subject_id=turn.turn_id,
            derivation_used=rep.derivation_used,
            degraded=rep.degraded,
            gap=rep.gap,
            start_order=turn_start_order(turn),
            text=text,
            tokens=estimate_tokens(text),
            reason=rep.reason,
        )

    def build_chunk_entry(chunk: SelectionChunk, band: Literal["detailed", "brief"]) -> ArrangementEntry:
        rep = (
            resolve_detailed_representation(
                chunk.chunk_id, lookup, chunk_material(chunk.chunk_id, "chunk_summary_detailed")
            )
            if band == "detailed"
            else resolve_brief_representation(
                chunk.chunk_id,
                lookup,
                budget(config.percentages.brief),
                chunk_material(chunk.chunk_id, "chunk_summary_brief"),
            )
        )
        text = render_arrangement_entry(
            "chunk", chunk.chunk_id, rep, [], chunk.member_turn_ids
        )
        member_starts = [
            turn_start_order(turn)
            for turn_id in chunk.member_turn_ids
            for turn in [turns_by_id.get(turn_id)]
            if turn is not None
        ]
        return ArrangementEntry(
            band=band,
            subject_kind="chunk",
            subject_id=chunk.chunk_id,
            derivation_used=rep.derivation_used,
            degraded=rep.degraded,
            gap=rep.gap,
            start_order=compact_point if len(member_starts) == 0 else min(member_starts),
            text=text,
            tokens=estimate_tokens(text),
            reason=rep.reason,
        )

    # The one fill rule, shared by all three bands: newest-first whole-entry
    # fill, <= inclusion (an entry exactly filling the budget is included), and
    # a crossing entry that is always included when the band is still empty —
    # every band renders at least one entry.
    #
    # What a crossing entry does to the rest of the walk is the band's own
    # choice. "stop" ends the band and hands the remaining candidates to the
    # band below. "skip" passes the entry over and keeps walking, for the last
    # band, which has nothing below it: the walk ends only once the entries it
    # actually included have consumed the budget. A passed-over candidate is
    # reported only when something older was selected after it — a run of them
    # at the tail of the walk is the ordinary window edge, not a hole.
    def fill_band(
        candidates: list[_T],
        band_budget: float,
        build: Callable[[_T], ArrangementEntry],
        crossing: Literal["stop", "skip"] = "stop",
    ) -> tuple[list[ArrangementEntry], list[_T], list[SelectionSkip]]:
        included: list[ArrangementEntry] = []
        skipped: list[SelectionSkip] = []
        pending: list[SelectionSkip] = []
        total = 0
        for i, candidate in enumerate(candidates):
            entry = build(candidate)
            if total + entry.tokens <= band_budget:
                included.append(entry)
                total += entry.tokens
                skipped.extend(pending)
                pending = []
                continue
            if len(included) == 0:
                included.append(entry)
                total += entry.tokens
                if crossing == "stop" or total >= band_budget:
                    return included, candidates[i + 1 :], skipped
                continue
            if crossing == "stop":
                return included, candidates[i:], skipped
            pending.append(
                SelectionSkip(
                    band=entry.band,
                    subject_id=entry.subject_id,
                    tokens=entry.tokens,
                    reason=(
                        f"entry did not fit the remaining {entry.band} budget "
                        f"({entry.tokens} tokens from {entry.derivation_used}); "
                        "skipped so older entries could be selected"
                    ),
                )
            )
        return included, [], skipped

    # Rule 2 + 5 — smooth band: banded closed turns newest-first, chunked or
    # not (rule 5 is structural: a closed-but-unchunked turn is a turn, takes
    # the smooth representation, and consumes this budget).
    smooth_included, _smooth_rest, _smooth_skipped = fill_band(
        list(reversed(banded_turns)),
        budget(config.percentages.smooth),
        build_turn_entry,
    )
    oldest_smooth_order = float("inf")
    for entry in smooth_included:
        turn = turns_by_id.get(entry.subject_id)
        oldest_smooth_order = min(
            oldest_smooth_order,
            turn.turn_order if turn is not None else float("inf"),
        )

    # Rules 3–4 — chunk candidacy: chunks entirely older than the smooth
    # band's coverage, with the pinned tie-breaker doing the deciding — chunk
    # coverage is its NEWEST member turn, which must sit behind the compact
    # point and be older than the smooth band's oldest included turn.
    def chunk_is_candidate(chunk: SelectionChunk) -> bool:
        if chunk.status != "closed":
            return False
        live_members = [
            turn
            for turn_id in chunk.member_turn_ids
            for turn in [turns_by_id.get(turn_id)]
            if turn is not None
        ]
        if len(live_members) == 0:
            return False  # fully tombstoned membership
        newest_member = live_members[0]
        for turn in live_members[1:]:
            if turn.turn_order > newest_member.turn_order:
                newest_member = turn
        return newest_member.turn_id in banded_turn_ids and newest_member.turn_order < oldest_smooth_order

    chunk_candidates = list(reversed([chunk for chunk in chunks if chunk_is_candidate(chunk)]))

    # Rule 3 — detailed: same fill rule against its share.
    detailed_included, detailed_rest, _detailed_skipped = fill_band(
        chunk_candidates,
        budget(config.percentages.detailed),
        lambda chunk: build_chunk_entry(chunk, "detailed"),
    )
    # Rule 4 — brief: the remaining chunks, same fill rule against its share,
    # skipping what it cannot fit — it is the last band, so stopping here would
    # drop every older chunk on the floor.
    brief_included, _brief_rest, brief_skipped = fill_band(
        detailed_rest,
        budget(config.percentages.brief),
        lambda chunk: build_chunk_entry(chunk, "brief"),
        "skip",
    )

    def by_record_order(entry: ArrangementEntry) -> int:
        return entry.start_order

    selected_entries: list[ArrangementEntry] = [
        *brief_included,
        *detailed_included,
        *smooth_included,
    ]

    # Coverage invariant: every closed turn behind the compact point must be
    # represented by a selected turn, represented by a selected chunk's
    # membership, or explicitly surfaced as a smooth gap. This catches the
    # normal open-chunk shape where older closed turns are too old for smooth
    # but cannot be represented by their still-open chunk.
    covered_turn_ids: set[str] = set()
    chunks_by_id = {chunk.chunk_id: chunk for chunk in chunks}
    oldest_selected_turn_order = float("inf")
    for entry in selected_entries:
        if entry.subject_kind == "turn":
            covered_turn_ids.add(entry.subject_id)
            turn = turns_by_id.get(entry.subject_id)
            if turn is not None:
                oldest_selected_turn_order = min(oldest_selected_turn_order, turn.turn_order)
            continue
        chunk = chunks_by_id.get(entry.subject_id)
        for turn_id in [] if chunk is None else chunk.member_turn_ids:
            turn = turns_by_id.get(turn_id)
            if turn is not None and turn_id in banded_turn_ids:
                covered_turn_ids.add(turn_id)
                oldest_selected_turn_order = min(oldest_selected_turn_order, turn.turn_order)

    # A skipped chunk's turns are accounted for by its gap note, so they count
    # as covered: the coverage machinery must not answer the hole with the
    # unbudgeted per-turn detailed material the band could not afford. They
    # never move oldest_selected_turn_order — nothing was selected there.
    for skip in brief_skipped:
        chunk = chunks_by_id.get(skip.subject_id)
        for turn_id in [] if chunk is None else chunk.member_turn_ids:
            if turn_id in banded_turn_ids:
                covered_turn_ids.add(turn_id)

    def ready_content(derivation: DerivationSnapshot | None) -> str | None:
        if (
            derivation is not None
            and derivation.state == "ready"
            and isinstance(derivation.content, str)
        ):
            return derivation.content
        return None

    def derivation_state(derivation: DerivationSnapshot | None) -> str:
        return "missing" if derivation is None else derivation.state

    def build_coverage_entry(turn: SelectionTurn) -> ArrangementEntry:
        compression = lookup(turn.turn_id, "detailed_turn_compression")
        assembly = lookup(turn.turn_id, "pre_detailed_assembly")
        compression_content = ready_content(compression)
        assembly_content = ready_content(assembly)
        if compression_content is not None:
            rep = ResolvedRepresentation(
                derivation_used="detailed_turn_compression",
                body=compression_content,
                degraded=False,
                gap=False,
            )
        elif assembly_content is not None:
            rep = ResolvedRepresentation(
                derivation_used="pre_detailed_assembly",
                body=assembly_content,
                degraded=True,
                gap=False,
                degraded_marker="coverage-from-pre-detailed-assembly",
                reason=f"detailed_turn_compression {derivation_state(compression)}",
            )
        else:
            rep = ResolvedRepresentation(
                derivation_used="gap",
                body="",
                degraded=False,
                gap=True,
                reason=(
                    "closed turn before compact point was not represented by selected bands "
                    f"(detailed_turn_compression: {derivation_state(compression)}, "
                    f"pre_detailed_assembly: {derivation_state(assembly)})"
                ),
            )
        text = render_arrangement_entry("turn", turn.turn_id, rep, [])
        return ArrangementEntry(
            band="detailed",
            subject_kind="turn",
            subject_id=turn.turn_id,
            derivation_used=rep.derivation_used,
            degraded=rep.degraded,
            gap=rep.gap,
            start_order=turn_start_order(turn),
            text=text,
            tokens=estimate_tokens(text),
            reason=rep.reason,
        )

    coverage_gaps = [
        build_coverage_entry(turn)
        for turn in banded_turns
        if turn.turn_order >= oldest_selected_turn_order and turn.turn_id not in covered_turn_ids
    ]

    entries: list[ArrangementEntry] = [
        *sorted(brief_included, key=by_record_order),
        *sorted([*detailed_included, *coverage_gaps], key=by_record_order),
        *sorted(smooth_included, key=by_record_order),
    ]

    covered_from = (
        compact_point if len(entries) == 0 else min(entry.start_order for entry in entries)
    )

    return SelectionResult(
        compact_point=compact_point,
        covered_from=covered_from,
        entries=entries,
        skipped=brief_skipped,
    )


def _snap_compact_point(
    oldest_taken: SelectionMessage,
    *,
    turns_by_id: dict[str, SelectionTurn],
    closed_turns: list[SelectionTurn],
    messages: list[SelectionMessage],
    messages_by_turn: dict[str, list[SelectionMessage]],
    turn_start_order: Callable[[SelectionTurn], int],
    full_budget: float,
) -> int:
    candidate = turns_by_id.get(oldest_taken.turn_id)

    def previous_close(turn: SelectionTurn) -> int:
        previous_list = [t for t in closed_turns if t.turn_order < turn.turn_order]
        previous = previous_list[-1] if previous_list else None
        if previous is None or previous.closed_at is None:
            return 0
        return previous.closed_at

    if candidate is None:
        raise CanonicalCorruptionError(
            "source_damaged",
            f"canonical record corrupt: message {oldest_taken.message_id} "
            f"references missing turn {oldest_taken.turn_id}",
        )
    if candidate.status == "open":
        # Open-turn messages are tail regardless of budget; the tail begins at
        # the open turn's start.
        return previous_close(candidate)
    # Fully covered down to the turn's start ⇒ the tail begins at this turn.
    if oldest_taken.order <= turn_start_order(candidate):
        return previous_close(candidate)

    # A partially-covered closed turn straddles the full-budget line. Keep it
    # whole in full when evicting it would leave no live tail; otherwise round
    # toward the side holding at least half of the turn's tokens (ties stay in
    # full). The split is at the exact budget line, even when that line falls
    # inside the crossing message's estimate.
    candidate_messages = messages_by_turn.get(candidate.turn_id, [])
    turn_tokens = sum(message.token_estimate for message in candidate_messages)
    newer_tokens = sum(
        message.token_estimate
        for message in messages
        if candidate.closed_at is not None and message.order > candidate.closed_at
    )
    full_side_tokens = max(0, min(turn_tokens, full_budget - newer_tokens))
    # Empty = no mappable live messages past the candidate — runtime_note alone
    # does not count as a rebuildable tail.
    eviction_would_empty_full = not any(
        candidate.closed_at is not None
        and message.order > candidate.closed_at
        and message.kind in _PI_MAPPABLE_KIND_SET
        for message in messages
    )
    if _straddling_turn_stays_in_full(full_side_tokens, turn_tokens, eviction_would_empty_full):
        return previous_close(candidate)
    return 0 if candidate.closed_at is None else candidate.closed_at

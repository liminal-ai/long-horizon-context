//! Metadata-first Smart Compact source, ported from `bounded-source.ts`.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::super::CompactAbortSignal;
use super::render::{CompactChunkMaterialSnapshot, DerivationSnapshot, ExcerptBlock, excerpt_line};
use super::select::{SelectionChunk, SelectionChunkStatus, SelectionTurn, SelectionTurnStatus};
use super::snapshot::{InstalledTransition, read_installed_transition};
use super::walk::{CompactStoppedError, SelectionSource};
use crate::compact_continuation::has_forced_boundary_history;
use crate::shared_tech::derivation::DerivationState;
use crate::shared_tech::persist::DbReadTransaction;
use crate::shared_tech::storage::{Db, SqlParam};
use crate::shared_tech::view::SkippedRecord;
use crate::turns::internal::chunk_recovery::CompactChunkMaterial;
use crate::turns::internal::steps::StepEdges;
use crate::turns::{
    ChunkDeriveDerivationType, TurnStatus, WholeTurnComposition, compose_turn_part_text,
    compose_whole_turn_text, get_chunk_text, read_turn_chunk_structure, read_turn_steps,
};

const COMPACT_POINT_PAGE_SIZE: i64 = 512;
const PLACEABLE_MESSAGE_FROM: &str = "FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       JOIN turns t ON t.turn_id = m.turn_id AND t.deleted_at IS NULL
       WHERE m.deleted_at IS NULL";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BoundedSelectionStats {
    pub queries: usize,
    pub compact_point_rows_scanned: usize,
    pub turn_excerpt_hydrations: usize,
    pub message_block_rows_read: usize,
    pub chunk_material_resolutions: usize,
    pub derivation_content_reads: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArrangementSourceState {
    pub empty_chunk_ids: Vec<String>,
    pub max_event_order: i64,
    pub derivation_counts: IndexMap<String, IndexMap<String, i64>>,
    pub skipped_records: Vec<SkippedRecord>,
}

#[derive(Debug, Clone)]
struct TurnMessageAggregate {
    min_order: i64,
    max_order: i64,
    tokens: i64,
    count: i64,
}

#[derive(Debug, Clone)]
struct DerivationIndexEntry {
    subject_kind: String,
    state: DerivationState,
    content_null: bool,
    source_version: i64,
}

fn required_str(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing column {key}"))
        .to_string()
}

fn required_i64(row: &Map<String, Value>, key: &str) -> i64 {
    row.get(key)
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("missing integer column {key}"))
}

fn derivation_state(state: &str) -> DerivationState {
    match state {
        "pending" => DerivationState::Pending,
        "ready" => DerivationState::Ready,
        "failed" => DerivationState::Failed,
        "blocked" => DerivationState::Blocked,
        other => panic!("unknown derivation state from row: {other}"),
    }
}

fn turn_status(status: TurnStatus) -> SelectionTurnStatus {
    match status {
        TurnStatus::Open => SelectionTurnStatus::Open,
        TurnStatus::Closed => SelectionTurnStatus::Closed,
    }
}

fn chunk_status(status: TurnStatus) -> SelectionChunkStatus {
    match status {
        TurnStatus::Open => SelectionChunkStatus::Open,
        TurnStatus::Closed => SelectionChunkStatus::Closed,
    }
}

pub struct BoundedSelectionSource<'a> {
    db: &'a Db,
    transaction: &'a DbReadTransaction<'a>,
    include_chunk_materials: bool,
    signal: Option<CompactAbortSignal>,
    turns: Vec<SelectionTurn>,
    chunks: Vec<SelectionChunk>,
    turn_aggregates: HashMap<String, TurnMessageAggregate>,
    derivation_index: HashMap<String, DerivationIndexEntry>,
    derivation_snapshots: HashMap<String, Option<DerivationSnapshot>>,
    excerpts: HashMap<String, Option<String>>,
    materials: HashMap<String, Option<CompactChunkMaterialSnapshot>>,
    // ── turn parts: the installed transition turn and the step/construction
    // reads the walk asks for only when it splits or settles. A thread on the
    // forced-boundary path has no parts source at all (AC-7.3 exclusivity):
    // it walks exactly as before this mechanism existed.
    parts_enabled: bool,
    installed: Option<InstalledTransition>,
    steps_by_turn: HashMap<String, StepEdges>,
    whole_texts: HashMap<String, Option<WholeTurnComposition>>,
    pub stats: BoundedSelectionStats,
}

pub struct BoundedSelection<'a> {
    pub source: BoundedSelectionSource<'a>,
    pub source_state: ArrangementSourceState,
}

pub fn create_bounded_selection<'a>(
    db: &'a Db,
    transaction: &'a DbReadTransaction<'a>,
    include_chunk_materials: bool,
    signal: Option<CompactAbortSignal>,
) -> BoundedSelection<'a> {
    let mut stats = BoundedSelectionStats::default();
    stats.queries += 1;
    let structure = read_turn_chunk_structure(db);
    let turn_ids: HashSet<String> = structure
        .turns
        .iter()
        .map(|turn| turn.turn_id.clone())
        .collect();
    let turns: Vec<SelectionTurn> = structure
        .turns
        .iter()
        .filter(|turn| !turn.deleted)
        .map(|turn| SelectionTurn {
            turn_id: turn.turn_id.clone(),
            turn_order: turn.turn_order,
            status: turn_status(turn.status),
            opened_at: turn.opened_at_event_order,
            closed_at: turn.closed_at_event_order,
        })
        .collect();
    let live_turn_ids: HashSet<String> = turns.iter().map(|turn| turn.turn_id.clone()).collect();
    stats.queries += 1;
    let orphan_rows = db
        .prepare(
            "SELECT m.message_id, m.turn_id
       FROM message m
       JOIN event e ON e.event_order = m.source_event_order
       WHERE m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.turn_id = m.turn_id AND t.deleted_at IS NULL)
       ORDER BY m.source_event_order",
        )
        .all(&[]);
    let mut skipped_records = orphan_rows
        .into_iter()
        .map(|row| {
            let message_id = required_str(&row, "message_id");
            let turn_id = required_str(&row, "turn_id");
            SkippedRecord::OrphanedMessage {
                reason: format!(
                    "message {message_id} points at turn {turn_id}, which is not a live turn"
                ),
                message_id,
                turn_id,
            }
        })
        .collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut empty_chunk_ids = Vec::new();
    for row in &structure.chunks {
        let mut members = Vec::new();
        let mut dangling = false;
        for member in &row.member_turn_ids {
            if !turn_ids.contains(member) {
                dangling = true;
                skipped_records.push(SkippedRecord::DanglingChunkMember {
                    chunk_id: row.chunk_id.clone(),
                    turn_id: member.clone(),
                    reason: format!(
                        "chunk {} has a member pointing at turn {}, which has no turn row",
                        row.chunk_id, member
                    ),
                });
            } else {
                members.push(member.clone());
            }
        }
        if !members.iter().any(|member| live_turn_ids.contains(member)) {
            if !dangling {
                empty_chunk_ids.push(row.chunk_id.clone());
            }
            continue;
        }
        chunks.push(SelectionChunk {
            chunk_id: row.chunk_id.clone(),
            chunk_order: row.chunk_order,
            status: chunk_status(row.status),
            member_turn_ids: members,
        });
    }

    stats.queries += 1;
    let aggregate_rows = db
        .prepare(&format!(
            "SELECT m.turn_id AS turn_id, MIN(m.source_event_order) AS min_order,
              MAX(m.source_event_order) AS max_order, SUM(m.token_estimate) AS tokens,
              COUNT(*) AS n
       {PLACEABLE_MESSAGE_FROM}
       GROUP BY m.turn_id"
        ))
        .all(&[]);
    let turn_aggregates = aggregate_rows
        .into_iter()
        .map(|row| {
            (
                required_str(&row, "turn_id"),
                TurnMessageAggregate {
                    min_order: required_i64(&row, "min_order"),
                    max_order: required_i64(&row, "max_order"),
                    tokens: required_i64(&row, "tokens"),
                    count: required_i64(&row, "n"),
                },
            )
        })
        .collect();

    stats.queries += 1;
    let derivation_rows = db
        .prepare(
            "SELECT subject_kind, subject_id, derivation_type, state, (content IS NULL) AS content_null,
              source_version
       FROM derivation",
        )
        .all(&[]);
    let empty_chunk_set: HashSet<&str> = empty_chunk_ids.iter().map(String::as_str).collect();
    let mut derivation_index = HashMap::new();
    let mut derivation_counts: IndexMap<String, IndexMap<String, i64>> = IndexMap::new();
    for row in derivation_rows {
        let subject_kind = required_str(&row, "subject_kind");
        let subject_id = required_str(&row, "subject_id");
        if subject_kind == "chunk" && empty_chunk_set.contains(subject_id.as_str()) {
            continue;
        }
        let kind = required_str(&row, "derivation_type");
        let state_wire = required_str(&row, "state");
        *derivation_counts
            .entry(kind.clone())
            .or_default()
            .entry(state_wire.clone())
            .or_insert(0) += 1;
        if subject_kind == "turn" || subject_kind == "chunk" {
            derivation_index.insert(
                format!("{subject_id}/{kind}"),
                DerivationIndexEntry {
                    subject_kind,
                    state: derivation_state(&state_wire),
                    content_null: required_i64(&row, "content_null") == 1,
                    source_version: required_i64(&row, "source_version"),
                },
            );
        }
    }
    stats.queries += 1;
    let max_event_order = db
        .prepare("SELECT COALESCE(MAX(event_order), 0) AS m FROM event")
        .get()
        .map(|row| required_i64(&row, "m"))
        .unwrap_or(0);

    stats.queries += 1;
    let installed = read_installed_transition(db);
    stats.queries += 1;
    let parts_enabled = !has_forced_boundary_history(db);

    BoundedSelection {
        source: BoundedSelectionSource {
            db,
            transaction,
            include_chunk_materials,
            signal,
            turns,
            chunks,
            turn_aggregates,
            derivation_index,
            derivation_snapshots: HashMap::new(),
            excerpts: HashMap::new(),
            materials: HashMap::new(),
            parts_enabled,
            installed,
            steps_by_turn: HashMap::new(),
            whole_texts: HashMap::new(),
            stats,
        },
        source_state: ArrangementSourceState {
            empty_chunk_ids,
            max_event_order,
            derivation_counts,
            skipped_records,
        },
    }
}

impl SelectionSource for BoundedSelectionSource<'_> {
    fn turns(&self) -> Vec<SelectionTurn> {
        self.turns.clone()
    }

    fn chunks(&self) -> Vec<SelectionChunk> {
        self.chunks.clone()
    }

    fn has_placeable_messages(&mut self) -> bool {
        self.stats.queries += 1;
        self.db
            .prepare(&format!(
                "SELECT 1 AS present {PLACEABLE_MESSAGE_FROM} LIMIT 1"
            ))
            .get()
            .is_some()
    }

    fn crossing_message(&mut self, budget: f64) -> Option<(i64, String)> {
        let sql = format!(
            "SELECT m.source_event_order AS o, m.turn_id AS turn_id, m.token_estimate AS tok
         {PLACEABLE_MESSAGE_FROM}
           AND m.source_event_order < ?
         ORDER BY m.source_event_order DESC
         LIMIT ?"
        );
        let mut cursor = i64::MAX;
        let mut sum = 0_i64;
        loop {
            self.stats.queries += 1;
            let rows = self.db.prepare(&sql).all(&[
                SqlParam::from(cursor),
                SqlParam::from(COMPACT_POINT_PAGE_SIZE),
            ]);
            for row in &rows {
                self.stats.compact_point_rows_scanned += 1;
                let order = required_i64(row, "o");
                sum += required_i64(row, "tok");
                if sum as f64 >= budget {
                    return Some((order, required_str(row, "turn_id")));
                }
                cursor = order;
            }
            if rows.len() < COMPACT_POINT_PAGE_SIZE as usize {
                return None;
            }
        }
    }

    fn turn_min_message_order(&mut self, turn_id: &str) -> Option<i64> {
        self.turn_aggregates.get(turn_id).map(|row| row.min_order)
    }

    fn turn_message_tokens(&mut self, turn_id: &str) -> i64 {
        self.turn_aggregates
            .get(turn_id)
            .map(|row| row.tokens)
            .unwrap_or(0)
    }

    fn message_tokens_after(&mut self, order: i64) -> i64 {
        self.stats.queries += 1;
        self.db
            .prepare(&format!(
                "SELECT COALESCE(SUM(m.token_estimate), 0) AS total
             {PLACEABLE_MESSAGE_FROM}
               AND m.source_event_order > ?"
            ))
            .get_params(&[SqlParam::from(order)])
            .map(|row| required_i64(&row, "total"))
            .unwrap_or(0)
    }

    fn turn_excerpt(&mut self, turn_id: &str) -> Option<String> {
        if let Some(cached) = self.excerpts.get(turn_id) {
            return cached.clone();
        }
        let Some(aggregate) = self.turn_aggregates.get(turn_id).cloned() else {
            self.excerpts.insert(turn_id.to_string(), None);
            return None;
        };
        if aggregate.count == 0 {
            self.excerpts.insert(turn_id.to_string(), None);
            return None;
        }
        self.stats.queries += 1;
        let rows = self
            .db
            .prepare(&format!(
                "SELECT m.message_id, m.kind
         {PLACEABLE_MESSAGE_FROM}
           AND m.turn_id = ?
           AND m.source_event_order >= ?
           AND m.source_event_order <= ?
         ORDER BY m.source_event_order"
            ))
            .all(&[
                SqlParam::from(turn_id),
                SqlParam::from(aggregate.min_order),
                SqlParam::from(aggregate.max_order),
            ]);
        let first_block = self.db.prepare(
            "SELECT block_type, content FROM message_block WHERE message_id = ? ORDER BY block_index LIMIT 1",
        );
        let mut lines = Vec::new();
        for row in rows {
            self.stats.queries += 1;
            let message_id = required_str(&row, "message_id");
            let kind = required_str(&row, "kind");
            let block = first_block.get_params(&[SqlParam::from(message_id.as_str())]);
            let blocks = block
                .map(|block| {
                    self.stats.message_block_rows_read += 1;
                    let content = required_str(&block, "content");
                    vec![ExcerptBlock {
                        block_type: required_str(&block, "block_type"),
                        content: serde_json::from_str::<Map<String, Value>>(&content)
                            .unwrap_or_else(|error| panic!("{error}")),
                    }]
                })
                .unwrap_or_default();
            lines.push(excerpt_line(&kind, &blocks));
        }
        self.stats.turn_excerpt_hydrations += 1;
        let excerpt = Some(lines.join("\n"));
        self.excerpts.insert(turn_id.to_string(), excerpt.clone());
        excerpt
    }

    fn derivation(
        &mut self,
        subject_id: &str,
        derivation_type: &str,
    ) -> Option<DerivationSnapshot> {
        let key = format!("{subject_id}/{derivation_type}");
        if let Some(cached) = self.derivation_snapshots.get(&key) {
            return cached.clone();
        }
        let snapshot = self.derivation_index.get(&key).cloned().map(|entry| {
            let mut snapshot = DerivationSnapshot {
                state: entry.state,
                content: None,
                reason: None,
                source_version: Some(entry.source_version),
            };
            if entry.state == DerivationState::Ready && !entry.content_null {
                self.stats.queries += 1;
                self.stats.derivation_content_reads += 1;
                let row = self
                    .db
                    .prepare(
                        "SELECT content FROM derivation
             WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?",
                    )
                    .get_params(&[
                        SqlParam::from(entry.subject_kind.as_str()),
                        SqlParam::from(subject_id),
                        SqlParam::from(derivation_type),
                    ]);
                snapshot.content = row
                    .and_then(|row| row.get("content").cloned())
                    .and_then(|value| value.as_str().map(str::to_string));
            }
            snapshot
        });
        self.derivation_snapshots.insert(key, snapshot.clone());
        snapshot
    }

    fn chunk_material(
        &mut self,
        chunk_id: &str,
        derivation_type: &str,
    ) -> Result<Option<CompactChunkMaterialSnapshot>, CompactStoppedError> {
        if !self.include_chunk_materials {
            return Ok(None);
        }
        let key = format!("{chunk_id}/{derivation_type}");
        if let Some(cached) = self.materials.get(&key) {
            return Ok(cached.clone());
        }
        if self
            .signal
            .as_ref()
            .is_some_and(CompactAbortSignal::aborted)
        {
            return Err(CompactStoppedError {
                detail: "compact stopped during fallback assembly".into(),
            });
        }
        let kind = match derivation_type {
            "chunk_summary_detailed" => ChunkDeriveDerivationType::ChunkSummaryDetailed,
            "chunk_summary_brief" => ChunkDeriveDerivationType::ChunkSummaryBrief,
            _ => unreachable!(),
        };
        self.stats.queries += 1;
        self.stats.chunk_material_resolutions += 1;
        let resolved = match get_chunk_text(self.transaction, chunk_id, Some(kind)) {
            CompactChunkMaterial::Blocked { .. } => None,
            CompactChunkMaterial::Ready { content } => {
                Some(CompactChunkMaterialSnapshot::Ready { content })
            }
            CompactChunkMaterial::Concat { content, reason } => {
                Some(CompactChunkMaterialSnapshot::Concat { content, reason })
            }
        };
        self.materials.insert(key, resolved.clone());
        Ok(resolved)
    }

    // ── turn parts ────────────────────────────────────────────────
    fn has_parts_source(&self) -> bool {
        self.parts_enabled
    }

    fn installed_transition(&self) -> Option<InstalledTransition> {
        if self.parts_enabled {
            self.installed.clone()
        } else {
            None
        }
    }

    fn turn_steps(&mut self, turn_id: &str) -> StepEdges {
        if let Some(cached) = self.steps_by_turn.get(turn_id) {
            return cached.clone();
        }
        self.stats.queries += 1;
        let edges = read_turn_steps(self.db, turn_id);
        self.steps_by_turn
            .insert(turn_id.to_string(), edges.clone());
        edges
    }

    fn part_text(
        &mut self,
        turn_id: &str,
        from_order: i64,
        to_order: i64,
        trailer: &str,
    ) -> String {
        self.stats.queries += 1;
        compose_turn_part_text(self.db, turn_id, from_order, to_order, trailer)
    }

    // Composed once per walk per turn: the walk asks for it to settle, to
    // protect, and to serve a ready stored rendering under the cap.
    fn whole_turn_text(&mut self, turn_id: &str) -> Option<WholeTurnComposition> {
        if let Some(cached) = self.whole_texts.get(turn_id) {
            return cached.clone();
        }
        self.stats.queries += 1;
        let composed = compose_whole_turn_text(self.db, turn_id);
        self.whole_texts
            .insert(turn_id.to_string(), composed.clone());
        composed
    }
}

//! Ported from packages/lhc/src/thread-view/internal/host-metadata.ts.
//!
//! Host metadata (turn parts, AC-7.1): one read composing the record's open
//! turn step facts with the installed view's transition turn. No inference,
//! no writes, no walk.

use super::snapshot::read_installed_transition;
use crate::shared_tech::storage::Db;
use crate::shared_tech::view::{HostMetadata, HostMetadataActiveTurn, HostMetadataUnsettledTurn};
use crate::turns::read_active_turn_steps;

pub fn read_host_metadata(db: &Db) -> HostMetadata {
    let active = read_active_turn_steps(db);
    let transition = read_installed_transition(db);
    HostMetadata {
        active_turn: active.map(|active| HostMetadataActiveTurn {
            turn_id: active.turn_id,
            estimated_tokens: active.estimated_tokens,
            complete_steps: active.edges.complete as i64,
            last_step_edge: if active.edges.splittable {
                active.edges.last_edge.map(|k| k as i64)
            } else {
                None
            },
            splittable: active.edges.splittable,
        }),
        unsettled_turn: transition.map(|t| HostMetadataUnsettledTurn { turn_id: t.turn_id }),
    }
}

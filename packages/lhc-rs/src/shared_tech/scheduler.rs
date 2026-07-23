//! Ported from packages/lhc/src/shared-tech/scheduler.ts.
//! Phase 1 PARTIAL stub — DrainReport (and related) for Wave 1 tests.
//! Full scheduler surface lands in a later wave.

use serde::{Deserialize, Serialize};

use super::work_queue::{WorkKind, WorkSourceRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrainDisposition {
    Done,
    FailedTerminal,
    StaleDiscarded,
    LostLease,
}

impl DrainDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            DrainDisposition::Done => "done",
            DrainDisposition::FailedTerminal => "failed_terminal",
            DrainDisposition::StaleDiscarded => "stale_discarded",
            DrainDisposition::LostLease => "lost_lease",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrainStoppedBecause {
    Empty,
    InFlight,
    MaxItems,
}

impl DrainStoppedBecause {
    pub fn as_str(self) -> &'static str {
        match self {
            DrainStoppedBecause::Empty => "empty",
            DrainStoppedBecause::InFlight => "in_flight",
            DrainStoppedBecause::MaxItems => "max_items",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainRanEntry {
    pub work_item_id: String,
    pub kind: WorkKind,
    pub source_ref: WorkSourceRef,
    pub disposition: DrainDisposition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// TS `DrainReport` (scheduler.ts:46).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    pub ran: Vec<DrainRanEntry>,
    pub stopped_because: DrainStoppedBecause,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_expires_at: Option<String>,
    pub remaining: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerMode {
    Background,
    Manual,
}

impl SchedulerMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SchedulerMode::Background => "background",
            SchedulerMode::Manual => "manual",
        }
    }
}

/// TS `Scheduler` — PARTIAL: mode + poke for Wave 1 fixtures.test.
pub struct Scheduler {
    pub mode: SchedulerMode,
}

impl Scheduler {
    pub fn poke(&self, _thread_id: &str) {
        todo!("phase 2")
    }
}

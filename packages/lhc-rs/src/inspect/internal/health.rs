//! Ported from packages/lhc/src/inspect/internal/health.ts.
//!
//! Health composition joins owners' report surfaces into state counts,
//! actionable failure detail, a repair preview, and live queue visibility.
//! Message/turn derivation health comes from DerivationReportEntry rows; capture
//! gaps come from durable source-event markers recorded by capture.

use std::collections::HashMap;

use crate::intake_stream;
use crate::intake_stream::EventRecord;
use crate::messages;
use crate::shared_tech::derivation::{DerivationReportEntry, DerivationState, QueueStatus};
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::inspect::{
    HealthFailure, HealthOwner, HealthOwnerCounts, HealthOwnerEntry, HealthQueue,
    HealthRepairPreview, HealthReport,
};
use crate::threads::ThreadRef;
use crate::turns;

/// TS private `type Owner = "capture" | "messages" | "turns"`.
type Owner = HealthOwner;

/// Capture-gap runtime_note text prefix — byte-exact from TS.
const CAPTURE_GAP_TEXT_PREFIX: &str = "capture gap:";

/// Capture-gap owner/kind key and kind label — byte-exact from TS.
const CAPTURE_GAP_OWNER_KIND_KEY: &str = "capture:capture_gap";
const CAPTURE_GAP_KIND: &str = "capture_gap";

/// Capture-gap failure subjectKind — byte-exact from TS.
const CAPTURE_GAP_SUBJECT_KIND: &str = "event";

fn empty_counts() -> HealthOwnerCounts {
    HealthOwnerCounts {
        ready: 0,
        pending: 0,
        failed: 0,
        blocked: 0,
    }
}

fn capture_gap_text(event: &EventRecord) -> Option<String> {
    let EventRecord::RuntimeNote { payload, .. } = event else {
        return None;
    };
    if payload.text.starts_with(CAPTURE_GAP_TEXT_PREFIX) {
        Some(payload.text.clone())
    } else {
        None
    }
}

fn failure_of(owner: Owner, entry: &DerivationReportEntry) -> HealthFailure {
    HealthFailure {
        owner: owner.as_str().to_string(),
        subject_kind: entry.subject_kind.as_str().to_string(),
        subject_id: entry.subject_id.clone(),
        derivation_type: entry.derivation_type.clone(),
        // TS: entry.reason ?? ""
        reason: entry.reason.clone().unwrap_or_default(),
    }
}

pub async fn compose_health(ref_: ThreadRef) -> OpResult<HealthReport> {
    let message_entries = match messages::report(ref_.clone(), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let turn_entries = match turns::report(ref_.clone(), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let events = match intake_stream::list_events(ref_).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };

    let sources: [(Owner, &[DerivationReportEntry]); 2] = [
        (HealthOwner::Messages, &message_entries),
        (HealthOwner::Turns, &turn_entries),
    ];

    let mut counts_by_owner_kind: HashMap<String, HealthOwnerEntry> = HashMap::new();
    let mut failures: Vec<HealthFailure> = Vec::new();
    let mut repair_preview: Vec<HealthRepairPreview> = Vec::new();
    let mut queue = HealthQueue {
        queued: 0,
        claimed: 0,
    };

    let capture_gaps: Vec<(&EventRecord, String)> = events
        .iter()
        .filter_map(|event| capture_gap_text(event).map(|text| (event, text)))
        .collect();
    if !capture_gaps.is_empty() {
        let mut counts = empty_counts();
        counts.failed = capture_gaps.len() as i64;
        counts_by_owner_kind.insert(
            CAPTURE_GAP_OWNER_KIND_KEY.to_string(),
            HealthOwnerEntry {
                owner: HealthOwner::Capture,
                kind: CAPTURE_GAP_KIND.to_string(),
                counts,
            },
        );
        for (event, text) in capture_gaps {
            failures.push(HealthFailure {
                owner: HealthOwner::Capture.as_str().to_string(),
                subject_kind: CAPTURE_GAP_SUBJECT_KIND.to_string(),
                subject_id: event.event_order().to_string(),
                derivation_type: CAPTURE_GAP_KIND.to_string(),
                reason: text,
            });
        }
    }

    for (owner, entries) in sources {
        for entry in entries {
            let key = format!("{}:{}", owner.as_str(), entry.derivation_type);
            let row = counts_by_owner_kind
                .entry(key)
                .or_insert_with(|| HealthOwnerEntry {
                    owner,
                    kind: entry.derivation_type.clone(),
                    counts: empty_counts(),
                });
            match entry.state {
                DerivationState::Ready => row.counts.ready += 1,
                DerivationState::Pending => row.counts.pending += 1,
                DerivationState::Failed => {
                    row.counts.failed += 1;
                    failures.push(failure_of(owner, entry));
                    // The preview is exactly the failed-and-not-blocked set: blocked is
                    // a distinct state, so failed entries ARE the requeue targets.
                    repair_preview.push(HealthRepairPreview {
                        owner: owner.as_str().to_string(),
                        subject_kind: entry.subject_kind.as_str().to_string(),
                        subject_id: entry.subject_id.clone(),
                        derivation_type: entry.derivation_type.clone(),
                    });
                }
                DerivationState::Blocked => {
                    row.counts.blocked += 1;
                    failures.push(failure_of(owner, entry));
                }
            }
            // Live queue visibility, per report entry: every pending entry rides a
            // live item, so queued + claimed here equals pending above by
            // construction. Counts are per derivation-report entry:
            // one work item may back multiple entries, so a raw work-item count would
            // break that identity.
            if let Some(q) = &entry.queue {
                match q.status {
                    QueueStatus::Queued => queue.queued += 1,
                    QueueStatus::Claimed => queue.claimed += 1,
                }
            }
        }
    }

    // Deterministic order: messages before turns, kinds alphabetical within
    // an owner — repeated reads with no writes between are deep-equal.
    let mut owners: Vec<HealthOwnerEntry> = counts_by_owner_kind.into_values().collect();
    owners.sort_by(|a, b| {
        a.owner
            .as_str()
            .cmp(b.owner.as_str())
            .then_with(|| a.kind.cmp(&b.kind))
    });

    OpResult::Ok {
        value: HealthReport {
            owners,
            failures,
            repair_preview,
            queue,
        },
    }
}

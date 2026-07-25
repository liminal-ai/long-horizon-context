//! Ported from packages/lhc/src/inspect/internal/overview.ts.
//!
//! Overview composition joins thread metadata, event/message/turn/chunk counts,
//! derivation state totals, and the active-view / visibility summary. Every
//! thread shape falls out of this one composition path: absent pieces normalize
//! to zeros/nulls, no shape-specific branch.

use indexmap::IndexMap;

use crate::intake_stream;
use crate::messages::{self, MessageListOptions};
use crate::shared_tech::derivation::{DerivationReportEntry, DerivationState};
use crate::shared_tech::errors::OpResult;
use crate::shared_tech::inspect::{
    InspectOverview, InspectOverviewChunks, InspectOverviewDerivation, InspectOverviewEvents,
    InspectOverviewEventsSpan, InspectOverviewMessages, InspectOverviewThread,
    InspectOverviewTurns, InspectOverviewView, InspectOverviewVisibility,
};
use crate::thread_view;
use crate::threads::{self, ResolveInput, ThreadRef};
use crate::turns::{self, TurnStatus};

/// TS `bucketEntries` — one report entry's operational bucket. Unlike
/// ViewStatus, overview counts ready too. Exported in TS (used by tests /
/// same-module); keep crate-visible.
pub fn bucket_entries(entries: &[DerivationReportEntry], counts: &mut InspectOverviewDerivation) {
    for entry in entries {
        match entry.state {
            DerivationState::Ready => counts.ready += 1,
            DerivationState::Pending => counts.pending += 1,
            DerivationState::Failed => counts.failed += 1,
            DerivationState::Blocked => counts.blocked += 1,
        }
    }
}

pub async fn compose_overview(ref_: ThreadRef) -> OpResult<InspectOverview> {
    // Thread identity from the threads surface: the file's own metadata header
    // serves any resolvable ref; a registry row (threadId refs) adds the title.
    let identity = match threads::info(ref_.clone()).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let mut thread = InspectOverviewThread {
        id: identity.thread_id,
        created_at: identity.created_at,
        metadata: None,
    };
    if let ThreadRef::Id(id_ref) = &ref_ {
        let registered = threads::resolve(ResolveInput {
            thread_id: id_ref.thread_id.clone(),
            registry_path: id_ref.registry_path.clone(),
        })
        .await;
        if let OpResult::Ok { value } = registered {
            if let Some(title) = value.title {
                let mut metadata = IndexMap::new();
                metadata.insert("title".to_string(), title);
                thread.metadata = Some(metadata);
            }
        }
    }

    let events = match intake_stream::list_events(ref_.clone()).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let first = events.first();
    let last = events.last();
    let event_section = InspectOverviewEvents {
        count: events.len() as i64,
        span: match (first, last) {
            (Some(first), Some(last)) => Some(InspectOverviewEventsSpan {
                first: first.event_order(),
                last: last.event_order(),
            }),
            _ => None,
        },
    };

    // The audit listing carries everything; deleted records count only in
    // `deleted`. Visible, byKind, and the token sum are computed over unflagged
    // records alone.
    let listed = match messages::list(
        ref_.clone(),
        Some(MessageListOptions {
            from: None,
            to: None,
            limit: None,
            include_deleted: Some(true),
        }),
    )
    .await
    {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let mut message_section = InspectOverviewMessages {
        visible: 0,
        by_kind: IndexMap::new(),
        deleted: 0,
        visible_tokens: 0,
    };
    for record in listed {
        if record.deleted == Some(true) {
            message_section.deleted += 1;
            continue;
        }
        message_section.visible += 1;
        // TS: messageSection.byKind[record.kind] = (… ?? 0) + 1
        let kind = record.kind.as_str().to_string();
        *message_section.by_kind.entry(kind).or_insert(0) += 1;
        message_section.visible_tokens += record.token_estimate;
    }

    let turn_list = match turns::list_turns(ref_.clone()).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let open = turn_list
        .iter()
        .filter(|turn| turn.status == TurnStatus::Open)
        .count() as i64;
    let closed = turn_list.len() as i64 - open;

    let chunk_list = match turns::list_chunks(ref_.clone()).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    // Closed-but-unchunked: closed turns whose derivation has not placed them
    // yet — stored placement read back, never recomputed.
    let unchunked_turns = turn_list
        .iter()
        .filter(|turn| turn.status == TurnStatus::Closed && turn.chunk_id.is_none())
        .count() as i64;

    // Derivation counts across both owners' report surfaces (never a
    // derivation read), ready included.
    let message_report = match messages::report(ref_.clone(), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let turn_report = match turns::report(ref_.clone(), None).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let mut derivation = InspectOverviewDerivation {
        ready: 0,
        pending: 0,
        failed: 0,
        blocked: 0,
    };
    bucket_entries(&message_report, &mut derivation);
    bucket_entries(&turn_report, &mut derivation);

    // View summary and visibility: visibility from status; view identity from
    // describe, with stored snapshot fields returned verbatim.
    let status = match thread_view::status(ref_.clone()).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let described = match thread_view::describe(ref_).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let view = described.map(|stored| InspectOverviewView {
        view_id: stored.view_id,
        created_at: stored.created_at,
        compact_point: stored.compact_point,
        covered_from: stored.covered_from,
    });

    OpResult::Ok {
        value: InspectOverview {
            thread,
            events: event_section,
            messages: message_section,
            turns: InspectOverviewTurns { open, closed },
            chunks: InspectOverviewChunks {
                count: chunk_list.len() as i64,
                unchunked_turns,
            },
            derivation,
            view,
            visibility: InspectOverviewVisibility {
                boundary_position: status.visibility.boundary_position,
                zone_tokens: status.visibility.zone_tokens,
            },
        },
    }
}

//! Ported from packages/lhc/src/inspect/internal/view-report.ts.
//!
//! View-contents report composition uses only describe + model context. The
//! stored arrangement, gaps, config, per-band token counts, and source-state
//! provenance come from `threadView.describe`; serving cost comes from measuring
//! `threadView.getLlmRequestContext` messages with the shared estimator. Nothing
//! here recomputes selection, rendering, derivation choice, or boundary state.

use crate::shared_tech::errors::{OpResult, storage_failure};
use crate::shared_tech::inspect::{
    ViewContentsBand, ViewContentsBandEntry, ViewContentsGap, ViewContentsLoadCost,
    ViewContentsMeta, ViewContentsMetaConfig, ViewContentsReport, ViewContentsSourceState,
    ViewContentsTail,
};
use crate::shared_tech::js_json::js_string_of_number;
use crate::shared_tech::token_counting::estimate_tokens;
use crate::shared_tech::view::{Band, LlmRequestContextMessage};
use crate::thread_view;
use crate::threads::ThreadRef;

/// TS private `BAND_ORDER` — brief → detailed → smooth served order.
const BAND_ORDER: &[Band] = &[Band::Brief, Band::Detailed, Band::Smooth];

/// TS view-report cross-check diagnostic fragments — byte-exact.
///
/// Full message:
/// `view report cross-check failed: describe saw ${n} stored band(s) but model context produced ${m} band message(s); the view changed between reads`
const DIAG_VIEW_REPORT_CROSS_CHECK_PREFIX: &str = "view report cross-check failed: describe saw ";
const DIAG_VIEW_REPORT_CROSS_CHECK_MID: &str = " stored band(s) but model context produced ";
const DIAG_VIEW_REPORT_CROSS_CHECK_SUFFIX: &str =
    " band message(s); the view changed between reads";

fn message_text(message: &LlmRequestContextMessage) -> String {
    message
        .content
        .iter()
        .map(|part| part.text.as_str())
        .collect()
}

fn measured_tokens(messages: &[LlmRequestContextMessage]) -> i64 {
    messages
        .iter()
        .map(|message| estimate_tokens(&message_text(message)))
        .sum()
}

pub async fn compose_view_report(ref_: ThreadRef) -> OpResult<ViewContentsReport> {
    let described = match thread_view::describe(ref_.clone()).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let context = match thread_view::get_llm_request_context(ref_).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => return OpResult::Err { error },
    };
    let stored = described;
    // TS: stored?.bands.length ?? 0
    let stored_band_count = stored.as_ref().map(|s| s.bands.len()).unwrap_or(0);

    let band_messages = &context.messages[..stored_band_count.min(context.messages.len())];
    let tail_messages = if stored_band_count <= context.messages.len() {
        &context.messages[stored_band_count..]
    } else {
        &[][..]
    };

    // Cross-check count only: the arrangement is describe's; model context has
    // to be serving the same snapshot's bands. A mismatch means the two reads saw
    // different stored state, so report it rather than papering over it.
    if band_messages.len() != stored_band_count {
        // JS template `${n}` uses ToString — shared number lane for diagnostics.
        return storage_failure(&format!(
            "{DIAG_VIEW_REPORT_CROSS_CHECK_PREFIX}{}{DIAG_VIEW_REPORT_CROSS_CHECK_MID}{}{DIAG_VIEW_REPORT_CROSS_CHECK_SUFFIX}",
            js_string_of_number(stored_band_count as f64),
            js_string_of_number(band_messages.len() as f64),
        ));
    }

    // Band sections: stored arrangement entries grouped in served order
    // (brief → detailed → smooth), gap entries included. Their reasons live in
    // `gaps`. storedTokens is the band row's count from the stored snapshot, not
    // recomputed here.
    let bands: Vec<ViewContentsBand> = match &stored {
        None => Vec::new(),
        Some(stored) => {
            let mut bands = Vec::new();
            for &band in BAND_ORDER {
                let entries: Vec<ViewContentsBandEntry> = stored
                    .arrangement
                    .iter()
                    .filter(|entry| entry.band == band)
                    .map(|entry| ViewContentsBandEntry {
                        subject_kind: entry.subject_kind,
                        subject_id: entry.subject_id.clone(),
                        derivation_used: entry.derivation_used.clone(),
                        degraded: entry.degraded,
                    })
                    .collect();
                let stored_band = stored.bands.iter().find(|row| row.band == band);
                if entries.is_empty() && stored_band.is_none() {
                    continue;
                }
                bands.push(ViewContentsBand {
                    band,
                    entries,
                    stored_tokens: stored_band.map(|row| row.stored_tokens).unwrap_or(0),
                });
            }
            bands
        }
    };

    let band_tokens = measured_tokens(band_messages);
    let tail_tokens = measured_tokens(tail_messages);

    let (meta, gaps, source_state) = match &stored {
        None => (None, Vec::new(), None),
        Some(stored) => (
            Some(ViewContentsMeta {
                view_id: stored.view_id.clone(),
                created_at: stored.created_at.clone(),
                profile: stored.profile_name.clone(),
                config: ViewContentsMetaConfig {
                    lower_bound: stored.config.lower_bound,
                    percentages: stored.config.percentages.clone(),
                },
                compact_point: stored.compact_point,
                covered_from: stored.covered_from,
            }),
            stored
                .gaps
                .iter()
                .map(|gap| ViewContentsGap {
                    band: gap.band,
                    subject_id: gap.subject_id.clone(),
                    reason: gap.reason.clone(),
                })
                .collect(),
            Some(ViewContentsSourceState {
                max_event_order: stored.source_state.max_event_order,
                derivation_counts: stored.source_state.derivation_counts.clone(),
            }),
        ),
    };

    OpResult::Ok {
        value: ViewContentsReport {
            meta,
            bands,
            gaps,
            tail: ViewContentsTail {
                message_count: tail_messages.len() as i64,
                tokens: tail_tokens,
            },
            load_cost: ViewContentsLoadCost {
                band_tokens,
                tail_tokens,
                total: band_tokens + tail_tokens,
            },
            source_state,
        },
    }
}

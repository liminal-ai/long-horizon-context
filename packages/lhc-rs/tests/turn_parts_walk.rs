//! Ported from packages/lhc/test/turn-parts-walk.test.ts.
//!
//! Turn parts — the walk (epic Flows 1, 3, 4, 6): split the open turn at the
//! newest admissible complete step edge, serve parts behind seam lines inside
//! the installed snapshot, keep the split point monotone and prior part bytes
//! stable, settle a closed transition turn whole before any other turn splits,
//! and never emit a part on the legacy plan. One invariant, exercised by the
//! scenario matrix: at most one unsettled turn at compact completion.
mod fixtures;

use fixtures::turn_parts::{
    closed_turn, compact_pinned, context, context_texts, describe, drain_to_zero, event, file_ref,
    giant, host_metadata, new_thread, params, part_entry, prompt, sdk_for, send, step, step_sums,
    turn_end,
};
use fixtures::{open_raw, temp_store};
use lhc::intake_stream::EventKind;
use lhc::shared_tech::errors::OpResult;
use lhc::shared_tech::js_json::js_json_stringify;
use lhc::shared_tech::storage::SqlParam;
use lhc::shared_tech::view::{
    Band, HostMetadataUnsettledTurn, ReceiptPart, SettleConstruction, SettledTurn, SplitPoint,
    ViewSubjectKind,
};
use lhc::turns::TurnStatus;
use serde_json::json;

static ALGORITHM_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn part(turn_id: &str, from_step: i64, to_step: i64) -> ReceiptPart {
    ReceiptPart {
        turn_id: turn_id.into(),
        from_step,
        to_step,
    }
}

fn unsettled(turn_id: &str) -> Option<HostMetadataUnsettledTurn> {
    Some(HostMetadataUnsettledTurn {
        turn_id: turn_id.into(),
    })
}

#[tokio::test]
async fn splits_at_the_smallest_complete_step_edge_whose_tail_fits_closes_nothing_serves_the_part_behind_a_seam()
 {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = new_thread(&sdk, &store).await;
    send(&sdk, &file_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    events.extend(step(2, "charlie"));
    events.extend(step(3, "delta"));
    // in-flight step: a call with no result yet
    events.push(event(
        EventKind::AssistantText,
        json!({"text": "step 4: working", "stepIndex": 4}),
    ));
    events.push(event(
        EventKind::ToolCall,
        json!({"toolCallId": "c4", "toolName": "read", "arguments": {}, "stepIndex": 4}),
    ));
    send(&sdk, &file_path, &events).await;
    // Exact tie on step 1's edge: the full share equals the tail after it, so
    // k = 2 (steps 0–1 in the part) by the inclusive rule; an off-by-one
    // (strict <) would select step 2's edge instead.
    let sums = step_sums(&file_path, "t2");
    let tie = sums.after[&1];
    assert!(sums.after[&0] > tie);
    let compacted = compact_pinned(&file_path, params(tie * 2)).await;
    let receipt = &compacted.receipt;

    assert_eq!(
        receipt.split_point,
        Some(SplitPoint {
            turn_id: "t2".into(),
            step_index: 1
        })
    );
    assert_eq!(receipt.parts, Some(vec![part("t2", 0, 1)]));
    assert_eq!(receipt.compact_point, sums.edge[&1]);
    assert_eq!(receipt.settled, None);

    // Nothing closed, nothing opened.
    let turns = match sdk.turns.list_turns(file_ref(&file_path)).await {
        OpResult::Ok { value } => value,
        OpResult::Err { error } => panic!("{}", error.reason),
    };
    assert_eq!(
        turns
            .iter()
            .map(|t| (t.turn_id.as_str(), t.status))
            .collect::<Vec<_>>(),
        vec![("t1", TurnStatus::Closed), ("t2", TurnStatus::Open)]
    );

    // The part: one smooth entry over steps 0–1, labeled, raw prompt, seam line last.
    let part = part_entry(&compacted.entries);
    assert_eq!(part.band, Band::Smooth);
    assert_eq!(part.subject_kind, ViewSubjectKind::Turn);
    assert_eq!(part.subject_id, "t2");
    assert_eq!(part.derivation_used, "part");
    assert!(part.text.starts_with("<t2>\n"));
    assert!(part.text.contains("long task"));
    assert!(part.text.contains("step 1: bravo"));
    assert!(!part.text.contains("step 2: charlie"));
    assert!(
        part.text
            .ends_with("\n[seam · t2 · steps 0–1 summarized above · t2 resumes below]\n</t2>")
    );
    assert!(part.text.contains("<m"));

    // Served view: bands, then the verbatim tail from the first message of step 2.
    let texts = context_texts(&context(&file_path).await);
    assert!(texts.iter().any(|t| t.starts_with("step 2: charlie")));
    assert!(!texts.iter().any(|t| t.starts_with("step 1: bravo")));
    assert_eq!(
        receipt.first_kept_message_id.as_deref(),
        Some(format!("m{}", sums.edge[&1] + 1).as_str())
    );
    assert_eq!(
        host_metadata(&file_path).await.unsettled_turn,
        unsettled("t2")
    );
    store.cleanup();
}

#[tokio::test]
async fn grows_monotonically_a_later_compact_appends_a_new_part_and_keeps_the_prior_parts_bytes() {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = new_thread(&sdk, &store).await;
    send(&sdk, &file_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    events.extend(step(2, "charlie"));
    send(&sdk, &file_path, &events).await;
    let first = compact_pinned(
        &file_path,
        params(step_sums(&file_path, "t2").after[&0] * 2),
    )
    .await;
    assert_eq!(first.receipt.parts, Some(vec![part("t2", 0, 0)]));
    let first_part = part_entry(&first.entries).text.clone();

    // Pressure relaxes (huge budget): k never moves backward.
    let relaxed = compact_pinned(&file_path, params(100_000)).await;
    assert_eq!(relaxed.receipt.parts, Some(vec![part("t2", 0, 0)]));
    assert_eq!(part_entry(&relaxed.entries).text, first_part);

    // More steps, tighter budget: coverage extends with a NEW part over the new range only.
    let mut more = Vec::new();
    more.extend(step(3, "delta"));
    more.extend(step(4, "echo"));
    more.extend(step(5, "foxtrot"));
    send(&sdk, &file_path, &more).await;
    let sums = step_sums(&file_path, "t2");
    let second = compact_pinned(&file_path, params(sums.after[&3] * 2)).await;
    assert_eq!(
        second.receipt.parts,
        Some(vec![part("t2", 0, 0), part("t2", 1, 3)])
    );
    let parts: Vec<_> = second.entries.iter().filter(|e| e.part.is_some()).collect();
    assert_eq!(parts[0].text, first_part);
    assert!(parts[1].text.contains("step 1: bravo"));
    assert!(parts[1].text.contains("step 3: delta"));
    assert!(!parts[1].text.contains("step 0: alpha"));
    assert!(
        parts[1]
            .text
            .ends_with("[seam · t2 · steps 1–3 summarized above · t2 resumes below]\n</t2>")
    );
    assert_eq!(second.receipt.compact_point, sums.edge[&3]);
    store.cleanup();
}

#[tokio::test]
async fn does_not_split_a_turn_with_any_null_step_index_and_the_legacy_plan_never_splits() {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = new_thread(&sdk, &store).await;
    send(&sdk, &file_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    events.push(event(
        EventKind::AssistantText,
        json!({"text": "unstamped"}),
    ));
    events.extend(step(2, "charlie"));
    send(&sdk, &file_path, &events).await;
    let tight = params(step_sums(&file_path, "t2").after[&1] * 2);
    let unstamped = compact_pinned(&file_path, tight).await;
    assert_eq!(unstamped.receipt.parts, None);
    assert_eq!(unstamped.receipt.split_point, None);
    assert!(!unstamped.entries.iter().any(|e| e.part.is_some()));

    // Stamped but legacy: identical no-split outcome, no part vocabulary anywhere.
    let legacy_path = new_thread(&sdk, &store).await;
    send(&sdk, &legacy_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    events.extend(step(2, "charlie"));
    send(&sdk, &legacy_path, &events).await;
    // SAFETY: serialized by ALGORITHM_ENV within this binary.
    unsafe { std::env::set_var("LHC_COMPACT_ALGORITHM", "legacy") };
    let legacy = compact_pinned(
        &legacy_path,
        params(step_sums(&legacy_path, "t2").after[&0] * 2),
    )
    .await;
    unsafe { std::env::remove_var("LHC_COMPACT_ALGORITHM") };
    assert_eq!(legacy.receipt.parts, None);
    assert_eq!(legacy.receipt.split_point, None);
    assert!(!legacy.entries.iter().any(|e| e.part.is_some()));
    let described = describe(&legacy_path).await;
    assert!(described.arrangement.iter().all(|e| e.part.is_none()));
    let raw = serde_json::to_value(&described.arrangement).expect("json");
    assert!(!raw.to_string().contains("\"part\""));
    store.cleanup();
}

#[tokio::test]
async fn tc_1_8c_serves_the_oversized_newest_complete_step_uncapped_in_the_tail_and_moves_the_complete_prefix_into_a_part()
 {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = new_thread(&sdk, &store).await;
    send(&sdk, &file_path, &closed_turn("t1")).await;
    let giant = giant();
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.push(event(
        EventKind::AssistantText,
        json!({"text": giant, "stepIndex": 1}),
    ));
    events.push(event(
        EventKind::ToolCall,
        json!({"toolCallId": "c1", "toolName": "read", "arguments": {}, "stepIndex": 1}),
    ));
    events.push(event(
        EventKind::ToolResult,
        json!({"toolCallId": "c1", "content": "result 1", "stepIndex": 1}),
    ));
    // In flight: step 2's call has no result yet, so step 1 is the newest
    // complete step and k may reach at most 1.
    events.push(event(
        EventKind::AssistantText,
        json!({"text": "step 2: charlie", "stepIndex": 2}),
    ));
    events.push(event(
        EventKind::ToolCall,
        json!({"toolCallId": "c2", "toolName": "read", "arguments": {}, "stepIndex": 2}),
    ));
    send(&sdk, &file_path, &events).await;
    let sums = step_sums(&file_path, "t2");
    // The full share is under the tail behind step 0's edge: no edge fits.
    let compacted = compact_pinned(&file_path, params(sums.after[&0])).await;
    let receipt = &compacted.receipt;
    assert_eq!(receipt.parts, Some(vec![part("t2", 0, 0)]));
    assert_eq!(receipt.compact_point, sums.edge[&0]);
    assert!(
        receipt.tail_tokens as f64 > receipt.config.lower_bound * (receipt.config.full / 100.0)
    );
    let part = part_entry(&compacted.entries);
    assert!(part.text.contains("step 0: alpha"));
    assert!(!part.text.contains("line 0 of a very long"));
    let texts = context_texts(&context(&file_path).await);
    assert!(texts.contains(&giant));
    assert!(!texts.iter().any(|t| t.contains("elided at construction")));
    store.cleanup();
}

async fn split_then_close(sdk: &lhc::Lhc, store: &fixtures::TempStore) -> (String, String) {
    let file_path = new_thread(sdk, store).await;
    send(sdk, &file_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    events.extend(step(2, "charlie"));
    send(sdk, &file_path, &events).await;
    let split = compact_pinned(
        &file_path,
        params(step_sums(&file_path, "t2").after[&0] * 2),
    )
    .await;
    assert_eq!(split.receipt.parts, Some(vec![part("t2", 0, 0)]));
    send(sdk, &file_path, &[turn_end()]).await;
    let text = part_entry(&split.entries).text.clone();
    (file_path, text)
}

#[tokio::test]
async fn a_closed_transition_turn_keeps_its_parts_until_a_compact_bands_it_a_split_elsewhere_settles_it_first()
 {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let (file_path, part_text) = split_then_close(&sdk, &store).await;
    send(&sdk, &file_path, &[prompt("next")]).await;

    // Lazy: a generous budget would leave t2 in the tail — the walk keeps its
    // installed edge and parts instead of serving it whole-unsettled.
    let lazy = compact_pinned(&file_path, params(100_000)).await;
    assert_eq!(lazy.receipt.parts, Some(vec![part("t2", 0, 0)]));
    assert_eq!(lazy.receipt.settled, None);
    assert_eq!(part_entry(&lazy.entries).text, part_text);
    assert_eq!(
        host_metadata(&file_path).await.unsettled_turn,
        unsettled("t2")
    );

    // t3 grows past the full share: t2 settles whole (composed in-walk — no
    // drain ran, so no stored rendering exists), then t3 splits.
    let mut events = Vec::new();
    events.extend(step(0, "golf"));
    events.extend(step(1, "hotel"));
    events.extend(step(2, "india"));
    events.extend(step(3, "juliet"));
    send(&sdk, &file_path, &events).await;
    let sums = step_sums(&file_path, "t3");
    let settled = compact_pinned(&file_path, params(sums.after[&1] * 2)).await;
    assert_eq!(
        settled.receipt.settled,
        Some(SettledTurn {
            turn_id: "t2".into(),
            construction: SettleConstruction::ComposedInWalk {
                turn_id: "t2".into()
            }
        })
    );
    assert_eq!(settled.receipt.parts, Some(vec![part("t3", 0, 1)]));
    let t2: Vec<_> = settled
        .entries
        .iter()
        .filter(|e| e.subject_id == "t2")
        .collect();
    assert_eq!(t2.len(), 1);
    assert_eq!(t2[0].band, Band::Smooth);
    assert_eq!(t2[0].derivation_used, "composed_in_walk");
    assert!(!t2[0].degraded);
    assert_eq!(t2[0].part, None);
    assert!(t2[0].text.contains("step 2: charlie"));
    let parted: std::collections::HashSet<&str> = settled
        .entries
        .iter()
        .filter(|e| e.part.is_some())
        .map(|e| e.subject_id.as_str())
        .collect();
    assert_eq!(parted, ["t3"].into_iter().collect());
    assert_eq!(
        host_metadata(&file_path).await.unsettled_turn,
        unsettled("t3")
    );
    store.cleanup();
}

#[tokio::test]
async fn split_equals_never_split_the_settled_construction_is_byte_identical_to_the_never_split_turns_stored_rendering()
 {
    let _env = ALGORITHM_ENV.lock().await;
    async fn script(sdk: &lhc::Lhc, file_path: &str, mid_turn_compact: bool) {
        send(sdk, file_path, &closed_turn("t1")).await;
        let mut events = vec![prompt("long task")];
        events.extend(step(0, "alpha"));
        events.extend(step(1, "bravo"));
        events.extend(step(2, "charlie"));
        send(sdk, file_path, &events).await;
        if mid_turn_compact {
            let split =
                compact_pinned(file_path, params(step_sums(file_path, "t2").after[&0] * 2)).await;
            assert_eq!(split.receipt.parts.as_ref().map(Vec::len), Some(1));
        }
        send(sdk, file_path, &[turn_end()]).await;
        let mut next = vec![prompt("next")];
        next.extend(step(0, "golf"));
        send(sdk, file_path, &next).await;
        // Pin derivation state on both copies: every queued derivation lands.
        drain_to_zero(sdk, file_path).await;
    }
    let store = temp_store();
    let sdk = sdk_for();
    let split = new_thread(&sdk, &store).await;
    let whole = new_thread(&sdk, &store).await;
    script(&sdk, &split, true).await;
    script(&sdk, &whole, false).await;

    // The split copy settles through the composed-in-walk rung: clear its
    // stored rendering (what an edit cascade does) so the walk must compose.
    let db = open_raw(&split);
    db.prepare(
        "DELETE FROM derivation WHERE subject_id = 't2' AND derivation_type = 'turn_rendering'",
    )
    .run(&[]);
    db.close();
    let budget = params(step_sums(&whole, "t3").after[&0] * 2 + 1);
    let settled = compact_pinned(&split, budget.clone()).await;
    let never = compact_pinned(&whole, budget).await;
    assert_eq!(
        settled
            .receipt
            .settled
            .as_ref()
            .map(|s| s.construction.clone()),
        Some(SettleConstruction::ComposedInWalk {
            turn_id: "t2".into()
        })
    );
    assert_eq!(never.receipt.settled, None);
    let settled_entry = settled
        .entries
        .iter()
        .find(|e| e.subject_id == "t2")
        .expect("t2");
    let whole_entry = never
        .entries
        .iter()
        .find(|e| e.subject_id == "t2")
        .expect("t2");
    assert_eq!(whole_entry.derivation_used, "turn_rendering");
    assert_eq!(settled_entry.text, whole_entry.text);
    store.cleanup();
}

#[tokio::test]
async fn tc_1_4a_a_part_renders_the_unsmoothed_prompt_identical_with_or_without_a_ready_smoothed_derivation()
 {
    let _env = ALGORITHM_ENV.lock().await;
    async fn build(sdk: &lhc::Lhc, store: &fixtures::TempStore, drain_first: bool) -> String {
        let file_path = new_thread(sdk, store).await;
        send(&sdk, &file_path, &closed_turn("t1")).await;
        let mut events = vec![prompt("long task")];
        events.extend(step(0, "alpha"));
        events.extend(step(1, "bravo"));
        events.extend(step(2, "charlie"));
        send(sdk, &file_path, &events).await;
        if drain_first {
            drain_to_zero(sdk, &file_path).await;
            let db = open_raw(&file_path);
            let row = db
                .prepare(
                    "SELECT state, content FROM derivation WHERE subject_id = 'm4' AND derivation_type = 'smoothed_prompt'",
                )
                .get()
                .expect("floor row");
            db.close();
            assert_eq!(row["state"].as_str(), Some("ready"));
            assert!(row["content"].as_str().unwrap_or("").contains("smoothed("));
        }
        let compacted = compact_pinned(
            &file_path,
            params(step_sums(&file_path, "t2").after[&0] * 2),
        )
        .await;
        assert_eq!(compacted.receipt.parts, Some(vec![part("t2", 0, 0)]));
        part_entry(&compacted.entries).text.clone()
    }
    let store = temp_store();
    let sdk = sdk_for();
    let unsmoothed = build(&sdk, &store, false).await;
    let smoothed = build(&sdk, &store, true).await;
    assert_eq!(smoothed, unsmoothed);
    assert!(smoothed.contains("long task"));
    assert!(!smoothed.contains("smoothed("));
    assert!(!smoothed.contains("[fallback"));
    store.cleanup();
}

#[tokio::test]
async fn ac_4_2_a_multi_part_turn_settles_exactly_like_the_single_part_case() {
    let _env = ALGORITHM_ENV.lock().await;
    async fn settle_after(
        sdk: &lhc::Lhc,
        store: &fixtures::TempStore,
        splits: u8,
    ) -> (String, usize) {
        let file_path = new_thread(sdk, store).await;
        send(sdk, &file_path, &closed_turn("t1")).await;
        let mut events = vec![prompt("long task")];
        events.extend(step(0, "alpha"));
        events.extend(step(1, "bravo"));
        send(sdk, &file_path, &events).await;
        if splits == 2 {
            let first = compact_pinned(
                &file_path,
                params(step_sums(&file_path, "t2").after[&0] * 2),
            )
            .await;
            assert_eq!(first.receipt.parts, Some(vec![part("t2", 0, 0)]));
        }
        let mut more = Vec::new();
        more.extend(step(2, "charlie"));
        more.extend(step(3, "delta"));
        send(sdk, &file_path, &more).await;
        let sums = step_sums(&file_path, "t2");
        let split = compact_pinned(
            &file_path,
            params(if splits == 2 {
                sums.after[&2] * 2
            } else {
                sums.after[&0] * 2
            }),
        )
        .await;
        assert_eq!(
            split.receipt.parts,
            Some(if splits == 2 {
                vec![part("t2", 0, 0), part("t2", 1, 2)]
            } else {
                vec![part("t2", 0, 0)]
            })
        );
        send(sdk, &file_path, &[turn_end()]).await;
        let mut next = vec![prompt("next")];
        next.extend(step(0, "golf"));
        next.extend(step(1, "hotel"));
        send(sdk, &file_path, &next).await;
        let settled = compact_pinned(
            &file_path,
            params(step_sums(&file_path, "t3").after[&0] * 2),
        )
        .await;
        assert_eq!(
            settled.receipt.settled,
            Some(SettledTurn {
                turn_id: "t2".into(),
                construction: SettleConstruction::ComposedInWalk {
                    turn_id: "t2".into()
                }
            })
        );
        let t2: Vec<_> = settled
            .entries
            .iter()
            .filter(|e| e.subject_id == "t2")
            .collect();
        assert_eq!(t2.len(), 1);
        assert_eq!(t2[0].part, None);
        assert_eq!(
            host_metadata(&file_path).await.unsettled_turn,
            unsettled("t3")
        );
        (
            t2[0].text.clone(),
            split.receipt.parts.map(|p| p.len()).unwrap_or(0),
        )
    }
    let store = temp_store();
    let sdk = sdk_for();
    let multi = settle_after(&sdk, &store, 2).await;
    let single = settle_after(&sdk, &store, 1).await;
    assert_eq!(multi.1, 2);
    assert_eq!(multi.0, single.0);
    assert!(multi.0.contains("step 3: delta"));
    assert!(!multi.0.contains("[seam ·"));
    store.cleanup();
}

#[tokio::test]
async fn tc_8_1a_install_is_the_whole_commitment_after_a_settle_nothing_outside_superseded_snapshots_holds_part_content()
 {
    let _env = ALGORITHM_ENV.lock().await;
    let store = temp_store();
    let sdk = sdk_for();
    let file_path = new_thread(&sdk, &store).await;
    send(&sdk, &file_path, &closed_turn("t1")).await;
    let mut events = vec![prompt("long task")];
    events.extend(step(0, "alpha"));
    events.extend(step(1, "bravo"));
    send(&sdk, &file_path, &events).await;
    let split = compact_pinned(
        &file_path,
        params(step_sums(&file_path, "t2").after[&0] * 2),
    )
    .await;
    assert_eq!(split.receipt.parts.as_ref().map(Vec::len), Some(1));
    send(&sdk, &file_path, &[turn_end()]).await;
    let mut next = vec![prompt("next")];
    next.extend(step(0, "golf"));
    send(&sdk, &file_path, &next).await;
    // A full share just over t3 bands t2 whole: settle, no part anywhere.
    let settled = compact_pinned(
        &file_path,
        params(step_sums(&file_path, "t2").after[&1] * 2 + 2),
    )
    .await;
    assert_eq!(
        settled.receipt.settled.as_ref().map(|s| s.turn_id.as_str()),
        Some("t2")
    );
    assert_eq!(settled.receipt.parts, None);

    // "Interrupted immediately after install": a fresh process serves from the
    // snapshot alone.
    let resumed = sdk_for();
    let served = fixtures::turn_parts::served_json(&file_path).await;
    let described = describe(&file_path).await;
    assert_eq!(described.view_id, settled.receipt.view_id);
    assert!(described.arrangement.iter().all(|e| e.part.is_none()));
    let db = open_raw(&file_path);
    let n = |sql: &str, params: &[SqlParam]| -> i64 {
        db.prepare(sql)
            .get_params(params)
            .and_then(|r| r["n"].as_i64())
            .unwrap_or(-1)
    };
    let views = n("SELECT COUNT(*) AS n FROM thread_view", &[]);
    let bands = n(
        "SELECT COUNT(*) AS n FROM thread_view_band WHERE view_id <> ?",
        &[SqlParam::from(settled.receipt.view_id.as_str())],
    );
    let seams = n(
        "SELECT COUNT(*) AS n FROM thread_view_band WHERE rendered_text LIKE '%[seam ·%'",
        &[],
    );
    let derived_seams = n(
        "SELECT COUNT(*) AS n FROM derivation WHERE content LIKE '%[seam ·%'",
        &[],
    );
    db.close();
    assert_eq!([views, bands, seams, derived_seams], [1, 0, 0, 0]);
    // Nothing is pending on the view's behalf: the queue drains to zero and
    // the installed snapshot is exactly what it was.
    drain_to_zero(&resumed, &file_path).await;
    let after = describe(&file_path).await;
    assert_eq!(
        js_json_stringify(&serde_json::to_value(&after).expect("json")),
        js_json_stringify(&serde_json::to_value(&described).expect("json"))
    );
    assert_eq!(fixtures::turn_parts::served_json(&file_path).await, served);
    store.cleanup();
}

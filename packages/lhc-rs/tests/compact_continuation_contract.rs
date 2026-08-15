//! LIM-62: compact-continuation contract parity against the canonical TypeScript
//! fixture store (`packages/lhc/fixtures/compact-continuation/v2`).
//!
//! Consumes fixtures **in place** via `CARGO_MANIFEST_DIR` — no fork/copy.
//! Also ports the independent LIM-60 behavioral probes from
//! `packages/lhc/test/compact-continuation-contract.test.ts`.

use std::collections::HashSet;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};

use lhc::shared_tech::compact_continuation::{
    COMPACT_CONTINUATION_CONTRACT_VERSION, COMPACT_CONTINUATION_HOST_CAPABILITIES,
    COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE, COMPACT_CONTINUATION_INVARIANTS,
    COMPACT_CONTINUATION_MARKER_ACTION, COMPACT_CONTINUATION_MARKER_CAUSE,
    COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX, COMPACT_CONTINUATION_MARKER_KIND,
    COMPACT_CONTINUATION_OUTCOME_KINDS, COMPACT_CONTINUATION_REFUSE_CODES,
    COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE, COMPACT_CONTINUATION_SKIP_CODES,
    COMPACT_CONTINUATION_STATES, COMPACT_CONTINUATION_TRANSITION_ORDER,
    COMPACT_CONTINUATION_WRITER_CLAIMS, CONTEXT_COMPACT_CONTINUE_REASON,
    CompactContinuationDecision, CompactContinuationEffect, CompactContinuationHostCapability,
    CompactContinuationInput, CompactContinuationInvariants, CompactContinuationOutcomeKind,
    CompactContinuationPolicy, CompactContinuationRefuseCode, CompactContinuationSeam,
    CompactContinuationSkipCode, CompactContinuationState, CompactMaterialFacts,
    ForcedContinuationBoundary, ForcedContinuationBoundaryApplied,
    ForcedContinuationBoundaryNotApplied, HostValidationStatusFact, PostMeasurementEstimate,
    ProviderUsageAuthority, ProviderUsageAvailable, ProviderUsageUnavailable,
    ProviderUsageUnavailableReason, ValidationResult, WorkContinuation, WriterClaim,
    as_compact_continuation_input, assert_decision_parity,
    compact_continuation_marker_idempotency_key, decide_compact_continuation,
    validate_compact_continuation_decision, validate_compact_continuation_input,
    validate_compact_continuation_receipt,
};
use lhc::shared_tech::js_json::js_json_stringify_of;

// ── Fixture location (canonical TS store; never forked) ──────────────────────

fn fixtures_root() -> PathBuf {
    // packages/lhc-rs → packages/lhc/fixtures/compact-continuation/v2
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("lhc")
        .join("fixtures")
        .join("compact-continuation")
        .join("v2")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    contract_version: String,
    contract_id: String,
    cases: Vec<ManifestCase>,
    required_coverage: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCase {
    file: String,
    name: String,
    coverage: Vec<String>,
    input_validation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCase {
    name: String,
    contract_version: String,
    #[allow(dead_code)]
    description: String,
    #[allow(dead_code)]
    coverage: Vec<String>,
    input_validation: String,
    input: Value,
    /// Typed expected for semantic validation / assert_decision_parity.
    expected: CompactContinuationDecision,
    /// Raw fixture `expected` Value retained for byte-parity vs TS disk bytes
    /// (preserve_order). Must not be reconstructed solely from the typed form.
    #[serde(skip)]
    expected_raw: Value,
}

fn load_manifest() -> Manifest {
    let path = fixtures_root().join("manifest.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("manifest parses")
}

fn load_case(rel: &str) -> FixtureCase {
    let path = fixtures_root().join(rel);
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let root: Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    let expected_raw = root
        .get("expected")
        .cloned()
        .unwrap_or_else(|| panic!("{}: missing expected", path.display()));
    let mut fixture: FixtureCase = serde_json::from_value(root)
        .unwrap_or_else(|e| panic!("typed parse {}: {e}", path.display()));
    fixture.expected_raw = expected_raw;
    fixture
}

fn assert_input_validation(value: &str, label: &str) {
    assert!(
        value == "accept" || value == "reject",
        "{label}: inputValidation must be \"accept\" | \"reject\", got {value:?}"
    );
}

fn base_material(over: Value) -> Value {
    let mut base = json!({
        "derivationsMissingOrFailed": false,
        "lowerTargetMet": true,
        "compactStructurallyValid": true,
        "installSucceeds": true,
        "usefulReduction": true,
        "canProduceValidProviderRequest": true,
        "projectedPressureTokens": 105_000,
        "renderedSavingsTokens": 0,
        "renderedSavingsSource": "lhc_rendered_history_estimate",
        "renderedSavingsDomain": "source_labelled_estimate",
        "safeRunwayThresholdTokens": 120_000,
        "safeRunwayThresholdSource": "host_safe_runway",
        "projectedPressureSafe": true,
        "protectedEscalationApplied": false,
        "visibilityBoundaryBefore": null,
        "visibilityBoundaryAfter": null,
        "compactPointAtInstall": null,
        "maximalPruneInsufficient": false,
        "hostValidationStatus": "not_required",
    });
    if let (Some(base_obj), Some(over_obj)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in over_obj {
            base_obj.insert(k.clone(), v.clone());
        }
    }
    base
}

/// TS-parity base input: section overrides merge (seam/policy/invariants/
/// compactMaterial/postMeasurementEstimate/providerUsage); other keys replace.
fn base_input(over: Value) -> Value {
    let over_obj = over.as_object().cloned().unwrap_or_default();
    let section = |name: &str| over_obj.get(name).cloned().unwrap_or(json!({}));

    let usage_over = over_obj.get("providerUsage").cloned();
    let provider_usage = match usage_over {
        None => json!({
            "available": true,
            "inputTokens": 105_000,
            "cacheCreationTokens": 0,
            "cacheReadTokens": 0,
            "total": 105_000,
            "domain": "provider_reported_input",
        }),
        Some(u) if u.get("available") == Some(&json!(false)) => json!({
            "available": false,
            "reason": u.get("reason").cloned().unwrap_or(json!("missing")),
            "domain": u.get("domain").cloned().unwrap_or(json!("provider_reported_input")),
        }),
        Some(u) => {
            let mut base = json!({
                "available": true,
                "inputTokens": 105_000,
                "cacheCreationTokens": 0,
                "cacheReadTokens": 0,
                "total": 105_000,
                "domain": "provider_reported_input",
            });
            if let (Some(b), Some(o)) = (base.as_object_mut(), u.as_object()) {
                for (k, v) in o {
                    b.insert(k.clone(), v.clone());
                }
            }
            base
        }
    };

    let merge = |mut base: Value, over: Value| -> Value {
        if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
            for (k, v) in o {
                b.insert(k.clone(), v.clone());
            }
        }
        base
    };

    let mut base = json!({
        "contractVersion": COMPACT_CONTINUATION_CONTRACT_VERSION,
        "seam": merge(json!({
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0,
        }), section("seam")),
        "providerUsage": provider_usage,
        "postMeasurementEstimate": merge(json!({
            "tokens": 0,
            "source": "lhc_token_estimate",
            "domain": "source_labelled_estimate",
        }), section("postMeasurementEstimate")),
        "policy": merge(json!({
            "upperTriggerTokens": 100_000,
            "lowerTargetTokens": 40_000,
            "hostCapability": "full_state_machine",
            "safeRunwayThresholdTokens": 120_000,
            "safeRunwayThresholdSource": "host_safe_runway",
        }), section("policy")),
        "continuation": { "kind": "active_non_tool" },
        "invariants": merge(json!({
            "captureComplete": true,
            "providerIdentityValid": true,
            "singleOpenTurn": true,
            "writerClaim": "none",
        }), section("invariants")),
        "forcedContinuationBoundary": { "applied": false },
        "compactMaterial": base_material(section("compactMaterial")),
    });
    if let Some(base_obj) = base.as_object_mut() {
        for (k, v) in &over_obj {
            if matches!(
                k.as_str(),
                "seam"
                    | "policy"
                    | "invariants"
                    | "compactMaterial"
                    | "postMeasurementEstimate"
                    | "providerUsage"
            ) {
                continue;
            }
            base_obj.insert(k.clone(), v.clone());
        }
    }
    base
}

fn effect_types(decision: &CompactContinuationDecision) -> Vec<&'static str> {
    decision.effects.iter().map(|e| e.type_str()).collect()
}

// ── Surface pins ─────────────────────────────────────────────────────────────

#[test]
fn pins_version_and_stable_strings() {
    assert_eq!(COMPACT_CONTINUATION_CONTRACT_VERSION, "2.0.0");
    assert_eq!(CONTEXT_COMPACT_CONTINUE_REASON, "context_compact_continue");
    assert_eq!(COMPACT_CONTINUATION_MARKER_KIND, "lhc.compact_continuation");
    assert_eq!(
        COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX,
        "lhc.compact_continuation:"
    );
    assert_eq!(
        compact_continuation_marker_idempotency_key("t3"),
        "lhc.compact_continuation:t3"
    );
    assert_eq!(
        COMPACT_CONTINUATION_MARKER_CAUSE,
        "context_compacted_task_in_progress"
    );
    assert_eq!(COMPACT_CONTINUATION_MARKER_ACTION, "continue_existing_task");
    assert!(COMPACT_CONTINUATION_REFUSE_CODES.contains(&"unsafe_runway"));
    assert!(COMPACT_CONTINUATION_REFUSE_CODES.contains(&"host_validation_failed"));
    assert!(COMPACT_CONTINUATION_REFUSE_CODES.contains(&"invalid_protected_tool_pairs"));
    assert!(COMPACT_CONTINUATION_OUTCOME_KINDS.contains(&"compact_preserve_tool_escalated"));
    assert!(COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE);
    assert!(COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE.contains("per-variant closed structs"));
}

#[test]
fn exports_closed_vocabularies() {
    assert!(COMPACT_CONTINUATION_STATES.len() > 10);
    assert!(COMPACT_CONTINUATION_OUTCOME_KINDS.contains(&"compact_continue_turn"));
    assert!(COMPACT_CONTINUATION_OUTCOME_KINDS.contains(&"compact_preserve_tool"));
    assert!(COMPACT_CONTINUATION_REFUSE_CODES.contains(&"native_writer_conflict"));
    assert!(COMPACT_CONTINUATION_REFUSE_CODES.contains(&"unsupported_contract_version"));
    assert!(COMPACT_CONTINUATION_REFUSE_CODES.contains(&"invalid_pending_boundary_continuation"));
    assert!(!COMPACT_CONTINUATION_REFUSE_CODES.contains(&"transport_retry"));
    assert!(!COMPACT_CONTINUATION_REFUSE_CODES.contains(&"not_at_settled_seam"));
    assert!(COMPACT_CONTINUATION_SKIP_CODES.contains(&"transport_retry"));
    assert!(COMPACT_CONTINUATION_SKIP_CODES.contains(&"input_epoch_changed"));
    assert!(COMPACT_CONTINUATION_SKIP_CODES.contains(&"not_at_settled_seam"));
    assert_eq!(COMPACT_CONTINUATION_TRANSITION_ORDER[0], "seam_eligibility");
    assert!(COMPACT_CONTINUATION_TRANSITION_ORDER.contains(&"forced_boundary_state_legality"));
    assert!(COMPACT_CONTINUATION_TRANSITION_ORDER.contains(&"force_boundary_if_continue_turn"));
    assert!(
        COMPACT_CONTINUATION_INVARIANTS
            .contains(&"install_failure_wins_over_no_reduction_classification")
    );
    assert!(
        COMPACT_CONTINUATION_INVARIANTS
            .contains(&"forced_boundary_repair_takes_precedence_over_fresh_pressure")
    );
    assert!(
        COMPACT_CONTINUATION_INVARIANTS
            .contains(&"marker_persisted_is_residual_state_not_attempt_scoped")
    );
    assert!(
        COMPACT_CONTINUATION_INVARIANTS
            .contains(&"settled_seam_lhc_claim_early_refuse_records_claim_and_release")
    );
    assert!(
        COMPACT_CONTINUATION_INVARIANTS
            .contains(&"preserve_tool_install_failure_includes_preserve_effect")
    );
    assert_eq!(COMPACT_CONTINUATION_HOST_CAPABILITIES.len(), 2);
    assert_eq!(COMPACT_CONTINUATION_WRITER_CLAIMS.len(), 4);
}

// ── Manifest + 47-case fixture parity ────────────────────────────────────────

#[test]
fn manifest_version_and_required_coverage_are_complete() {
    let manifest = load_manifest();
    assert_eq!(
        manifest.contract_version,
        COMPACT_CONTINUATION_CONTRACT_VERSION
    );
    assert_eq!(manifest.contract_id, "lhc.compact_continuation");
    assert!(manifest.cases.len() >= 18);
    assert_eq!(
        manifest.cases.len(),
        47,
        "LIM-67 expects exactly 47 fixture cases"
    );

    let covered: HashSet<&str> = manifest
        .cases
        .iter()
        .flat_map(|c| c.coverage.iter().map(|s| s.as_str()))
        .collect();
    for tag in &manifest.required_coverage {
        assert!(
            covered.contains(tag.as_str()),
            "missing coverage tag: {tag}"
        );
    }

    // Unique names and files.
    let mut names = HashSet::new();
    let mut files = HashSet::new();
    for c in &manifest.cases {
        assert!(
            names.insert(c.name.as_str()),
            "duplicate case name {}",
            c.name
        );
        assert!(
            files.insert(c.file.as_str()),
            "duplicate case file {}",
            c.file
        );
        assert_input_validation(&c.input_validation, &format!("manifest {}", c.name));
    }
}

#[test]
fn every_cases_json_file_is_listed_in_manifest() {
    let manifest = load_manifest();
    let cases_dir = fixtures_root().join("cases");
    let mut on_disk: Vec<String> = fs::read_dir(&cases_dir)
        .expect("cases dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.ends_with(".json"))
        .map(|f| format!("cases/{f}"))
        .collect();
    on_disk.sort();
    let mut listed: Vec<String> = manifest.cases.iter().map(|c| c.file.clone()).collect();
    listed.sort();
    assert_eq!(
        listed, on_disk,
        "manifest must list every case file and no extras"
    );
}

#[test]
fn all_47_fixture_cases_match_oracle_exactly() {
    let manifest = load_manifest();
    assert_eq!(manifest.cases.len(), 47);

    for entry in &manifest.cases {
        let fixture = load_case(&entry.file);
        assert_eq!(
            fixture.contract_version,
            COMPACT_CONTINUATION_CONTRACT_VERSION
        );
        assert_eq!(fixture.name, entry.name);

        assert_input_validation(&entry.input_validation, &format!("manifest {}", entry.name));
        assert_input_validation(
            &fixture.input_validation,
            &format!("fixture {}", fixture.name),
        );
        assert_eq!(
            fixture.input_validation, entry.input_validation,
            "fixture/manifest inputValidation must agree for {}",
            entry.name
        );

        let input_check = validate_compact_continuation_input(&fixture.input);
        // Branch on first-class inputValidation only — never on coverage tags.
        if fixture.input_validation == "reject" {
            assert!(
                !input_check.ok,
                "case {}: fixture must remain input-invalid",
                entry.name
            );
        } else {
            assert!(
                input_check.ok,
                "case {}: input validation failed: {:?}",
                entry.name, input_check.issues
            );
        }

        let expected_check = validate_compact_continuation_decision(&fixture.expected);
        assert!(
            expected_check.ok,
            "case {}: expected decision invalid: {:?}",
            entry.name, expected_check.issues
        );
        let receipt_value = serde_json::to_value(&fixture.expected.receipt).unwrap();
        let receipt_check = validate_compact_continuation_receipt(&receipt_value);
        assert!(
            receipt_check.ok,
            "case {}: expected receipt invalid: {:?}",
            entry.name, receipt_check.issues
        );

        // For reject cases, still evaluate the total oracle on the raw typed
        // shape (mirrors TS cast path) so residual refuse behavior is pinned.
        let actual = if fixture.input_validation == "reject" {
            // Deserialize without as_* (input is intentionally invalid). The
            // TS oracle is structurally typed: unknown props are invisible and
            // missing arrays normalize to empty. Mirror that for reject cases
            // that are not strictly deserializable (e.g. legacy toolCallId —
            // dual-field shim rejected at the type boundary).
            let typed_value = match serde_json::from_value::<
                lhc::shared_tech::compact_continuation::CompactContinuationInput,
            >(fixture.input.clone())
            {
                Ok(v) => v,
                Err(_) => {
                    let mut lenient = fixture.input.clone();
                    if let Some(cont) = lenient
                        .get_mut("continuation")
                        .and_then(|c| c.as_object_mut())
                        && cont.get("kind").and_then(|k| k.as_str())
                            == Some("pending_correlated_tool_result")
                    {
                        cont.remove("toolCallId");
                        cont.entry("protectedToolCallIds".to_string())
                            .or_insert(json!([]));
                    }
                    serde_json::from_value(lenient).unwrap_or_else(|e| {
                        panic!(
                            "case {}: reject fixture must still deserialize for total oracle: {e}",
                            entry.name
                        )
                    })
                }
            };
            let typed: CompactContinuationInputViaValue =
                CompactContinuationInputViaValue(typed_value);
            decide_compact_continuation(&typed.0)
        } else {
            let input = as_compact_continuation_input(&fixture.input)
                .unwrap_or_else(|e| panic!("case {}: {e}", entry.name));
            decide_compact_continuation(&input)
        };

        let parity = assert_decision_parity(&actual, &fixture.expected);
        assert!(
            parity.ok,
            "case {}: parity issues: {:?}",
            entry.name, parity.issues
        );

        // Semantic equality against typed expected.
        let actual_json = js_json_stringify_of(&actual).expect("serialize actual");
        let typed_expected_json =
            js_json_stringify_of(&fixture.expected).expect("serialize typed expected");
        assert_eq!(
            actual_json, typed_expected_json,
            "case {}: typed decision JSON must match\nactual:   {actual_json}\ntyped:    {typed_expected_json}",
            entry.name
        );

        // Fable finding 1: raw fixture bytes (not typed round-trip). Catches
        // Rust struct field-order / null-vs-omission / spelling drift.
        let raw_expected_json =
            js_json_stringify_of(&fixture.expected_raw).expect("serialize raw expected");
        assert_eq!(
            actual_json, raw_expected_json,
            "case {}: decision must be byte-identical to raw fixture expected (preserve_order)\nactual:   {actual_json}\nfixture:  {raw_expected_json}",
            entry.name
        );

        // Produced decision/receipt validate.
        let dcheck = validate_compact_continuation_decision(&actual);
        assert!(
            dcheck.ok,
            "case {}: produced decision invalid: {:?}",
            entry.name, dcheck.issues
        );
        let rcheck =
            validate_compact_continuation_receipt(&serde_json::to_value(&actual.receipt).unwrap());
        assert!(
            rcheck.ok,
            "case {}: produced receipt invalid: {:?}",
            entry.name, rcheck.issues
        );
    }
}

/// Newtype so the reject-path typed deserialize is explicit.
struct CompactContinuationInputViaValue(
    lhc::shared_tech::compact_continuation::CompactContinuationInput,
);

// ── Independent behavioral probes ────────────────────────────────────────────

#[test]
fn never_fabricates_next_request_pressure_without_provider_base() {
    let raw = base_input(json!({
        "providerUsage": {
            "available": false,
            "reason": "missing",
            "domain": "provider_reported_input",
        },
        "postMeasurementEstimate": {
            "tokens": 50_000,
            "source": "lhc_token_estimate",
            "domain": "source_labelled_estimate",
        },
        "policy": {
            "upperTriggerTokens": 10_000,
            "lowerTargetTokens": 5_000,
            "hostCapability": "full_state_machine",
        },
    }));
    let input = as_compact_continuation_input(&raw).unwrap();
    let actual = decide_compact_continuation(&input);
    assert_eq!(
        actual.outcome,
        CompactContinuationOutcomeKind::ContinueNormal
    );
    assert!(
        actual
            .receipt
            .pressure
            .next_request_pressure_tokens
            .is_none()
    );
    assert!(actual.receipt.pressure.at_or_above_trigger.is_none());
    assert!(
        !actual
            .transition_path
            .iter()
            .any(|s| *s == CompactContinuationState::BelowTrigger)
    );
}

#[test]
fn active_non_tool_forces_boundary_before_compact() {
    let fixture = load_case("cases/active_non_tool_above_trigger.json");
    let input = as_compact_continuation_input(&fixture.input).unwrap();
    let actual = decide_compact_continuation(&input);
    assert_eq!(
        actual.outcome,
        CompactContinuationOutcomeKind::CompactContinueTurn
    );
    assert_eq!(
        actual.receipt.turn_end_reason.as_deref(),
        Some(CONTEXT_COMPACT_CONTINUE_REASON)
    );
    let types = effect_types(&actual);
    let force_i = types.iter().position(|t| *t == "force_turn_end").unwrap();
    let compact_i = types.iter().position(|t| *t == "compact").unwrap();
    assert!(force_i < compact_i);
    assert!(!types.contains(&"open_continuation_turn"));
    assert!(!types.iter().any(|t| *t == "preserve_tool_pairs_verbatim"));
    assert!(actual.receipt.continuation.opened);
    assert!(actual.receipt.residual.marker_persisted);
    assert!(actual.receipt.residual.marker_served);
}

#[test]
fn pending_tool_path_preserves_pair_no_marker() {
    let fixture = load_case("cases/pending_tool_result_above_trigger.json");
    let input = as_compact_continuation_input(&fixture.input).unwrap();
    let actual = decide_compact_continuation(&input);
    assert_eq!(
        actual.outcome,
        CompactContinuationOutcomeKind::CompactPreserveTool
    );
    assert!(actual.receipt.turn_end_reason.is_none());
    assert!(actual.receipt.continuation.same_agentic_turn_preserved);
    let types = effect_types(&actual);
    assert!(!types.contains(&"insert_continuation_marker"));
    assert!(!types.contains(&"force_turn_end"));
    assert!(types.contains(&"preserve_tool_pairs_verbatim"));
}

#[test]
fn post_boundary_compact_failure_keeps_boundary_and_releases_writer() {
    let fixture = load_case("cases/compact_failed_continue_turn.json");
    let input = as_compact_continuation_input(&fixture.input).unwrap();
    let actual = decide_compact_continuation(&input);
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::CompactFailed)
    );
    assert!(actual.receipt.residual.forced_continuation_boundary_applied);
    assert!(actual.receipt.residual.writer_released);
    assert!(!actual.receipt.residual.marker_persisted);
    let types = effect_types(&actual);
    assert!(types.contains(&"claim_writer"));
    assert!(types.contains(&"force_turn_end"));
    assert!(types.contains(&"compact"));
    assert!(types.contains(&"release_writer"));
    assert!(!types.contains(&"insert_continuation_marker"));
    assert!(!types.contains(&"install_serving_view"));
}

#[test]
fn pending_forced_boundary_repair_does_not_re_force() {
    let fixture = load_case("cases/pending_forced_boundary_repair.json");
    let input = as_compact_continuation_input(&fixture.input).unwrap();
    let actual = decide_compact_continuation(&input);
    assert_eq!(
        actual.outcome,
        CompactContinuationOutcomeKind::CompactContinueTurn
    );
    assert!(!effect_types(&actual).contains(&"force_turn_end"));
    assert!(effect_types(&actual).contains(&"insert_continuation_marker"));
}

#[test]
fn capability_limited_identical_decision_table() {
    let boundary = json!({
        "applied": true,
        "continuationTurnId": "t2",
        "forcedThisSeam": true,
        "markerAlreadyPersisted": false,
    });
    let full = decide_compact_continuation(
        &as_compact_continuation_input(&base_input(json!({
            "forcedContinuationBoundary": boundary,
            "policy": {
                "upperTriggerTokens": 100_000,
                "lowerTargetTokens": 40_000,
                "hostCapability": "full_state_machine",
            },
        })))
        .unwrap(),
    );
    let limited = decide_compact_continuation(
        &as_compact_continuation_input(&base_input(json!({
            "forcedContinuationBoundary": boundary,
            "policy": {
                "upperTriggerTokens": 100_000,
                "lowerTargetTokens": 40_000,
                "hostCapability": "capability_limited",
            },
        })))
        .unwrap(),
    );
    assert_eq!(limited.outcome, full.outcome);
    assert_eq!(
        js_json_stringify_of(&limited.effects).unwrap(),
        js_json_stringify_of(&full.effects).unwrap()
    );
    assert_eq!(limited.transition_path, full.transition_path);
    let _ = CompactContinuationHostCapability::CapabilityLimited;
}

#[test]
fn unsupported_contract_version_refuses() {
    let mut raw = base_input(json!({}));
    raw.as_object_mut()
        .unwrap()
        .insert("contractVersion".into(), json!("0.9.0"));
    // as_* only checks non-empty version string; unsupported is an oracle refuse.
    let input = as_compact_continuation_input(&raw).unwrap();
    let actual = decide_compact_continuation(&input);
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::UnsupportedContractVersion)
    );
    assert!(actual.receipt.reason_code.contains("0.9.0"));
    assert_eq!(
        actual.receipt.contract_version,
        COMPACT_CONTINUATION_CONTRACT_VERSION
    );
}

#[test]
fn not_at_settled_seam_is_skip_not_refuse() {
    let raw = base_input(json!({
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": false,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::SkipSeam);
    assert_eq!(
        actual.receipt.skip_code,
        Some(CompactContinuationSkipCode::NotAtSettledSeam)
    );
    assert!(!actual.receipt.refused);
    assert!(!actual.receipt.residual.next_provider_request_allowed);
}

#[test]
fn degrade_fidelity_ordered_after_compact_before_install() {
    let fixture = load_case("cases/derivation_gaps_degraded_compact.json");
    let actual =
        decide_compact_continuation(&as_compact_continuation_input(&fixture.input).unwrap());
    let types = effect_types(&actual);
    let c = types.iter().position(|t| *t == "compact").unwrap();
    let d = types.iter().position(|t| *t == "degrade_fidelity").unwrap();
    let i = types
        .iter()
        .position(|t| *t == "install_serving_view")
        .unwrap();
    assert!(c < d && d < i);
}

#[test]
fn receipts_never_user_chat_visible() {
    let manifest = load_manifest();
    for entry in &manifest.cases {
        let fixture = load_case(&entry.file);
        for effect in &fixture.expected.effects {
            if let CompactContinuationEffect::RecordReceipt {
                durable,
                user_chat_visible,
            } = effect
            {
                assert!(!*user_chat_visible);
                assert!(*durable);
            }
        }
    }
}

#[test]
fn lower_target_never_success_gate() {
    let manifest = load_manifest();
    for entry in &manifest.cases {
        let fixture = load_case(&entry.file);
        assert!(!fixture.expected.receipt.lower_target.is_success_gate);
        assert_eq!(
            fixture.expected.receipt.lower_target.domain,
            "lhc_rendered_history"
        );
    }
}

#[test]
fn rejects_non_boolean_seam_fields() {
    let bad = base_input(json!({
        "seam": {
            "modelResponseComplete": "yes",
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0,
        },
    }));
    let v = validate_compact_continuation_input(&bad);
    assert!(!v.ok);
    assert!(
        v.issues
            .iter()
            .any(|i| i.path.contains("modelResponseComplete"))
    );
}

#[test]
fn rejects_unsafe_combined_pressure_sum() {
    let bad = base_input(json!({
        "providerUsage": {
            "available": true,
            "inputTokens": 9007199254740991i64,
            "cacheCreationTokens": 0,
            "cacheReadTokens": 0,
            "total": 9007199254740991i64,
            "domain": "provider_reported_input",
        },
        "postMeasurementEstimate": {
            "tokens": 1,
            "source": "x",
            "domain": "source_labelled_estimate",
        },
    }));
    let v = validate_compact_continuation_input(&bad);
    assert!(!v.ok);
}

#[test]
fn install_failure_wins_over_no_reduction_continue_turn() {
    let raw = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": true,
            "markerAlreadyPersisted": false,
        },
        "compactMaterial": {
            "derivationsMissingOrFailed": false,
            "lowerTargetMet": true,
            "compactStructurallyValid": true,
            "installSucceeds": false,
            "usefulReduction": false,
            "canProduceValidProviderRequest": true,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InstallFailed)
    );
    let types = effect_types(&actual);
    assert!(!types.contains(&"install_serving_view"));
    assert!(types.contains(&"insert_continuation_marker"));
    assert!(actual.receipt.residual.marker_persisted);
    assert!(!actual.receipt.residual.marker_served);
    assert!(!actual.receipt.residual.next_provider_request_allowed);
}

#[test]
fn install_failure_wins_over_no_reduction_preserve_tool() {
    let raw = base_input(json!({
        "continuation": {
            "kind": "pending_correlated_tool_result",
            "protectedToolCallIds": ["call-42"],
            "correlationValid": true,
        },
        "compactMaterial": {
            "derivationsMissingOrFailed": false,
            "lowerTargetMet": true,
            "compactStructurallyValid": true,
            "installSucceeds": false,
            "usefulReduction": false,
            "canProduceValidProviderRequest": true,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InstallFailed)
    );
    assert!(actual.receipt.residual.original_agentic_turn_still_open);
}

#[test]
fn pending_boundary_resumes_despite_missing_provider_usage() {
    let raw = base_input(json!({
        "providerUsage": {
            "available": false,
            "reason": "missing",
            "domain": "provider_reported_input",
        },
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": false,
            "markerAlreadyPersisted": false,
        },
        "continuation": { "kind": "active_non_tool" },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.outcome,
        CompactContinuationOutcomeKind::CompactContinueTurn
    );
    assert!(!effect_types(&actual).contains(&"force_turn_end"));
    assert!(actual.receipt.residual.forced_continuation_boundary_applied);
}

#[test]
fn pending_boundary_resumes_despite_below_trigger() {
    let raw = base_input(json!({
        "providerUsage": {
            "available": true,
            "inputTokens": 10_000,
            "cacheCreationTokens": 0,
            "cacheReadTokens": 0,
            "total": 10_000,
            "domain": "provider_reported_input",
        },
        "policy": {
            "upperTriggerTokens": 100_000,
            "lowerTargetTokens": 40_000,
            "hostCapability": "full_state_machine",
        },
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": false,
            "markerAlreadyPersisted": false,
        },
        "continuation": { "kind": "active_non_tool" },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.outcome,
        CompactContinuationOutcomeKind::CompactContinueTurn
    );
    assert!(
        !actual
            .transition_path
            .iter()
            .any(|s| *s == CompactContinuationState::BelowTrigger)
    );
}

#[test]
fn pending_boundary_kind_none_refuses() {
    let raw = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": false,
            "markerAlreadyPersisted": false,
        },
        "continuation": { "kind": "none" },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation)
    );
    assert!(actual.receipt.residual.forced_continuation_boundary_applied);
    assert!(!actual.receipt.residual.original_agentic_turn_still_open);
}

#[test]
fn pending_boundary_tool_continuation_is_legal_protected_escalation_v2() {
    let raw = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": false,
            "markerAlreadyPersisted": false,
        },
        "continuation": {
            "kind": "pending_correlated_tool_result",
            "protectedToolCallIds": ["call-42"],
            "correlationValid": true,
        },
        "compactMaterial": {
            "protectedEscalationApplied": true,
            "hostValidationStatus": "awaiting",
            "projectedPressureSafe": true,
            "usefulReduction": true,
            "installSucceeds": true,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert!(!actual.receipt.refused);
    assert!(actual.receipt.residual.forced_continuation_boundary_applied);
    assert_eq!(
        actual.receipt.protected_tool_call_ids,
        vec!["call-42".to_string()]
    );
}

#[test]
fn skip_with_pending_boundary_preserves_residual() {
    let raw = base_input(json!({
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": false,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": false,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0,
        },
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": false,
            "markerAlreadyPersisted": false,
        },
        "continuation": { "kind": "active_non_tool" },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::SkipSeam);
    assert!(actual.receipt.residual.forced_continuation_boundary_applied);
    assert!(actual.receipt.residual.continuation_turn_opened);
    assert!(!actual.receipt.residual.original_agentic_turn_still_open);
    assert!(!actual.receipt.residual.next_provider_request_allowed);
    assert_eq!(
        actual.receipt.turn_end_reason.as_deref(),
        Some(CONTEXT_COMPACT_CONTINUE_REASON)
    );
}

#[test]
fn transport_retry_skip_does_not_authorize_next_request() {
    let raw = base_input(json!({
        "seam": {
            "modelResponseComplete": true,
            "requestedToolsSettled": true,
            "captureFlushed": true,
            "beforeNextProviderRequest": true,
            "insideTransportRetry": true,
            "inputEpochAtDecision": 0,
            "inputEpochAtApply": 0,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.receipt.skip_code,
        Some(CompactContinuationSkipCode::TransportRetry)
    );
    assert!(!actual.receipt.residual.next_provider_request_allowed);
}

#[test]
fn writer_claim_lhc_idempotent_reassert() {
    let boundary = json!({
        "applied": true,
        "continuationTurnId": "t2",
        "forcedThisSeam": true,
        "markerAlreadyPersisted": false,
    });
    let none = decide_compact_continuation(
        &as_compact_continuation_input(&base_input(json!({
            "forcedContinuationBoundary": boundary,
        })))
        .unwrap(),
    );
    let lhc = decide_compact_continuation(
        &as_compact_continuation_input(&base_input(json!({
            "forcedContinuationBoundary": boundary,
            "invariants": {
                "captureComplete": true,
                "providerIdentityValid": true,
                "singleOpenTurn": true,
                "writerClaim": "lhc",
            },
        })))
        .unwrap(),
    );
    assert_eq!(lhc.outcome, none.outcome);
    assert_eq!(
        js_json_stringify_of(&lhc.effects).unwrap(),
        js_json_stringify_of(&none.effects).unwrap()
    );
    assert!(effect_types(&lhc).contains(&"claim_writer"));
}

#[test]
fn rejects_unknown_fields_closed_shape() {
    let bad = base_input(json!({ "mystery": true }));
    let v = validate_compact_continuation_input(&bad);
    assert!(!v.ok);
    assert!(v.issues.iter().any(|i| i.message.contains("unknown field")));

    let mut bad_usage = base_input(json!({}));
    bad_usage["providerUsage"] = json!({
        "available": false,
        "reason": "missing",
        "domain": "provider_reported_input",
        "inputTokens": 1,
    });
    let v2 = validate_compact_continuation_input(&bad_usage);
    assert!(!v2.ok);
}

#[test]
fn install_failed_continue_turn_marker_persisted_not_served() {
    let raw = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": true,
            "markerAlreadyPersisted": false,
        },
        "compactMaterial": {
            "derivationsMissingOrFailed": false,
            "lowerTargetMet": true,
            "compactStructurallyValid": true,
            "installSucceeds": false,
            "usefulReduction": true,
            "canProduceValidProviderRequest": true,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    let types = effect_types(&actual);
    let compact_i = types.iter().position(|t| *t == "compact").unwrap();
    let marker_i = types
        .iter()
        .position(|t| *t == "insert_continuation_marker")
        .unwrap();
    assert!(compact_i < marker_i);
    assert!(!types.contains(&"install_serving_view"));
    assert!(types.contains(&"release_writer"));
    assert!(actual.receipt.residual.marker_persisted);
    assert!(!actual.receipt.residual.marker_served);
}

#[test]
fn active_non_tool_above_trigger_without_boundary_refuses() {
    let raw = base_input(json!({
        "continuation": { "kind": "active_non_tool" },
        "forcedContinuationBoundary": { "applied": false },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation)
    );
    assert_eq!(effect_types(&actual), vec!["refuse", "record_receipt"]);
}

#[test]
fn single_open_turn_false_refuses() {
    let raw = base_input(json!({
        "invariants": {
            "captureComplete": true,
            "providerIdentityValid": true,
            "singleOpenTurn": false,
            "writerClaim": "none",
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::OpenTurnInvariantBroken)
    );
}

#[test]
fn repair_prior_marker_compact_fail_residual_truth() {
    let raw = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t4",
            "forcedThisSeam": false,
            "markerAlreadyPersisted": true,
        },
        "compactMaterial": {
            "derivationsMissingOrFailed": false,
            "lowerTargetMet": true,
            "compactStructurallyValid": false,
            "installSucceeds": true,
            "usefulReduction": true,
            "canProduceValidProviderRequest": true,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::CompactFailed)
    );
    assert!(!effect_types(&actual).contains(&"force_turn_end"));
    assert!(!effect_types(&actual).contains(&"insert_continuation_marker"));
    assert!(actual.receipt.residual.marker_persisted);
    assert!(!actual.receipt.residual.marker_served);
    assert_eq!(
        actual.receipt.residual.continuation_turn_id.as_deref(),
        Some("t4")
    );
}

#[test]
fn writer_claim_lhc_incomplete_capture_records_claim_and_release() {
    let raw = base_input(json!({
        "invariants": {
            "captureComplete": false,
            "providerIdentityValid": true,
            "singleOpenTurn": true,
            "writerClaim": "lhc",
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::IncompleteCapture)
    );
    assert_eq!(
        effect_types(&actual),
        vec!["claim_writer", "refuse", "record_receipt", "release_writer"]
    );
}

#[test]
fn install_failed_preserve_tool_includes_preserve_effect() {
    let raw = base_input(json!({
        "continuation": {
            "kind": "pending_correlated_tool_result",
            "protectedToolCallIds": ["call-99"],
            "correlationValid": true,
        },
        "compactMaterial": {
            "derivationsMissingOrFailed": false,
            "lowerTargetMet": true,
            "compactStructurallyValid": true,
            "installSucceeds": false,
            "usefulReduction": true,
            "canProduceValidProviderRequest": true,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InstallFailed)
    );
    let types = effect_types(&actual);
    assert!(types.contains(&"preserve_tool_pairs_verbatim"));
    assert!(!types.contains(&"insert_continuation_marker"));
    assert!(actual.receipt.residual.original_agentic_turn_still_open);
}

// ── Marker identity ──────────────────────────────────────────────────────────

#[test]
fn marker_identity_differs_per_continuation_turn() {
    let a = decide_compact_continuation(
        &as_compact_continuation_input(&base_input(json!({
            "forcedContinuationBoundary": {
                "applied": true,
                "continuationTurnId": "t2",
                "forcedThisSeam": true,
                "markerAlreadyPersisted": false,
            },
        })))
        .unwrap(),
    );
    let b = decide_compact_continuation(
        &as_compact_continuation_input(&base_input(json!({
            "forcedContinuationBoundary": {
                "applied": true,
                "continuationTurnId": "t5",
                "forcedThisSeam": true,
                "markerAlreadyPersisted": false,
            },
        })))
        .unwrap(),
    );
    let key_a = a
        .effects
        .iter()
        .find_map(|e| match e {
            CompactContinuationEffect::InsertContinuationMarker {
                idempotency_key, ..
            } => Some(idempotency_key.as_str()),
            _ => None,
        })
        .unwrap();
    let key_b = b
        .effects
        .iter()
        .find_map(|e| match e {
            CompactContinuationEffect::InsertContinuationMarker {
                idempotency_key, ..
            } => Some(idempotency_key.as_str()),
            _ => None,
        })
        .unwrap();
    assert_eq!(key_a, "lhc.compact_continuation:t2");
    assert_eq!(key_b, "lhc.compact_continuation:t5");
    assert_ne!(key_a, key_b);
}

#[test]
fn same_boundary_repair_reasserts_marker_key() {
    let repair = decide_compact_continuation(
        &as_compact_continuation_input(&base_input(json!({
            "forcedContinuationBoundary": {
                "applied": true,
                "continuationTurnId": "t4",
                "forcedThisSeam": false,
                "markerAlreadyPersisted": false,
            },
        })))
        .unwrap(),
    );
    assert!(!effect_types(&repair).contains(&"force_turn_end"));
    let marker = repair
        .effects
        .iter()
        .find(|e| {
            matches!(
                e,
                CompactContinuationEffect::InsertContinuationMarker { .. }
            )
        })
        .unwrap();
    if let CompactContinuationEffect::InsertContinuationMarker {
        continuation_turn_id,
        idempotency_key,
        semantics,
        ..
    } = marker
    {
        assert_eq!(continuation_turn_id, "t4");
        assert_eq!(
            idempotency_key,
            &compact_continuation_marker_idempotency_key("t4")
        );
        assert_eq!(semantics.cause, COMPACT_CONTINUATION_MARKER_CAUSE);
        assert_eq!(semantics.action, COMPACT_CONTINUATION_MARKER_ACTION);
        assert!(!semantics.new_user_request);
        assert!(!semantics.wait_for_user);
    }
}

#[test]
fn applied_boundary_legality_precedes_native_writer_conflict() {
    let raw = base_input(json!({
        "continuation": { "kind": "none" },
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": false,
            "markerAlreadyPersisted": false,
        },
        "invariants": {
            "captureComplete": true,
            "providerIdentityValid": true,
            "singleOpenTurn": true,
            "writerClaim": "native",
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation)
    );
}

#[test]
fn rejects_applied_boundary_missing_marker_already_persisted() {
    let bad = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": true,
        },
    }));
    let v = validate_compact_continuation_input(&bad);
    assert!(!v.ok);
    assert!(
        v.issues
            .iter()
            .any(|i| i.path.contains("markerAlreadyPersisted"))
    );
}

#[test]
fn fresh_force_marker_already_persisted_illegal() {
    let raw = base_input(json!({
        "continuation": { "kind": "active_non_tool" },
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": true,
            "markerAlreadyPersisted": true,
        },
        "invariants": {
            "captureComplete": true,
            "providerIdentityValid": true,
            "singleOpenTurn": true,
            "writerClaim": "native",
        },
    }));
    let v = validate_compact_continuation_input(&raw);
    assert!(!v.ok);
    assert!(v.issues.iter().any(|i| {
        i.path == "forcedContinuationBoundary"
            && i.message
                .contains("forcedThisSeam true cannot pair with markerAlreadyPersisted true")
    }));

    // Total evaluator refuses even for direct typed callers that skip as*.
    let typed: lhc::shared_tech::compact_continuation::CompactContinuationInput =
        serde_json::from_value(raw).unwrap();
    let actual = decide_compact_continuation(&typed);
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation)
    );
    assert_ne!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::NativeWriterConflict)
    );
    assert_eq!(
        actual.transition_path,
        vec![
            CompactContinuationState::AtSeam,
            CompactContinuationState::CheckingInvariants,
            CompactContinuationState::TerminalRefuse,
        ]
    );
    assert!(actual.receipt.residual.forced_continuation_boundary_applied);
    assert!(!actual.receipt.residual.marker_persisted);
    assert!(!actual.receipt.residual.marker_served);
    assert_eq!(
        actual.receipt.residual.continuation_turn_id.as_deref(),
        Some("t2")
    );
    assert!(validate_compact_continuation_decision(&actual).ok);
}

// ── Adversarial closed-union / nesting ───────────────────────────────────────

#[test]
fn adversarial_unknown_fields_at_union_and_nesting_boundaries() {
    // Root unknown
    assert!(!validate_compact_continuation_input(&base_input(json!({ "extra": 1 }))).ok);

    // Seam unknown
    let mut seam = base_input(json!({}));
    seam["seam"]["surprise"] = json!(true);
    assert!(!validate_compact_continuation_input(&seam).ok);

    // Provider available branch unknown
    let mut usage = base_input(json!({}));
    usage["providerUsage"]["bogus"] = json!(0);
    assert!(!validate_compact_continuation_input(&usage).ok);

    // Continuation none with extra
    let cont_none = base_input(json!({
        "continuation": { "kind": "none", "toolCallId": "x" },
    }));
    assert!(!validate_compact_continuation_input(&cont_none).ok);

    // Continuation active_non_tool with extra
    let cont_active = base_input(json!({
        "continuation": { "kind": "active_non_tool", "extra": true },
    }));
    assert!(!validate_compact_continuation_input(&cont_active).ok);

    // Forced boundary not-applied with extra
    let b_na = base_input(json!({
        "forcedContinuationBoundary": { "applied": false, "continuationTurnId": "t1" },
    }));
    assert!(!validate_compact_continuation_input(&b_na).ok);

    // Forced boundary applied unknown
    let b_ap = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": true,
            "markerAlreadyPersisted": false,
            "ghost": true,
        },
    }));
    assert!(!validate_compact_continuation_input(&b_ap).ok);

    // Policy / material / invariants / estimate
    let mut pol = base_input(json!({}));
    pol["policy"]["extra"] = json!(1);
    assert!(!validate_compact_continuation_input(&pol).ok);
    let mut mat = base_input(json!({}));
    mat["compactMaterial"]["extra"] = json!(1);
    assert!(!validate_compact_continuation_input(&mat).ok);
    let mut inv = base_input(json!({}));
    inv["invariants"]["extra"] = json!(1);
    assert!(!validate_compact_continuation_input(&inv).ok);
    let mut est = base_input(json!({}));
    est["postMeasurementEstimate"]["extra"] = json!(1);
    assert!(!validate_compact_continuation_input(&est).ok);

    // Non-finite / fractional tokens
    let frac = base_input(json!({
        "policy": {
            "upperTriggerTokens": 1.5,
            "lowerTargetTokens": 40_000,
            "hostCapability": "full_state_machine",
        },
    }));
    assert!(!validate_compact_continuation_input(&frac).ok);

    let neg = base_input(json!({
        "postMeasurementEstimate": {
            "tokens": -1,
            "source": "x",
            "domain": "source_labelled_estimate",
        },
    }));
    assert!(!validate_compact_continuation_input(&neg).ok);
}

#[test]
fn crate_root_and_sdk_export_surface_pins() {
    // Crate-root re-exports mirror sdk.ts pure-contract names.
    let _ = lhc::COMPACT_CONTINUATION_CONTRACT_VERSION;
    let _ = lhc::decide_compact_continuation;
    let _ = lhc::validate_compact_continuation_input;
    let _ = lhc::compact_continuation_marker_idempotency_key;
    let _ = lhc::CONTEXT_COMPACT_CONTINUE_REASON;
    // sdk module carries the same names.
    let _ = lhc::sdk::COMPACT_CONTINUATION_CONTRACT_VERSION;
    let _ = lhc::sdk::decide_compact_continuation;
}

#[test]
fn effects_vs_residual_documented_rule_pin() {
    // Install-failed continue-turn: effects include insert_continuation_marker
    // (prescribed protocol reached marker stage) while residual records
    // markerPersisted=true, markerServed=false — effects are not "already
    // committed" proof for install.
    let fixture = load_case("cases/install_failed_continue_turn.json");
    let actual =
        decide_compact_continuation(&as_compact_continuation_input(&fixture.input).unwrap());
    assert!(effect_types(&actual).contains(&"insert_continuation_marker"));
    assert!(!effect_types(&actual).contains(&"install_serving_view"));
    assert!(actual.receipt.residual.marker_persisted);
    assert!(!actual.receipt.residual.marker_served);
    assert!(actual.receipt.residual.prior_serving_view_intact);
}

// ── Fable finding 1: raw fixture bytes, not typed round-trip ─────────────────

#[test]
fn raw_fixture_expected_bytes_not_only_typed_round_trip() {
    // Narrow regression: comparing only typed-expected JSON would miss field-
    // order drift. The fixture loader retains raw expected Value; assert it
    // still matches the typed form for a representative case (and the 47-case
    // loop asserts actual vs raw for every case).
    let fixture = load_case("cases/active_non_tool_above_trigger.json");
    let typed = js_json_stringify_of(&fixture.expected).unwrap();
    let raw = js_json_stringify_of(&fixture.expected_raw).unwrap();
    assert_eq!(
        typed, raw,
        "typed expected must still equal raw fixture expected (order-sensitive)"
    );
    // Key order pin: first receipt keys must match TS construction order.
    let receipt = fixture
        .expected_raw
        .get("receipt")
        .unwrap()
        .as_object()
        .unwrap();
    let keys: Vec<&str> = receipt.keys().map(|k| k.as_str()).collect();
    assert_eq!(
        &keys[..4],
        &["contractVersion", "outcome", "reasonCode", "turnEndReason"]
    );
}

// ── Fable finding 2: receipt absent-key alignment with TS ────────────────────

fn sample_receipt_value() -> Value {
    // Minimal valid-looking receipt skeleton (oracle-shaped) for mutation probes.
    let fixture = load_case("cases/no_authoritative_provider_usage.json");
    fixture.expected_raw["receipt"].clone()
}

#[test]
fn receipt_pressure_null_base_requires_present_null_companions() {
    let mut good = sample_receipt_value();
    // Valid: keys present and null.
    assert!(
        validate_compact_continuation_receipt(&good).ok,
        "canonical receipt should validate: {:?}",
        validate_compact_continuation_receipt(&good).issues
    );

    // Absent nextRequestPressureTokens → invalid (TS flags).
    let mut absent_next = good.clone();
    absent_next["pressure"]
        .as_object_mut()
        .unwrap()
        .remove("nextRequestPressureTokens");
    let v = validate_compact_continuation_receipt(&absent_next);
    assert!(!v.ok);
    assert!(
        v.issues
            .iter()
            .any(|i| i.path == "pressure.nextRequestPressureTokens")
    );

    // Absent atOrAboveTrigger → invalid.
    let mut absent_trig = good.clone();
    absent_trig["pressure"]
        .as_object_mut()
        .unwrap()
        .remove("atOrAboveTrigger");
    let v = validate_compact_continuation_receipt(&absent_trig);
    assert!(!v.ok);
    assert!(
        v.issues
            .iter()
            .any(|i| i.path == "pressure.atOrAboveTrigger")
    );

    // Non-null when base null → invalid.
    good["pressure"]["nextRequestPressureTokens"] = json!(1);
    let v = validate_compact_continuation_receipt(&good);
    assert!(!v.ok);
    assert!(
        v.issues
            .iter()
            .any(|i| i.path == "pressure.nextRequestPressureTokens")
    );

    // Wrong type for atOrAboveTrigger.
    let mut wrong = sample_receipt_value();
    wrong["pressure"]["atOrAboveTrigger"] = json!(false);
    let v = validate_compact_continuation_receipt(&wrong);
    assert!(!v.ok);
}

#[test]
fn receipt_residual_continuation_turn_id_always_required_present() {
    let mut good = sample_receipt_value();
    assert!(validate_compact_continuation_receipt(&good).ok);

    // Absent key → invalid (independent of forced boundary).
    good["residual"]
        .as_object_mut()
        .unwrap()
        .remove("continuationTurnId");
    let v = validate_compact_continuation_receipt(&good);
    assert!(!v.ok);
    assert!(
        v.issues
            .iter()
            .any(|i| i.path == "residual.continuationTurnId")
    );

    // Wrong type → invalid.
    let mut wrong = sample_receipt_value();
    wrong["residual"]["continuationTurnId"] = json!(42);
    let v = validate_compact_continuation_receipt(&wrong);
    assert!(!v.ok);

    // Valid string when boundary applied (from continue-turn fixture).
    let cont = load_case("cases/active_non_tool_above_trigger.json");
    let r = &cont.expected_raw["receipt"];
    assert!(validate_compact_continuation_receipt(r).ok);
    assert_eq!(r["residual"]["continuationTurnId"].as_str(), Some("t2"));
}

// ── Fable finding 3: pure oracle does not panic ──────────────────────────────

fn hand_built_base(continuation: WorkContinuation) -> CompactContinuationInput {
    CompactContinuationInput {
        contract_version: COMPACT_CONTINUATION_CONTRACT_VERSION.to_string(),
        seam: CompactContinuationSeam {
            model_response_complete: true,
            requested_tools_settled: true,
            capture_flushed: true,
            before_next_provider_request: true,
            inside_transport_retry: false,
            input_epoch_at_decision: 0,
            input_epoch_at_apply: 0,
        },
        provider_usage: ProviderUsageAuthority::Available(ProviderUsageAvailable {
            available: true,
            input_tokens: i64::MAX,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total: i64::MAX,
            domain: "provider_reported_input".to_string(),
        }),
        post_measurement_estimate: PostMeasurementEstimate {
            tokens: 1,
            source: "hand_built".to_string(),
            domain: "source_labelled_estimate".to_string(),
        },
        policy: CompactContinuationPolicy {
            safe_runway_threshold_tokens: None,
            safe_runway_threshold_source: None,
            upper_trigger_tokens: 100_000,
            lower_target_tokens: 40_000,
            host_capability: CompactContinuationHostCapability::FullStateMachine,
        },
        continuation,
        invariants: CompactContinuationInvariants {
            capture_complete: true,
            provider_identity_valid: true,
            single_open_turn: true,
            writer_claim: WriterClaim::None,
        },
        forced_continuation_boundary: ForcedContinuationBoundary::not_applied(),
        compact_material: CompactMaterialFacts {
            derivations_missing_or_failed: false,
            lower_target_met: true,
            compact_structurally_valid: true,
            install_succeeds: true,
            useful_reduction: true,
            can_produce_valid_provider_request: true,
            projected_pressure_tokens: None,
            rendered_savings_tokens: 0,
            rendered_savings_source: "lhc_rendered_history_estimate".to_string(),
            rendered_savings_domain: "source_labelled_estimate".to_string(),
            safe_runway_threshold_tokens: None,
            safe_runway_threshold_source: None,
            projected_pressure_safe: None,
            protected_escalation_applied: false,
            visibility_boundary_before: None,
            visibility_boundary_after: None,
            compact_point_at_install: None,
            maximal_prune_insufficient: false,
            host_validation_status: HostValidationStatusFact::NotRequired,
        },
    }
}

#[test]
fn decide_does_not_panic_on_near_i64_max_pressure_sum() {
    // Overflowing total+estimate must not panic; defensive fallback is defined.
    for cont in [
        WorkContinuation::None,
        WorkContinuation::ActiveNonTool,
        WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids: vec!["c1".to_string()],
            correlation_valid: true,
        },
    ] {
        let input = hand_built_base(cont);
        let result = catch_unwind(AssertUnwindSafe(|| decide_compact_continuation(&input)));
        assert!(
            result.is_ok(),
            "decide_compact_continuation must not panic on i64::MAX+1 pressure sum"
        );
        let decision = result.unwrap();
        // Overflow ⇒ no invented pressure trigger.
        assert!(
            decision
                .receipt
                .pressure
                .next_request_pressure_tokens
                .is_none()
        );
        assert!(decision.receipt.pressure.at_or_above_trigger.is_none());
    }
}

#[test]
fn decide_does_not_panic_for_every_continuation_kind_hand_built() {
    // Also covers applied boundary + tool kind mismatch without panic.
    let cases: Vec<CompactContinuationInput> = vec![
        hand_built_base(WorkContinuation::None),
        hand_built_base(WorkContinuation::ActiveNonTool),
        hand_built_base(WorkContinuation::PendingCorrelatedToolResult {
            protected_tool_call_ids: vec!["c1".to_string()],
            correlation_valid: true,
        }),
        {
            let mut i = hand_built_base(WorkContinuation::None);
            // Impossible preserve-path selection cannot be reached via public
            // API; ensure applied boundary + none refuses without panic.
            i.forced_continuation_boundary =
                ForcedContinuationBoundary::Applied(ForcedContinuationBoundaryApplied {
                    applied: true,
                    continuation_turn_id: "t9".to_string(),
                    forced_this_seam: false,
                    marker_already_persisted: false,
                });
            i.provider_usage = ProviderUsageAuthority::Available(ProviderUsageAvailable {
                available: true,
                input_tokens: 10,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                total: 10,
                domain: "provider_reported_input".to_string(),
            });
            i.post_measurement_estimate.tokens = 0;
            i
        },
    ];
    for input in cases {
        let result = catch_unwind(AssertUnwindSafe(|| decide_compact_continuation(&input)));
        assert!(result.is_ok(), "no panic for hand-built continuation kinds");
    }
}

// ── Fable finding 4: direct serde union decoding ─────────────────────────────

#[test]
fn direct_serde_provider_usage_selects_by_available_literal() {
    // Valid available.
    let ok: ProviderUsageAuthority = serde_json::from_value(json!({
        "available": true,
        "inputTokens": 1,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "total": 1,
        "domain": "provider_reported_input",
    }))
    .unwrap();
    assert!(matches!(ok, ProviderUsageAuthority::Available(_)));

    // Valid unavailable.
    let miss: ProviderUsageAuthority = serde_json::from_value(json!({
        "available": false,
        "reason": "missing",
        "domain": "provider_reported_input",
    }))
    .unwrap();
    assert!(matches!(miss, ProviderUsageAuthority::Unavailable(_)));

    // Misclassified under untagged: available:true + reason must NOT become Unavailable.
    let bad = serde_json::from_value::<ProviderUsageAuthority>(json!({
        "available": true,
        "reason": "missing",
        "domain": "provider_reported_input",
    }));
    assert!(bad.is_err(), "available:true + reason must fail serde");

    // available:false with available-arm fields → fail (unknown/missing reason).
    let bad2 = serde_json::from_value::<ProviderUsageAuthority>(json!({
        "available": false,
        "inputTokens": 1,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "total": 1,
        "domain": "provider_reported_input",
    }));
    assert!(bad2.is_err());

    // Unknown field on available arm.
    let unk = serde_json::from_value::<ProviderUsageAuthority>(json!({
        "available": true,
        "inputTokens": 1,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "total": 1,
        "domain": "provider_reported_input",
        "extra": true,
    }));
    assert!(unk.is_err());

    // Missing available discriminant.
    let nod = serde_json::from_value::<ProviderUsageAuthority>(json!({
        "reason": "missing",
        "domain": "provider_reported_input",
    }));
    assert!(nod.is_err());
}

#[test]
fn direct_serde_forced_boundary_selects_by_applied_literal() {
    let na: ForcedContinuationBoundary =
        serde_json::from_value(json!({ "applied": false })).unwrap();
    assert!(!na.is_applied());

    let ap: ForcedContinuationBoundary = serde_json::from_value(json!({
        "applied": true,
        "continuationTurnId": "t2",
        "forcedThisSeam": true,
        "markerAlreadyPersisted": false,
    }))
    .unwrap();
    assert!(ap.is_applied());

    // Fable finding 4: {applied:true} alone must NOT deserialize as not-applied.
    let bare = serde_json::from_value::<ForcedContinuationBoundary>(json!({ "applied": true }));
    assert!(
        bare.is_err(),
        "applied:true without applied-arm fields must fail, not become NotApplied"
    );

    // applied:false with extra applied-arm fields → unknown fields fail.
    let extra = serde_json::from_value::<ForcedContinuationBoundary>(json!({
        "applied": false,
        "continuationTurnId": "t1",
    }));
    assert!(extra.is_err());

    // Wrong applied type.
    let wrong = serde_json::from_value::<ForcedContinuationBoundary>(json!({ "applied": "yes" }));
    assert!(wrong.is_err());
}

#[test]
fn direct_serde_work_continuation_rejects_unknown_fields() {
    let ok: WorkContinuation = serde_json::from_value(json!({ "kind": "none" })).unwrap();
    assert!(matches!(ok, WorkContinuation::None));

    let tool: WorkContinuation = serde_json::from_value(json!({
        "kind": "pending_correlated_tool_result",
        "protectedToolCallIds": ["c1"],
        "correlationValid": true,
    }))
    .unwrap();
    assert!(matches!(
        tool,
        WorkContinuation::PendingCorrelatedToolResult { .. }
    ));

    // Contract 2.0.0: legacy single toolCallId is rejected — no dual-field shim.
    assert!(
        serde_json::from_value::<WorkContinuation>(json!({
            "kind": "pending_correlated_tool_result",
            "toolCallId": "c1",
            "correlationValid": true,
        }))
        .is_err()
    );

    // Unknown field on none / active_non_tool.
    assert!(
        serde_json::from_value::<WorkContinuation>(json!({ "kind": "none", "extra": 1 })).is_err()
    );
    assert!(
        serde_json::from_value::<WorkContinuation>(json!({
            "kind": "active_non_tool",
            "toolCallId": "x",
        }))
        .is_err()
    );

    // Unknown kind.
    assert!(serde_json::from_value::<WorkContinuation>(json!({ "kind": "mystery" })).is_err());
}

#[test]
fn reject_fixture_still_deserializes_for_total_oracle() {
    // Cross-field-invalid but structurally deserializable (fresh force + marker).
    let fixture = load_case("cases/fresh_force_marker_already_persisted_illegal.json");
    assert_eq!(fixture.input_validation, "reject");
    let typed: CompactContinuationInput = serde_json::from_value(fixture.input.clone()).unwrap();
    let actual = decide_compact_continuation(&typed);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::InvalidPendingBoundaryContinuation)
    );
}

// ── Fable finding 5: integral 1.0 + no_valid_provider_request evidence ───────

/// Apply integral-float JSON spellings (`1.0` / `0.0`) across every contract
/// numeric field. serde_json may surface these as f64; validation accepts them
/// (JS Number) and `as_compact_continuation_input` must convert them.
fn with_integral_float_spellings(mut input: Value) -> Value {
    input["seam"]["inputEpochAtDecision"] = serde_json::from_str("0.0").unwrap();
    input["seam"]["inputEpochAtApply"] = serde_json::from_str("0.0").unwrap();
    input["providerUsage"]["inputTokens"] = serde_json::from_str("1000.0").unwrap();
    input["providerUsage"]["cacheCreationTokens"] = serde_json::from_str("0.0").unwrap();
    input["providerUsage"]["cacheReadTokens"] = serde_json::from_str("0.0").unwrap();
    input["providerUsage"]["total"] = serde_json::from_str("1000.0").unwrap();
    input["postMeasurementEstimate"]["tokens"] = serde_json::from_str("0.0").unwrap();
    input["policy"]["upperTriggerTokens"] = serde_json::from_str("10000.0").unwrap();
    input["policy"]["lowerTargetTokens"] = serde_json::from_str("5000.0").unwrap();
    input
}

fn with_integer_spellings(mut input: Value) -> Value {
    input["seam"]["inputEpochAtDecision"] = json!(0);
    input["seam"]["inputEpochAtApply"] = json!(0);
    input["providerUsage"]["inputTokens"] = json!(1000);
    input["providerUsage"]["cacheCreationTokens"] = json!(0);
    input["providerUsage"]["cacheReadTokens"] = json!(0);
    input["providerUsage"]["total"] = json!(1000);
    input["postMeasurementEstimate"]["tokens"] = json!(0);
    input["policy"]["upperTriggerTokens"] = json!(10000);
    input["policy"]["lowerTargetTokens"] = json!(5000);
    input
}

#[test]
fn accepts_json_integral_float_spelling_like_js() {
    // Validator accepts integral float spellings (JS Number.isSafeInteger).
    let ok = with_integral_float_spellings(base_input(json!({})));
    let v = validate_compact_continuation_input(&ok);
    assert!(
        v.ok,
        "integral JSON floats must be accepted by validation: {:?}",
        v.issues
    );

    let mut frac = base_input(json!({}));
    frac["policy"]["upperTriggerTokens"] = serde_json::from_str("1.5").unwrap();
    assert!(!validate_compact_continuation_input(&frac).ok);

    let mut neg = base_input(json!({}));
    neg["postMeasurementEstimate"]["tokens"] = json!(-1);
    assert!(!validate_compact_continuation_input(&neg).ok);

    let mut big = base_input(json!({}));
    big["policy"]["upperTriggerTokens"] = json!(9_007_199_254_740_992i64);
    assert!(!validate_compact_continuation_input(&big).ok);
}

#[test]
fn as_input_converts_integral_float_spellings_like_js() {
    // Public raw-host boundary: validation-accepted 1.0 spellings must convert
    // through as_compact_continuation_input and yield the same typed input /
    // decision as integer spellings. Fractional/negative/over-safe still Err.
    let float_raw = with_integral_float_spellings(base_input(json!({})));
    let int_raw = with_integer_spellings(base_input(json!({})));

    assert!(
        validate_compact_continuation_input(&float_raw).ok,
        "validation must accept integral float spellings"
    );
    let from_float = as_compact_continuation_input(&float_raw).unwrap_or_else(|e| {
        panic!("as_compact_continuation_input must convert validation-accepted 1.0: {e}")
    });
    let from_int = as_compact_continuation_input(&int_raw).expect("integer spelling converts");

    assert_eq!(
        js_json_stringify_of(&from_float).unwrap(),
        js_json_stringify_of(&from_int).unwrap(),
        "typed input from 1.0 spellings must equal integer spellings"
    );

    let dec_float = decide_compact_continuation(&from_float);
    let dec_int = decide_compact_continuation(&from_int);
    assert_eq!(
        js_json_stringify_of(&dec_float).unwrap(),
        js_json_stringify_of(&dec_int).unwrap(),
        "decision bytes must match for float vs integer numeric spellings"
    );

    // Fractional → Err, no panic.
    let mut frac = base_input(json!({}));
    frac["policy"]["upperTriggerTokens"] = serde_json::from_str("1.5").unwrap();
    let r = catch_unwind(AssertUnwindSafe(|| as_compact_continuation_input(&frac)));
    assert!(r.is_ok(), "as_* must not panic on fractional input");
    assert!(r.unwrap().is_err(), "fractional must Err");

    // Negative → Err, no panic.
    let mut neg = base_input(json!({}));
    neg["postMeasurementEstimate"]["tokens"] = json!(-1);
    let r = catch_unwind(AssertUnwindSafe(|| as_compact_continuation_input(&neg)));
    assert!(r.is_ok());
    assert!(r.unwrap().is_err());

    // Above MAX_SAFE_INTEGER → Err, no panic.
    let mut big = base_input(json!({}));
    big["policy"]["upperTriggerTokens"] = json!(9_007_199_254_740_992i64);
    let r = catch_unwind(AssertUnwindSafe(|| as_compact_continuation_input(&big)));
    assert!(r.is_ok());
    assert!(r.unwrap().is_err());
}

#[test]
fn no_valid_provider_request_continue_turn_refuses() {
    let raw = base_input(json!({
        "forcedContinuationBoundary": {
            "applied": true,
            "continuationTurnId": "t2",
            "forcedThisSeam": true,
            "markerAlreadyPersisted": false,
        },
        "compactMaterial": {
            "derivationsMissingOrFailed": false,
            "lowerTargetMet": true,
            "compactStructurallyValid": true,
            "installSucceeds": true,
            "usefulReduction": true,
            "canProduceValidProviderRequest": false,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::NoValidProviderRequest)
    );
    let types = effect_types(&actual);
    assert!(types.contains(&"claim_writer"));
    assert!(types.contains(&"force_turn_end"));
    assert!(types.contains(&"compact"));
    assert!(!types.contains(&"insert_continuation_marker"));
    assert!(!types.contains(&"install_serving_view"));
    assert!(types.contains(&"release_writer"));
    assert_eq!(
        actual.transition_path.last().copied(),
        Some(CompactContinuationState::TerminalRefuse)
    );
    assert!(actual.receipt.residual.forced_continuation_boundary_applied);
    assert!(!actual.receipt.residual.marker_persisted);
    assert!(!actual.receipt.residual.marker_served);
    assert!(actual.receipt.residual.prior_serving_view_intact);
    assert!(!actual.receipt.residual.next_provider_request_allowed);
    assert!(validate_compact_continuation_decision(&actual).ok);
}

#[test]
fn no_valid_provider_request_preserve_tool_refuses() {
    let raw = base_input(json!({
        "continuation": {
            "kind": "pending_correlated_tool_result",
            "protectedToolCallIds": ["call-nv"],
            "correlationValid": true,
        },
        "compactMaterial": {
            "derivationsMissingOrFailed": false,
            "lowerTargetMet": true,
            "compactStructurallyValid": true,
            "installSucceeds": true,
            "usefulReduction": true,
            "canProduceValidProviderRequest": false,
        },
    }));
    let actual = decide_compact_continuation(&as_compact_continuation_input(&raw).unwrap());
    assert_eq!(actual.outcome, CompactContinuationOutcomeKind::Refuse);
    assert_eq!(
        actual.receipt.refuse_code,
        Some(CompactContinuationRefuseCode::NoValidProviderRequest)
    );
    let types = effect_types(&actual);
    assert!(types.contains(&"claim_writer"));
    assert!(types.contains(&"compact"));
    assert!(!types.contains(&"preserve_tool_pairs_verbatim")); // compact fails request before preserve install stage
    assert!(!types.contains(&"install_serving_view"));
    assert!(types.contains(&"release_writer"));
    assert!(actual.receipt.residual.original_agentic_turn_still_open);
    assert!(actual.receipt.residual.prior_serving_view_intact);
    assert!(!actual.receipt.residual.next_provider_request_allowed);
    assert!(validate_compact_continuation_decision(&actual).ok);
}

// Silence unused import warnings for types exercised only at type level.
#[allow(dead_code)]
fn _type_pins() {
    let _: Option<ForcedContinuationBoundary> = None;
    let _: Option<ForcedContinuationBoundaryApplied> = None;
    let _: Option<ForcedContinuationBoundaryNotApplied> = None;
    let _: Option<ProviderUsageAuthority> = None;
    let _: Option<ProviderUsageAvailable> = None;
    let _: Option<ProviderUsageUnavailable> = None;
    let _: Option<ProviderUsageUnavailableReason> = None;
    let _: Option<WorkContinuation> = None;
    let _: Option<WriterClaim> = None;
    let _: Option<PostMeasurementEstimate> = None;
    let _: Option<CompactMaterialFacts> = None;
    let _: Option<ValidationResult> = None;
}

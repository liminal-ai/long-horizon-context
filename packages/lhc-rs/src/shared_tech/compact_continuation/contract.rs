//! Compact-continuation contract 2.0.0 — types, vocabularies, stable strings.
//!
//! Ported from `packages/lhc/src/shared-tech/compact-continuation/contract.ts`.
//! Field order on Serialize shapes matches TypeScript object construction so
//! fixture parity can reach byte-identical compact JSON via `js_json_stringify`.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

// ── Version and stable strings ───────────────────────────────────────────────

/// Semver of this contract surface. Fixtures pin the same string.
pub const COMPACT_CONTINUATION_CONTRACT_VERSION: &str = "2.0.0";

/// Canonical turn_end / outcome reason when a continuation turn is opened.
pub const CONTEXT_COMPACT_CONTINUE_REASON: &str = "context_compact_continue";

/// Stable typed marker kind served to the model after a continuation compact.
pub const COMPACT_CONTINUATION_MARKER_KIND: &str = "lhc.compact_continuation";

/// Prefix for per-boundary marker idempotency keys.
pub const COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX: &str = "lhc.compact_continuation:";

/// Stable marker semantic cause.
pub const COMPACT_CONTINUATION_MARKER_CAUSE: &str = "context_compacted_task_in_progress";

/// Stable marker semantic action.
pub const COMPACT_CONTINUATION_MARKER_ACTION: &str = "continue_existing_task";

/// Build the intake-safe marker idempotency key for one continuation turn.
pub fn compact_continuation_marker_idempotency_key(continuation_turn_id: &str) -> String {
    format!("{COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX}{continuation_turn_id}")
}

/// Required model-facing semantics of the typed continuation marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactContinuationMarkerSemantics {
    pub cause: String,
    pub action: String,
    pub new_user_request: bool,
    pub wait_for_user: bool,
}

impl CompactContinuationMarkerSemantics {
    pub fn canonical() -> Self {
        Self {
            cause: COMPACT_CONTINUATION_MARKER_CAUSE.to_string(),
            action: COMPACT_CONTINUATION_MARKER_ACTION.to_string(),
            new_user_request: false,
            wait_for_user: false,
        }
    }
}

// ── Accounting domains ───────────────────────────────────────────────────────

/// Upper-trigger base domain: provider-reported input context only.
pub const PROVIDER_REPORTED_INPUT: &str = "provider_reported_input";
/// Lower-target domain: LHC rendered-history tokens.
pub const LHC_RENDERED_HISTORY: &str = "lhc_rendered_history";
/// Post-measurement pressure delta domain.
pub const SOURCE_LABELLED_ESTIMATE: &str = "source_labelled_estimate";

/// Token accounting domain vocabulary (three closed strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TokenAccountingDomain {
    #[serde(rename = "provider_reported_input")]
    ProviderReportedInput,
    #[serde(rename = "lhc_rendered_history")]
    LhcRenderedHistory,
    #[serde(rename = "source_labelled_estimate")]
    SourceLabelledEstimate,
}

impl TokenAccountingDomain {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProviderReportedInput => PROVIDER_REPORTED_INPUT,
            Self::LhcRenderedHistory => LHC_RENDERED_HISTORY,
            Self::SourceLabelledEstimate => SOURCE_LABELLED_ESTIMATE,
        }
    }
}

// Type aliases matching TS named domain brands (wire-identical strings).
pub type ProviderReportedInputAccounting = TokenAccountingDomain;
pub type LhcRenderedHistoryAccounting = TokenAccountingDomain;
pub type SourceLabelledEstimateAccounting = TokenAccountingDomain;

// ── Host capability ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactContinuationHostCapability {
    #[serde(rename = "full_state_machine")]
    FullStateMachine,
    #[serde(rename = "capability_limited")]
    CapabilityLimited,
}

impl CompactContinuationHostCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FullStateMachine => "full_state_machine",
            Self::CapabilityLimited => "capability_limited",
        }
    }
}

pub const COMPACT_CONTINUATION_HOST_CAPABILITIES: &[&str] =
    &["full_state_machine", "capability_limited"];

// ── Machine states ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactContinuationState {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "at_seam")]
    AtSeam,
    #[serde(rename = "checking_invariants")]
    CheckingInvariants,
    #[serde(rename = "evaluating_pressure")]
    EvaluatingPressure,
    #[serde(rename = "below_trigger")]
    BelowTrigger,
    #[serde(rename = "path_preserve_tool")]
    PathPreserveTool,
    #[serde(rename = "path_continue_turn")]
    PathContinueTurn,
    #[serde(rename = "path_normal_complete")]
    PathNormalComplete,
    #[serde(rename = "compacting")]
    Compacting,
    #[serde(rename = "installing")]
    Installing,
    #[serde(rename = "terminal_continue_normal")]
    TerminalContinueNormal,
    #[serde(rename = "terminal_preserve_tool")]
    TerminalPreserveTool,
    #[serde(rename = "terminal_continue_turn")]
    TerminalContinueTurn,
    #[serde(rename = "terminal_normal_complete")]
    TerminalNormalComplete,
    #[serde(rename = "terminal_degraded")]
    TerminalDegraded,
    #[serde(rename = "terminal_no_reduction")]
    TerminalNoReduction,
    /// Terminal: continuation machinery declined; the host's ordinary settled-seam
    /// compact runs on canonical turns. No continuation mutation happened.
    #[serde(rename = "terminal_decline_ordinary")]
    TerminalDeclineOrdinary,
    /// Terminal: compact/install attempt failed; bounded retry still authorized.
    #[serde(rename = "terminal_retry")]
    TerminalRetry,
    /// Terminal: session continues on its current body; no relief this seam.
    #[serde(rename = "terminal_continue_current_body")]
    TerminalContinueCurrentBody,
    #[serde(rename = "terminal_skip")]
    TerminalSkip,
    #[serde(rename = "terminal_refuse")]
    TerminalRefuse,
}

impl CompactContinuationState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::AtSeam => "at_seam",
            Self::CheckingInvariants => "checking_invariants",
            Self::EvaluatingPressure => "evaluating_pressure",
            Self::BelowTrigger => "below_trigger",
            Self::PathPreserveTool => "path_preserve_tool",
            Self::PathContinueTurn => "path_continue_turn",
            Self::PathNormalComplete => "path_normal_complete",
            Self::Compacting => "compacting",
            Self::Installing => "installing",
            Self::TerminalContinueNormal => "terminal_continue_normal",
            Self::TerminalPreserveTool => "terminal_preserve_tool",
            Self::TerminalContinueTurn => "terminal_continue_turn",
            Self::TerminalNormalComplete => "terminal_normal_complete",
            Self::TerminalDegraded => "terminal_degraded",
            Self::TerminalNoReduction => "terminal_no_reduction",
            Self::TerminalDeclineOrdinary => "terminal_decline_ordinary",
            Self::TerminalRetry => "terminal_retry",
            Self::TerminalContinueCurrentBody => "terminal_continue_current_body",
            Self::TerminalSkip => "terminal_skip",
            Self::TerminalRefuse => "terminal_refuse",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "idle" => Self::Idle,
            "at_seam" => Self::AtSeam,
            "checking_invariants" => Self::CheckingInvariants,
            "evaluating_pressure" => Self::EvaluatingPressure,
            "below_trigger" => Self::BelowTrigger,
            "path_preserve_tool" => Self::PathPreserveTool,
            "path_continue_turn" => Self::PathContinueTurn,
            "path_normal_complete" => Self::PathNormalComplete,
            "compacting" => Self::Compacting,
            "installing" => Self::Installing,
            "terminal_continue_normal" => Self::TerminalContinueNormal,
            "terminal_preserve_tool" => Self::TerminalPreserveTool,
            "terminal_continue_turn" => Self::TerminalContinueTurn,
            "terminal_normal_complete" => Self::TerminalNormalComplete,
            "terminal_degraded" => Self::TerminalDegraded,
            "terminal_no_reduction" => Self::TerminalNoReduction,
            "terminal_decline_ordinary" => Self::TerminalDeclineOrdinary,
            "terminal_retry" => Self::TerminalRetry,
            "terminal_continue_current_body" => Self::TerminalContinueCurrentBody,
            "terminal_skip" => Self::TerminalSkip,
            "terminal_refuse" => Self::TerminalRefuse,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_STATES: &[&str] = &[
    "idle",
    "at_seam",
    "checking_invariants",
    "evaluating_pressure",
    "below_trigger",
    "path_preserve_tool",
    "path_continue_turn",
    "path_normal_complete",
    "compacting",
    "installing",
    "terminal_continue_normal",
    "terminal_preserve_tool",
    "terminal_continue_turn",
    "terminal_normal_complete",
    "terminal_degraded",
    "terminal_no_reduction",
    "terminal_decline_ordinary",
    "terminal_retry",
    "terminal_continue_current_body",
    "terminal_skip",
    "terminal_refuse",
];

// ── Outcome kinds ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactContinuationOutcomeKind {
    #[serde(rename = "continue_normal")]
    ContinueNormal,
    #[serde(rename = "compact_preserve_tool")]
    CompactPreserveTool,
    #[serde(rename = "compact_continue_turn")]
    CompactContinueTurn,
    #[serde(rename = "compact_preserve_tool_escalated")]
    CompactPreserveToolEscalated,
    #[serde(rename = "normal_complete")]
    NormalComplete,
    #[serde(rename = "degraded_compact")]
    DegradedCompact,
    #[serde(rename = "no_reduction")]
    NoReduction,
    /// Continuation machinery declined this seam and handed the work to the
    /// host's ordinary settled-seam compact on canonical turns. No mutation by
    /// the continuation machine; the next provider request is authorized.
    #[serde(rename = "decline_to_ordinary_compact")]
    DeclineToOrdinaryCompact,
    /// A compact or install attempt failed and bounded retry is still authorized.
    /// The session continues on its current body until the next eligible seam.
    #[serde(rename = "retry_compact")]
    RetryCompact,
    /// The session continues on its current body with no relief this seam
    /// (retry budget exhausted, or a live writer owner holds the thread).
    #[serde(rename = "continue_current_body")]
    ContinueCurrentBody,
    #[serde(rename = "skip_seam")]
    SkipSeam,
    #[serde(rename = "refuse")]
    Refuse,
}

impl CompactContinuationOutcomeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ContinueNormal => "continue_normal",
            Self::CompactPreserveTool => "compact_preserve_tool",
            Self::CompactContinueTurn => "compact_continue_turn",
            Self::CompactPreserveToolEscalated => "compact_preserve_tool_escalated",
            Self::NormalComplete => "normal_complete",
            Self::DegradedCompact => "degraded_compact",
            Self::NoReduction => "no_reduction",
            Self::DeclineToOrdinaryCompact => "decline_to_ordinary_compact",
            Self::RetryCompact => "retry_compact",
            Self::ContinueCurrentBody => "continue_current_body",
            Self::SkipSeam => "skip_seam",
            Self::Refuse => "refuse",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "continue_normal" => Self::ContinueNormal,
            "compact_preserve_tool" => Self::CompactPreserveTool,
            "compact_continue_turn" => Self::CompactContinueTurn,
            "compact_preserve_tool_escalated" => Self::CompactPreserveToolEscalated,
            "normal_complete" => Self::NormalComplete,
            "degraded_compact" => Self::DegradedCompact,
            "no_reduction" => Self::NoReduction,
            "decline_to_ordinary_compact" => Self::DeclineToOrdinaryCompact,
            "retry_compact" => Self::RetryCompact,
            "continue_current_body" => Self::ContinueCurrentBody,
            "skip_seam" => Self::SkipSeam,
            "refuse" => Self::Refuse,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_OUTCOME_KINDS: &[&str] = &[
    "continue_normal",
    "compact_preserve_tool",
    "compact_continue_turn",
    "compact_preserve_tool_escalated",
    "normal_complete",
    "degraded_compact",
    "no_reduction",
    "decline_to_ordinary_compact",
    "retry_compact",
    "continue_current_body",
    "skip_seam",
    "refuse",
];

// ── Skip / refuse codes ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactContinuationSkipCode {
    #[serde(rename = "not_at_settled_seam")]
    NotAtSettledSeam,
    #[serde(rename = "transport_retry")]
    TransportRetry,
}

impl CompactContinuationSkipCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAtSettledSeam => "not_at_settled_seam",
            Self::TransportRetry => "transport_retry",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "not_at_settled_seam" => Self::NotAtSettledSeam,
            "transport_retry" => Self::TransportRetry,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_SKIP_CODES: &[&str] = &["not_at_settled_seam", "transport_retry"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactContinuationRefuseCode {
    #[serde(rename = "incomplete_capture")]
    IncompleteCapture,
    #[serde(rename = "invalid_tool_correlation")]
    InvalidToolCorrelation,
    #[serde(rename = "invalid_provider_identity")]
    InvalidProviderIdentity,
    #[serde(rename = "open_turn_invariant_broken")]
    OpenTurnInvariantBroken,
    #[serde(rename = "native_writer_conflict")]
    NativeWriterConflict,
    #[serde(rename = "compact_failed")]
    CompactFailed,
    #[serde(rename = "install_failed")]
    InstallFailed,
    #[serde(rename = "no_valid_provider_request")]
    NoValidProviderRequest,
    #[serde(rename = "invalid_pending_boundary_continuation")]
    InvalidPendingBoundaryContinuation,
    #[serde(rename = "unsupported_contract_version")]
    UnsupportedContractVersion,
    #[serde(rename = "invalid_protected_tool_pairs")]
    InvalidProtectedToolPairs,
    #[serde(rename = "unsafe_runway")]
    UnsafeRunway,
    #[serde(rename = "host_validation_failed")]
    HostValidationFailed,
}

impl CompactContinuationRefuseCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IncompleteCapture => "incomplete_capture",
            Self::InvalidToolCorrelation => "invalid_tool_correlation",
            Self::InvalidProviderIdentity => "invalid_provider_identity",
            Self::OpenTurnInvariantBroken => "open_turn_invariant_broken",
            Self::NativeWriterConflict => "native_writer_conflict",
            Self::CompactFailed => "compact_failed",
            Self::InstallFailed => "install_failed",
            Self::NoValidProviderRequest => "no_valid_provider_request",
            Self::InvalidPendingBoundaryContinuation => "invalid_pending_boundary_continuation",
            Self::UnsupportedContractVersion => "unsupported_contract_version",
            Self::InvalidProtectedToolPairs => "invalid_protected_tool_pairs",
            Self::UnsafeRunway => "unsafe_runway",
            Self::HostValidationFailed => "host_validation_failed",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "incomplete_capture" => Self::IncompleteCapture,
            "invalid_tool_correlation" => Self::InvalidToolCorrelation,
            "invalid_provider_identity" => Self::InvalidProviderIdentity,
            "open_turn_invariant_broken" => Self::OpenTurnInvariantBroken,
            "native_writer_conflict" => Self::NativeWriterConflict,
            "compact_failed" => Self::CompactFailed,
            "install_failed" => Self::InstallFailed,
            "no_valid_provider_request" => Self::NoValidProviderRequest,
            "invalid_pending_boundary_continuation" => Self::InvalidPendingBoundaryContinuation,
            "unsupported_contract_version" => Self::UnsupportedContractVersion,
            "invalid_protected_tool_pairs" => Self::InvalidProtectedToolPairs,
            "unsafe_runway" => Self::UnsafeRunway,
            "host_validation_failed" => Self::HostValidationFailed,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_REFUSE_CODES: &[&str] = &[
    "incomplete_capture",
    "invalid_tool_correlation",
    "invalid_provider_identity",
    "open_turn_invariant_broken",
    "native_writer_conflict",
    "compact_failed",
    "install_failed",
    "no_valid_provider_request",
    "invalid_pending_boundary_continuation",
    "unsupported_contract_version",
    "invalid_protected_tool_pairs",
    "unsafe_runway",
    "host_validation_failed",
];

/// Refuse codes this contract version can still produce: none (List 2 is empty).
pub const COMPACT_CONTINUATION_REACHABLE_REFUSE_CODES: &[&str] = &[];

// ── Warning codes (detect + warn + continue) ─────────────────────────────────

/// Closed set of degradation warnings. A warning records a condition that used
/// to stop the compact path and now only degrades it. Warnings are loud
/// diagnostics: they are inspectable on the durable receipt and emitted as
/// ordered `warn` effects, but they never govern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactContinuationWarningCode {
    /// Capture of the settled model turn is incomplete; compact ran on thread data anyway.
    #[serde(rename = "capture_incomplete")]
    CaptureIncomplete,
    /// Provider/model identity is unproven; signed reasoning is omitted from the body.
    #[serde(rename = "provider_identity_unproven")]
    ProviderIdentityUnproven,
    /// Exactly-one-open-turn could not be verified; core LHC owns turn-record health.
    #[serde(rename = "open_turn_invariant_unverified")]
    OpenTurnInvariantUnverified,
    /// A stale native/conflict writer row was reclaimed after host authority confirmed no live owner.
    #[serde(rename = "stale_writer_row_reclaimed")]
    StaleWriterRowReclaimed,
    /// A live owner holds this LHC thread; this attempt continues its current request instead.
    #[serde(rename = "writer_owned_elsewhere")]
    WriterOwnedElsewhere,
    /// Pending tool-call/result correlation is unproven; declined into ordinary compact.
    #[serde(rename = "tool_correlation_unproven")]
    ToolCorrelationUnproven,
    /// Protected pair set is structurally invalid; declined into ordinary compact.
    #[serde(rename = "protected_tool_pairs_invalid")]
    ProtectedToolPairsInvalid,
    /// An illegal/unusable pending forced boundary was discarded; the seam starts fresh.
    #[serde(rename = "pending_boundary_discarded")]
    PendingBoundaryDiscarded,
    /// A fresh force claimed a pre-existing boundary marker; the claim was not trusted.
    #[serde(rename = "boundary_marker_claim_untrusted")]
    BoundaryMarkerClaimUntrusted,
    /// A continuation boundary is required but no continuation turn id is available.
    #[serde(rename = "continuation_boundary_unavailable")]
    ContinuationBoundaryUnavailable,
    /// Input contract version is not this oracle version. Continuation state is
    /// treated as absent in its entirety — no partial parse, no guessing.
    #[serde(rename = "unsupported_contract_version_omitted")]
    UnsupportedContractVersionOmitted,
    /// Compact assembly could not produce a structurally valid view this attempt.
    #[serde(rename = "compact_attempt_failed")]
    CompactAttemptFailed,
    /// Post-compact serving view could not be installed this attempt.
    #[serde(rename = "install_attempt_failed")]
    InstallAttemptFailed,
    /// Bounded compact/install retry budget is spent; continuing on the current body.
    #[serde(rename = "compact_retry_budget_exhausted")]
    CompactRetryBudgetExhausted,
    /// No structurally valid provider request could be proven; best available body is sent.
    #[serde(rename = "provider_request_unvalidated")]
    ProviderRequestUnvalidated,
    /// Projected runway remains unsafe after relief; diagnostic only, never a gate.
    #[serde(rename = "unsafe_runway_projection")]
    UnsafeRunwayProjection,
    /// Host full-body validation failed after core install; degraded body stands.
    #[serde(rename = "host_validation_failed")]
    HostValidationFailed,
}

impl CompactContinuationWarningCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CaptureIncomplete => "capture_incomplete",
            Self::ProviderIdentityUnproven => "provider_identity_unproven",
            Self::OpenTurnInvariantUnverified => "open_turn_invariant_unverified",
            Self::StaleWriterRowReclaimed => "stale_writer_row_reclaimed",
            Self::WriterOwnedElsewhere => "writer_owned_elsewhere",
            Self::ToolCorrelationUnproven => "tool_correlation_unproven",
            Self::ProtectedToolPairsInvalid => "protected_tool_pairs_invalid",
            Self::PendingBoundaryDiscarded => "pending_boundary_discarded",
            Self::BoundaryMarkerClaimUntrusted => "boundary_marker_claim_untrusted",
            Self::ContinuationBoundaryUnavailable => "continuation_boundary_unavailable",
            Self::UnsupportedContractVersionOmitted => "unsupported_contract_version_omitted",
            Self::CompactAttemptFailed => "compact_attempt_failed",
            Self::InstallAttemptFailed => "install_attempt_failed",
            Self::CompactRetryBudgetExhausted => "compact_retry_budget_exhausted",
            Self::ProviderRequestUnvalidated => "provider_request_unvalidated",
            Self::UnsafeRunwayProjection => "unsafe_runway_projection",
            Self::HostValidationFailed => "host_validation_failed",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "capture_incomplete" => Self::CaptureIncomplete,
            "provider_identity_unproven" => Self::ProviderIdentityUnproven,
            "open_turn_invariant_unverified" => Self::OpenTurnInvariantUnverified,
            "stale_writer_row_reclaimed" => Self::StaleWriterRowReclaimed,
            "writer_owned_elsewhere" => Self::WriterOwnedElsewhere,
            "tool_correlation_unproven" => Self::ToolCorrelationUnproven,
            "protected_tool_pairs_invalid" => Self::ProtectedToolPairsInvalid,
            "pending_boundary_discarded" => Self::PendingBoundaryDiscarded,
            "boundary_marker_claim_untrusted" => Self::BoundaryMarkerClaimUntrusted,
            "continuation_boundary_unavailable" => Self::ContinuationBoundaryUnavailable,
            "unsupported_contract_version_omitted" => Self::UnsupportedContractVersionOmitted,
            "compact_attempt_failed" => Self::CompactAttemptFailed,
            "install_attempt_failed" => Self::InstallAttemptFailed,
            "compact_retry_budget_exhausted" => Self::CompactRetryBudgetExhausted,
            "provider_request_unvalidated" => Self::ProviderRequestUnvalidated,
            "unsafe_runway_projection" => Self::UnsafeRunwayProjection,
            "host_validation_failed" => Self::HostValidationFailed,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_WARNING_CODES: &[&str] = &[
    "capture_incomplete",
    "provider_identity_unproven",
    "open_turn_invariant_unverified",
    "stale_writer_row_reclaimed",
    "writer_owned_elsewhere",
    "tool_correlation_unproven",
    "protected_tool_pairs_invalid",
    "pending_boundary_discarded",
    "boundary_marker_claim_untrusted",
    "continuation_boundary_unavailable",
    "unsupported_contract_version_omitted",
    "compact_attempt_failed",
    "install_attempt_failed",
    "compact_retry_budget_exhausted",
    "provider_request_unvalidated",
    "unsafe_runway_projection",
    "host_validation_failed",
];

/// One recorded degradation warning (aggregated onto `receipt.warnings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactContinuationWarning {
    pub code: CompactContinuationWarningCode,
    /// Provider-neutral human-readable detail. Stable per condition for fixtures.
    pub reason: String,
}

/// Default bounded compact/install retry budget (attempts at one seam identity).
pub const DEFAULT_COMPACT_RETRY_BUDGET: i64 = 2;

// ── Relief paths / host validation (contract 2.0.0) ──────────────────────────

/// Durable relief-path vocabulary (receipt/identity).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CompactContinuationReliefPath {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "normal_preserve")]
    NormalPreserve,
    #[serde(rename = "protected_escalation")]
    ProtectedEscalation,
    #[serde(rename = "core_install_failed")]
    CoreInstallFailed,
    #[serde(rename = "host_validation_awaiting")]
    HostValidationAwaiting,
    #[serde(rename = "host_validation_failed")]
    HostValidationFailed,
    #[serde(rename = "host_validation_ok")]
    HostValidationOk,
}

impl CompactContinuationReliefPath {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::NormalPreserve => "normal_preserve",
            Self::ProtectedEscalation => "protected_escalation",
            Self::CoreInstallFailed => "core_install_failed",
            Self::HostValidationAwaiting => "host_validation_awaiting",
            Self::HostValidationFailed => "host_validation_failed",
            Self::HostValidationOk => "host_validation_ok",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Self::None,
            "normal_preserve" => Self::NormalPreserve,
            "protected_escalation" => Self::ProtectedEscalation,
            "core_install_failed" => Self::CoreInstallFailed,
            "host_validation_awaiting" => Self::HostValidationAwaiting,
            "host_validation_failed" => Self::HostValidationFailed,
            "host_validation_ok" => Self::HostValidationOk,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_RELIEF_PATHS: &[&str] = &[
    "none",
    "normal_preserve",
    "protected_escalation",
    "core_install_failed",
    "host_validation_awaiting",
    "host_validation_failed",
    "host_validation_ok",
];

/// Host full-body validation status for an attempt.
/// `not_required` for paths that do not need post-install host validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HostValidationStatusFact {
    #[serde(rename = "not_required")]
    NotRequired,
    #[serde(rename = "awaiting")]
    Awaiting,
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "failed")]
    Failed,
}

impl HostValidationStatusFact {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Awaiting => "awaiting",
            Self::Ok => "ok",
            Self::Failed => "failed",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "not_required" => Self::NotRequired,
            "awaiting" => Self::Awaiting,
            "ok" => Self::Ok,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

/// JS `<` string ordering (UTF-16 code-unit lexicographic), matching TS `.sort()`.
pub fn js_string_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    crate::shared_tech::js_json::js_char_codes(a)
        .cmp(&crate::shared_tech::js_json::js_char_codes(b))
}

/// Normalize protected IDs: unique, non-empty strings, sorted ascending
/// (JS UTF-16 code-unit order, matching the TypeScript oracle).
pub fn normalize_protected_tool_call_ids(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !id.is_empty() && !out.contains(id) {
            out.push(id.clone());
        }
    }
    out.sort_by(|a, b| js_string_cmp(a, b));
    out
}

// ── Effects ──────────────────────────────────────────────────────────────────

/// Writer target on claim_writer effects (always `"lhc"` in v1 success paths).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClaimWriterTarget {
    #[serde(rename = "lhc")]
    Lhc,
}

impl ClaimWriterTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lhc => "lhc",
        }
    }
}

/// Prior writer row a `reclaim_writer` effect displaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReclaimPriorClaim {
    #[serde(rename = "native")]
    Native,
    #[serde(rename = "conflict")]
    Conflict,
}

impl ReclaimPriorClaim {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Conflict => "conflict",
        }
    }
}

/// Host ownership answer that authorized a reclaim. Only `no_live_owner` is legal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReclaimHostAuthority {
    #[serde(rename = "no_live_owner")]
    NoLiveOwner,
}

impl ReclaimHostAuthority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoLiveOwner => "no_live_owner",
        }
    }
}

/// Host ownership authority for a `native`/`conflict` writer row, resolved
/// host-side against a process-global registry keyed by LHC thread id. The
/// registry itself never lives in the SDK; the SDK only consumes the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WriterOwnershipAuthority {
    /// Stale row from a dead owner — reclaim proceeds.
    #[serde(rename = "no_live_owner")]
    NoLiveOwner,
    /// A live owner holds the thread — this attempt is the loser and continues
    /// its current request. It never steals and never strands.
    #[serde(rename = "live_owner")]
    LiveOwner,
}

impl WriterOwnershipAuthority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoLiveOwner => "no_live_owner",
            Self::LiveOwner => "live_owner",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "no_live_owner" => Self::NoLiveOwner,
            "live_owner" => Self::LiveOwner,
            _ => return None,
        })
    }
}

/// Ordered effects the runtime applied (or attempted) on this seam.
///
/// Field order matches TypeScript construction for byte-stable JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CompactContinuationEffect {
    #[serde(rename = "claim_writer")]
    ClaimWriter { writer: ClaimWriterTarget },
    #[serde(rename = "release_writer")]
    ReleaseWriter,
    #[serde(rename = "force_turn_end")]
    ForceTurnEnd {
        reason: String,
        outcome: String,
        #[serde(rename = "opensContinuationTurn")]
        opens_continuation_turn: bool,
        #[serde(rename = "continuationTurnCount")]
        continuation_turn_count: i64,
        #[serde(rename = "continuationTurnId")]
        continuation_turn_id: String,
    },
    #[serde(rename = "compact")]
    Compact {
        #[serde(rename = "lowerTargetDomain")]
        lower_target_domain: String,
        #[serde(rename = "lowerTargetTokens")]
        lower_target_tokens: i64,
        #[serde(rename = "allowDegradedDerivations")]
        allow_degraded_derivations: bool,
    },
    #[serde(rename = "preserve_tool_pairs_verbatim")]
    PreserveToolPairsVerbatim {
        #[serde(rename = "protectedToolCallIds")]
        protected_tool_call_ids: Vec<String>,
        location: String,
    },
    #[serde(rename = "advance_visibility_boundary")]
    AdvanceVisibilityBoundary {
        #[serde(rename = "previousBoundary")]
        previous_boundary: i64,
        #[serde(rename = "newBoundary")]
        new_boundary: i64,
        #[serde(rename = "compactPoint")]
        compact_point: i64,
    },
    #[serde(rename = "await_host_validation")]
    AwaitHostValidation {
        #[serde(rename = "attemptIdScope")]
        attempt_id_scope: String,
    },
    #[serde(rename = "record_host_validation")]
    RecordHostValidation {
        result: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "insert_continuation_marker")]
    InsertContinuationMarker {
        kind: String,
        #[serde(rename = "continuationTurnId")]
        continuation_turn_id: String,
        #[serde(rename = "idempotencyKey")]
        idempotency_key: String,
        semantics: CompactContinuationMarkerSemantics,
        #[serde(rename = "modelVisible")]
        model_visible: bool,
        #[serde(rename = "lhcInspectVisible")]
        lhc_inspect_visible: bool,
        #[serde(rename = "userChatVisible")]
        user_chat_visible: bool,
        #[serde(rename = "hostMayInjectTransiently")]
        host_may_inject_transiently: bool,
    },
    #[serde(rename = "install_serving_view")]
    InstallServingView,
    #[serde(rename = "record_receipt")]
    RecordReceipt {
        durable: bool,
        #[serde(rename = "userChatVisible")]
        user_chat_visible: bool,
    },
    #[serde(rename = "degrade_fidelity")]
    DegradeFidelity { causes: Vec<String> },
    #[serde(rename = "skip_seam")]
    SkipSeam {
        code: CompactContinuationSkipCode,
        reason: String,
    },
    /// Loud diagnostic for a condition that degraded — never governed — this
    /// seam. Ordered where the condition was detected; aggregated onto
    /// `receipt.warnings`.
    #[serde(rename = "warn")]
    Warn {
        code: CompactContinuationWarningCode,
        reason: String,
    },
    /// Provider/model identity is unproven, so the one feature that needs it —
    /// signed reasoning — is omitted from the body. The compact proceeds.
    #[serde(rename = "omit_signed_reasoning")]
    OmitSignedReasoning { reason: String },
    /// Reclaim a stale native/conflict writer row. Only legal after host
    /// ownership authority confirmed no live owner holds this LHC thread.
    #[serde(rename = "reclaim_writer")]
    ReclaimWriter {
        #[serde(rename = "priorClaim")]
        prior_claim: ReclaimPriorClaim,
        #[serde(rename = "hostAuthority")]
        host_authority: ReclaimHostAuthority,
    },
    /// Drop an unusable pending forced boundary and start the seam fresh.
    /// `continuationTurnId` is null when the boundary was never interpreted
    /// (unsupported contract version — no partial parse).
    #[serde(rename = "discard_pending_boundary")]
    DiscardPendingBoundary {
        #[serde(rename = "continuationTurnId")]
        continuation_turn_id: Option<String>,
        reason: String,
    },
    /// Unreachable in this contract version — the refuse set is empty (CX-S5).
    #[serde(rename = "refuse")]
    Refuse {
        code: CompactContinuationRefuseCode,
        reason: String,
    },
}

impl CompactContinuationEffect {
    pub fn effect_type(&self) -> CompactContinuationEffectType {
        match self {
            Self::ClaimWriter { .. } => CompactContinuationEffectType::ClaimWriter,
            Self::ReleaseWriter => CompactContinuationEffectType::ReleaseWriter,
            Self::ForceTurnEnd { .. } => CompactContinuationEffectType::ForceTurnEnd,
            Self::Compact { .. } => CompactContinuationEffectType::Compact,
            Self::PreserveToolPairsVerbatim { .. } => {
                CompactContinuationEffectType::PreserveToolPairsVerbatim
            }
            Self::AdvanceVisibilityBoundary { .. } => {
                CompactContinuationEffectType::AdvanceVisibilityBoundary
            }
            Self::AwaitHostValidation { .. } => CompactContinuationEffectType::AwaitHostValidation,
            Self::RecordHostValidation { .. } => {
                CompactContinuationEffectType::RecordHostValidation
            }
            Self::InsertContinuationMarker { .. } => {
                CompactContinuationEffectType::InsertContinuationMarker
            }
            Self::InstallServingView => CompactContinuationEffectType::InstallServingView,
            Self::RecordReceipt { .. } => CompactContinuationEffectType::RecordReceipt,
            Self::DegradeFidelity { .. } => CompactContinuationEffectType::DegradeFidelity,
            Self::SkipSeam { .. } => CompactContinuationEffectType::SkipSeam,
            Self::Warn { .. } => CompactContinuationEffectType::Warn,
            Self::OmitSignedReasoning { .. } => CompactContinuationEffectType::OmitSignedReasoning,
            Self::ReclaimWriter { .. } => CompactContinuationEffectType::ReclaimWriter,
            Self::DiscardPendingBoundary { .. } => {
                CompactContinuationEffectType::DiscardPendingBoundary
            }
            Self::Refuse { .. } => CompactContinuationEffectType::Refuse,
        }
    }

    pub fn type_str(&self) -> &'static str {
        self.effect_type().as_str()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CompactContinuationEffectType {
    ClaimWriter,
    ReleaseWriter,
    ForceTurnEnd,
    Compact,
    PreserveToolPairsVerbatim,
    AdvanceVisibilityBoundary,
    AwaitHostValidation,
    RecordHostValidation,
    InsertContinuationMarker,
    InstallServingView,
    RecordReceipt,
    DegradeFidelity,
    SkipSeam,
    Warn,
    OmitSignedReasoning,
    ReclaimWriter,
    DiscardPendingBoundary,
    Refuse,
}

impl CompactContinuationEffectType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaimWriter => "claim_writer",
            Self::ReleaseWriter => "release_writer",
            Self::ForceTurnEnd => "force_turn_end",
            Self::Compact => "compact",
            Self::PreserveToolPairsVerbatim => "preserve_tool_pairs_verbatim",
            Self::AdvanceVisibilityBoundary => "advance_visibility_boundary",
            Self::AwaitHostValidation => "await_host_validation",
            Self::RecordHostValidation => "record_host_validation",
            Self::InsertContinuationMarker => "insert_continuation_marker",
            Self::InstallServingView => "install_serving_view",
            Self::RecordReceipt => "record_receipt",
            Self::DegradeFidelity => "degrade_fidelity",
            Self::SkipSeam => "skip_seam",
            Self::Warn => "warn",
            Self::OmitSignedReasoning => "omit_signed_reasoning",
            Self::ReclaimWriter => "reclaim_writer",
            Self::DiscardPendingBoundary => "discard_pending_boundary",
            Self::Refuse => "refuse",
        }
    }
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/// Authoritative provider usage (available branch).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderUsageAvailable {
    pub available: bool,
    pub input_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub total: i64,
    pub domain: String,
}

/// Authoritative provider usage (unavailable branch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderUsageUnavailable {
    pub available: bool,
    pub reason: ProviderUsageUnavailableReason,
    pub domain: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderUsageUnavailableReason {
    Missing,
    Invalid,
}

impl ProviderUsageUnavailableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Invalid => "invalid",
        }
    }
}

/// Provider usage authority union.
///
/// **Deserialize:** selects the variant by the literal `available` boolean
/// (not untagged first-match). Wrong/missing discriminator, wrong arm fields,
/// or unknown fields fail. Prefer [`crate::shared_tech::compact_continuation::as_compact_continuation_input`]
/// for raw host JSON (also enforces numeric and cross-field rules).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ProviderUsageAuthority {
    Available(ProviderUsageAvailable),
    Unavailable(ProviderUsageUnavailable),
}

impl<'de> Deserialize<'de> for ProviderUsageAuthority {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Peek the discriminant without untagged first-match misclassification.
        let value = serde_json::Value::deserialize(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| de::Error::custom("providerUsage must be an object"))?;
        let available = obj
            .get("available")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| de::Error::custom("providerUsage.available must be a boolean"))?;
        if available {
            let parsed: ProviderUsageAvailable =
                serde_json::from_value(value).map_err(de::Error::custom)?;
            if !parsed.available {
                return Err(de::Error::custom(
                    "providerUsage available branch requires available:true",
                ));
            }
            Ok(Self::Available(parsed))
        } else {
            let parsed: ProviderUsageUnavailable =
                serde_json::from_value(value).map_err(de::Error::custom)?;
            if parsed.available {
                return Err(de::Error::custom(
                    "providerUsage unavailable branch requires available:false",
                ));
            }
            Ok(Self::Unavailable(parsed))
        }
    }
}

impl ProviderUsageAuthority {
    pub fn is_available(&self) -> bool {
        match self {
            Self::Available(a) => a.available,
            Self::Unavailable(_) => false,
        }
    }

    pub fn available_total(&self) -> Option<i64> {
        match self {
            Self::Available(a) if a.available => Some(a.total),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostMeasurementEstimate {
    pub tokens: i64,
    pub source: String,
    pub domain: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactContinuationSeam {
    pub model_response_complete: bool,
    pub requested_tools_settled: bool,
    pub capture_flushed: bool,
    pub before_next_provider_request: bool,
    pub inside_transport_retry: bool,
    pub input_epoch_at_decision: i64,
    pub input_epoch_at_apply: i64,
}

/// Work continuation kind. Per-variant closed shape.
///
/// Custom `Deserialize` (not only `#[serde(tag = "kind", deny_unknown_fields)]`):
/// unit variants of internally-tagged enums do not reliably reject unknown
/// fields under serde; we enforce closed shape explicitly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum WorkContinuation {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "pending_correlated_tool_result")]
    PendingCorrelatedToolResult {
        #[serde(rename = "protectedToolCallIds")]
        protected_tool_call_ids: Vec<String>,
        #[serde(rename = "correlationValid")]
        correlation_valid: bool,
    },
    #[serde(rename = "active_non_tool")]
    ActiveNonTool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkContinuationToolWire {
    protected_tool_call_ids: Vec<String>,
    correlation_valid: bool,
}

impl<'de> Deserialize<'de> for WorkContinuation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| de::Error::custom("continuation must be an object"))?;
        let kind = obj
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| de::Error::custom("continuation.kind must be a string"))?;
        match kind {
            "none" => {
                // Closed: only `kind`.
                for k in obj.keys() {
                    if k != "kind" {
                        return Err(de::Error::custom(format!(
                            "unknown field `{k}` on continuation kind none"
                        )));
                    }
                }
                Ok(Self::None)
            }
            "active_non_tool" => {
                for k in obj.keys() {
                    if k != "kind" {
                        return Err(de::Error::custom(format!(
                            "unknown field `{k}` on continuation kind active_non_tool"
                        )));
                    }
                }
                Ok(Self::ActiveNonTool)
            }
            "pending_correlated_tool_result" => {
                // Contract 2.0.0: single toolCallId removed; no dual-field shim.
                if obj.contains_key("toolCallId") {
                    return Err(de::Error::custom(
                        "continuation.toolCallId removed in contract 2.0.0; use protectedToolCallIds",
                    ));
                }
                // Drop kind, parse closed tool fields.
                let mut map = obj.clone();
                map.remove("kind");
                let wire: WorkContinuationToolWire =
                    serde_json::from_value(serde_json::Value::Object(map))
                        .map_err(de::Error::custom)?;
                Ok(Self::PendingCorrelatedToolResult {
                    protected_tool_call_ids: wire.protected_tool_call_ids,
                    correlation_valid: wire.correlation_valid,
                })
            }
            other => Err(de::Error::custom(format!(
                "unknown continuation.kind {other}"
            ))),
        }
    }
}

impl WorkContinuation {
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::PendingCorrelatedToolResult { .. } => "pending_correlated_tool_result",
            Self::ActiveNonTool => "active_non_tool",
        }
    }
}

/// Forced boundary not applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForcedContinuationBoundaryNotApplied {
    pub applied: bool,
}

/// Forced boundary applied (fresh force or repair).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForcedContinuationBoundaryApplied {
    pub applied: bool,
    pub continuation_turn_id: String,
    pub forced_this_seam: bool,
    pub marker_already_persisted: bool,
}

/// Forced continuation-boundary identity for the whole-seam oracle.
///
/// **Deserialize:** selects the variant by the literal `applied` boolean.
/// `{ "applied": true }` alone is **not** accepted as not-applied (unlike naive
/// untagged first-match). Prefer [`crate::shared_tech::compact_continuation::as_compact_continuation_input`]
/// for raw host JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ForcedContinuationBoundary {
    NotApplied(ForcedContinuationBoundaryNotApplied),
    Applied(ForcedContinuationBoundaryApplied),
}

impl<'de> Deserialize<'de> for ForcedContinuationBoundary {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| de::Error::custom("forcedContinuationBoundary must be an object"))?;
        let applied = obj
            .get("applied")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| {
                de::Error::custom("forcedContinuationBoundary.applied must be a boolean")
            })?;
        if applied {
            let parsed: ForcedContinuationBoundaryApplied =
                serde_json::from_value(value).map_err(de::Error::custom)?;
            if !parsed.applied {
                return Err(de::Error::custom(
                    "forcedContinuationBoundary applied branch requires applied:true",
                ));
            }
            Ok(Self::Applied(parsed))
        } else {
            let parsed: ForcedContinuationBoundaryNotApplied =
                serde_json::from_value(value).map_err(de::Error::custom)?;
            if parsed.applied {
                return Err(de::Error::custom(
                    "forcedContinuationBoundary not-applied branch requires applied:false",
                ));
            }
            Ok(Self::NotApplied(parsed))
        }
    }
}

impl ForcedContinuationBoundary {
    pub fn is_applied(&self) -> bool {
        match self {
            Self::Applied(a) => a.applied,
            Self::NotApplied(_) => false,
        }
    }

    pub fn as_applied(&self) -> Option<&ForcedContinuationBoundaryApplied> {
        match self {
            Self::Applied(a) if a.applied => Some(a),
            _ => None,
        }
    }

    pub fn not_applied() -> Self {
        Self::NotApplied(ForcedContinuationBoundaryNotApplied { applied: false })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriterClaim {
    None,
    Lhc,
    Native,
    Conflict,
}

impl WriterClaim {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Lhc => "lhc",
            Self::Native => "native",
            Self::Conflict => "conflict",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Self::None,
            "lhc" => Self::Lhc,
            "native" => Self::Native,
            "conflict" => Self::Conflict,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_WRITER_CLAIMS: &[&str] = &["none", "lhc", "native", "conflict"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactContinuationInvariants {
    pub capture_complete: bool,
    pub provider_identity_valid: bool,
    pub single_open_turn: bool,
    /// Writer row observed at seam entry.
    pub writer_claim: WriterClaim,
    /// Host ownership authority for a `native`/`conflict` writer row.
    /// Absent/null: no authority supplied — treated as `live_owner` (no reclaim).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_ownership_authority: Option<WriterOwnershipAuthority>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactMaterialFacts {
    pub derivations_missing_or_failed: bool,
    pub lower_target_met: bool,
    pub compact_structurally_valid: bool,
    pub install_succeeds: bool,
    pub useful_reduction: bool,
    pub can_produce_valid_provider_request: bool,
    pub projected_pressure_tokens: Option<i64>,
    pub rendered_savings_tokens: i64,
    pub rendered_savings_source: String,
    pub rendered_savings_domain: String,
    pub safe_runway_threshold_tokens: Option<i64>,
    pub safe_runway_threshold_source: Option<String>,
    pub projected_pressure_safe: Option<bool>,
    pub protected_escalation_applied: bool,
    pub visibility_boundary_before: Option<i64>,
    pub visibility_boundary_after: Option<i64>,
    pub compact_point_at_install: Option<i64>,
    pub maximal_prune_insufficient: bool,
    /// 1-based index of this compact/install attempt at this seam identity.
    /// Compared against `policy.compactRetryBudget` for bounded retry. Absent
    /// means 1 (first attempt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_attempt_index: Option<i64>,
    pub host_validation_status: HostValidationStatusFact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactContinuationPolicy {
    pub upper_trigger_tokens: i64,
    pub lower_target_tokens: i64,
    pub host_capability: CompactContinuationHostCapability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_runway_threshold_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_runway_threshold_source: Option<String>,
    /// Bounded compact/install retry budget: how many attempts at this seam
    /// identity may run before the session stops retrying and continues on its
    /// current body. Absent means `DEFAULT_COMPACT_RETRY_BUDGET`. Values below 1
    /// are clamped to 1 — a failed attempt is never terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_retry_budget: Option<i64>,
}

/// Pre-decision facts plus attempt results for the whole-seam oracle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactContinuationInput {
    pub contract_version: String,
    pub seam: CompactContinuationSeam,
    pub provider_usage: ProviderUsageAuthority,
    pub post_measurement_estimate: PostMeasurementEstimate,
    pub policy: CompactContinuationPolicy,
    pub continuation: WorkContinuation,
    pub invariants: CompactContinuationInvariants,
    pub forced_continuation_boundary: ForcedContinuationBoundary,
    pub compact_material: CompactMaterialFacts,
}

// ── Receipt / decision ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationPressureReceipt {
    pub provider_base_tokens: Option<i64>,
    pub provider_base_domain: String,
    pub estimate_tokens: i64,
    pub estimate_source: String,
    pub estimate_domain: String,
    pub next_request_pressure_tokens: Option<i64>,
    pub upper_trigger_tokens: i64,
    pub at_or_above_trigger: Option<bool>,
    pub projected_pressure_tokens: Option<i64>,
    pub rendered_savings_tokens: Option<i64>,
    pub rendered_savings_source: Option<String>,
    pub rendered_savings_domain: Option<String>,
    pub safe_runway_threshold_tokens: Option<i64>,
    pub safe_runway_threshold_source: Option<String>,
    pub projected_pressure_safe: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationLowerTargetReceipt {
    pub domain: String,
    pub tokens: i64,
    pub met: Option<bool>,
    pub is_success_gate: bool,
}

/// Residual state after the seam.
///
/// ## Key order is load-bearing
///
/// TypeScript builds this record through a `residual()` helper that appends
/// `pendingBoundaryDiscarded` **last** when the call-site literal omitted it
/// (skip and compact/install-attempt-failure paths) and leaves it where the
/// literal spelled it — right after `originalAgenticTurnStillOpen` — everywhere
/// else. `JSON.stringify` insertion order is part of the persisted-bytes
/// contract, so [`pending_boundary_discarded_trailing`] carries that spelling
/// through serialization and round-trips it on parse.
///
/// [`pending_boundary_discarded_trailing`]: CompactContinuationResidualState::pending_boundary_discarded_trailing
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactContinuationResidualState {
    pub writer_released: bool,
    pub prior_serving_view_intact: bool,
    pub forced_continuation_boundary_applied: bool,
    pub continuation_turn_opened: bool,
    pub continuation_turn_id: Option<String>,
    pub marker_persisted: bool,
    pub marker_served: bool,
    pub original_agentic_turn_still_open: bool,
    /// An unusable pending forced boundary was discarded on this seam and the
    /// seam started fresh (R23-S12), or continuation state was omitted in its
    /// entirety for an unknown contract version (R22).
    pub pending_boundary_discarded: bool,
    pub next_provider_request_allowed: bool,
    pub relief_path: CompactContinuationReliefPath,
    pub protected_tool_call_ids: Vec<String>,
    pub visibility_boundary_before: Option<i64>,
    pub visibility_boundary_after: Option<i64>,
    pub host_validation_status: HostValidationStatusFact,
    pub core_install_retained_pending_host_validation: bool,
    /// JS key-order spelling only: `true` emits `pendingBoundaryDiscarded` after
    /// `coreInstallRetainedPendingHostValidation` instead of after
    /// `originalAgenticTurnStillOpen`. Never a fact about the seam.
    pub pending_boundary_discarded_trailing: bool,
}

const RESIDUAL_KEYS: &[&str] = &[
    "writerReleased",
    "priorServingViewIntact",
    "forcedContinuationBoundaryApplied",
    "continuationTurnOpened",
    "continuationTurnId",
    "markerPersisted",
    "markerServed",
    "originalAgenticTurnStillOpen",
    "pendingBoundaryDiscarded",
    "nextProviderRequestAllowed",
    "reliefPath",
    "protectedToolCallIds",
    "visibilityBoundaryBefore",
    "visibilityBoundaryAfter",
    "hostValidationStatus",
    "coreInstallRetainedPendingHostValidation",
];

impl Serialize for CompactContinuationResidualState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(RESIDUAL_KEYS.len()))?;
        map.serialize_entry("writerReleased", &self.writer_released)?;
        map.serialize_entry("priorServingViewIntact", &self.prior_serving_view_intact)?;
        map.serialize_entry(
            "forcedContinuationBoundaryApplied",
            &self.forced_continuation_boundary_applied,
        )?;
        map.serialize_entry("continuationTurnOpened", &self.continuation_turn_opened)?;
        map.serialize_entry("continuationTurnId", &self.continuation_turn_id)?;
        map.serialize_entry("markerPersisted", &self.marker_persisted)?;
        map.serialize_entry("markerServed", &self.marker_served)?;
        map.serialize_entry(
            "originalAgenticTurnStillOpen",
            &self.original_agentic_turn_still_open,
        )?;
        if !self.pending_boundary_discarded_trailing {
            map.serialize_entry("pendingBoundaryDiscarded", &self.pending_boundary_discarded)?;
        }
        map.serialize_entry(
            "nextProviderRequestAllowed",
            &self.next_provider_request_allowed,
        )?;
        map.serialize_entry("reliefPath", &self.relief_path)?;
        map.serialize_entry("protectedToolCallIds", &self.protected_tool_call_ids)?;
        map.serialize_entry("visibilityBoundaryBefore", &self.visibility_boundary_before)?;
        map.serialize_entry("visibilityBoundaryAfter", &self.visibility_boundary_after)?;
        map.serialize_entry("hostValidationStatus", &self.host_validation_status)?;
        map.serialize_entry(
            "coreInstallRetainedPendingHostValidation",
            &self.core_install_retained_pending_host_validation,
        )?;
        if self.pending_boundary_discarded_trailing {
            map.serialize_entry("pendingBoundaryDiscarded", &self.pending_boundary_discarded)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for CompactContinuationResidualState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        // `serde_json::Map` is insertion-ordered here (preserve_order), so the
        // observed position of `pendingBoundaryDiscarded` survives the parse.
        let map = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        for key in map.keys() {
            if !RESIDUAL_KEYS.contains(&key.as_str()) {
                return Err(D::Error::custom(format!("residual: unknown field {key}")));
            }
        }
        let trailing = map
            .keys()
            .position(|k| k == "pendingBoundaryDiscarded")
            .is_some_and(|i| i + 1 == map.len());
        fn take<T: serde::de::DeserializeOwned, E: serde::de::Error>(
            map: &serde_json::Map<String, serde_json::Value>,
            key: &str,
        ) -> Result<T, E> {
            let raw = map
                .get(key)
                .ok_or_else(|| E::custom(format!("residual: missing field {key}")))?;
            serde_json::from_value(raw.clone())
                .map_err(|e| E::custom(format!("residual.{key}: {e}")))
        }
        Ok(Self {
            writer_released: take(&map, "writerReleased")?,
            prior_serving_view_intact: take(&map, "priorServingViewIntact")?,
            forced_continuation_boundary_applied: take(&map, "forcedContinuationBoundaryApplied")?,
            continuation_turn_opened: take(&map, "continuationTurnOpened")?,
            continuation_turn_id: take(&map, "continuationTurnId")?,
            marker_persisted: take(&map, "markerPersisted")?,
            marker_served: take(&map, "markerServed")?,
            original_agentic_turn_still_open: take(&map, "originalAgenticTurnStillOpen")?,
            pending_boundary_discarded: take(&map, "pendingBoundaryDiscarded")?,
            next_provider_request_allowed: take(&map, "nextProviderRequestAllowed")?,
            relief_path: take(&map, "reliefPath")?,
            protected_tool_call_ids: take(&map, "protectedToolCallIds")?,
            visibility_boundary_before: take(&map, "visibilityBoundaryBefore")?,
            visibility_boundary_after: take(&map, "visibilityBoundaryAfter")?,
            host_validation_status: take(&map, "hostValidationStatus")?,
            core_install_retained_pending_host_validation: take(
                &map,
                "coreInstallRetainedPendingHostValidation",
            )?,
            pending_boundary_discarded_trailing: trailing,
        })
    }
}

/// Bounded compact/install retry accounting for this seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationRetryReceipt {
    /// 1-based index of the compact/install attempt this receipt classifies.
    pub attempt_index: i64,
    /// Effective bounded retry budget (policy value, clamped to at least 1).
    pub budget: i64,
    /// True when a failed compact/install may be retried at the next eligible
    /// seam. False when no attempt failed, or when the budget is spent and the
    /// session continues on its current body.
    pub retry_authorized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationReceiptContinuation {
    pub opened: bool,
    pub marker_served: bool,
    pub same_agentic_turn_preserved: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationReceipt {
    pub contract_version: String,
    pub outcome: CompactContinuationOutcomeKind,
    pub reason_code: String,
    pub turn_end_reason: Option<String>,
    pub pressure: CompactContinuationPressureReceipt,
    pub lower_target: CompactContinuationLowerTargetReceipt,
    pub fidelity: String,
    pub degradation_reasons: Vec<String>,
    /// Closed, ordered list of conditions that degraded this seam instead of
    /// stopping it. Derived from the `warn` effects in `effects`, same order.
    pub warnings: Vec<CompactContinuationWarning>,
    /// Bounded compact/install retry accounting.
    pub retry: CompactContinuationRetryReceipt,
    pub continuation: CompactContinuationReceiptContinuation,
    pub relief_path: CompactContinuationReliefPath,
    pub protected_tool_call_ids: Vec<String>,
    pub effects: Vec<CompactContinuationEffect>,
    pub residual: CompactContinuationResidualState,
    pub refused: bool,
    pub refuse_code: Option<CompactContinuationRefuseCode>,
    pub skipped: bool,
    pub skip_code: Option<CompactContinuationSkipCode>,
    pub transition_path: Vec<CompactContinuationState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationDecision {
    pub outcome: CompactContinuationOutcomeKind,
    pub terminal_state: CompactContinuationState,
    pub transition_path: Vec<CompactContinuationState>,
    pub effects: Vec<CompactContinuationEffect>,
    pub receipt: CompactContinuationReceipt,
}

// ── Transition order / invariants ────────────────────────────────────────────

pub const COMPACT_CONTINUATION_TRANSITION_ORDER: &[&str] = &[
    "seam_eligibility",
    "forced_boundary_state_legality",
    "writer_claim",
    "capture_identity_correlation",
    "provider_usage_authority",
    "pressure_evaluation",
    "continuation_branch",
    "force_boundary_if_continue_turn",
    "compact_assembly",
    "install_or_preserve",
    "bounded_retry_or_decline",
    "receipt_and_release",
];

pub type CompactContinuationTransitionStep = &'static str;

pub const COMPACT_CONTINUATION_INVARIANTS: &[&str] = &[
    "provider_usage_is_sole_upper_trigger_base",
    "lhc_estimates_never_replace_missing_provider_usage",
    "upper_and_lower_use_distinct_accounting_domains",
    "post_measurement_estimate_is_source_labelled_not_provider_usage",
    "evaluate_only_at_settled_seam_never_in_transport_retry",
    "below_trigger_continues_normally",
    "pending_tool_result_keeps_agentic_turn_open_no_continuation_prompt",
    "active_non_tool_forces_boundary_before_compact_one_turn_end_opens_one_turn",
    "normal_completion_creates_no_empty_continuation_turn",
    "missing_derivations_degrade_fidelity_not_block_valid_compact",
    "lower_target_is_not_a_success_gate",
    "unsettled_seam_is_skip_not_corruption",
    // ── CX-S5: the compact path gates against not compacting, never against compacting
    "refuse_set_is_empty_no_stop_in_the_compact_path",
    "never_strand_a_session_every_condition_warns_and_continues",
    "record_request_health_warns_and_continues_never_refuses",
    "input_epoch_is_diagnostic_only_never_vetoes_a_settled_seam",
    "unproven_provider_identity_omits_signed_reasoning_only",
    "uncorrelatable_tool_pairs_decline_into_ordinary_compact",
    "invalid_protected_pair_set_declines_into_ordinary_compact",
    "unusable_pending_boundary_is_discarded_and_the_seam_starts_fresh",
    "unknown_contract_version_omits_continuation_state_in_its_entirety",
    "unknown_contract_version_is_never_partially_parsed",
    "compact_and_install_failure_are_bounded_retry_not_terminal",
    "retry_budget_exhaustion_continues_on_the_current_body",
    "stale_writer_row_reclaim_requires_host_ownership_authority",
    "writer_ownership_registry_lives_host_side_not_in_the_sdk",
    "live_writer_loser_continues_current_request_never_steals_never_strands",
    "unsafe_runway_is_diagnostic_not_a_gate",
    "best_available_body_is_sent_provider_is_final_authority",
    "host_validation_failure_degrades_and_never_blocks_next_request",
    "warnings_are_loud_diagnostics_that_never_govern",
    // ── carried forward
    "forced_boundary_repair_takes_precedence_over_fresh_pressure",
    "applied_forced_boundary_residual_truthful_on_skip_and_decline",
    "install_failure_wins_over_no_reduction_classification",
    "marker_persisted_before_install_served_only_after_install",
    "marker_persisted_is_residual_state_not_attempt_scoped",
    "marker_idempotency_key_is_prefix_plus_continuation_turn_id",
    "skip_does_not_authorize_next_provider_request",
    "writer_claim_lhc_is_idempotent_reassert_not_second_lock",
    "post_claim_failures_release_writer_and_state_residual_truthfully",
    "preserve_tool_install_failure_includes_preserve_effect",
    "input_is_closed_shape_unknown_fields_rejected",
    "receipts_are_not_user_chat",
    "stable_turn_end_reason_context_compact_continue",
    "no_false_parity_for_capability_limited_hosts",
    "pure_function_is_whole_seam_oracle_not_pre_effect_plan",
    "protected_tool_call_ids_sorted_unique_nonempty",
    "projected_pressure_is_base_plus_growth_minus_savings",
    "safe_runway_threshold_is_not_lower_target",
    "protected_results_budgeted_full_before_prune",
    "visibility_boundary_monotonic_before_earliest_protected_result",
    "atomic_view_and_boundary_install_or_neither",
    "host_validation_never_claimed_inside_lhc_core",
    "host_validation_failure_does_not_rollback_core_install",
    "no_dual_field_toolcallid_shim",
];

pub type CompactContinuationInvariantId = &'static str;

/// v1 JSON inputs are closed-shape (unknown fields rejected).
pub const COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE: bool = true;

/// Rust closed-union note: naive enum deny_unknown_fields is insufficient.
pub const COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE: &str =
    "per-variant closed structs required; deny_unknown_fields on enum derive is insufficient";

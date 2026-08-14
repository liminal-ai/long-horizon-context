//! Compact-continuation contract v1 — types, vocabularies, stable strings.
//!
//! Ported from `packages/lhc/src/shared-tech/compact-continuation/contract.ts`.
//! Field order on Serialize shapes matches TypeScript object construction so
//! fixture parity can reach byte-identical compact JSON via `js_json_stringify`.

use serde::{Deserialize, Serialize};

// ── Version and stable strings ───────────────────────────────────────────────

/// Semver of this contract surface. Fixtures pin the same string.
pub const COMPACT_CONTINUATION_CONTRACT_VERSION: &str = "1.0.0";

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
    #[serde(rename = "normal_complete")]
    NormalComplete,
    #[serde(rename = "degraded_compact")]
    DegradedCompact,
    #[serde(rename = "no_reduction")]
    NoReduction,
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
            Self::NormalComplete => "normal_complete",
            Self::DegradedCompact => "degraded_compact",
            Self::NoReduction => "no_reduction",
            Self::SkipSeam => "skip_seam",
            Self::Refuse => "refuse",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "continue_normal" => Self::ContinueNormal,
            "compact_preserve_tool" => Self::CompactPreserveTool,
            "compact_continue_turn" => Self::CompactContinueTurn,
            "normal_complete" => Self::NormalComplete,
            "degraded_compact" => Self::DegradedCompact,
            "no_reduction" => Self::NoReduction,
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
    "normal_complete",
    "degraded_compact",
    "no_reduction",
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
    #[serde(rename = "input_epoch_changed")]
    InputEpochChanged,
}

impl CompactContinuationSkipCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAtSettledSeam => "not_at_settled_seam",
            Self::TransportRetry => "transport_retry",
            Self::InputEpochChanged => "input_epoch_changed",
        }
    }

    pub fn from_str_exact(s: &str) -> Option<Self> {
        Some(match s {
            "not_at_settled_seam" => Self::NotAtSettledSeam,
            "transport_retry" => Self::TransportRetry,
            "input_epoch_changed" => Self::InputEpochChanged,
            _ => return None,
        })
    }
}

pub const COMPACT_CONTINUATION_SKIP_CODES: &[&str] = &[
    "not_at_settled_seam",
    "transport_retry",
    "input_epoch_changed",
];

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
];

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
    #[serde(rename = "preserve_tool_pair_verbatim")]
    PreserveToolPairVerbatim {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        location: String,
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
            Self::PreserveToolPairVerbatim { .. } => {
                CompactContinuationEffectType::PreserveToolPairVerbatim
            }
            Self::InsertContinuationMarker { .. } => {
                CompactContinuationEffectType::InsertContinuationMarker
            }
            Self::InstallServingView => CompactContinuationEffectType::InstallServingView,
            Self::RecordReceipt { .. } => CompactContinuationEffectType::RecordReceipt,
            Self::DegradeFidelity { .. } => CompactContinuationEffectType::DegradeFidelity,
            Self::SkipSeam { .. } => CompactContinuationEffectType::SkipSeam,
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
    PreserveToolPairVerbatim,
    InsertContinuationMarker,
    InstallServingView,
    RecordReceipt,
    DegradeFidelity,
    SkipSeam,
    Refuse,
}

impl CompactContinuationEffectType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaimWriter => "claim_writer",
            Self::ReleaseWriter => "release_writer",
            Self::ForceTurnEnd => "force_turn_end",
            Self::Compact => "compact",
            Self::PreserveToolPairVerbatim => "preserve_tool_pair_verbatim",
            Self::InsertContinuationMarker => "insert_continuation_marker",
            Self::InstallServingView => "install_serving_view",
            Self::RecordReceipt => "record_receipt",
            Self::DegradeFidelity => "degrade_fidelity",
            Self::SkipSeam => "skip_seam",
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

/// Provider usage authority union. Prefer constructing via the named structs;
/// serde uses an untagged enum with per-variant closed fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProviderUsageAuthority {
    Available(ProviderUsageAvailable),
    Unavailable(ProviderUsageUnavailable),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum WorkContinuation {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "pending_correlated_tool_result")]
    PendingCorrelatedToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "correlationValid")]
        correlation_valid: bool,
    },
    #[serde(rename = "active_non_tool")]
    ActiveNonTool,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ForcedContinuationBoundary {
    NotApplied(ForcedContinuationBoundaryNotApplied),
    Applied(ForcedContinuationBoundaryApplied),
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
    pub writer_claim: WriterClaim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactMaterialFacts {
    pub derivations_missing_or_failed: bool,
    pub lower_target_met: bool,
    pub compact_structurally_valid: bool,
    pub install_succeeds: bool,
    pub useful_reduction: bool,
    pub can_produce_valid_provider_request: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactContinuationPolicy {
    pub upper_trigger_tokens: i64,
    pub lower_target_tokens: i64,
    pub host_capability: CompactContinuationHostCapability,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationLowerTargetReceipt {
    pub domain: String,
    pub tokens: i64,
    pub met: Option<bool>,
    pub is_success_gate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactContinuationResidualState {
    pub writer_released: bool,
    pub prior_serving_view_intact: bool,
    pub forced_continuation_boundary_applied: bool,
    pub continuation_turn_opened: bool,
    pub continuation_turn_id: Option<String>,
    pub marker_persisted: bool,
    pub marker_served: bool,
    pub original_agentic_turn_still_open: bool,
    pub next_provider_request_allowed: bool,
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
    pub continuation: CompactContinuationReceiptContinuation,
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
    "input_epoch",
    "forced_boundary_state_legality",
    "writer_claim",
    "capture_identity_correlation",
    "provider_usage_authority",
    "pressure_evaluation",
    "continuation_branch",
    "force_boundary_if_continue_turn",
    "compact_assembly",
    "install_or_preserve",
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
    "record_request_health_refuses_even_below_pressure_after_claimed_seam",
    "unsettled_seam_is_skip_not_corruption",
    "refuse_only_when_no_valid_request_or_invariants_unproven",
    "one_writer_at_seam_no_silent_native_mid_turn_fallback",
    "post_claim_failures_release_writer_and_state_residual_truthfully",
    "forced_boundary_repair_takes_precedence_over_fresh_pressure",
    "applied_forced_boundary_requires_active_non_tool_continuation",
    "applied_forced_boundary_residual_truthful_on_skip_and_refuse",
    "install_failure_wins_over_no_reduction_classification",
    "marker_persisted_before_install_served_only_after_install",
    "marker_persisted_is_residual_state_not_attempt_scoped",
    "marker_idempotency_key_is_prefix_plus_continuation_turn_id",
    "skip_does_not_authorize_next_provider_request",
    "writer_claim_lhc_is_idempotent_reassert_not_second_lock",
    "settled_seam_lhc_claim_early_refuse_records_claim_and_release",
    "preserve_tool_install_failure_includes_preserve_effect",
    "input_is_closed_shape_unknown_fields_rejected",
    "receipts_are_not_user_chat",
    "stable_turn_end_reason_context_compact_continue",
    "no_false_parity_for_capability_limited_hosts",
    "pure_function_is_whole_seam_oracle_not_pre_effect_plan",
];

pub type CompactContinuationInvariantId = &'static str;

/// v1 JSON inputs are closed-shape (unknown fields rejected).
pub const COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE: bool = true;

/// Rust closed-union note: naive enum deny_unknown_fields is insufficient.
pub const COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE: &str =
    "per-variant closed structs required; deny_unknown_fields on enum derive is insufficient";

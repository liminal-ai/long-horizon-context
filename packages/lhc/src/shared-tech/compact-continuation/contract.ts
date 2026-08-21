/**
 * Compact-continuation contract v1 — provider-neutral state machine surface.
 *
 * This module defines the durable, versioned contract for LHC-owned context
 * relief at a settled model-turn seam when agentic work must continue across a
 * compact boundary. It is intentionally pure: no I/O, no thread database, no
 * host adapter.
 *
 * ## Pure-function protocol (LIM-60 oracle, not LIM-61 runtime)
 *
 * `decideCompactContinuation` is a **whole-seam parity and receipt oracle**.
 * It classifies a completed seam from:
 * - **pre-decision facts** known before any mutation (seam, usage, policy,
 *   continuation kind, invariants, pending forced boundary), and
 * - **attempt results** known only after stages run (compact/install material).
 *
 * A host runtime (LIM-61) must **not** call this once up front and then apply
 * every effect blindly. It executes `COMPACT_CONTINUATION_TRANSITION_ORDER`
 * stage-by-stage (claim writer, optional forced boundary, compact, marker,
 * install, …), gathers attempt results, then uses this oracle/contract to
 * classify the completed seam and emit the durable receipt. Fixtures pin the
 * oracle outputs for TypeScript/Rust parity.
 *
 * Owner rulings (2026-08-13) supersede earlier research-package designs that
 * kept the agentic turn open for every mid-turn relief path. When work continues
 * without a pending correlated tool-result pair, the contract forces a canonical
 * turn boundary with reason `context_compact_continue`.
 *
 * Self-contained enough for a fresh implementer: read this file, README.md, and
 * the parity fixtures under packages/lhc/fixtures/compact-continuation/v1/.
 */

// ── Version and stable strings ───────────────────────────────────────────────

/** Semver of this contract surface. Fixtures pin the same string. */
export const COMPACT_CONTINUATION_CONTRACT_VERSION = "2.0.0" as const;

/** Canonical turn_end / outcome reason when a continuation turn is opened. */
export const CONTEXT_COMPACT_CONTINUE_REASON = "context_compact_continue" as const;

/**
 * Stable typed marker kind served to the model after a continuation compact.
 * Model-visible and LHC inspection/retrieval-visible; hidden from normal user chat.
 */
export const COMPACT_CONTINUATION_MARKER_KIND = "lhc.compact_continuation" as const;

/**
 * Prefix for per-boundary marker idempotency keys.
 * Full key = prefix + continuationTurnId (e.g. `lhc.compact_continuation:t3`).
 * Must be unique per forced boundary and stable across repair of that boundary.
 */
export const COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX = "lhc.compact_continuation:" as const;

/** Build the intake-safe marker idempotency key for one continuation turn. */
export function compactContinuationMarkerIdempotencyKey(continuationTurnId: string): string {
  return `${COMPACT_CONTINUATION_MARKER_IDEMPOTENCY_PREFIX}${continuationTurnId}`;
}

/** Stable marker semantic cause: context compacted while the task remained in progress. */
export const COMPACT_CONTINUATION_MARKER_CAUSE = "context_compacted_task_in_progress" as const;

/** Stable marker semantic action: continue the existing task. */
export const COMPACT_CONTINUATION_MARKER_ACTION = "continue_existing_task" as const;

/**
 * Required model-facing semantics of the typed continuation marker.
 * Hosts may render provider-specific text but must preserve these fields.
 */
export type CompactContinuationMarkerSemantics = {
  cause: typeof COMPACT_CONTINUATION_MARKER_CAUSE;
  action: typeof COMPACT_CONTINUATION_MARKER_ACTION;
  /** This is not a new user request. */
  newUserRequest: false;
  /** Do not wait for another user message. */
  waitForUser: false;
};

// ── Accounting domains (intentionally distinct) ──────────────────────────────

/**
 * Upper-trigger base domain: provider-reported input context only.
 * For Claude this is input + cache creation + cache read. LHC token estimates
 * never substitute for a missing provider measurement.
 */
export type ProviderReportedInputAccounting = "provider_reported_input";

/**
 * Lower-target domain: LHC rendered-history tokens after compact assembly.
 * Upper and lower use different accounting domains by design.
 */
export type LhcRenderedHistoryAccounting = "lhc_rendered_history";

/**
 * Post-measurement pressure delta: source-labelled estimate of messages
 * captured after the last provider request. Must never be relabelled as
 * provider usage.
 */
export type SourceLabelledEstimateAccounting = "source_labelled_estimate";

export type TokenAccountingDomain =
  | ProviderReportedInputAccounting
  | LhcRenderedHistoryAccounting
  | SourceLabelledEstimateAccounting;

// ── Host capability (truthful; no false parity) ──────────────────────────────

/**
 * Host capability posture for this contract.
 * - `full_state_machine`: Codex (and similar) implement every branch.
 * - `capability_limited`: cc-lhc later — truthful limited governance + handoff;
 *   must not claim in-place request replacement it cannot perform.
 * The pure decision table is identical for both; capability-limited hosts
 * simply cannot perform some effects and must not fabricate them.
 */
export type CompactContinuationHostCapability = "full_state_machine" | "capability_limited";

export const COMPACT_CONTINUATION_HOST_CAPABILITIES: readonly CompactContinuationHostCapability[] = [
  "full_state_machine",
  "capability_limited",
] as const;

// ── Machine states ───────────────────────────────────────────────────────────

/**
 * Explicit machine states. Evaluation begins at `at_seam` only when seam
 * readiness holds; otherwise the host skips (not-at-seam / transport retry).
 *
 * Terminal states are the leaf outcomes. Intermediate states document ordered
 * evaluation; pure `decideCompactContinuation` folds them into a single
 * Decision for parity fixtures.
 */
export type CompactContinuationState =
  | "idle"
  /** Settled model-turn seam: response complete, tools settled, capture flushed. */
  | "at_seam"
  /** Checking writer exclusivity, capture, identity, correlation, epoch. */
  | "checking_invariants"
  /** Authoritative provider usage + labelled post-measurement estimate. */
  | "evaluating_pressure"
  /** Pressure was evaluated and is below upper trigger; no compact. */
  | "below_trigger"
  /** Above trigger; pending correlated tool-result path. */
  | "path_preserve_tool"
  /** Above trigger; active non-tool work continues. */
  | "path_continue_turn"
  /** Work finished; close normally without continuation. */
  | "path_normal_complete"
  /** Compact assembly in progress (closed history only). */
  | "compacting"
  /** Installing/serving the post-compact request context. */
  | "installing"
  /** Terminal: continue without compact. */
  | "terminal_continue_normal"
  /** Terminal: same agentic turn; tool pair preserved; no continuation marker. */
  | "terminal_preserve_tool"
  /** Terminal: forced turn_end (opens one continuation turn) + marker. */
  | "terminal_continue_turn"
  /** Terminal: normal work completion; no empty continuation turn. */
  | "terminal_normal_complete"
  /** Terminal: structurally valid compact with degraded fidelity. */
  | "terminal_degraded"
  /** Terminal: no useful reduction; structurally ok; continue without claiming success. */
  | "terminal_no_reduction"
  /**
   * Terminal: continuation machinery declined; the host's ordinary settled-seam
   * compact runs on canonical turns. No continuation mutation happened.
   */
  | "terminal_decline_ordinary"
  /** Terminal: compact/install attempt failed; bounded retry still authorized. */
  | "terminal_retry"
  /** Terminal: session continues on its current body; no relief this seam. */
  | "terminal_continue_current_body"
  /**
   * Terminal: seam skipped without mutation — transport retry or a not-yet-settled
   * seam (wait). Not record corruption.
   */
  | "terminal_skip"
  /**
   * Terminal: hard refuse. **Unreachable in this contract version** — the refuse
   * set is empty (CX-S5). Retained so historical receipts still validate.
   */
  | "terminal_refuse";

export const COMPACT_CONTINUATION_STATES: readonly CompactContinuationState[] = [
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
] as const;

// ── Outcome kinds (fixture-stable) ───────────────────────────────────────────

export type CompactContinuationOutcomeKind =
  | "continue_normal"
  | "compact_preserve_tool"
  | "compact_continue_turn"
  | "compact_preserve_tool_escalated"
  | "normal_complete"
  | "degraded_compact"
  | "no_reduction"
  /**
   * Continuation machinery declined this seam and handed the work to the
   * host's ordinary settled-seam compact on canonical turns. No mutation by
   * the continuation machine; the next provider request is authorized.
   */
  | "decline_to_ordinary_compact"
  /**
   * A compact or install attempt failed and bounded retry is still authorized.
   * The session continues on its current body until the next eligible seam.
   */
  | "retry_compact"
  /**
   * The session continues on its current body with no relief this seam
   * (retry budget exhausted, or a live writer owner holds the thread).
   */
  | "continue_current_body"
  | "skip_seam"
  /**
   * Unreachable in this contract version — the refuse set is empty (CX-S5).
   * Retained so historical receipts still validate.
   */
  | "refuse";

export const COMPACT_CONTINUATION_OUTCOME_KINDS: readonly CompactContinuationOutcomeKind[] = [
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
] as const;

/**
 * Durable relief-path vocabulary (receipt/identity). Distinct from outcome when
 * outcome folds degraded/no_reduction under the same install result.
 * - normal_preserve: ordinary preserve installed without escalation
 * - protected_escalation: forced boundary + protected boundary + atomic install
 * - core_install_failed: atomic view+boundary (or preserve install) failed; rolled back
 * - host_validation_awaiting: core install succeeded; host body not yet acknowledged
 * - host_validation_failed: host recorded full-body validation failure after core install
 * - host_validation_ok: host recorded successful body validation (send may proceed)
 */
export type CompactContinuationReliefPath =
  | "none"
  | "normal_preserve"
  | "protected_escalation"
  | "core_install_failed"
  | "host_validation_awaiting"
  | "host_validation_failed"
  | "host_validation_ok";

export const COMPACT_CONTINUATION_RELIEF_PATHS: readonly CompactContinuationReliefPath[] = [
  "none",
  "normal_preserve",
  "protected_escalation",
  "core_install_failed",
  "host_validation_awaiting",
  "host_validation_failed",
  "host_validation_ok",
] as const;

// ── Skip codes (closed; distinct from refuse) ────────────────────────────────

/**
 * Soft skip: do not mutate; re-evaluate later. Never a stop.
 * - `not_at_settled_seam` — seam simply has not settled yet (wait), not record corruption.
 * - `transport_retry` — never mutate inside a transport retry.
 *
 * **Removed (CX-S5 / R1):** `input_epoch_changed`. Input arriving during a turn
 * does not invalidate settled history; new input belongs to the next turn. The
 * seam still carries `inputEpochAtDecision`/`inputEpochAtApply` as diagnostics,
 * but epoch drift never vetoes a settled seam.
 */
export type CompactContinuationSkipCode = "not_at_settled_seam" | "transport_retry";

export const COMPACT_CONTINUATION_SKIP_CODES: readonly CompactContinuationSkipCode[] = [
  "not_at_settled_seam",
  "transport_retry",
] as const;

// ── Refuse codes (empty set — retained for historical receipts) ─────────────

/**
 * Hard refuse codes.
 *
 * ## The refuse set is empty (CX-S5, rulings R21–R24)
 *
 * Compact is the recovery mechanism, not the thing you recover from. A session
 * that does not compact dies against the context wall; a session that compacts
 * imperfectly keeps working. This contract therefore gates against **not**
 * compacting, never against compacting: no condition in the compact path
 * returns a stop. Every former refuse became detect + warn + continue, bounded
 * retry, or an explicit decline into the host's ordinary settled-seam compact.
 *
 * The code union and the code list are retained so durable receipts written by
 * earlier versions still validate and can be read back. `decideCompactContinuation`
 * never produces any of them.
 *
 * Former codes and their current disposition:
 * - `incomplete_capture` → warn `capture_incomplete`, continue (capture feeds
 *   derivation quality, not compact capability).
 * - `invalid_tool_correlation` → decline into ordinary settled-seam compact.
 * - `invalid_provider_identity` → warn + omit signed reasoning, continue.
 * - `open_turn_invariant_broken` → warn, continue (turn-record validation is
 *   core LHC's own job, not a compact precondition).
 * - `native_writer_conflict` → stale-row reclaim under host ownership authority;
 *   a live loser continues its current request.
 * - `compact_failed` / `install_failed` → bounded retry, then continue on the
 *   current body.
 * - `no_valid_provider_request` → warn and send the best available body; the
 *   provider is the final authority on what it accepts.
 * - `invalid_pending_boundary_continuation` → discard the boundary, start fresh.
 * - `unsupported_contract_version` → degrade by feature omission (see
 *   `CompactContinuationWarningCode`).
 * - `invalid_protected_tool_pairs` → decline into ordinary compact.
 * - `unsafe_runway` → diagnostic only; oversized outgoing content is ours to
 *   truncate as a ladder rung, and the host's exact check is downstream.
 * - `host_validation_failed` → degrade to the best available body, continue.
 *
 * Genuinely unreadable or referentially damaged canonical source still fails
 * closed, but it does so as a storage/caller error outside this oracle — not as
 * a refuse outcome.
 */
export type CompactContinuationRefuseCode =
  | "incomplete_capture"
  | "invalid_tool_correlation"
  | "invalid_provider_identity"
  | "open_turn_invariant_broken"
  | "native_writer_conflict"
  | "compact_failed"
  | "install_failed"
  | "no_valid_provider_request"
  | "invalid_pending_boundary_continuation"
  | "unsupported_contract_version"
  | "invalid_protected_tool_pairs"
  | "unsafe_runway"
  | "host_validation_failed";

/**
 * Historical refuse codes accepted by receipt validation. **No decision path
 * produces a refuse** — see `COMPACT_CONTINUATION_REACHABLE_REFUSE_CODES`.
 */
export const COMPACT_CONTINUATION_REFUSE_CODES: readonly CompactContinuationRefuseCode[] = [
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
] as const;

/** Refuse codes this contract version can still produce: none (List 2 is empty). */
export const COMPACT_CONTINUATION_REACHABLE_REFUSE_CODES: readonly CompactContinuationRefuseCode[] = [] as const;

// ── Warning codes (detect + warn + continue) ─────────────────────────────────

/**
 * Closed set of degradation warnings. A warning records a condition that used
 * to stop the compact path and now only degrades it. Warnings are loud
 * diagnostics: they are inspectable on the durable receipt and emitted as
 * ordered `warn` effects, but they never govern.
 */
export type CompactContinuationWarningCode =
  /** Capture of the settled model turn is incomplete; compact ran on thread data anyway. */
  | "capture_incomplete"
  /** Provider/model identity is unproven; signed reasoning is omitted from the body. */
  | "provider_identity_unproven"
  /** Exactly-one-open-turn could not be verified; core LHC owns turn-record health. */
  | "open_turn_invariant_unverified"
  /** A stale native/conflict writer row was reclaimed after host authority confirmed no live owner. */
  | "stale_writer_row_reclaimed"
  /** A live owner holds this LHC thread; this attempt continues its current request instead. */
  | "writer_owned_elsewhere"
  /** Pending tool-call/result correlation is unproven; declined into ordinary compact. */
  | "tool_correlation_unproven"
  /** Protected pair set is structurally invalid; declined into ordinary compact. */
  | "protected_tool_pairs_invalid"
  /** An illegal/unusable pending forced boundary was discarded; the seam starts fresh. */
  | "pending_boundary_discarded"
  /** A fresh force claimed a pre-existing boundary marker; the claim was not trusted. */
  | "boundary_marker_claim_untrusted"
  /** A continuation boundary is required but no continuation turn id is available. */
  | "continuation_boundary_unavailable"
  /**
   * Input contract version is not this oracle version. Continuation state is
   * treated as absent in its entirety — no partial parse, no guessing: the
   * pending boundary is discarded, continuation machinery is skipped, and the
   * host's ordinary compact runs on canonical (schema-stable) turns.
   */
  | "unsupported_contract_version_omitted"
  /** Compact assembly could not produce a structurally valid view this attempt. */
  | "compact_attempt_failed"
  /** Post-compact serving view could not be installed this attempt. */
  | "install_attempt_failed"
  /** Bounded compact/install retry budget is spent; continuing on the current body. */
  | "compact_retry_budget_exhausted"
  /** No structurally valid provider request could be proven; best available body is sent. */
  | "provider_request_unvalidated"
  /** Projected runway remains unsafe after relief; diagnostic only, never a gate. */
  | "unsafe_runway_projection"
  /** Host full-body validation failed after core install; degraded body stands. */
  | "host_validation_failed";

export const COMPACT_CONTINUATION_WARNING_CODES: readonly CompactContinuationWarningCode[] = [
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
] as const;

export type CompactContinuationWarning = {
  code: CompactContinuationWarningCode;
  /** Provider-neutral human-readable detail. Stable per condition for fixtures. */
  reason: string;
};

/** Default bounded compact/install retry budget (attempts at one seam identity). */
export const DEFAULT_COMPACT_RETRY_BUDGET = 2 as const;

// ── Effects (ordered, applied by runtime in later stories) ───────────────────

/**
 * Ordered effects the runtime applied (or attempted) on this seam.
 *
 * For active non-tool continuation the normative success order is:
 * claim LHC writer → force_turn_end (closes prior + opens exactly one
 * continuation turn) → compact → [degrade_fidelity] → insert marker → install
 * → receipt → release.
 *
 * Post-claim failure receipts must include effects already attempted and end
 * with writer release (see residual state).
 */
export type CompactContinuationEffect =
  | { type: "claim_writer"; writer: "lhc" }
  | { type: "release_writer" }
  | {
      /**
       * Force a canonical `turn_end` with reason `context_compact_continue`.
       *
       * **Turn mechanics:** LHC intake of one `turn_end` on a populated open
       * turn atomically closes that turn **and opens exactly one new empty
       * turn** (`turns.create`). This single effect models that atomic
       * boundary. Runtimes must not apply a second imperative "open turn"
       * action that would create another turn.
       *
       * `continuationTurnId` is the newly opened turn id (`tN`) returned by
       * that transition — the stable per-boundary identity for marker keys.
       */
      type: "force_turn_end";
      reason: typeof CONTEXT_COMPACT_CONTINUE_REASON;
      outcome: "completed";
      /** Always true: the atomic turn_end opens exactly one continuation turn. */
      opensContinuationTurn: true;
      /** Always 1: exactly one empty continuation turn after the boundary. */
      continuationTurnCount: 1;
      /** Newly opened continuation turn id (`tN`). */
      continuationTurnId: string;
    }
  | {
      type: "compact";
      lowerTargetDomain: LhcRenderedHistoryAccounting;
      lowerTargetTokens: number;
      /** Missing/failed derivations degrade fidelity; never block a valid compact. */
      allowDegradedDerivations: true;
    }
  | {
      type: "preserve_tool_pairs_verbatim";
      /** Sorted unique protected tool-call IDs kept full in the open-turn tail. */
      protectedToolCallIds: string[];
      /** Current call/result pairs stay in the open-turn tail. */
      location: "open_turn_tail";
    }
  | {
      /**
       * Advance the visibility boundary together with serving-view install
       * (protected-escalation atomic core install). Boundary is monotonic and
       * strictly before the earliest protected result event.
       */
      type: "advance_visibility_boundary";
      previousBoundary: number;
      newBoundary: number;
      compactPoint: number;
    }
  | {
      /**
       * Host must validate the provider request body after core install.
       * LHC never claims the host body was validated inside the core.
       */
      type: "await_host_validation";
      attemptIdScope: "current_attempt";
    }
  | {
      type: "record_host_validation";
      result: "ok" | "failed";
      /** Provider-neutral reason when failed; absent on ok. */
      reason?: string;
    }
  | {
      /**
       * Persist one canonical typed marker that starts the continuation turn.
       * Model-visible when later installed into a serving view; always LHC
       * inspection/retrieval-visible; hidden from normal user chat.
       *
       * Insertion is durable on successful compact (before serving-view install).
       * Idempotency key is `lhc.compact_continuation:<continuationTurnId>` —
       * unique per forced boundary, stable across repair of that boundary.
       * Reasserting the same key during repair skips rather than duplicating.
       *
       * `semantics` is the stable instruction payload every host must preserve
       * (render/transient inject may vary; meaning may not).
       */
      type: "insert_continuation_marker";
      kind: typeof COMPACT_CONTINUATION_MARKER_KIND;
      /** Echo of the forced boundary's continuation turn id. */
      continuationTurnId: string;
      /** Must equal compactContinuationMarkerIdempotencyKey(continuationTurnId). */
      idempotencyKey: string;
      semantics: CompactContinuationMarkerSemantics;
      modelVisible: true;
      lhcInspectVisible: true;
      userChatVisible: false;
      /**
       * Hosts that cannot mirror the typed item may inject transiently while
       * preserving the canonical boundary and semantics.
       */
      hostMayInjectTransiently: true;
    }
  | { type: "install_serving_view" }
  | {
      type: "record_receipt";
      durable: true;
      /** Receipts/cause are inspectable but are not ordinary user chat. */
      userChatVisible: false;
    }
  | { type: "degrade_fidelity"; causes: string[] }
  | {
      type: "skip_seam";
      code: CompactContinuationSkipCode;
      reason: string;
    }
  | {
      /**
       * Loud diagnostic for a condition that degraded — never governed — this
       * seam. Ordered where the condition was detected; aggregated onto
       * `receipt.warnings`.
       */
      type: "warn";
      code: CompactContinuationWarningCode;
      reason: string;
    }
  | {
      /**
       * Provider/model identity is unproven, so the one feature that needs it —
       * signed reasoning — is omitted from the body. The compact proceeds.
       */
      type: "omit_signed_reasoning";
      reason: string;
    }
  | {
      /**
       * Reclaim a stale native/conflict writer row. Only legal after host
       * ownership authority confirmed no live owner holds this LHC thread.
       * The ownership registry lives host-side, keyed by LHC thread id.
       */
      type: "reclaim_writer";
      priorClaim: "native" | "conflict";
      hostAuthority: "no_live_owner";
    }
  | {
      /**
       * Drop an unusable pending forced boundary and start the seam fresh.
       * `continuationTurnId` is null when the boundary was never interpreted
       * (unsupported contract version — no partial parse).
       */
      type: "discard_pending_boundary";
      continuationTurnId: string | null;
      reason: string;
    }
  /** Unreachable in this contract version — the refuse set is empty (CX-S5). */
  | { type: "refuse"; code: CompactContinuationRefuseCode; reason: string };

export type CompactContinuationEffectType = CompactContinuationEffect["type"];

// ── Inputs ───────────────────────────────────────────────────────────────────

export type ProviderUsageAuthority =
  | {
      available: true;
      /** Provider input tokens (authoritative component). */
      inputTokens: number;
      /** Claude cache creation; 0 when absent/unsupported. */
      cacheCreationTokens: number;
      /** Claude cache read; 0 when absent/unsupported. */
      cacheReadTokens: number;
      /**
       * Authoritative total for upper-trigger base.
       * Claude: input + cache_creation + cache_read.
       */
      total: number;
      domain: ProviderReportedInputAccounting;
    }
  | {
      available: false;
      reason: "missing" | "invalid";
      domain: ProviderReportedInputAccounting;
    };

export type PostMeasurementEstimate = {
  tokens: number;
  /**
   * Host-owned source label (e.g. "lhc_token_estimate", "host_byte_estimate").
   * The estimate is never relabelled as provider usage.
   */
  source: string;
  domain: SourceLabelledEstimateAccounting;
};

export type CompactContinuationSeam = {
  /** Model response for model turn N is complete (terminal stop). */
  modelResponseComplete: boolean;
  /** Every tool the model requested for that response has returned. */
  requestedToolsSettled: boolean;
  /** Host flushed capture of response + tools (+ steering) to LHC. */
  captureFlushed: boolean;
  /** Evaluation is before the next provider request is issued. */
  beforeNextProviderRequest: boolean;
  /**
   * True when inside a transport-retry loop for the current provider request.
   * Mutation is forbidden; must skip the seam.
   */
  insideTransportRetry: boolean;
  /**
   * Input epoch at decision time. **Diagnostic only** (CX-S5 / R1): settled
   * history is not invalidated by input that arrived later in the turn.
   */
  inputEpochAtDecision: number;
  /**
   * Input epoch re-checked at apply time. **Diagnostic only** — drift from
   * `inputEpochAtDecision` never vetoes a settled seam; new input belongs to
   * the next turn.
   */
  inputEpochAtApply: number;
};

export type WorkContinuation =
  | { kind: "none" }
  | {
      kind: "pending_correlated_tool_result";
      /**
       * Sorted, unique, non-empty set of response-scoped client-executed
       * pending tool-call IDs whose call/result pairs stay full in the open
       * tail. Contract 2.0.0 — no single-id field and no dual-field shim.
       */
      protectedToolCallIds: string[];
      /** Call/result correlation can be proven for every protected id. */
      correlationValid: boolean;
    }
  | { kind: "active_non_tool" };

/** Normalize protected IDs: unique, non-empty strings, sorted ascending. */
export function normalizeProtectedToolCallIds(ids: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const out = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].sort();
  return out;
}

/**
 * Forced continuation-boundary identity for the whole-seam oracle.
 *
 * Runtime protocol (LIM-61):
 * - **Fresh continue-turn:** apply atomic `turn_end` first, receive the new
 *   continuation turn id (`tN`), supply `{ applied: true, continuationTurnId,
 *   forcedThisSeam: true, markerAlreadyPersisted: false }`.
 * - **Repair:** read the already-open continuation turn id; check whether the
 *   boundary-derived marker key
 *   (`lhc.compact_continuation:<continuationTurnId>`) already exists; supply
 *   `{ applied: true, continuationTurnId, forcedThisSeam: false,
 *   markerAlreadyPersisted: <actual> }` — do not force another boundary.
 * - **No forced boundary** (preserve-tool, below-trigger, skips, etc.):
 *   `{ applied: false }`.
 *
 * Continue-turn compact/marker paths require `applied: true` with a non-empty
 * turn id. Marker idempotency keys derive from that id only (not UUID, usage,
 * epoch, timestamp, or the reason string alone). Reassertion of the marker is
 * idempotent by that per-boundary key.
 *
 * **Illegal v1 combination:** `applied: true` with `forcedThisSeam: true` and
 * `markerAlreadyPersisted: true`. A fresh atomic `turn_end` just minted the
 * continuation turn id, so its boundary-derived marker cannot already exist at
 * seam entry. Input validation rejects this pair; the total evaluator also
 * refuses `invalid_pending_boundary_continuation` at
 * `forced_boundary_state_legality` (residual does not trust the claim —
 * `markerPersisted`/`markerServed` stay false while applied-boundary facts remain).
 */
export type ForcedContinuationBoundary =
  | { applied: false }
  | {
      applied: true;
      /** Newly opened (or already open) continuation turn id, e.g. `t3`. */
      continuationTurnId: string;
      /**
       * true when this seam applied the atomic force_turn_end;
       * false when repairing a prior forced boundary (no second force).
       */
      forcedThisSeam: boolean;
      /**
       * Closed residual fact at seam entry: does the boundary-keyed marker
       * already exist in the canonical record?
       * - Fresh force supplies `false` (must not be true — illegal with
       *   `forcedThisSeam: true`).
       * - Repair checks the boundary-derived idempotency key and supplies the
       *   actual existing state.
       * Residual `markerPersisted` is true when a *trusted* prior marker is
       * present (repair, `forcedThisSeam: false`) **or** this attempt
       * persisted the marker. A contradictory fresh+already-persisted claim
       * is never OR'd into residual true.
       */
      markerAlreadyPersisted: boolean;
    };

/**
 * Writer claim observed at seam entry.
 * - `none`: no writer held; this operation may claim LHC.
 * - `lhc`: already-established claim owned by **this same operation** (e.g.
 *   repair after crash mid-seam). The whole-seam receipt still records a
 *   `claim_writer` effect as the claim of record — idempotent re-assert, not a
 *   second lock acquisition.
 * - `native` / `conflict`: a row claims the thread for someone else. Resolved by
 *   `writerOwnershipAuthority`, never by refusing (CX-S5 / R23-S8).
 */
export type WriterClaim = "none" | "lhc" | "native" | "conflict";

export const COMPACT_CONTINUATION_WRITER_CLAIMS: readonly WriterClaim[] = [
  "none",
  "lhc",
  "native",
  "conflict",
] as const;

export type CompactContinuationInvariants = {
  /**
   * Capture of the settled model turn is complete and proven. False warns
   * (`capture_incomplete`) and continues — capture feeds derivation quality,
   * not compact capability.
   */
  captureComplete: boolean;
  /**
   * Provider/model identity required for a valid request is proven. False warns
   * and omits signed reasoning; it never blocks the compact.
   */
  providerIdentityValid: boolean;
  /**
   * Exactly one open agentic turn (RECORD-12). False warns and continues —
   * turn-record validation is core LHC's own job, not a compact precondition.
   */
  singleOpenTurn: boolean;
  /** Writer row observed at seam entry. */
  writerClaim: WriterClaim;
  /**
   * Host ownership authority for a `native`/`conflict` writer row, resolved
   * host-side against a process-global registry keyed by LHC thread id. The
   * registry itself never lives in the SDK; the SDK only consumes the answer.
   * - `no_live_owner`: stale row from a dead owner — reclaim proceeds.
   * - `live_owner`: a live owner holds the thread — this attempt is the loser
   *   and continues its current request. It never steals and never strands.
   * - absent/null: no authority supplied — treated as `live_owner` (no reclaim).
   */
  writerOwnershipAuthority?: "no_live_owner" | "live_owner" | null;
};

/**
 * Attempt-result facts. Known only after the runtime has attempted compact
 * (and install when compact succeeded). Pre-decision classification uses these
 * only on paths that attempt those stages.
 */
export type CompactMaterialFacts = {
  /** Missing/failed derivations degrade fidelity but do not block. */
  derivationsMissingOrFailed: boolean;
  /** After compact attempt: lower target met? Target is not a success gate. */
  lowerTargetMet: boolean;
  /** Compact assembly can run to a structurally valid band arrangement. */
  compactStructurallyValid: boolean;
  /** Core install of serving view (+ optional boundary) succeeded. */
  installSucceeds: boolean;
  /**
   * Whether the compact reclaims useful served size. False is a first-class
   * non-error outcome when structure is still valid (`no_reduction`).
   */
  usefulReduction: boolean;
  /**
   * When false, no structurally valid provider request could be **proven** even
   * after best-effort compact. Warns (`provider_request_unvalidated`) and the
   * best available body is sent anyway: the provider is the final authority on
   * what it accepts, and a provider rejection is recoverable where a stranded
   * session is not.
   */
  canProduceValidProviderRequest: boolean;
  /**
   * Projected next-request pressure after relief (provider base + growth − savings).
   * Null when provider base is unavailable.
   */
  projectedPressureTokens: number | null;
  /** Source-labelled rendered savings (current served − candidate served). */
  renderedSavingsTokens: number;
  renderedSavingsSource: string;
  renderedSavingsDomain: SourceLabelledEstimateAccounting;
  /**
   * Host-supplied safe-runway threshold (not the lower target). Required for
   * pending-tool escalation classification when pressure evaluation runs.
   */
  safeRunwayThresholdTokens: number | null;
  safeRunwayThresholdSource: string | null;
  /** True when projected pressure is below the safe-runway threshold. */
  projectedPressureSafe: boolean | null;
  /**
   * True when the attempt escalated through a protected continuation boundary
   * (force + protected visibility prune + marker) rather than normal preserve.
   */
  protectedEscalationApplied: boolean;
  /** Visibility boundary before the atomic install (null when not advanced). */
  visibilityBoundaryBefore: number | null;
  /** Visibility boundary after atomic install (null when not advanced). */
  visibilityBoundaryAfter: number | null;
  /** Compact point of the prepared/installed view (for boundary effect). */
  compactPointAtInstall: number | null;
  /**
   * Maximal eligible unprotected prune still leaves projected pressure unsafe.
   * Diagnostic only: warns (`unsafe_runway_projection`) and the relief still
   * installs. Oversized outgoing content is ours to truncate as a ladder rung,
   * and the host's exact body check is downstream.
   */
  maximalPruneInsufficient: boolean;
  /**
   * 1-based index of this compact/install attempt at this seam identity.
   * Compared against `policy.compactRetryBudget` for bounded retry. Absent
   * means 1 (first attempt).
   */
  compactAttemptIndex?: number;
  /**
   * Host full-body validation status for this attempt.
   * `not_required` for paths that do not need post-install host validation.
   * LHC never claims the provider body was validated inside the core.
   * `failed` degrades (warn + keep the installed body); it never rolls back the
   * core install and never blocks the next provider request.
   */
  hostValidationStatus: "not_required" | "awaiting" | "ok" | "failed";
};

export type CompactContinuationPolicy = {
  /** Upper trigger in provider-reported input domain. */
  upperTriggerTokens: number;
  /** Lower target in LHC rendered-history domain. */
  lowerTargetTokens: number;
  hostCapability: CompactContinuationHostCapability;
  /**
   * Host-supplied safe-runway threshold in source-labelled projected-pressure
   * domain. Not the lower target. Optional on non-pending paths; required for
   * pending-tool escalation decisions at runtime.
   */
  safeRunwayThresholdTokens?: number;
  /** Source label for the safe-runway threshold (e.g. host_auto_compact_scope). */
  safeRunwayThresholdSource?: string;
  /**
   * Bounded compact/install retry budget: how many attempts at this seam
   * identity may run before the session stops retrying and continues on its
   * current body. Absent means `DEFAULT_COMPACT_RETRY_BUDGET`. Values below 1
   * are clamped to 1 — a failed attempt is never terminal.
   */
  compactRetryBudget?: number;
};

/**
 * Pre-decision facts (known before mutation) plus attempt results (known after
 * stages execute). See module protocol comment: this is an oracle bag, not a
 * pre-effect plan-only input.
 */
export type CompactContinuationInput = {
  /**
   * Must equal `COMPACT_CONTINUATION_CONTRACT_VERSION` for an accepted v2 seam.
   * Unsupported versions refuse with `unsupported_contract_version` and do not
   * claim acceptance of the input as v2.
   */
  contractVersion: string;
  // ── pre-decision facts ────────────────────────────────────────────────────
  seam: CompactContinuationSeam;
  providerUsage: ProviderUsageAuthority;
  postMeasurementEstimate: PostMeasurementEstimate;
  policy: CompactContinuationPolicy;
  continuation: WorkContinuation;
  invariants: CompactContinuationInvariants;
  /**
   * Forced boundary identity (or none). Replaces the prior bare boolean.
   *
   * **Legal v2 when applied:** requires `continuation.kind === "active_non_tool"`.
   * Pairing with `none` or `pending_correlated_tool_result` is
   * `invalid_pending_boundary_continuation`. Active non-tool above trigger with
   * `{ applied: false }` is the same refuse (runtime must force first).
   * `forcedThisSeam: true` + `markerAlreadyPersisted: true` is the same refuse
   * (and input-invalid): fresh force cannot already hold the boundary marker.
   *
   * **Repair precedence** (`applied: true`, `forcedThisSeam: false`): after seam
   * + record/request-health checks pass, resume compact/marker/install
   * regardless of missing provider usage or a now-below trigger.
   *
   * **Marker identity:** key = `lhc.compact_continuation:<continuationTurnId>`.
   * **Marker residual:** supply `markerAlreadyPersisted` so residual
   * `markerPersisted` is record-state truthful across repair. Only trusted when
   * `forcedThisSeam: false`.
   */
  forcedContinuationBoundary: ForcedContinuationBoundary;
  // ── attempt results ───────────────────────────────────────────────────────
  compactMaterial: CompactMaterialFacts;
};

// ── Receipt ──────────────────────────────────────────────────────────────────

export type CompactContinuationPressureReceipt = {
  providerBaseTokens: number | null;
  providerBaseDomain: ProviderReportedInputAccounting;
  estimateTokens: number;
  estimateSource: string;
  estimateDomain: SourceLabelledEstimateAccounting;
  /**
   * last provider measurement + labelled estimate when provider base exists;
   * null when no authoritative provider measurement (never fabricated).
   */
  nextRequestPressureTokens: number | null;
  upperTriggerTokens: number;
  /** null when pressure cannot be evaluated (no provider base). */
  atOrAboveTrigger: boolean | null;
  /**
   * Projected pressure after relief: provider base + growth − rendered savings.
   * Null when provider base is unavailable.
   */
  projectedPressureTokens: number | null;
  renderedSavingsTokens: number | null;
  renderedSavingsSource: string | null;
  renderedSavingsDomain: SourceLabelledEstimateAccounting | null;
  safeRunwayThresholdTokens: number | null;
  safeRunwayThresholdSource: string | null;
  /** null when projected pressure or threshold unavailable. */
  projectedPressureSafe: boolean | null;
};

export type CompactContinuationLowerTargetReceipt = {
  domain: LhcRenderedHistoryAccounting;
  tokens: number;
  /** null when compact did not run. */
  met: boolean | null;
  /** Always false — lower bound is a target, never a pass/fail gate. */
  isSuccessGate: false;
};

/**
 * Residual durable/runtime state after the seam decision.
 * Post-claim failures always release the writer and never leave a partial install.
 */
export type CompactContinuationResidualState = {
  /** Writer claim released (or never held). Always true on terminal receipts. */
  writerReleased: boolean;
  /**
   * Prior serving view remains installed. True when install did not succeed
   * (including install_failed and pre-install refuses). False only when
   * `install_serving_view` was applied successfully.
   */
  priorServingViewIntact: boolean;
  /**
   * A forced `context_compact_continue` boundary was applied on this seam
   * (or already pending from a prior attempt). Durable even if compact/install
   * fails, and even when skip/health-refuse exits with pending boundary true.
   */
  forcedContinuationBoundaryApplied: boolean;
  /**
   * Exactly one empty continuation turn is open as a result of the forced
   * boundary (atomic turn_end). False when no forced boundary applies.
   */
  continuationTurnOpened: boolean;
  /**
   * Continuation turn id for an applied forced boundary (`tN`), else null.
   * Inspectable for repair and marker-key audit.
   */
  continuationTurnId: string | null;
  /**
   * Residual: the boundary-keyed typed marker exists in the canonical record
   * **after** this attempt (not attempt-scoped). True when it was already
   * present at entry (`forcedContinuationBoundary.markerAlreadyPersisted`) or
   * this attempt persisted it (successful compact, before install). A repair
   * compact failure after a prior marker persistence reports
   * `markerPersisted: true` with `markerServed: false`. Repair reasserts by
   * the same per-boundary idempotency key.
   */
  markerPersisted: boolean;
  /**
   * Typed continuation marker reached an installed model-visible serving view.
   * False on install failure even when `markerPersisted` is true.
   */
  markerServed: boolean;
  /**
   * Original agentic turn still open (tool-preserve path and early refuses/skips
   * without a pending forced boundary). False after a forced continuation
   * boundary (including pending-boundary residual on skip/refuse).
   */
  originalAgenticTurnStillOpen: boolean;
  /**
   * An unusable pending forced boundary was discarded on this seam and the seam
   * started fresh (R23-S12), or continuation state was omitted in its entirety
   * for an unknown contract version (R22).
   */
  pendingBoundaryDiscarded: boolean;
  /**
   * This state-machine receipt has authorized a fresh next provider request.
   * False on skip (wait and re-evaluate) and while host validation is still
   * awaiting. **Never false merely because a condition degraded** — a stranded
   * session is the one outcome this contract does not permit.
   *
   * **Does not cancel an already in-flight transport retry.** For
   * `transport_retry` skips, this means the compact-continuation machine has
   * not authorized a *new* governed request; the in-flight retry proceeds under
   * transport rules alone.
   *
   * **Does not claim the host provider body was validated inside LHC.** While
   * host validation is `awaiting`, this stays false until the host records an
   * acknowledgment. A `failed` acknowledgment degrades rather than blocks.
   */
  nextProviderRequestAllowed: boolean;
  /** Durable relief path classification for this attempt. */
  reliefPath: CompactContinuationReliefPath;
  /**
   * Sorted protected tool-call IDs for pending-tool / escalated paths; empty
   * when not applicable.
   */
  protectedToolCallIds: string[];
  /** Visibility boundary before core install; null when unchanged/not advanced. */
  visibilityBoundaryBefore: number | null;
  /** Visibility boundary after core install; null when unchanged/not advanced. */
  visibilityBoundaryAfter: number | null;
  /** Compact point of the prepared/installed view (for boundary effect). */
  /**
   * Host validation residual. `not_required` when the path does not need
   * post-install host body validation. LHC never sets `ok` for a body it did
   * not receive acknowledgment for.
   */
  hostValidationStatus: "not_required" | "awaiting" | "ok" | "failed";
  /**
   * True when a successful core install remains installed but the next request
   * is still waiting on a host validation acknowledgment.
   */
  coreInstallRetainedPendingHostValidation: boolean;
};

/** Bounded compact/install retry accounting for this seam. */
export type CompactContinuationRetryReceipt = {
  /** 1-based index of the compact/install attempt this receipt classifies. */
  attemptIndex: number;
  /** Effective bounded retry budget (policy value, clamped to at least 1). */
  budget: number;
  /**
   * True when a failed compact/install may be retried at the next eligible
   * seam. False when no attempt failed, or when the budget is spent and the
   * session continues on its current body.
   */
  retryAuthorized: boolean;
};

export type CompactContinuationReceipt = {
  /**
   * Oracle contract version that produced this receipt (`2.0.0`).
   * For `unsupported_contract_version`, this is still the oracle version that
   * classified the refuse — not acceptance of the input version. The rejected
   * input version appears only in `reasonCode` / refuse reason text.
   */
  contractVersion: typeof COMPACT_CONTINUATION_CONTRACT_VERSION;
  outcome: CompactContinuationOutcomeKind;
  reasonCode: string;
  /** Set when a continuation turn boundary was forced (success or post-boundary failure). */
  turnEndReason: typeof CONTEXT_COMPACT_CONTINUE_REASON | null;
  pressure: CompactContinuationPressureReceipt;
  lowerTarget: CompactContinuationLowerTargetReceipt;
  fidelity: "full" | "degraded";
  degradationReasons: string[];
  /**
   * Closed, ordered list of conditions that degraded this seam instead of
   * stopping it. Derived from the `warn` effects in `effects`, same order.
   * Empty on a clean seam.
   */
  warnings: CompactContinuationWarning[];
  /** Bounded compact/install retry accounting. */
  retry: CompactContinuationRetryReceipt;
  continuation: {
    /**
     * Exactly one continuation turn opened (via atomic force_turn_end), or
     * already open from a pending forced boundary on repair.
     */
    opened: boolean;
    markerServed: boolean;
    sameAgenticTurnPreserved: boolean;
  };
  /** Durable path vocabulary (normal preserve / protected escalation / …). */
  reliefPath: CompactContinuationReliefPath;
  /** Sorted protected tool-call IDs when pending-tool path applies. */
  protectedToolCallIds: string[];
  /**
   * Ordered effects the runtime applied or attempted on this seam, including
   * post-claim failures (claim + attempted stages + refuse + receipt + release).
   */
  effects: CompactContinuationEffect[];
  residual: CompactContinuationResidualState;
  /** Always false in this contract version — the refuse set is empty (CX-S5). */
  refused: boolean;
  /** Always null in this contract version — the refuse set is empty (CX-S5). */
  refuseCode: CompactContinuationRefuseCode | null;
  skipped: boolean;
  skipCode: CompactContinuationSkipCode | null;
  /**
   * Transition path through named states (documentation + parity).
   * Always starts with `at_seam` or a skip/refuse that never entered it.
   */
  transitionPath: CompactContinuationState[];
};

// ── Decision ─────────────────────────────────────────────────────────────────

export type CompactContinuationDecision = {
  outcome: CompactContinuationOutcomeKind;
  terminalState: CompactContinuationState;
  transitionPath: CompactContinuationState[];
  effects: CompactContinuationEffect[];
  receipt: CompactContinuationReceipt;
};

// ── Transition ordering (normative) ──────────────────────────────────────────

/**
 * Normative evaluation order at a candidate seam. Hosts execute stages in this
 * order; the pure oracle classifies the completed seam for parity/receipts.
 *
 * 1. Seam eligibility — settled seam only; never inside transport retry (skips).
 * 2. Forced-boundary state legality — an unusable applied boundary is discarded
 *    (warn) and the seam starts fresh; it is never a stop.
 * 3. Writer exclusivity — a `native`/`conflict` row is resolved by host
 *    ownership authority: reclaim the stale row when no live owner holds the
 *    thread, otherwise continue this attempt's current request.
 * 4. Capture / identity / open-turn proofs — each failure warns and continues.
 *    Unprovable tool correlation or an invalid protected pair set declines into
 *    the host's ordinary settled-seam compact on canonical state.
 * 5. Authoritative provider usage — missing/invalid ⇒ continue_normal without
 *    inventing pressure (no upper trigger fire).
 * 6. Pressure = provider base + source-labelled estimate (estimate not relabelled).
 * 7. Branch on pressure × work-continuation kind.
 * 8. Active non-tool: force turn boundary **before** compact so the just-closed
 *    turn is eligible; one turn_end closes prior and opens one continuation turn.
 *    Repair supplies `forcedContinuationBoundary` as
 *    `{ applied: true, continuationTurnId, forcedThisSeam: false,
 *    markerAlreadyPersisted }` and skips re-forcing.
 * 9. Compact (closed history) with degraded-derivation tolerance; lower target
 *    is not a success gate. Fidelity degradation is classified at assembly.
 * 10. Preserve tool pair / insert marker / install serving view. An unsafe
 *     projected runway and an unproven provider request both warn and install.
 * 11. Bounded retry or decline — a failed compact/install retries within budget,
 *     then continues on the current body. Neither strands.
 * 12. Record durable receipt (not user chat); release writer.
 *
 * ### Residual state after post-claim failure / skip with pending boundary
 * - **tool-preserve** compact/install failure: original agentic turn remains
 *   open; prior serving view intact; no marker; writer released; the next
 *   provider request proceeds on the current body.
 * - **active non-tool** compact failure **after** forced boundary (before
 *   this attempt's marker): boundary durable; `markerPersisted` reflects
 *   residual state (`markerAlreadyPersisted` or false when none yet);
 *   markerServed=false; prior view intact; writer released; boundary repairable
 *   at the next seam while the session continues.
 * - **active non-tool** install failure **after** successful compact: marker
 *   is persisted (`markerPersisted=true`, `markerServed=false`); no
 *   `install_serving_view`; prior view intact; boundary durable; repair
 *   recoverable; writer released.
 * - **preserve-tool** install failure (install attempt reached): effects
 *   include `preserve_tool_pair_verbatim` before the failure warning; no
 *   marker; original turn open; prior view intact; writer released.
 * - **install failure** always wins over `no_reduction` classification.
 *   `usefulReduction` is evaluated only after successful install.
 * - **Settled-seam decline** with `writerClaim: "lhc"`: effects record
 *   idempotent `claim_writer` and final `release_writer` when residual
 *   `writerReleased` is true. Never claim/release native/conflict.
 * - **Skip**: `nextProviderRequestAllowed=false` (wait and re-evaluate). Does
 *   not cancel an in-flight transport retry. Pending-boundary residual fields
 *   remain truthful on skip.
 * - **Repair/retry**: `forcedContinuationBoundary` with
 *   `{ applied: true, forcedThisSeam: false, markerAlreadyPersisted }` takes
 *   precedence over fresh pressure; do not duplicate the boundary; reassert
 *   marker by idempotency key; residual `markerPersisted` is residual-state
 *   truthful across repair; retry install.
 */
export const COMPACT_CONTINUATION_TRANSITION_ORDER = [
  "seam_eligibility",
  /**
   * Forced-boundary state + continuation-kind legality. Runs **before**
   * writer/capture proofs. An applied boundary with the wrong continuation
   * kind, an empty turn id, or a contradictory fresh-force marker claim is
   * discarded (warn) rather than refused; the seam then starts fresh.
   */
  "forced_boundary_state_legality",
  /**
   * Writer claim, including stale-row reclaim gated on host ownership
   * authority. A live owner means this attempt continues its current request.
   */
  "writer_claim",
  "capture_identity_correlation",
  "provider_usage_authority",
  "pressure_evaluation",
  "continuation_branch",
  "force_boundary_if_continue_turn",
  "compact_assembly",
  "install_or_preserve",
  /** Bounded compact/install retry, or decline into the ordinary compact path. */
  "bounded_retry_or_decline",
  "receipt_and_release",
] as const;

export type CompactContinuationTransitionStep = (typeof COMPACT_CONTINUATION_TRANSITION_ORDER)[number];

// ── Invariants (normative, prose + machine-checkable) ────────────────────────

export const COMPACT_CONTINUATION_INVARIANTS = [
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
] as const;

export type CompactContinuationInvariantId = (typeof COMPACT_CONTINUATION_INVARIANTS)[number];

// ── Closed-shape parity ──────────────────────────────────────────────────────

/**
 * v1 JSON inputs are **closed-shape**: TypeScript and Rust must reject unknown
 * fields at every contract-owned input object and discriminated-union branch
 * (`deny_unknown_fields` equivalent). Receipt validators may be extended to
 * full closed-shape in the Rust port story; input closure is mandatory now.
 */
export const COMPACT_CONTINUATION_INPUT_CLOSED_SHAPE = true as const;

/**
 * Rust ports: naive `#[serde(deny_unknown_fields)]` on internally-tagged or
 * boolean-discriminated enums does **not** enforce per-variant closed shape.
 * Use per-variant closed structs and/or custom validation equivalent to the
 * TypeScript validator and parity tests.
 */
export const COMPACT_CONTINUATION_RUST_CLOSED_UNION_NOTE =
  "per-variant closed structs required; deny_unknown_fields on enum derive is insufficient" as const;

/**
 * Shared context mutation/materialization operation for manual compact, manual
 * prune, and automatic compact. One fenced pass: prune-if-due, preview,
 * compact, served view, ONE rebuilt rollout. Compact plus a due prune is one
 * materialization and (in the wrapper) one handoff, never two.
 *
 * This module owns no processes: no child lifecycle, no descriptor writes, no
 * lineage persistence, no respawn. It returns a HandoffRequest for the wrapper
 * lifecycle manager. Success lineage is registered by the wrapper only after
 * the replacement generation is proven ready-after-replay.
 */

import { readFile } from "node:fs/promises";

import type { Band, CompactReceipt, Lhc, PruneReceipt, ThreadRef } from "lhc";
import { NO_STORED_VIEW_FINGERPRINT } from "../governor/recovery.js";
import { CAPTURE_NOT_READY_REFUSAL } from "../intake/session.js";
import { statRolloutFile } from "../rollout/stat-file.js";
import { type WriteRebuiltRolloutResult, writeRebuiltRollout } from "../rollout/write-rebuilt.js";
import {
  CAPTURE_DEGRADED_REFUSAL,
  CAPTURE_PARTIAL_VIEW_MUTATION,
  type LhcCommandRuntime,
  TURN_OPEN_REFUSAL,
} from "./dispatch.js";
import { threadIdFromRef } from "./rebuild-receipt.js";
import {
  inspectRolloutBytes,
  observeCurrentStoredView,
  type RecoveryPort,
  type RolloutVerificationArtifacts,
} from "./recovery-ops.js";

export const INPUT_ARRIVED_REFUSAL = "input arrived — context mutation cancelled before any change";
export const INPUT_ARRIVED_PARTIAL =
  "input arrived after LHC view mutation — no session handoff; live Claude session unchanged";

export type ContextMutationOperation = "compact" | "prune" | "auto_compact";
export type ContextMutationOrigin = "auto" | "manual";

/**
 * Metric provenance labels (LIM-80 Slice 4). Each governor/receipt measure names its
 * SOURCE so the three are never conflated or double-counted: the trigger's
 * next-request pressure (provider-reported total + accepted host-canonical estimate),
 * the SDK compact-receipt rendered-view total, and the SDK prune-zone measure. Only
 * the trigger measure drives auto-compact; view/zone are execution/receipt-only and
 * never feed the trigger nor infer post-compact provider pressure.
 */
export const SDK_VIEW_TOKENS_SOURCE = "sdk_compact_receipt_view_tokens";
export const SDK_ZONE_TOKENS_SOURCE = "sdk_prune_zone_tokens";
export type SdkViewTokensSource = typeof SDK_VIEW_TOKENS_SOURCE;
export type SdkZoneTokensSource = typeof SDK_ZONE_TOKENS_SOURCE;

/** Metrics behind the durable receipt and the panel's last-action line. Each measure
 * is DISTINCT and carries a machine-readable `*Source` field naming its provenance —
 * the trigger pressure (provider total + accepted LHC canonical-payload estimate), the
 * SDK compact-receipt rendered view, and the SDK prune-zone. The receipt renders them
 * as separate fields and never equates them; view/zone never feed the trigger. */
export interface ContextMutationMetrics {
  origin: ContextMutationOrigin;
  /** Trigger next-request pressure (provider total + accepted LHC canonical-payload estimate). */
  triggerContextTokens?: number;
  /** Source of {@link ContextMutationMetrics.triggerContextTokens}; set whenever it is present. */
  triggerPressureSource?: string;
  /** Rebuilt LHC served-view size from the SDK compact receipt. */
  viewTokens?: number;
  /** Source of {@link ContextMutationMetrics.viewTokens}; set whenever it is present. */
  viewTokensSource?: SdkViewTokensSource;
  /** Configured SDK lower target. */
  targetTokens?: number;
  /** SDK prune-zone (tool-result) tokens before/after. Never a trigger input. */
  zoneTokensBefore?: number;
  zoneTokensAfter?: number;
  /** Source of the SDK prune-zone measures; set whenever the zone values are present. */
  zoneTokensSource?: SdkZoneTokensSource;
}

export interface HandoffRequest {
  operation: ContextMutationOperation;
  oldSessionId: string;
  threadId: string;
  rebuilt: WriteRebuiltRolloutResult;
  /** Receipt lines describing the SDK mutation (for logs/panel). */
  receiptLines: string[];
  /** The ONE durable runtime note appended to the rebuilt rollout. */
  durableReceipt: string;
  metrics: ContextMutationMetrics;
}

/** Compact token display for receipts: 247k / 8.2k / 941. A pure DISPLAY shortener
 * only — it does not imply the values it formats are the same measure. Provider
 * trigger pressure, the SDK rendered-view total, and the SDK prune-zone tokens are
 * distinct sources (see the *_SOURCE labels) and are rendered as separate fields. */
export function formatTokensShort(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * Exactly one concise durable receipt, labeled operation:origin. "Trigger
 * context" is Claude host context (includes system/tool overhead); "LHC view"
 * is the SDK-served size — the receipt never implies they are the same measure.
 */
export function formatDurableReceipt(operation: ContextMutationOperation, metrics: ContextMutationMetrics): string {
  const label = operation === "prune" ? "prune" : "compact";
  const parts: string[] = [];
  if (metrics.triggerContextTokens !== undefined) {
    const source = metrics.triggerPressureSource === undefined ? "" : ` [source=${metrics.triggerPressureSource}]`;
    parts.push(`trigger context ${formatTokensShort(metrics.triggerContextTokens)}${source}`);
  }
  if (metrics.zoneTokensBefore !== undefined && metrics.zoneTokensAfter !== undefined) {
    const source = metrics.zoneTokensSource === undefined ? "" : ` [source=${metrics.zoneTokensSource}]`;
    parts.push(
      `tool-result zone ${formatTokensShort(metrics.zoneTokensBefore)} -> ${formatTokensShort(metrics.zoneTokensAfter)}${source}`,
    );
  }
  if (metrics.viewTokens !== undefined) {
    const target = metrics.targetTokens !== undefined ? ` (${formatTokensShort(metrics.targetTokens)} target)` : "";
    const source = metrics.viewTokensSource === undefined ? "" : ` [source=${metrics.viewTokensSource}]`;
    parts.push(`rebuilt LHC view ${formatTokensShort(metrics.viewTokens)}${target}${source}`);
  }
  return `[lhc ${label}:${metrics.origin}] ${parts.join("; ")}.`;
}

export interface ContextMutationPlan {
  operation: ContextMutationOperation;
  /** Canonical SDK profile for compact construction (compact operations). */
  profile: string;
  /** Configured SDK lower target, passed as params.lowerBound. */
  lowerBoundTokens: number;
  /**
   * Combined compact-time prune: when the tool-result zone is at/above
   * thresholdTokens, prune to targetTokens before compacting. One rebuild.
   */
  pruneIfDue?: { thresholdTokens: number; targetTokens: number };
  /** Manual prune target (operation "prune" only). */
  manualPruneTargetTokens?: number;
  /** Provider context that triggered an automatic operation (receipt detail). */
  triggerContextTokens?: number;
  /** Exact source carried from the governor pressure receipt. */
  triggerPressureSource?: string;
  /**
   * True when user input arrived since the operation started. Checked at every
   * fence; a pre-SDK trip refuses, a post-SDK trip reports partial (view
   * mutated, no handoff).
   */
  inputEpochChanged?: () => boolean;
}

/**
 * Recovery disposition for the automatic (recovery-port) path (LIM-80 Slice 3A).
 * Lets the wrapper decide terminal-vs-open WITHOUT parsing message text:
 *
 *  - `retryable_pre_mutation`     nothing durable changed (unreadable baseline,
 *                                 pre-compact fence/input race, preview/compact
 *                                 failure, a port write that threw before compact).
 *                                 Safe to re-run the mutation; the attempt stays open.
 *  - `recoverable_post_mutation`  the SDK view was installed and/or a rollout was
 *                                 written but the operation did not finish. Must be
 *                                 re-planned from durable facts, NEVER re-compacted.
 *  - `terminal_noop`              a genuine no-op (nothing to do), permanent.
 *  - `terminal_refused`           an explicit permanent capability refusal
 *                                 (capture disabled). No retry.
 *
 * Absent on the manual path (no recoveryPort): manual behavior is byte-for-byte
 * unchanged and never carries a disposition.
 */
export type MutationDisposition =
  | "retryable_pre_mutation"
  | "recoverable_post_mutation"
  | "terminal_noop"
  | "terminal_refused";

export type ContextMutationOutcome =
  | { kind: "refused"; messages: string[]; disposition?: MutationDisposition }
  | { kind: "noop"; messages: string[]; disposition?: MutationDisposition }
  /** SDK view mutated but fence tripped afterwards: no rebuild handoff. */
  | { kind: "partial"; messages: string[]; disposition?: MutationDisposition }
  | { kind: "rebuilt"; messages: string[]; handoff: HandoffRequest };

function formatBandSummary(receipt: CompactReceipt): string {
  const bands: Band[] = ["smooth", "detailed", "brief"];
  const parts: string[] = [];
  for (const band of bands) {
    const stats = receipt.bands[band];
    if (stats.entries > 0 || stats.tokens > 0) {
      parts.push(`${band}=${stats.tokens}tok/${stats.entries}entries`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : "no bands";
}

export function formatCompactReceipt(receipt: CompactReceipt): string {
  return [
    `compact view=${receipt.viewId} tail=${receipt.tailTokens} total=${receipt.totalTokens}`,
    formatBandSummary(receipt),
  ].join("\n");
}

export function formatPruneReceipt(receipt: PruneReceipt): string {
  return [
    `prune boundary ${receipt.previousBoundary} -> ${receipt.newBoundary}`,
    `zone tokens ${receipt.zoneTokensBefore} -> ${receipt.zoneTokensAfter}`,
    `tool_results_pruned=${receipt.toolResultsPruned}`,
    receipt.noOp ? "no-op" : "applied",
  ].join("\n");
}

export function notReadyOutcome(runtime: LhcCommandRuntime): ContextMutationOutcome | null {
  if (runtime.captureDisabled) return { kind: "refused", messages: ["capture disabled"] };
  if (runtime.sdk === undefined || runtime.threadRef === undefined) {
    return { kind: "refused", messages: ["capture not ready"] };
  }
  return null;
}

/**
 * The shared mutation fence: turn closed, capture ready and healthy, capture
 * generation unchanged since the operation leased it, no input since start.
 */
export function mutationFence(
  runtime: LhcCommandRuntime,
  leaseGeneration: number,
  inputEpochChanged?: () => boolean,
): string | null {
  if (runtime.isTurnOpen?.() === true) return TURN_OPEN_REFUSAL;
  if (runtime.isCaptureReady?.() === false) {
    if (runtime.capturePhase === "binding") return CAPTURE_NOT_READY_REFUSAL;
    return CAPTURE_DEGRADED_REFUSAL;
  }
  if (runtime.isCaptureHealthy?.() === false || runtime.captureDegraded === true) {
    return CAPTURE_DEGRADED_REFUSAL;
  }
  const currentGen = runtime.getCaptureGeneration?.() ?? runtime.captureGeneration;
  if (currentGen !== undefined && currentGen !== leaseGeneration) {
    return CAPTURE_DEGRADED_REFUSAL;
  }
  if (inputEpochChanged?.() === true) return INPUT_ARRIVED_REFUSAL;
  return null;
}

/**
 * Run the fenced SDK mutation and single materialization. On success the
 * caller (wrapper) owns the handoff; on partial the view mutated but no
 * rebuild/handoff happened; on refused nothing changed.
 */
function recoveryDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Whole-file structural verification of a freshly written rebuilt rollout,
 * used only on the recovery-port path. Returns the verification identities or
 * null when the file could not be read/verified (recordRolloutWritten is then
 * skipped and restart recovers via the reserved id).
 */
async function verifyWrittenRollout(
  rebuilt: WriteRebuiltRolloutResult,
  reservedSessionId: string,
  durableReceipt: string,
): Promise<RolloutVerificationArtifacts | null> {
  let buf: Buffer;
  try {
    buf = await readFile(rebuilt.rolloutPath);
  } catch {
    return null;
  }
  const inspected = inspectRolloutBytes(buf, {
    reservedSessionId,
    rebuiltRolloutPath: rebuilt.rolloutPath,
    durableReceipt,
  });
  return inspected.kind === "ok" ? inspected.verification : null;
}

/**
 * Classify a non-rebuilt outcome into a recovery disposition (typed, never from
 * message text). The invariant `refused ⟺ nothing durable mutated` and
 * `partial ⟺ the SDK view was mutated` makes the kind authoritative:
 *   refused → retryable_pre_mutation (unless capture is permanently disabled),
 *   partial → recoverable_post_mutation, noop → terminal_noop.
 */
function classifyDisposition(kind: "refused" | "noop" | "partial", runtime: LhcCommandRuntime): MutationDisposition {
  if (kind === "noop") return "terminal_noop";
  if (kind === "partial") return "recoverable_post_mutation";
  return runtime.captureDisabled ? "terminal_refused" : "retryable_pre_mutation";
}

export async function runContextMutation(
  plan: ContextMutationPlan,
  runtime: LhcCommandRuntime,
  /**
   * Optional recovery boundary (LIM-80). When supplied (auto-compact path), the
   * durable attempt records baseline → view_installed → reservation →
   * rollout_written around the compact, and the returned non-rebuilt outcome
   * carries a typed `disposition` so the wrapper can leave transient/recoverable
   * failures OPEN (retry/re-plan) and complete only proven-terminal results.
   * Absent for ordinary manual compact/prune — that path is byte-for-byte
   * unchanged (no extra SDK calls, no port writes, no disposition).
   */
  recoveryPort?: RecoveryPort,
): Promise<ContextMutationOutcome> {
  const outcome = await runContextMutationImpl(plan, runtime, recoveryPort);
  if (recoveryPort === undefined || outcome.kind === "rebuilt") return outcome;
  return { ...outcome, disposition: classifyDisposition(outcome.kind, runtime) };
}

async function runContextMutationImpl(
  plan: ContextMutationPlan,
  runtime: LhcCommandRuntime,
  recoveryPort?: RecoveryPort,
): Promise<ContextMutationOutcome> {
  const blocked = notReadyOutcome(runtime);
  if (blocked !== null) return blocked;

  const leaseGeneration = runtime.getCaptureGeneration?.() ?? runtime.captureGeneration ?? 0;
  const fence = (): string | null => mutationFence(runtime, leaseGeneration, plan.inputEpochChanged);

  const fenced = fence();
  if (fenced !== null) return { kind: "refused", messages: [fenced] };

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const threadId = threadIdFromRef(threadRef);
  const lines: string[] = [];
  let viewMutated = false;
  const metrics: ContextMutationMetrics = {
    origin: plan.operation === "auto_compact" ? "auto" : "manual",
    ...(plan.triggerContextTokens === undefined
      ? {}
      : {
          triggerContextTokens: plan.triggerContextTokens,
          ...(plan.triggerPressureSource === undefined ? {} : { triggerPressureSource: plan.triggerPressureSource }),
        }),
  };

  const partialOrRefused = (fenceMessage: string): ContextMutationOutcome => {
    if (!viewMutated) return { kind: "refused", messages: [...lines, fenceMessage] };
    const partialNote = fenceMessage === INPUT_ARRIVED_REFUSAL ? INPUT_ARRIVED_PARTIAL : CAPTURE_PARTIAL_VIEW_MUTATION;
    return { kind: "partial", messages: [...lines, partialNote] };
  };

  if (plan.operation === "prune") {
    const pruneResult = await sdk.threadView.prune(
      threadRef,
      plan.manualPruneTargetTokens === undefined ? {} : { targetTokens: plan.manualPruneTargetTokens },
    );
    if (!pruneResult.ok) return { kind: "refused", messages: [`prune error: ${pruneResult.error.reason}`] };
    const receipt = pruneResult.value;
    lines.push(formatPruneReceipt(receipt));
    if (receipt.noOp) return { kind: "noop", messages: lines };
    metrics.zoneTokensBefore = receipt.zoneTokensBefore;
    metrics.zoneTokensAfter = receipt.zoneTokensAfter;
    metrics.zoneTokensSource = SDK_ZONE_TOKENS_SOURCE;
    viewMutated = true;
    const afterPrune = fence();
    if (afterPrune !== null) return partialOrRefused(afterPrune);
  } else {
    // Compact path (manual or automatic): combined prune first when due.
    if (recoveryPort !== undefined) {
      // Record the baseline before ANY served-view mutation in this operation,
      // including an optional due-prune. A failed observation or store write is
      // therefore truthfully pre-mutation and safe to retry.
      const baseline = await observeCurrentStoredView(sdk, threadRef);
      if (baseline.kind === "unreadable") {
        return {
          kind: "refused",
          messages: [`recovery baseline unreadable (${baseline.reason}); no mutation started`],
        };
      }
      recoveryPort.recordBaseline(baseline.kind === "none" ? NO_STORED_VIEW_FINGERPRINT : baseline.fingerprint);
    }
    if (plan.pruneIfDue !== undefined) {
      const status = await sdk.threadView.status(threadRef);
      const afterStatus = fence();
      if (afterStatus !== null) return partialOrRefused(afterStatus);
      if (status.ok && status.value.visibility.zoneTokens >= plan.pruneIfDue.thresholdTokens) {
        const pruneResult = await sdk.threadView.prune(threadRef, {
          targetTokens: plan.pruneIfDue.targetTokens,
        });
        if (pruneResult.ok) {
          if (!pruneResult.value.noOp) {
            viewMutated = true;
            metrics.zoneTokensBefore = pruneResult.value.zoneTokensBefore;
            metrics.zoneTokensAfter = pruneResult.value.zoneTokensAfter;
            metrics.zoneTokensSource = SDK_ZONE_TOKENS_SOURCE;
          }
          lines.push(formatPruneReceipt(pruneResult.value));
        } else {
          // A failed due-prune does not abort the compact; it is reported.
          lines.push(`prune error: ${pruneResult.error.reason}`);
        }
        const afterDuePrune = fence();
        if (afterDuePrune !== null) return partialOrRefused(afterDuePrune);
      }
    }

    const compactOpts = {
      profile: plan.profile,
      params: { lowerBound: plan.lowerBoundTokens },
    };
    const preview = await sdk.threadView.previewCompact(threadRef, compactOpts);
    const afterPreview = fence();
    if (afterPreview !== null) return partialOrRefused(afterPreview);
    if (!preview.ok) {
      return viewMutated
        ? { kind: "partial", messages: [...lines, `compact preview error: ${preview.error.reason}`] }
        : { kind: "refused", messages: [`compact preview error: ${preview.error.reason}`] };
    }
    if (preview.value.kind === "error") {
      return viewMutated
        ? { kind: "partial", messages: [...lines, `compact blocked: ${preview.value.reason}`] }
        : { kind: "refused", messages: [`compact blocked: ${preview.value.reason}`] };
    }

    const compactResult = await sdk.threadView.compact(threadRef, compactOpts);
    if (recoveryPort !== undefined && compactResult.ok) {
      // The SDK compact installed a view: it is mutated regardless of what
      // follows. Record view_installed BEFORE the post-compact fence, requiring
      // a fresh present observation whose viewId equals the compact receipt.
      // Any unreadable/none/mismatch, or a recordViewInstalled failure, is a
      // truthful partial with no rollout write/handoff — never a throw. The
      // durable baseline lets a restart recover the install.
      viewMutated = true;
      const installed = await observeCurrentStoredView(sdk, threadRef);
      if (installed.kind !== "present" || installed.viewId !== compactResult.value.viewId) {
        return {
          kind: "partial",
          messages: [
            ...lines,
            "LHC view installed but view_installed not recorded (view unreadable/none/id mismatch) — restart recovers via baseline",
          ],
        };
      }
      try {
        recoveryPort.recordViewInstalled({ viewId: installed.viewId, installedViewFingerprint: installed.fingerprint });
      } catch (cause) {
        return {
          kind: "partial",
          messages: [
            ...lines,
            `LHC view installed but view_installed record failed (${recoveryDetail(cause)}) — restart recovers via baseline`,
          ],
        };
      }
    }
    const afterCompact = fence();
    if (afterCompact !== null) {
      viewMutated = true;
      return partialOrRefused(afterCompact);
    }
    if (!compactResult.ok) {
      return viewMutated
        ? { kind: "partial", messages: [...lines, `compact error: ${compactResult.error.reason}`] }
        : { kind: "refused", messages: [`compact error: ${compactResult.error.reason}`] };
    }
    viewMutated = true;
    metrics.viewTokens = compactResult.value.totalTokens;
    metrics.viewTokensSource = SDK_VIEW_TOKENS_SOURCE;
    metrics.targetTokens = plan.lowerBoundTokens;
    lines.push(formatCompactReceipt(compactResult.value));
  }

  // ONE served-view read and ONE rebuilt rollout for the whole operation.
  const view = await sdk.threadView.getSessionThreadView(threadRef);
  const afterView = fence();
  if (afterView !== null) return partialOrRefused(afterView);
  if (!view.ok) return { kind: "partial", messages: [...lines, `view error: ${view.error.reason}`] };

  try {
    if (runtime.sourceRolloutPath !== undefined) {
      await statRolloutFile(runtime.sourceRolloutPath);
    }
    const afterStat = fence();
    if (afterStat !== null) return partialOrRefused(afterStat);

    const durableReceipt = formatDurableReceipt(plan.operation, metrics);
    // Reserve + persist the rebuilt session id/path (with the receipt) BEFORE
    // the write, so a crash during the write is discoverable by that id.
    const reserved = recoveryPort?.reserveRebuiltSession(durableReceipt);
    const rebuilt = await writeRebuiltRollout({
      view: view.value,
      cwd: runtime.cwd,
      ...(reserved === undefined ? {} : { newSessionId: reserved.sessionId }),
      ...(runtime.sourceRolloutPath === undefined ? {} : { sourceRolloutPath: runtime.sourceRolloutPath }),
      receipt: { text: durableReceipt },
    });
    if (recoveryPort !== undefined) {
      // (3) The written path must equal the durable reservation.
      if (reserved !== undefined && rebuilt.rolloutPath !== reserved.rolloutPath) {
        return {
          kind: "partial",
          messages: [
            ...lines,
            `rebuilt rollout path ${rebuilt.rolloutPath} does not equal reserved ${reserved.rolloutPath} — no handoff`,
          ],
        };
      }
      // (4) rollout_written is mandatory on the recovery path: only a file that
      // passes whole-file structural verification AND a successful record may
      // reach kind=rebuilt. Anything else is a truthful partial with no handoff.
      const verification = await verifyWrittenRollout(
        rebuilt,
        reserved?.sessionId ?? rebuilt.sessionId,
        durableReceipt,
      );
      if (verification === null) {
        return {
          kind: "partial",
          messages: [...lines, "rebuilt rollout could not be read/structurally verified — no handoff"],
        };
      }
      try {
        recoveryPort.recordRolloutWritten(verification);
      } catch (cause) {
        return {
          kind: "partial",
          messages: [...lines, `rollout_written record failed (${recoveryDetail(cause)}) — no handoff`],
        };
      }
    }
    const afterRebuild = fence();
    if (afterRebuild !== null) {
      return {
        kind: "partial",
        messages: [
          ...lines,
          afterRebuild === INPUT_ARRIVED_REFUSAL ? INPUT_ARRIVED_PARTIAL : CAPTURE_PARTIAL_VIEW_MUTATION,
          "rebuild discarded from operator-ready state — live session unchanged",
        ],
      };
    }

    return {
      kind: "rebuilt",
      messages: lines,
      handoff: {
        operation: plan.operation,
        oldSessionId: runtime.sourceSessionId ?? "unknown",
        threadId,
        rebuilt,
        receiptLines: [...lines],
        durableReceipt,
        metrics,
      },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "partial",
      messages: [...lines, `rebuild failed: ${message}`, "session left running unchanged"],
    };
  }
}

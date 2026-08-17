import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { spawn as defaultSpawn, type IPty } from "@lydell/node-pty";

import {
  type ContextMutationPlan,
  formatDurableReceipt,
  formatTokensShort,
  type HandoffRequest,
  runContextMutation,
} from "../commands/context-mutation.js";
import { type DispatchOutcome, dispatchLhcCommand, type LhcCommandRuntime } from "../commands/dispatch.js";
import {
  formatRebuildRelaunchGuidance,
  registerRebuiltSessionLineage,
  threadIdFromRef,
} from "../commands/rebuild-receipt.js";
import {
  observeCurrentStoredView,
  type RecoveryPort,
  type RolloutVerificationArtifacts,
  recoverReservedRollout,
} from "../commands/recovery-ops.js";
import { createStoreBackedRecoveryPort, RecoveryPortCasError } from "../commands/recovery-port.js";
import {
  applyGovernorLifecycleBatch,
  type ContextPolicyPartial,
  createGovernorRuntimeState,
  formatGovernorObserveLogLine,
  type GovernorDurableReceipt,
  type GovernorHandoffOutcome,
  type GovernorMutationDeferReason,
  type GovernorReceiptStore,
  type GovernorRuntimeState,
  isTerminalHandoffOutcome,
  loadContextPolicy,
  noteGovernorInput,
  openGovernorReceiptStore,
  planRecovery,
  policySourcesSummary,
  projectConfigPath,
  type RecoveryAction,
  type RecoveryAttempt,
  type RecoveryObservation,
  type RecoveryStage,
  type ResolvedContextPolicy,
  recoveryStageIndex,
  setGovernorCaptureHealth,
  setGovernorDescriptorReady,
  setGovernorOperationInFlight,
  userConfigPath,
  validateContextPolicy,
} from "../governor/index.js";
import { killAllInferenceChildren } from "../inference/claude-cli.js";
import {
  LaunchGrammarError,
  resolveLaunchSession,
  respawnArgvSafety,
  respawnChildArgv,
} from "../intake/launch-session.js";
import { defaultLineageDbPath } from "../intake/lineage-db.js";
import { ccLhcHome, defaultRegistryPath } from "../intake/paths.js";
import { type CaptureSession, startCaptureSession } from "../intake/session.js";
import type { LifecycleSignal } from "../observation/types.js";
import { injectRetrievalGuidance } from "../retrieval/guidance.js";
import type { ExpectedSession } from "../rollout/expected-session.js";
import { applyClaudeRuntimeSettings, type ClaudeRuntimeSettings } from "../rollout/runtime-settings.js";
import {
  closeAndRemove,
  createOpeningDescriptor,
  type DescriptorIo,
  markDegraded,
  markReady,
  newDescriptorPath,
  type RevocationResult,
  RUNTIME_DESCRIPTOR_ENV,
  type RuntimeDescriptorV1,
  revokeCapability,
  revokeDescriptor,
} from "../runtime/descriptor.js";
import { probeProcessIdentityNative } from "../runtime/native-identity.js";
import {
  identitiesEqual,
  type ProbeProcessIdentity,
  type ProcessIdentity,
  ProcessIdentityUnavailableError,
  type ProcessLivenessResult,
} from "../runtime/process-identity.js";
import {
  acquireSessionOwner,
  type SessionOwnerLease,
  SessionOwnershipConflictError,
} from "../runtime/session-owner.js";
import { emptyCaptureStats, formatCaptureStatsLine } from "../stats.js";
import { forceKillChildTree, requestPtyTermination, runTaskkillTree } from "./child-termination.js";
import { CommandInFlightGuard, formatBusyMessage } from "./command-guard.js";
import {
  DEFAULT_CAPTURE_READY_TIMEOUT_MS,
  DEFAULT_CHILD_LIVENESS_TIMEOUT_MS,
  DEFAULT_CHILD_STABLE_WINDOW_MS,
  executeHandoff,
  formatHandoffResult,
  type HandoffChild,
  type HandoffPorts,
  type HandoffRecoveryStagePort,
  type HandoffResult,
  type RecoveryArtifact,
} from "./handoff.js";
import { createInputDebugLogger } from "./input-debug.js";
import { createInputJournal, type InputJournal, removeInputJournal } from "./input-journal.js";
import {
  createInputState,
  finishExecuting,
  forceResetInput,
  type InputState,
  noteUntrackedDeliveredInput,
  processInputChunk,
  resolveBareEsc,
  resolveLeaderByte,
  showLateReceipts,
  showReceipts,
} from "./modal.js";
import { OutputHold } from "./output-hold.js";
import { createAltScreenGuard, renderPanel } from "./panel.js";
import { createWrapperLog, type WrapperLog } from "./wrapper-log.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = "xterm-256color";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Cap on pty output held while the modal is open. Claude keeps running while
 * we hold its bytes; a runaway stream must not grow unbounded, so past the
 * cap the modal is cancelled, a one-line notice printed, and everything
 * flushed.
 */
export const OUTPUT_HOLD_CAP_BYTES = 4 * 1024 * 1024;
export const OUTPUT_HOLD_OVERFLOW_MESSAGE = "output buffer full — command entry cancelled";
/**
 * How long a pending ESC may sit unresolved before it is ruled a bare Esc
 * keypress. Split escape sequences deliver their next byte within a few ms;
 * kitty-protocol terminals never send a bare ESC at all.
 */
export const PENDING_ESC_RESOLVE_MS = 50;

/**
 * What the panel shows when a command settles. Compact/prune no longer
 * auto-dismiss via in-app swap (retired on 2.1.226); receipts always stay
 * until the operator dismisses so relaunch guidance is visible.
 */
export function settleReceipts(outcomeMessages: string[]): string[] {
  return outcomeMessages;
}

export type PtySpawn = typeof defaultSpawn;

/**
 * Production default: terminate the wrapper process so OS process-identity
 * invalidates any unproven ready descriptor. Tests inject a no-op/recording seam.
 */
export type ForceWrapperExit = (code: number) => void;

export type RunOptions = {
  claudeBin?: string;
  spawnPty?: PtySpawn;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  noCapture?: boolean;
  noInference?: boolean;
  /** Test hook: substitute the wrapper log (defaults to ~/.cc-lhc/wrapper.log). */
  wrapperLog?: WrapperLog;
  /** Test hook: cap held pty output while the modal is open (defaults to 4 MiB). */
  outputHoldCapBytes?: number;
  /**
   * Injected wrapper-process termination. Default schedules `process.exit(code)`.
   * Tests must inject a non-exiting seam.
   */
  forceWrapperExit?: ForceWrapperExit;
  /**
   * Test hook: substitute descriptor filesystem/identity IO (publish, unlink, owner check).
   * Production uses the real defaultDescriptorIo.
   */
  descriptorIo?: DescriptorIo;
  /**
   * Session-scoped context policy overrides (not persisted). Highest merge
   * precedence after project config. Slice 3 remains observe-only regardless.
   */
  contextPolicyOverrides?: ContextPolicyPartial;
  /** Test hook: substitute resolved policy (skips filesystem load). */
  resolvedContextPolicy?: ResolvedContextPolicy;
  /** Test hook: inspect governor runtime state after lifecycle. */
  onGovernorObserve?: (record: import("../governor/index.js").GovernorObserveRecord) => void;
  /**
   * Test hook: durable governor receipt store path (defaults to lineage DB under CC_LHC_HOME).
   * Pass a temp path in tests to avoid shared ~/.cc-lhc pollution.
   */
  governorReceiptDbPath?: string;
  /**
   * Test hook: wrap the opened receipt store (inject append/attach failures after open).
   * Not used in production.
   */
  governorReceiptStoreHook?: (store: GovernorReceiptStore) => GovernorReceiptStore;
  /**
   * Test hook: inject a pre-configured command guard (e.g. already holding a flight)
   * so auto-compact can observe command_guard_busy terminalization.
   */
  commandGuard?: CommandInFlightGuard;
  /**
   * Test hook: run before auto operation claim. Can force handoffInProgress or
   * exited races (production never uses this). `clearHandoffInProgress` restores
   * so teardown is not stuck after the deferred gate. `markExited` sets the
   * wrapper-exiting flag so the early `wrapper_exiting` terminalization path is
   * reachable without a real process teardown race.
   */
  onBeforeAutoOperation?: (ports: {
    markHandoffInProgress: () => void;
    clearHandoffInProgress: () => void;
    markExited: () => void;
  }) => void;
  /** Test hook: observe controlled-handoff results (auto and manual). */
  onHandoffResult?: (result: HandoffResult) => void;
  /** Test hooks: handoff timing (SIGTERM grace, SIGKILL wait, capture-ready cap, liveness caps). */
  handoffTimeouts?: {
    sigtermGraceMs?: number;
    sigkillWaitMs?: number;
    captureReadyTimeoutMs?: number;
    childLivenessTimeoutMs?: number;
    childStableWindowMs?: number;
  };
  /** Test hook: recovery artifact directory (defaults to ~/.cc-lhc/recovery). */
  recoveryDir?: string;
  /**
   * Exact self/owner process identity probe (LIM-80). Defaults to the native
   * provider. Tests inject a deterministic probe to drive owner liveness
   * (live / not_found / indeterminate) for recovery.
   */
  readProcessIdentity?: ProbeProcessIdentity;
  /**
   * Test hook: projects root the concrete recovery port uses to compute reserved
   * rollout paths (defaults to ~/.claude/projects). Must match the path the
   * rollout writer produces so the reserved/written paths agree.
   */
  recoveryProjectsRoot?: string;
  /** Test hook: reserved rebuilt-session id mint (defaults to randomUUID). */
  recoverySessionIdFn?: () => string;
  /**
   * Test hook: suppress the `--autocompact <backstop>` child args (harnesses
   * spawn a generic fake child that rejects claude-only flags).
   */
  disableNativeBackstopArgs?: boolean;
  /** Disable the hazardous-command notifier for this launch (--lhc-no-notifier). */
  notifierDisabled?: boolean;
};

import { resolveClaudeBin } from "../shared/claude-bin.js";

export { resolveClaudeBin };

export function resizePty(pty: Pick<IPty, "resize">, cols: number, rows: number): void {
  pty.resize(cols, rows);
}

export function onTerminalResize(
  pty: Pick<IPty, "resize">,
  stdout: Pick<NodeJS.WriteStream, "columns" | "rows">,
): void {
  resizePty(pty, stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS);
}

/** Structural equality of two durable governor outcomes (small flat objects). */
function governorOutcomesEqual(a: GovernorHandoffOutcome, b: GovernorHandoffOutcome): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/** Map a controlled-handoff result to its durable governor outcome. Pure. */
function governorOutcomeFromHandoffResult(
  result: HandoffResult,
): Exclude<GovernorHandoffOutcome, { kind: "scheduled" }> {
  switch (result.kind) {
    case "success":
      return {
        kind: "handoff_success",
        newSessionId: result.newSessionId,
        flushedInputBytes: result.flushedInputBytes,
      };
    case "cancelled":
      return { kind: "handoff_cancelled", detail: result.reason };
    case "rolled_back":
      return { kind: "handoff_rolled_back", detail: result.reason, oldSessionId: result.oldSessionId };
    default:
      return {
        kind: "handoff_failed",
        detail: result.reason,
        oldSessionId: result.oldSessionId,
        rebuiltSessionId: result.rebuiltSessionId,
      };
  }
}

function restoreTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): void {
  if (stdin.isTTY) {
    stdin.setRawMode(false);
  }
  if (stdout.isTTY) {
    stdout.write(SHOW_CURSOR);
  }
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const claudeBin = options.claudeBin ?? resolveClaudeBin();
  const spawnPty = options.spawnPty ?? defaultSpawn;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const noCapture = options.noCapture === true;
  const noInference = options.noInference === true || process.env.CC_LHC_NO_INFERENCE === "1";
  const commandGuard = options.commandGuard ?? new CommandInFlightGuard();
  const forceWrapperExit: ForceWrapperExit =
    options.forceWrapperExit ??
    ((code: number) => {
      // Schedule after the current stack so cleanup can finish; really terminates.
      setImmediate(() => {
        process.exit(code);
      });
    });
  const descriptorIo = options.descriptorIo;

  // Doctrine: the wrapper NEVER writes raw bytes into a UI it does not own.
  // While the child owns the terminal, diagnostics go to the wrapper log
  // (surface (c)); `status` reports the warning count so nothing is lost.
  const wrapperLog = options.wrapperLog ?? createWrapperLog();

  // Slice 3: load context policy (observe-only). Invalid policy does not arm
  // automatic intent but leaves Claude/capture usable with a visible diagnostic.
  let resolvedContextPolicy: ResolvedContextPolicy =
    options.resolvedContextPolicy ??
    loadContextPolicy({
      cwd: process.cwd(),
      ...(options.contextPolicyOverrides !== undefined ? { sessionOverrides: options.contextPolicyOverrides } : {}),
    });
  if (!resolvedContextPolicy.armed) {
    for (const err of resolvedContextPolicy.errors) {
      wrapperLog.warn(`cc-lhc context policy: ${err}`);
    }
    wrapperLog.warn(
      "cc-lhc context policy: automatic policy not armed; observe reports policy_invalid; Claude/capture continue",
    );
  } else {
    wrapperLog.info(
      `cc-lhc context policy armed observeOnly=${resolvedContextPolicy.policy.observeOnly} autoCompact=${resolvedContextPolicy.policy.autoCompact} lower=${resolvedContextPolicy.policy.lowerBoundTokens} upper=${resolvedContextPolicy.policy.upperBoundTokens} profile=${resolvedContextPolicy.policy.profile} sources=${policySourcesSummary(resolvedContextPolicy.sources)}`,
    );
  }
  let governorState: GovernorRuntimeState = createGovernorRuntimeState();
  /** Most recent non-success outcome (health visibility; never claims success). */
  let lastAttempt: { summary: string; atMs: number } | null = null;
  /** Exact self/owner identity probe (LIM-80 recovery). */
  const readProcessIdentity: ProbeProcessIdentity = options.readProcessIdentity ?? probeProcessIdentityNative;
  /** Receipts with a recovery pass currently running (single-flight coalescing). */
  const recoveryInFlight = new Set<string>();
  /** Bounded recovery retry counters per receipt (no busy-loop). */
  const recoveryRetries = new Map<string, number>();
  /** Startup current-session scan runs at most once. */
  let startupRecoveryScanned = false;
  /** Durable LIM-64 observe/handoff receipts (SQLite; survives restart). */
  let governorReceiptStore: GovernorReceiptStore | null = null;
  try {
    const opened = openGovernorReceiptStore(options.governorReceiptDbPath ?? defaultLineageDbPath());
    governorReceiptStore =
      options.governorReceiptStoreHook !== undefined ? options.governorReceiptStoreHook(opened) : opened;
  } catch (cause) {
    wrapperLog.warn(
      `cc-lhc governor receipt store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  /**
   * Persist a classification. Returns the exact durable receipt when inserted or
   * when an exact replay hit an existing row. Open-turn may stay log-only if the
   * store is unavailable; settled wouldMutate must not mutate without a durable id.
   */
  const persistGovernorObserve = (
    record: import("../governor/index.js").GovernorObserveRecord,
  ): { receipt: GovernorDurableReceipt; inserted: boolean } | null => {
    if (governorReceiptStore === null) return null;
    try {
      const rollout = captureSession?.getRolloutInfo();
      const ctx = captureSession?.getCommandContext();
      return governorReceiptStore.appendObserve({
        observe: record,
        sessionId: rollout?.sessionId ?? null,
        threadId: ctx?.stats.threadId ?? null,
      });
    } catch (cause) {
      wrapperLog.warn(
        `cc-lhc governor receipt append failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  };
  /**
   * Attach outcome to the exact receipt id that scheduled the operation.
   * Never uses "latest wouldMutate" fallback — session identity can change
   * mid-handoff and manual compact must not mutate unrelated governor rows.
   *
   * Failures are always loud for a known receipt id (error log + lastAttempt):
   * a freshly inserted `scheduled` row that cannot be terminalized must not
   * go quiet even when mutation has not begun. Missing receipt id remains
   * loud only after mutation began (no durable row to recover).
   */
  const attachGovernorHandoffOutcome = (
    receiptId: string | null | undefined,
    outcome: GovernorHandoffOutcome,
    opts: { mutationBegan: boolean } = { mutationBegan: false },
  ): boolean => {
    const markUndurable = (summary: string, logLine: string): void => {
      wrapperLog.warn(logLine);
      lastAttempt = { summary, atMs: Date.now() };
    };
    if (receiptId === null || receiptId === undefined || receiptId === "") {
      if (opts.mutationBegan) {
        markUndurable(
          `receipt outcome undurable: missing receipt id (${outcome.kind})`,
          `cc-lhc governor receipt outcome NOT durable: missing receipt id for outcome ${outcome.kind}`,
        );
      }
      return false;
    }
    if (governorReceiptStore === null) {
      markUndurable(
        `receipt outcome undurable: store unavailable (${outcome.kind})`,
        `cc-lhc governor receipt outcome NOT durable: store unavailable for ${receiptId} outcome ${outcome.kind}`,
      );
      return false;
    }
    try {
      const updated = governorReceiptStore.attachHandoffOutcome(receiptId, outcome);
      if (updated === null) {
        markUndurable(
          `receipt outcome undurable: receipt missing (${outcome.kind})`,
          `cc-lhc governor receipt outcome NOT durable: receipt ${receiptId} not found for outcome ${outcome.kind}`,
        );
        return false;
      }
      return true;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      markUndurable(
        `receipt outcome undurable: attach failed (${outcome.kind})`,
        `cc-lhc governor receipt outcome NOT durable: attach failed for ${receiptId}: ${detail}`,
      );
      return false;
    }
  };

  /**
   * Complete an owned attempt AND attach the receipt's outcome atomically
   * (LIM-80). Replaces attachHandoffOutcome once an attempt exists: a restart
   * can never see a terminal receipt with a non-terminal attempt, or vice versa.
   * Loud on any non-completed store result (health + lastAttempt), so a stranded
   * `scheduled` receipt whose completion did not land stays inspectable.
   */
  const completeGovernorAttempt = (
    receiptId: string,
    attemptId: string,
    outcome: Exclude<GovernorHandoffOutcome, { kind: "scheduled" }>,
  ): boolean => {
    const markUndurable = (summary: string, logLine: string): void => {
      wrapperLog.warn(logLine);
      lastAttempt = { summary, atMs: Date.now() };
    };
    if (governorReceiptStore === null) {
      markUndurable(
        `attempt outcome undurable: store unavailable (${outcome.kind})`,
        `cc-lhc governor receipt outcome NOT durable: store unavailable for ${receiptId} outcome ${outcome.kind}`,
      );
      return false;
    }
    try {
      const result = governorReceiptStore.completeAttempt({ receiptId, attemptId, outcome });
      if (result.kind === "completed") return true;
      if (result.kind === "already_terminal") {
        // Idempotent ONLY when the receipt's FULL current terminal outcome equals
        // the requested one. A different stored outcome is a loud correlation
        // failure, never a silent success.
        const current = governorReceiptStore.getById(receiptId)?.handoffOutcome ?? null;
        if (current !== null && current.kind !== "scheduled" && governorOutcomesEqual(current, outcome)) {
          wrapperLog.info(`cc-lhc governor: attempt already terminal for ${receiptId} (${outcome.kind}); exact match`);
          return true;
        }
        markUndurable(
          `attempt outcome undurable: already-terminal mismatch (${outcome.kind})`,
          `cc-lhc governor receipt outcome NOT durable: attempt already terminal for ${receiptId} but stored ${current?.kind ?? "unknown"} != requested ${outcome.kind}`,
        );
        return false;
      }
      markUndurable(
        `attempt outcome undurable: ${result.kind} (${outcome.kind})`,
        `cc-lhc governor receipt outcome NOT durable: completeAttempt ${result.kind} for ${receiptId} outcome ${outcome.kind}`,
      );
      return false;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      markUndurable(
        `attempt outcome undurable: complete failed (${outcome.kind})`,
        `cc-lhc governor receipt outcome NOT durable: completeAttempt failed for ${receiptId}: ${detail}`,
      );
      return false;
    }
  };

  /**
   * Resolve the wrapper's own exact process identity through the native
   * provider. Unavailable/indeterminate defers (never synthesizes an identity).
   */
  const resolveSelfIdentity = (): ProcessLivenessResult => readProcessIdentity(process.pid);

  /**
   * Probe a foreign owner by its EXACT identity: a reused pid (live process with
   * a different bootId/starttime) reads as `not_found` (the original is gone), so
   * only a kernel-proven absence can justify a reclaim. Live/indeterminate wait.
   */
  const probeOwnerLiveness = (owner: ProcessIdentity): ProcessLivenessResult => {
    const probed = readProcessIdentity(owner.pid);
    if (probed.ok && !identitiesEqual(probed.identity, owner)) {
      return { ok: false, code: "not_found", message: `pid ${owner.pid} reused by a different process` };
    }
    return probed;
  };

  /**
   * Startup current-session scan (LIM-80 Slice 3A). Once capture is bound/ready
   * and this Claude session + LHC thread are known, drive OUR OWN unfinished work
   * through recovery — BOTH scheduled receipts with no attempt (crash after insert
   * before claim) AND receipts with an open attempt (crash after claim, or a
   * terminal receipt whose attempt bookkeeping is stale). Never touches another
   * wrapper/session's receipt. Coalesces with exact-replay through the same
   * single-flight function.
   *
   * Latches only after a COMPLETE pass: a transient session-list failure logs and
   * retries with cooldown (never latches); a malformed attempt row is loud and
   * fail-closed for that one receipt but does not suppress the rest.
   */
  const STARTUP_SCAN_RETRY_DELAY_MS = 1_000;
  const STARTUP_SCAN_MAX_RETRIES = 5;
  let startupScanRetries = 0;
  const scanCurrentSessionRecovery = (sessionId: string, threadId: string): void => {
    if (startupRecoveryScanned) return;
    if (governorReceiptStore === null || sessionId === "" || threadId === "") return;
    let receipts: GovernorDurableReceipt[];
    try {
      receipts = governorReceiptStore.listBySession(sessionId);
    } catch (cause) {
      // Transient list failure: do NOT latch. Retry with a bounded cooldown so a
      // corrupt row cannot busy-loop; the exact-replay path still recovers
      // scheduled receipts in the meantime.
      const detail = cause instanceof Error ? cause.message : String(cause);
      startupScanRetries += 1;
      if (startupScanRetries > STARTUP_SCAN_MAX_RETRIES) {
        wrapperLog.warn(
          `cc-lhc governor: startup recovery scan session list unreadable after ${STARTUP_SCAN_MAX_RETRIES} retries; giving up this pass: ${detail}`,
        );
        return;
      }
      wrapperLog.warn(`cc-lhc governor: startup recovery scan deferred (session list unreadable): ${detail}`);
      const timer = setTimeout(() => scanCurrentSessionRecovery(sessionId, threadId), STARTUP_SCAN_RETRY_DELAY_MS);
      if (typeof timer.unref === "function") timer.unref();
      return;
    }
    let scheduled = 0;
    for (const receipt of receipts) {
      // Exact current session (list) AND thread.
      if (receipt.threadId !== threadId) continue;
      let attempt: RecoveryAttempt | null;
      try {
        attempt = governorReceiptStore.getAttempt(receipt.receiptId);
      } catch (cause) {
        // Malformed attempt row: loud + fail-closed for THIS receipt only.
        wrapperLog.warn(
          `cc-lhc governor: startup scan — attempt row for ${receipt.receiptId} unreadable (skipped, fail-closed): ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        continue;
      }
      const scheduledReceipt = receipt.handoffOutcome?.kind === "scheduled";
      const openAttempt = attempt !== null && attempt.stage !== "terminal";
      if (!scheduledReceipt && !openAttempt) continue;
      const receiptId = receipt.receiptId;
      wrapperLog.info(
        `cc-lhc governor: startup recovery scan scheduling receipt ${receiptId} (scheduled=${scheduledReceipt} openAttempt=${openAttempt})`,
      );
      scheduled += 1;
      setImmediate(() => {
        void runRecovery(receiptId, "startup");
      });
    }
    // Full pass completed (including zero matching work): latch once.
    startupRecoveryScanned = true;
    if (scheduled === 0) {
      wrapperLog.info(`cc-lhc governor: startup recovery scan found no open work for session ${sessionId}`);
    }
  };

  let observedRuntimeSettings: ClaudeRuntimeSettings = {};
  let handoffRuntimeSettings: ClaudeRuntimeSettings | undefined;
  const onRuntimeSettings = (settings: Readonly<ClaudeRuntimeSettings>): void => {
    // A replacement rollout emits permission mode before its first assistant
    // response. Keep the prior confirmed effort until Claude confirms a newer one.
    observedRuntimeSettings = { ...observedRuntimeSettings, ...settings };
  };

  let expectedSession: ExpectedSession | undefined;
  const ownedSessionLeases = new Map<string, SessionOwnerLease>();
  const releaseSessionOwners = (): void => {
    for (const lease of ownedSessionLeases.values()) lease.release();
    ownedSessionLeases.clear();
  };
  const ensureSessionOwner = (sessionId: string): void => {
    if (ownedSessionLeases.has(sessionId)) return;
    ownedSessionLeases.set(sessionId, acquireSessionOwner(sessionId));
  };
  let resumeSessionIdForLineage: string | undefined;
  let childArgv = argv;
  /** Non-selector user argv retained for wrapper-owned respawn. */
  let respawnRest: string[] = [];
  let respawnPassthrough: string[] = [];
  /** Set when the launch form could replay a positional prompt: handoff fails closed. */
  let respawnUnsafeReason: string | null = null;
  if (!noCapture) {
    try {
      const plan = await resolveLaunchSession(argv, {
        cwd: process.cwd(),
        stdin,
        stdout,
        stderr,
      });
      expectedSession = plan.expected;
      childArgv = plan.childArgv;
      resumeSessionIdForLineage = plan.resumeSessionIdForLineage;
      respawnRest = plan.rest;
      respawnPassthrough = plan.passthrough;
      wrapperLog.info(`cc-lhc expected session ${expectedSession.sessionId} (source=${expectedSession.source})`);
      ensureSessionOwner(expectedSession.sessionId);
      const safety = respawnArgvSafety(respawnRest, respawnPassthrough);
      if (!safety.safe) {
        respawnUnsafeReason = safety.reason;
        wrapperLog.warn(`cc-lhc handoff disabled for this launch form: ${safety.reason}`);
      }
    } catch (cause) {
      releaseSessionOwners();
      const message =
        cause instanceof SessionOwnershipConflictError
          ? `cc-lhc refused duplicate session owner: ${cause.message}`
          : cause instanceof LaunchGrammarError || cause instanceof Error
            ? cause.message
            : String(cause);
      stderr.write(`${message}\n`);
      return 2;
    }
  }

  // Native Claude compact stays as the EMERGENCY BACKSTOP above the LHC upper
  // trigger. An explicit user --autocompact choice is preserved verbatim;
  // otherwise the child gets the configured backstop through the supported
  // CLI surface. Applied to the initial spawn and every respawn.
  const userChoseAutocompact = argv.some(
    (arg, i) =>
      argv.slice(0, i + 1).every((a) => a !== "--") && (arg === "--autocompact" || arg.startsWith("--autocompact=")),
  );
  const nativeBackstopArgs: string[] =
    !noCapture && !userChoseAutocompact && resolvedContextPolicy.armed && options.disableNativeBackstopArgs !== true
      ? ["--autocompact", String(resolvedContextPolicy.policy.nativeBackstopTokens)]
      : [];
  if (nativeBackstopArgs.length > 0) {
    childArgv = [...nativeBackstopArgs, ...childArgv];
    wrapperLog.info(
      `cc-lhc native compact backstop: --autocompact ${resolvedContextPolicy.policy.nativeBackstopTokens}`,
    );
  }

  // Per-wrapper runtime descriptor: Bash inherits only the path. Thread/archive
  // selection for retrieval comes exclusively from this file.
  // Undefined descriptorIo uses each API's defaultDescriptorIo (production path).
  let runtimeDescriptorPath: string | undefined;
  let runtimeDescriptor: RuntimeDescriptorV1 | undefined;
  if (!noCapture) {
    try {
      runtimeDescriptorPath = newDescriptorPath(undefined, descriptorIo);
      runtimeDescriptor = createOpeningDescriptor(runtimeDescriptorPath, descriptorIo);
      const guided = injectRetrievalGuidance(childArgv);
      if (!guided.ok) {
        const rev = closeAndRemove(runtimeDescriptorPath, runtimeDescriptor, descriptorIo);
        runtimeDescriptorPath = undefined;
        runtimeDescriptor = undefined;
        if (!rev.ok) {
          stderr.write(`cc-lhc: descriptor revoke failed: ${rev.reason}\n`);
        }
        stderr.write(`cc-lhc: ${guided.reason}\n`);
        releaseSessionOwners();
        return 2;
      }
      childArgv = guided.argv;
      wrapperLog.info(`cc-lhc runtime descriptor: ${runtimeDescriptorPath}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (runtimeDescriptorPath !== undefined) {
        const rev = revokeDescriptor(runtimeDescriptorPath, runtimeDescriptor, descriptorIo);
        if (!rev.ok) {
          wrapperLog.warn(`cc-lhc: descriptor revoke failed after create error: ${rev.reason}`);
        }
      }
      runtimeDescriptorPath = undefined;
      runtimeDescriptor = undefined;
      if (cause instanceof ProcessIdentityUnavailableError) {
        // Exact process identity is a startup invariant on supported
        // platforms: without it, ownership and descriptor liveness cannot be
        // proven. Fail with the actionable message rather than degrading.
        stderr.write(`cc-lhc: ${message}\n`);
        releaseSessionOwners();
        return 2;
      }
      wrapperLog.warn(`cc-lhc runtime descriptor create failed: ${message}`);
    }
  }

  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;

  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (runtimeDescriptorPath !== undefined) {
    childEnv[RUNTIME_DESCRIPTOR_ENV] = runtimeDescriptorPath;
  }

  let currentPty: IPty;
  try {
    currentPty = spawnPty(claudeBin, childArgv, {
      name: TERM_NAME,
      cols,
      rows,
      cwd: process.cwd(),
      env: childEnv,
    });
  } catch (cause) {
    // Spawn failed after descriptor create → revoke opening descriptor.
    if (runtimeDescriptorPath !== undefined) {
      const rev = closeAndRemove(runtimeDescriptorPath, runtimeDescriptor, descriptorIo);
      if (!rev.ok) {
        wrapperLog.warn(`cc-lhc: spawn-failure descriptor revoke unproven: ${rev.reason}`);
      }
      runtimeDescriptorPath = undefined;
      runtimeDescriptor = undefined;
    }
    releaseSessionOwners();
    throw cause;
  }

  let exited = false;
  let captureSession: CaptureSession | undefined;
  const startedAt = new Date();
  /** When true, skip long drain — owner identity must go stale promptly. */
  let fatalRevocationExit = false;
  /** After first successful degrade revoke, later reasons are sticky diagnostics only. */
  let descriptorCapabilityRevoked = false;
  let resolveRun: ((code: number) => void) | undefined;

  // ---- Slice 4 controlled-handoff state ----
  /** Post-commit stdin bytes, in arrival order; null = normal forwarding. */
  let inputBarrier: Buffer[] | null = null;
  /** Durable post-commit input journal (LIM-80 3B1); null for manual handoff. */
  let handoffInputJournal: InputJournal | null = null;
  /** False once a journal append failed mid-barrier: delivery must be withheld. */
  let handoffJournalDurable = true;
  /** True from commit until the handoff settles; suppresses teardown-on-exit. */
  let handoffInProgress = false;
  /** The child whose exit the handoff expects (old child during termination). */
  let expectedExitPty: IPty | null = null;
  let expectedExitResolve: (() => void) | null = null;
  /** Set when any child dies while a handoff is mid-flight (fast-fails ready wait). */
  let childDiedDuringHandoff = false;
  /** PTY output bytes from the current child (liveness signal, never parsed). */
  let currentChildOutputBytes = 0;
  /** Recorded ONLY after a confirmed successful handoff. */
  let lastAction: {
    operation: string;
    origin: string;
    atMs: number;
    triggerTokens?: number;
    viewTokens?: number;
    targetTokens?: number;
    zoneBefore?: number;
    zoneAfter?: number;
  } | null = null;
  /** Detached manual handoff receipts shown once on the next panel open. */
  let pendingPanelNotices: string[] = [];
  /** Smallest settled provider context seen: the observed Claude host overhead floor. */
  let minObservedProviderTotal: number | null = null;
  /** One auto operation scheduled/coalesced at a time. */
  let autoOperationScheduled = false;
  /** Cooldown after a non-success handoff; replayed rollback lifecycle must not re-trigger. */
  let autoBlockedUntilMs = 0;
  /** Assigned inside the run promise where child/teardown machinery lives. */
  let runAutoOperation: (args: { frozenTriggerTokens: number | null; receiptId: string }) => Promise<void> =
    async () => {};
  /** Single-flight recovery of one durable receipt (replay + startup scan). */
  let runRecovery: (receiptId: string, trigger: "replay" | "startup") => Promise<void> = async () => {};
  const HANDOFF_FAILURE_COOLDOWN_MS = 120_000;
  /** Bounded recovery retry policy (avoid busy-loop; leave receipt open). */
  const RECOVERY_RETRY_DELAY_MS = 750;
  const RECOVERY_MAX_RETRIES = 8;

  const triggerFatalRevocation = (reason: string): void => {
    if (fatalRevocationExit && exited) return;
    fatalRevocationExit = true;
    wrapperLog.warn(`cc-lhc capture/retrieval FATAL: ${reason}`);
    // 1–3: stop input, restore terminal, best-effort kill children.
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      // best effort
    }
    try {
      stdin.removeAllListeners("data");
    } catch {
      // best effort
    }
    try {
      requestPtyTermination(currentPty, process.platform, "SIGKILL");
    } catch {
      // kill may throw; still exit the owner process
    }
    killAllInferenceChildren();
    try {
      altScreen.leave();
    } catch {
      // best effort
    }
    try {
      restoreTerminal(stdin, stdout);
    } catch {
      // best effort
    }
    // 4: do not await capture drain — schedule wrapper process exit.
    forceWrapperExit(1);
    if (!exited) {
      exited = true;
      resolveRun?.(1);
    }
  };

  // Alt-screen truth for every exit path, normal or not: the process-exit
  // hook, signal handlers, and stdin loss all leave through this guard, so a
  // crash between ?1049h and a normal dismiss still restores the terminal,
  // and no path can double-leave.
  const altScreen = createAltScreenGuard((data) => stdout.write(data));

  // Exit stats print on stderr only from teardown, AFTER the child has
  // exited and the screen is back with the shell — legitimate surface (d).
  const printExitStats = (): void => {
    if (captureSession === undefined) return;
    stderr.write(`${formatCaptureStatsLine(captureSession.stats)}\n`);
  };

  // SIGUSR1 can fire at any moment while claude owns the screen: the stats
  // snapshot goes to the wrapper log, never the terminal.
  const onSigusr1 = (): void => {
    if (captureSession === undefined) return;
    wrapperLog.info(formatCaptureStatsLine(captureSession.stats));
  };

  const publishDescriptorFromCapture = (): void => {
    if (runtimeDescriptorPath === undefined || runtimeDescriptor === undefined) return;
    if (captureSession === undefined) return;
    if (runtimeDescriptor.state === "closed") return;
    try {
      if (!captureSession.isCaptureReady()) {
        if (captureSession.getCaptureHealth().phase === "degraded" && runtimeDescriptor.state !== "degraded") {
          const reasons = captureSession.getCaptureHealth().reasons;
          runtimeDescriptor = markDegraded(
            runtimeDescriptorPath,
            runtimeDescriptor,
            reasons[0] ?? "capture_degraded",
            descriptorIo,
          );
        }
        return;
      }
      const ctx = captureSession.getCommandContext();
      const rollout = captureSession.getRolloutInfo();
      const threadRef = ctx.threadRef;
      const threadId = threadRef !== undefined && "threadId" in threadRef ? threadRef.threadId : "";
      const registryPath =
        threadRef !== undefined && "registryPath" in threadRef && threadRef.registryPath !== undefined
          ? threadRef.registryPath
          : defaultRegistryPath();
      if (
        threadId === "" ||
        rollout.path === undefined ||
        rollout.path === "" ||
        rollout.sessionId === undefined ||
        rollout.sessionId === ""
      ) {
        return;
      }
      runtimeDescriptor = markReady(
        runtimeDescriptorPath,
        runtimeDescriptor,
        {
          threadId,
          registryPath,
          sessionId: rollout.sessionId,
          rolloutPath: rollout.path,
        },
        descriptorIo,
      );
      wrapperLog.info(`cc-lhc runtime descriptor ready thread=${threadId} session=${rollout.sessionId}`);
      governorState = setGovernorDescriptorReady(governorState, true);
      // Capture bound/ready and this session's exact identity known: scan for our
      // own crash-interrupted receipts once and drive them through the same
      // single-flight recovery function (coalesces with any exact-replay pass).
      scanCurrentSessionRecovery(rollout.sessionId, threadId);
    } catch (cause) {
      wrapperLog.warn(
        `cc-lhc runtime descriptor update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      governorState = setGovernorDescriptorReady(governorState, false);
    }
  };

  const onCaptureLifecycle = (signals: readonly LifecycleSignal[]): void => {
    // Sync capture health / generation into governor before decide (no I/O).
    if (captureSession !== undefined) {
      governorState = setGovernorCaptureHealth(
        governorState,
        captureSession.isCaptureHealthy(),
        captureSession.getCaptureGeneration(),
      );
    }
    if (runtimeDescriptor?.state === "ready" && !descriptorCapabilityRevoked) {
      governorState = setGovernorDescriptorReady(governorState, true);
    }

    // Pure decide + wrapper-log record. Mutation only after durable receipt.
    const observed = applyGovernorLifecycleBatch(governorState, signals, resolvedContextPolicy);
    governorState = observed.state;
    for (const record of observed.observes) {
      wrapperLog.info(formatGovernorObserveLogLine(record));
      const persisted = persistGovernorObserve(record);
      options.onGovernorObserve?.(record);
      // Use predicted next-request pressure for floor learning when available;
      // fall back to authoritative provider total only.
      const pressureForFloor = record.pressure.nextRequestPressureTokens ?? record.providerContextTotal;
      if (pressureForFloor !== null && pressureForFloor > 0) {
        minObservedProviderTotal =
          minObservedProviderTotal === null ? pressureForFloor : Math.min(minObservedProviderTotal, pressureForFloor);
      }
      // Capability-limited: executable would_compact only at a settled seam
      // (wouldMutate is false during open turns). Starts ONE automatic operation,
      // scheduled off the capture batch path (the handoff stops capture; doing
      // that inline would deadlock the batch queue it runs on).
      //
      // Durable-before-mutate: open-turn may remain log-only if receipt
      // persistence is unavailable; a settled wouldMutate must not start
      // context mutation without a durable receipt id. Exact replay
      // (inserted=false) must not schedule a second automatic mutation —
      // including an existing `scheduled` receipt after process crash (fail closed).
      //
      // After a NEW inserted wouldMutate receipt, every branch must either start
      // the exact operation or attach a terminal/non-running outcome
      // (mutation_deferred / mutation_refused). Leaving `scheduled` without an
      // owner is reserved for the crash window after insert and before claim.
      if (record.wouldMutate === true && record.observePhase === "settled_seam") {
        if (persisted === null) {
          wrapperLog.warn(
            "cc-lhc governor: wouldMutate refused — durable receipt unavailable; Claude/LHC context left unchanged",
          );
          lastAttempt = {
            summary: "auto compact refused: durable receipt unavailable",
            atMs: Date.now(),
          };
        } else if (!persisted.inserted) {
          const existingOutcome = persisted.receipt.handoffOutcome;
          if (existingOutcome?.kind === "scheduled") {
            // Exact replay of a scheduled receipt is recoverable work, not a
            // permanent latch (LIM-80 Slice 3A). Drive one single-flight recovery
            // pass off the capture batch path: it plans from durable state and
            // never runs a second native compact for a stage that already landed.
            const receiptId = persisted.receipt.receiptId;
            wrapperLog.info(
              `cc-lhc governor: replay of scheduled receipt ${receiptId} — scheduling recovery (no second native compact)`,
            );
            setImmediate(() => {
              void runRecovery(receiptId, "replay");
            });
          } else if (isTerminalHandoffOutcome(existingOutcome)) {
            wrapperLog.info(
              `cc-lhc governor: exact replay of receipt ${persisted.receipt.receiptId} with terminal outcome ${existingOutcome?.kind}; no re-schedule`,
            );
          } else {
            wrapperLog.info(`cc-lhc governor: exact replay of receipt ${persisted.receipt.receiptId}; no re-schedule`);
          }
        } else {
          // Fresh insert: receipt is currently `scheduled`. Claim it or terminalize.
          const receiptId = persisted.receipt.receiptId;
          const deferAuto = (
            reason: GovernorMutationDeferReason,
            detail: string,
            logLevel: "info" | "warn" = "info",
          ): void => {
            const outcome: GovernorHandoffOutcome = { kind: "mutation_deferred", detail, reason };
            const attached = attachGovernorHandoffOutcome(receiptId, outcome, { mutationBegan: false });
            const line = `cc-lhc governor: wouldMutate deferred (${reason}): ${detail} [receipt ${receiptId}]`;
            if (logLevel === "warn") wrapperLog.warn(line);
            else wrapperLog.info(line);
            // attachGovernorHandoffOutcome already sets lastAttempt on failure.
            // On success, record the deferred gate for panel status.
            if (attached) {
              lastAttempt = {
                summary: `auto compact deferred: ${reason} (${detail})`,
                atMs: Date.now(),
              };
            }
          };

          if (exited) {
            deferAuto("wrapper_exiting", "wrapper already exiting; mutation not started");
          } else if (handoffInProgress) {
            deferAuto("handoff_in_progress", "controlled handoff already in progress; mutation not started");
          } else if (autoOperationScheduled) {
            deferAuto(
              "auto_operation_in_flight",
              "another automatic operation already owns the flight; coalesced (no second mutation)",
            );
          } else if (respawnUnsafeReason !== null) {
            // Respawn cannot safely replace the child: refuse, do not pretend scheduled.
            attachGovernorHandoffOutcome(
              receiptId,
              {
                kind: "mutation_refused",
                detail: `respawn_unsafe: ${respawnUnsafeReason}`,
              },
              { mutationBegan: false },
            );
            wrapperLog.warn(
              `cc-lhc governor: wouldMutate refused — respawn unsafe: ${respawnUnsafeReason} [receipt ${receiptId}]`,
            );
            lastAttempt = {
              summary: `auto compact refused: respawn unsafe (${respawnUnsafeReason})`,
              atMs: Date.now(),
            };
          } else if (Date.now() < autoBlockedUntilMs) {
            const remainMs = Math.max(0, autoBlockedUntilMs - Date.now());
            deferAuto(
              "cooldown",
              `post-failure cooldown active (~${Math.ceil(remainMs / 1000)}s remaining); mutation not started`,
            );
          } else {
            // Claim ownership: keep `scheduled` only while this operation owns it.
            // Crash between here and runAutoOperation claim is the fail-closed window.
            autoOperationScheduled = true;
            const frozenTriggerTokens = record.pressure.nextRequestPressureTokens ?? record.providerContextTotal;
            setImmediate(() => {
              void runAutoOperation({ frozenTriggerTokens, receiptId }).finally(() => {
                autoOperationScheduled = false;
              });
            });
          }
        }
      }
    }

    for (const signal of signals) {
      if (signal.kind === "session_bound") {
        publishDescriptorFromCapture();
      } else if (signal.kind === "capture_degraded") {
        // Slice 1 latches multiple distinct reasons per generation. After the
        // descriptor capability is already non-ready/absent, further reasons are
        // diagnostics only — never re-publish or treat as fatal re-transition.
        wrapperLog.warn(`cc-lhc capture degraded: ${signal.reason}`);
        governorState = setGovernorCaptureHealth(governorState, false, signal.generation);
        governorState = setGovernorDescriptorReady(governorState, false);
        if (descriptorCapabilityRevoked || runtimeDescriptorPath === undefined) {
          continue;
        }
        if (
          runtimeDescriptor !== undefined &&
          (runtimeDescriptor.state === "degraded" || runtimeDescriptor.state === "closed")
        ) {
          descriptorCapabilityRevoked = true;
          continue;
        }
        if (runtimeDescriptor === undefined) {
          descriptorCapabilityRevoked = true;
          continue;
        }
        try {
          const rev = revokeCapability(
            runtimeDescriptorPath,
            runtimeDescriptor,
            "degraded",
            signal.reason,
            descriptorIo,
          );
          if (!rev.ok) {
            runtimeDescriptor = undefined;
            runtimeDescriptorPath = undefined;
            descriptorCapabilityRevoked = true;
            triggerFatalRevocation(`descriptor revoke failed: ${rev.reason}`);
            continue;
          }
          descriptorCapabilityRevoked = true;
          if (rev.kind === "absent") {
            runtimeDescriptorPath = undefined;
            runtimeDescriptor = undefined;
          } else {
            runtimeDescriptor = {
              ...runtimeDescriptor,
              state: rev.state,
              degradeReason: signal.reason,
            };
          }
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          runtimeDescriptor = undefined;
          runtimeDescriptorPath = undefined;
          descriptorCapabilityRevoked = true;
          triggerFatalRevocation(`descriptor revoke failed: ${msg}`);
        }
      }
    }
  };

  if (!noCapture && expectedSession !== undefined) {
    captureSession = startCaptureSession({
      startedAt,
      noInference,
      expectedSession,
      ...(resumeSessionIdForLineage !== undefined ? { resumeSessionId: resumeSessionIdForLineage } : {}),
      lineageDbPath: defaultLineageDbPath(),
      log: (message) => wrapperLog.info(message),
      logError: (message) => wrapperLog.warn(message),
      onLifecycle: onCaptureLifecycle,
      onRuntimeSettings,
    });
    process.on("SIGUSR1", onSigusr1);
  }

  /**
   * Revoke retrieval capability before long drain. Fatal if still ready.
   */
  const revokeDescriptorNow = (): RevocationResult => {
    if (runtimeDescriptorPath === undefined) {
      return { ok: true, kind: "absent" };
    }
    const path = runtimeDescriptorPath;
    const current = runtimeDescriptor;
    runtimeDescriptorPath = undefined;
    runtimeDescriptor = undefined;
    const rev = revokeCapability(path, current, "closed", undefined, descriptorIo);
    if (!rev.ok) {
      wrapperLog.warn(`cc-lhc capture/retrieval FATAL: child-exit revoke unproven: ${rev.reason}`);
      fatalRevocationExit = true;
    }
    return rev;
  };

  const cleanupDescriptor = (): void => {
    if (runtimeDescriptorPath === undefined) return;
    const rev = closeAndRemove(runtimeDescriptorPath, runtimeDescriptor, descriptorIo);
    if (!rev.ok) {
      wrapperLog.warn(`cc-lhc: cleanup descriptor revoke unproven: ${rev.reason}`);
    }
    runtimeDescriptorPath = undefined;
    runtimeDescriptor = undefined;
  };

  const cleanup = (): void => {
    altScreen.leave();
    restoreTerminal(stdin, stdout);
    process.removeListener("SIGUSR1", onSigusr1);
    cleanupDescriptor();
    releaseSessionOwners();
  };

  process.on("exit", cleanup);

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  const leaderByte = resolveLeaderByte(process.env.CC_LHC_LEADER, (message) => {
    wrapperLog.warn(message);
  });
  const notifierEnabled = options.notifierDisabled !== true;
  let inputState: InputState = createInputState(leaderByte, { notifierEnabled });
  /** Bumped on every modal entry; tags a dismiss-at-injection so late failures reopen only if still idle. */
  let _modalGeneration = 0;

  // While the modal (or an executing command) owns the screen, pty output is
  // held — claude keeps running; we just delay rendering its bytes.
  const outputHold = new OutputHold(
    options.outputHoldCapBytes ?? OUTPUT_HOLD_CAP_BYTES,
    (data) => stdout.write(data),
    () => {
      inputState = forceResetInput(inputState);
      altScreen.leave();
      // No terminal notice — the child owns the restored screen. The event is
      // logged and counted; `status` will surface it.
      wrapperLog.warn(OUTPUT_HOLD_OVERFLOW_MESSAGE);
      outputHold.flush();
    },
  );

  const forwardOutput = (data: string): void => {
    outputHold.feed(data);
  };

  const commandRuntime = (): LhcCommandRuntime => {
    const rollout = captureSession?.getRolloutInfo();
    if (noCapture || captureSession === undefined) {
      return {
        captureDisabled: true,
        stats: emptyCaptureStats(),
        sdk: undefined,
        threadRef: undefined,
        cwd: process.cwd(),
        sourceRolloutPath: undefined,
        sourceSessionId: undefined,
      };
    }
    const ctx = captureSession.getCommandContext();
    const policy = resolvedContextPolicy.policy;
    return {
      ...ctx,
      cwd: process.cwd(),
      sourceRolloutPath: rollout?.path,
      sourceSessionId: rollout?.sessionId,
      contextPolicy: {
        profile: policy.profile,
        lowerBoundTokens: policy.lowerBoundTokens,
        ...(policy.pruneEnabled && policy.pruneThresholdTokens !== null && policy.pruneTargetTokens !== null
          ? {
              pruneIfDue: {
                thresholdTokens: policy.pruneThresholdTokens,
                targetTokens: policy.pruneTargetTokens,
              },
            }
          : {}),
      },
      isTurnOpen: () => captureSession?.isTurnOpen() ?? false,
      isCaptureHealthy: () => captureSession?.isCaptureHealthy() ?? false,
      isCaptureReady: () => captureSession?.isCaptureReady() ?? false,
      getCaptureGeneration: () => captureSession?.getCaptureGeneration() ?? 0,
      captureDegraded: captureSession?.getCaptureHealth().phase === "degraded",
      captureGeneration: captureSession?.getCaptureGeneration(),
      capturePhase: captureSession?.getCaptureHealth().phase,
      lineageDbPath: defaultLineageDbPath(),
      logLineageError: (message) => wrapperLog.warn(message),
      warnings: { count: wrapperLog.warningCount(), logPath: wrapperLog.path },
    };
  };

  const renderModalPanel = (): void => {
    if (inputState.mode === "passthrough") return;
    const inFlight = commandGuard.current();
    const elapsedSeconds =
      inputState.mode === "executing" && inFlight !== null
        ? Math.floor((Date.now() - inFlight.startedAtMs) / 1000)
        : undefined;
    stdout.write(renderPanel(inputState, stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS, elapsedSeconds));
  };

  // Once-a-second repaint while a command executes: the progress line's
  // elapsed counter is the panel's liveness signal — without it a slow
  // `status` is indistinguishable from a hang. Self-cancels the moment the
  // mode leaves executing (settle, detach, overflow reset, signal restore).
  let executingTicker: NodeJS.Timeout | null = null;
  const stopExecutingTicker = (): void => {
    if (executingTicker !== null) {
      clearInterval(executingTicker);
      executingTicker = null;
    }
  };
  const startExecutingTicker = (): void => {
    stopExecutingTicker();
    executingTicker = setInterval(() => {
      if (inputState.mode !== "executing") {
        stopExecutingTicker();
        return;
      }
      renderModalPanel();
    }, 1_000);
    executingTicker.unref?.();
  };

  const handleSigwinch = (): void => {
    onTerminalResize(currentPty, stdout);
    renderModalPanel();
  };
  process.on("SIGWINCH", handleSigwinch);

  // Signals restore the terminal FIRST (leave alt, flush held output —
  // ordering invariant intact), then forward to the child as before. The
  // child may ignore the signal and keep running; the wrapper must already be
  // back on the main screen either way.
  const restoreIfModal = (): void => {
    if (!altScreen.active && inputState.mode === "passthrough") return;
    inputState = forceResetInput(inputState);
    altScreen.leave();
    outputHold.flush();
  };

  const forwardSignal = (signal: NodeJS.Signals): void => {
    restoreIfModal();
    if (!exited) {
      requestPtyTermination(currentPty, process.platform, signal);
    }
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  process.on("SIGHUP", forwardSignal);

  return new Promise((resolve) => {
    resolveRun = resolve;
    const teardownAndExit = async (exitCode: number): Promise<void> => {
      if (exited) return;
      exited = true;
      if (pendingEscTimer !== null) {
        clearTimeout(pendingEscTimer);
        pendingEscTimer = null;
      }
      stopExecutingTicker();
      stdin.removeListener("data", forwardInput);
      stdin.removeListener("end", onStdinGone);
      stdin.removeListener("close", onStdinGone);
      stdin.removeListener("error", onStdinError);
      process.removeListener("SIGWINCH", handleSigwinch);
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      process.removeListener("SIGHUP", forwardSignal);
      altScreen.leave();
      outputHold.flush();
      // Child is gone: revoke ready capability BEFORE awaited flush/drain.
      const rev = revokeDescriptorNow();
      if (fatalRevocationExit || !rev.ok) {
        // Owner must die even if child kill fails — invalidate OS identity.
        try {
          requestPtyTermination(currentPty, process.platform, "SIGKILL");
        } catch {
          // already dead or kill throws
        }
        killAllInferenceChildren();
        cleanup();
        forceWrapperExit(1);
        resolve(1);
        return;
      }
      if (captureSession !== undefined) {
        await captureSession.stop().catch(() => {});
        printExitStats();
        killAllInferenceChildren();
      }
      if (governorReceiptStore !== null) {
        try {
          governorReceiptStore.close();
        } catch {
          // best effort
        }
        governorReceiptStore = null;
      }
      cleanup();
      resolve(exitCode);
    };

    const debugInput = createInputDebugLogger(process.env.CC_LHC_INPUT_DEBUG);

    // A modal-executed command settles here. Receipts go into the alt-screen
    // panel above a fresh prompt, screen still held — the panel owns its own
    // screen, so receipts stay readable whatever the main-screen TUI is doing.
    // One keypress (Esc/ctrl-C/leader) dismisses: leave the alt screen (the
    // terminal restores CC's layout exactly), then flush the held output.
    const settleCommand = (messages: string[], label: string, retainForNextPanel = false): void => {
      stopExecutingTicker();
      if (inputState.mode === "executing") {
        if (messages.length === 0) {
          inputState = finishExecuting(inputState);
          altScreen.leave();
          outputHold.flush();
          return;
        }
        inputState = showReceipts(inputState, messages);
        renderModalPanel();
        return;
      }
      if (inputState.mode === "modal") {
        // The user detached and REOPENED the panel: land the late receipt
        // where they are looking instead of vanishing it into the log,
        // preserving whatever they are mid-typing.
        if (messages.length === 0) return;
        inputState = showLateReceipts(inputState, label, messages);
        renderModalPanel();
        return;
      }
      // Detached (ctrl-C/Esc/leader) or force-cancelled (overflow) and never
      // reopened: the child owns the live screen, so the receipt goes to the
      // wrapper log (doctrine — never write into CC's UI).
      for (const message of messages) wrapperLog.warn(`command receipt (modal dismissed early): [${label}] ${message}`);
      if (retainForNextPanel && messages.length > 0) {
        pendingPanelNotices = [`${label} finished:`, ...messages.flatMap((message) => message.split("\n"))];
      }
    };

    /** Atomic session-scoped policy edit: validate the whole candidate with the
     * same rules as launch; a rejected edit changes nothing. */
    const applyPolicyEdit = (commandLine: string): string[] => {
      const parts = commandLine.trim().split(/\s+/);
      const current = resolvedContextPolicy.policy;
      let candidate: typeof current;
      let changedKeys: Array<"autoCompact" | "lowerBoundTokens" | "upperBoundTokens">;
      let editLabel: string;
      if (parts[0] === "/lhc-auto") {
        const on = parts[1] === "on";
        candidate = { ...current, autoCompact: on };
        changedKeys = ["autoCompact"];
        editLabel = `auto ${on ? "on" : "off"}`;
      } else {
        const lower = Number.parseInt(parts[1] ?? "", 10);
        const upper = Number.parseInt(parts[2] ?? "", 10);
        candidate = { ...current, lowerBoundTokens: lower, upperBoundTokens: upper };
        changedKeys = ["lowerBoundTokens", "upperBoundTokens"];
        editLabel = `bounds ${lower} ${upper}`;
      }
      const errors = validateContextPolicy(candidate);
      if (errors.length > 0) {
        return [`rejected — nothing changed (${editLabel}):`, ...errors];
      }
      const sources = { ...resolvedContextPolicy.sources };
      for (const key of changedKeys) sources[key] = "session";
      resolvedContextPolicy = { policy: candidate, sources, armed: true, errors: [] };
      wrapperLog.info(
        `cc-lhc policy edit applied (${editLabel}) session scope: auto=${candidate.autoCompact} lower=${candidate.lowerBoundTokens} upper=${candidate.upperBoundTokens}`,
      );
      return [
        `${editLabel} — applied live to this wrapper`,
        "scope: session only — survives child handoffs, lost at wrapper exit",
        "persist by editing user/project config; native --autocompact is a next-launch value",
      ];
    };

    const runModalCommand = (commandLine: string): void => {
      const label = commandLine.replace(/^\/lhc-/, "");
      if (commandLine.startsWith("/lhc-auto ") || commandLine.startsWith("/lhc-bounds ")) {
        // Synchronous session-policy edit: no SDK, no processes, no guard needed.
        settleCommand(applyPolicyEdit(commandLine), label);
        return;
      }
      if (!commandGuard.tryAcquire(label, Date.now())) {
        const inFlight = commandGuard.current();
        settleCommand(
          [inFlight === null ? "busy — command in progress" : formatBusyMessage(inFlight, Date.now())],
          label,
        );
        return;
      }
      startExecutingTicker();
      // Manual mutating commands share the automatic path's cancel fence: any
      // pty-bound user byte from dispatch start cancels before commit.
      const epochAtStart = governorState.currentInputEpoch;
      const epochChanged = (): boolean => governorState.currentInputEpoch !== epochAtStart;
      // A synchronous throw (runtime-snapshot construction, dispatch setup)
      // must not escape into the stdin data handler as an uncaught exception —
      // settle it exactly like an async failure.
      let dispatched: Promise<DispatchOutcome>;
      try {
        dispatched = dispatchLhcCommand(commandLine, {
          ...commandRuntime(),
          inputEpochChanged: epochChanged,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        settleCommand([`command error: ${message}`], label);
        commandGuard.release();
        return;
      }
      void dispatched
        .then(async (outcome) => {
          if (outcome.handoff !== undefined) {
            // Wrapper-owned respawn (in-app /resume is retired on 2.1.226).
            // The child swap owns the screen: close the modal and flush held
            // output BEFORE commit, then run the same handoff as automatic.
            governorState = setGovernorOperationInFlight(governorState, true);
            stopExecutingTicker();
            inputState = forceResetInput(inputState);
            altScreen.leave();
            outputHold.flush();
            try {
              const result = await performHandoff(outcome.handoff, epochChanged);
              const summary = formatHandoffResult(result);
              const extra: string[] = [];
              if (result.kind === "cancelled" && respawnUnsafeReason !== null) {
                // Manual recovery for a launch form that cannot respawn: bind
                // the rebuilt artifact so an external wrapper resume can load it
                // (accepted Slice 1 interim path), and say exactly what to run.
                const lineage = await registerRebuiltSessionLineage({
                  newSessionId: outcome.handoff.rebuilt.sessionId,
                  threadId: outcome.handoff.threadId,
                  prefixBoundary: outcome.handoff.rebuilt.prefixBoundary,
                  lineageDbPath: defaultLineageDbPath(),
                  logError: (message) => wrapperLog.warn(message),
                });
                if (lineage.ok) {
                  extra.push(
                    ...formatRebuildRelaunchGuidance({
                      operation: outcome.handoff.operation === "prune" ? "prune" : "compact",
                      oldSessionId: outcome.handoff.oldSessionId,
                      newSessionId: outcome.handoff.rebuilt.sessionId,
                      threadId: outcome.handoff.threadId,
                    }),
                  );
                } else {
                  extra.push(`rebuilt artifact not registered (${lineage.reason}); re-run compact after relaunch`);
                }
              }
              settleCommand([...outcome.messages, summary, ...extra], label, true);
            } finally {
              governorState = setGovernorOperationInFlight(governorState, false);
            }
            return;
          }
          if (label === "compact" || label.startsWith("prune")) {
            lastAttempt = {
              summary: `manual ${label} did not hand off: ${outcome.messages[outcome.messages.length - 1] ?? "(no detail)"}`,
              atMs: Date.now(),
            };
          }
          settleCommand(settleReceipts(outcome.messages), label);
        })
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          settleCommand([`command error: ${message}`], label);
        })
        .finally(() => {
          stopExecutingTicker();
          commandGuard.release();
        });
    };

    const formatAgo = (atMs: number): string => {
      const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
      if (seconds < 60) return `${seconds}s ago`;
      if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
      return `${Math.round(seconds / 3600)}h ago`;
    };

    /** Compact status summary shown above the prompt whenever the panel opens.
     * "Trigger context" is Claude host context; "LHC view" is SDK-served size. */
    const buildPanelStatusRows = (): string[] => {
      const policy = resolvedContextPolicy.policy;
      const rows: string[] = ["LHC context management"];

      const capturePhase = captureSession?.getCaptureHealth().phase ?? (noCapture ? "disabled" : "starting");
      const retrievalState =
        runtimeDescriptor?.state === "ready" ? "ready" : (runtimeDescriptor?.state ?? "unavailable");
      rows.push(`capture ${capturePhase} · retrieval ${retrievalState}`);

      const provider = governorState.latestProviderContext;
      const providerText =
        provider === null
          ? "provider context: none observed yet"
          : `provider context ${formatTokensShort(provider.total)}`;
      if (!resolvedContextPolicy.armed) {
        rows.push(`${providerText} · policy INVALID (auto disabled)`);
        for (const err of resolvedContextPolicy.errors.slice(0, 3)) rows.push(`  config error: ${err}`);
      } else {
        rows.push(
          `${providerText} · auto ${policy.autoCompact ? "on" : "off"}${policy.observeOnly ? " (observe-only)" : ""} · ` +
            `trigger ${formatTokensShort(policy.upperBoundTokens)} · target ${formatTokensShort(policy.lowerBoundTokens)}`,
        );
      }
      rows.push(
        `native compact backstop ${formatTokensShort(policy.nativeBackstopTokens)} (--autocompact, next-launch value)`,
      );

      const inFlight = commandGuard.current();
      rows.push(
        handoffInProgress
          ? "active operation: handoff in progress"
          : inFlight !== null
            ? `active operation: ${inFlight.label}`
            : "active operation: none",
      );

      if (lastAction === null) {
        rows.push("last action: none this wrapper session");
      } else {
        const parts = [
          `${lastAction.operation === "prune" ? "pruned" : "compacted"} ${formatAgo(lastAction.atMs)} (${lastAction.origin})`,
        ];
        if (lastAction.triggerTokens !== undefined)
          parts.push(`trigger ${formatTokensShort(lastAction.triggerTokens)}`);
        if (lastAction.zoneBefore !== undefined && lastAction.zoneAfter !== undefined)
          parts.push(`zone ${formatTokensShort(lastAction.zoneBefore)} -> ${formatTokensShort(lastAction.zoneAfter)}`);
        if (lastAction.viewTokens !== undefined) parts.push(`view ${formatTokensShort(lastAction.viewTokens)}`);
        rows.push(`last action: ${parts.join(" · ")}`);
      }
      if (lastAttempt !== null && (lastAction === null || lastAttempt.atMs > lastAction.atMs)) {
        rows.push(`last attempt: ${lastAttempt.summary} (${formatAgo(lastAttempt.atMs)})`);
      }

      if (
        resolvedContextPolicy.armed &&
        minObservedProviderTotal !== null &&
        policy.upperBoundTokens <= minObservedProviderTotal
      ) {
        rows.push(
          `WARNING: trigger ${formatTokensShort(policy.upperBoundTokens)} is at/below observed Claude host overhead ` +
            `(${formatTokensShort(minObservedProviderTotal)}) — every settled turn would compact`,
        );
      }
      if (respawnUnsafeReason !== null) {
        rows.push("WARNING: automatic handoff disabled for this launch form (see wrapper log)");
      }

      rows.push("edits (auto/bounds) are session-scoped: live now, survive handoffs, lost at wrapper exit");
      rows.push(
        `precedence: builtin < user ${userConfigPath()} < project ${projectConfigPath(process.cwd())} < session`,
      );
      return rows;
    };

    const applyActions = (actions: ReturnType<typeof processInputChunk>["actions"]): void => {
      for (const action of actions) {
        if (action.kind === "enter_modal") {
          _modalGeneration += 1;
          outputHold.hold();
          altScreen.enter();
          inputState = {
            ...inputState,
            panelRows: [...buildPanelStatusRows(), ...pendingPanelNotices],
          };
          pendingPanelNotices = [];
        } else if (action.kind === "exit_modal") {
          // Leave BEFORE flushing: the terminal restores CC's main screen,
          // then the held bytes land on it in order.
          altScreen.leave();
          outputHold.flush();
        } else if (action.kind === "notifier_open") {
          wrapperLog.info(`cc-lhc notifier: holding Enter for ${action.command}`);
          outputHold.hold();
          altScreen.enter();
        } else if (action.kind === "notifier_continue") {
          altScreen.leave();
          outputHold.flush();
          if (action.enterBytes.length > 0) {
            // The user's own Enter, delivered exactly once — it is input
            // reaching Claude, so it bumps the governor epoch like any byte.
            governorState = noteGovernorInput(governorState);
            currentPty.write(Buffer.from(action.enterBytes).toString("latin1"));
          }
        } else if (action.kind === "notifier_return") {
          altScreen.leave();
          outputHold.flush();
        } else if (action.kind === "execute") runModalCommand(action.commandLine);
      }
    };

    // A pending ESC held by the modal is resolved by the next byte; when no
    // byte follows (a truly bare Esc keypress), this timer rules it bare so
    // the cancel is never ambiguous for longer than PENDING_ESC_RESOLVE_MS.
    let pendingEscTimer: NodeJS.Timeout | null = null;

    const armPendingEscTimer = (): void => {
      if (pendingEscTimer !== null) {
        clearTimeout(pendingEscTimer);
        pendingEscTimer = null;
      }
      const kind = inputState.escape?.kind;
      const holding = kind === "pending_esc" || (inputState.mode === "passthrough" && kind === "csi_candidate");
      if (!holding) return;
      pendingEscTimer = setTimeout(() => {
        pendingEscTimer = null;
        const resolved = resolveBareEsc(inputState);
        if (resolved === null) return;
        inputState = resolved.state;
        if (resolved.toPty !== undefined && resolved.toPty.length > 0)
          currentPty.write(resolved.toPty.toString("latin1"));
        applyActions(resolved.actions);
      }, PENDING_ESC_RESOLVE_MS);
      pendingEscTimer.unref?.();
    };

    const onStdinGone = (): void => {
      restoreIfModal();
    };

    const onStdinError = (cause: unknown): void => {
      // Restore the terminal, then let the error do what it always did
      // (propagate as an uncaught exception) — the exit hook's guarded leave
      // makes the rethrow safe.
      restoreIfModal();
      throw cause;
    };

    const forwardInput = (data: Buffer): void => {
      // Post-commit barrier: preserve every byte in arrival order, raw. No
      // terminal semantics are inferred from buffered bytes. When journaling
      // (automatic handoff), the chunk is durably appended+fsynced FIRST, before
      // it is mirrored in memory; a synchronous append forbids any reorder. An
      // append failure stops automatic delivery loudly (handled at flush) but
      // still preserves the byte in memory.
      if (inputBarrier !== null) {
        if (handoffInputJournal !== null && handoffJournalDurable) {
          try {
            handoffInputJournal.appendChunk(data);
          } catch (cause) {
            handoffJournalDurable = false;
            wrapperLog.warn(
              `cc-lhc handoff: input journal append failed; buffered delivery will be withheld: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
        inputBarrier.push(Buffer.from(data));
        return;
      }
      const result = processInputChunk(data, inputState);
      inputState = result.state;
      debugInput(data, inputState);
      // User bytes reaching Claude bump input epoch so the governor can suppress
      // would_compact when the operator typed during the open turn.
      if (result.toPty.length > 0) {
        governorState = noteGovernorInput(governorState);
        currentPty.write(result.toPty);
      }
      applyActions(result.actions);
      renderModalPanel();
      armPendingEscTimer();
    };

    /** Per-child exit routing: expected handoff exits resolve the waiter; a
     * stale (replaced) child's exit is ignored; the live child's exit tears
     * down — except mid-handoff, where the failure surfaces via ready-wait. */
    const handleChildExit = (pty: IPty, exitCode: number, signal?: number): void => {
      if (expectedExitPty === pty) {
        expectedExitPty = null;
        const resolveWaiter = expectedExitResolve;
        expectedExitResolve = null;
        resolveWaiter?.();
        return;
      }
      if (pty !== currentPty) return;
      if (handoffInProgress) {
        childDiedDuringHandoff = true;
        return;
      }
      if (exited) return;
      void teardownAndExit(signal !== undefined && signal !== 0 ? 128 + signal : (exitCode ?? 1));
    };

    const attachChild = (pty: IPty): void => {
      currentPty = pty;
      currentChildOutputBytes = 0;
      pty.onData((data: string) => {
        // Non-semantic liveness signal only: count bytes, never parse them.
        if (pty === currentPty) currentChildOutputBytes += data.length;
        forwardOutput(data);
      });
      pty.onExit(({ exitCode, signal }) => {
        handleChildExit(pty, exitCode, signal);
      });
    };

    // ---- Slice 4: controlled handoff machinery ----
    const sigtermGraceMs = options.handoffTimeouts?.sigtermGraceMs ?? 3_000;
    const sigkillWaitMs = options.handoffTimeouts?.sigkillWaitMs ?? 2_000;
    const captureReadyTimeoutMs = options.handoffTimeouts?.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
    const childLivenessTimeoutMs = options.handoffTimeouts?.childLivenessTimeoutMs ?? DEFAULT_CHILD_LIVENESS_TIMEOUT_MS;
    const childStableWindowMs = options.handoffTimeouts?.childStableWindowMs ?? DEFAULT_CHILD_STABLE_WINDOW_MS;

    const waitForExpectedExit = (timeoutMs: number): Promise<boolean> =>
      new Promise<boolean>((resolveWait) => {
        if (expectedExitPty === null) {
          resolveWait(true);
          return;
        }
        const timer = setTimeout(() => {
          expectedExitResolve = null;
          resolveWait(false);
        }, timeoutMs);
        timer.unref?.();
        expectedExitResolve = () => {
          clearTimeout(timer);
          resolveWait(true);
        };
      });

    /** Spawn a claude child for `--resume <sessionId>` with a fresh opening
     * descriptor generation; attaches output/exit handlers. */
    const spawnHandoffChild = (sessionId: string): HandoffChild => {
      ensureSessionOwner(sessionId);
      let respawnArgv = respawnChildArgv(respawnRest, respawnPassthrough, sessionId);
      if (handoffRuntimeSettings !== undefined) {
        respawnArgv = applyClaudeRuntimeSettings(respawnArgv, handoffRuntimeSettings);
      }
      if (nativeBackstopArgs.length > 0) respawnArgv = [...nativeBackstopArgs, ...respawnArgv];
      // Fresh descriptor per child generation: the old one is closed at commit;
      // ready→ready with a different binding is an illegal transition.
      descriptorCapabilityRevoked = false;
      runtimeDescriptorPath = undefined;
      runtimeDescriptor = undefined;
      try {
        runtimeDescriptorPath = newDescriptorPath(undefined, descriptorIo);
        runtimeDescriptor = createOpeningDescriptor(runtimeDescriptorPath, descriptorIo);
      } catch (cause) {
        runtimeDescriptorPath = undefined;
        runtimeDescriptor = undefined;
        wrapperLog.warn(
          `cc-lhc handoff descriptor create failed (retrieval stays unavailable): ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const guided = injectRetrievalGuidance(respawnArgv);
      if (guided.ok) respawnArgv = guided.argv;
      else wrapperLog.warn(`cc-lhc handoff: retrieval guidance not injected: ${guided.reason}`);
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (runtimeDescriptorPath !== undefined) env[RUNTIME_DESCRIPTOR_ENV] = runtimeDescriptorPath;
      wrapperLog.info(`cc-lhc handoff spawn: ${claudeBin} ${respawnArgv.join(" ")}`);
      const pty = spawnPty(claudeBin, respawnArgv, {
        name: TERM_NAME,
        cols: stdout.columns ?? DEFAULT_COLS,
        rows: stdout.rows ?? DEFAULT_ROWS,
        cwd: process.cwd(),
        env,
      });
      attachChild(pty);
      return { write: (data: string) => pty.write(data) };
    };

    const awaitCaptureReadyAfterReplay = async (timeoutMs: number): Promise<"ready" | "degraded" | "timeout"> => {
      const startMs = Date.now();
      for (;;) {
        if (captureSession?.isCaptureReady() === true) return "ready";
        if (captureSession?.getCaptureHealth().phase === "degraded") return "degraded";
        if (childDiedDuringHandoff) return "degraded";
        if (Date.now() - startMs > timeoutMs) return "timeout";
        await new Promise((resolveTick) => {
          const tick = setTimeout(resolveTick, 25);
          tick.unref?.();
        });
      }
    };

    const recoveryDirPath = (): string => options.recoveryDir ?? join(ccLhcHome(), "recovery");

    const writeRecoveryArtifactFile = (artifact: RecoveryArtifact): string | null => {
      // When a durable journal owns the ordered bytes, reference it (path/id/state
      // + delivery-ambiguity flag) instead of duplicating base64. A journal whose
      // append failed mid-barrier keeps the memory base64 AND the (incomplete)
      // journal pointer. No journal (manual/backward) keeps base64 as before.
      let finalArtifact: RecoveryArtifact = artifact;
      const journal = handoffInputJournal;
      if (journal !== null) {
        const state = journal.currentState();
        const journalMeta = {
          inputJournalPath: journal.path,
          inputJournalId: journal.journalId,
          inputJournalState: state,
          deliveryIndeterminate: state === "delivering",
        };
        if (handoffJournalDurable) {
          const { bufferedInputBase64: _dropDurableBytes, ...rest } = artifact;
          finalArtifact = { ...rest, ...journalMeta };
        } else {
          finalArtifact = { ...artifact, ...journalMeta };
        }
      }
      try {
        const dir = recoveryDirPath();
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `handoff-${Date.now()}-${process.pid}.json`);
        writeFileSync(path, `${JSON.stringify(finalArtifact, null, 2)}\n`, { mode: 0o600 });
        return path;
      } catch (cause) {
        wrapperLog.warn(
          `cc-lhc handoff recovery artifact write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return null;
      }
    };

    /** Execute the controlled handoff for a rebuilt session. Shared by manual
     * compact/prune and the automatic governor path.
     * `recordOutcome` is invoked with the final result just before any fatal
     * teardown; it returns whether the terminal completion is DURABLE, which
     * gates delivered-journal cleanup. `recovery` (automatic path only) supplies
     * the owned receipt/attempt for durable stage instrumentation + journaling.
     * Manual compact/prune pass neither: no stages, no journal, unchanged.
     */
    const performHandoff = async (
      request: HandoffRequest,
      inputEpochChanged: () => boolean,
      recordOutcome?: (result: HandoffResult) => boolean,
      recovery?: { receiptId: string; attemptId: string },
    ): Promise<HandoffResult> => {
      handoffInProgress = true;
      childDiedDuringHandoff = false;
      handoffInputJournal = null;
      handoffJournalDurable = true;
      const leaseGeneration = captureSession?.getCaptureGeneration() ?? 0;
      const oldCaptureSnapshot = captureSession;
      handoffRuntimeSettings = { ...observedRuntimeSettings };
      const ports: HandoffPorts = {
        preCommitGate: (): string | null => {
          if (respawnUnsafeReason !== null) {
            return `respawn unavailable for this launch form: ${respawnUnsafeReason}`;
          }
          if (exited) return "wrapper exiting";
          if (oldCaptureSnapshot === undefined) return "capture not available";
          if (inputEpochChanged()) return "input arrived before commit";
          if (oldCaptureSnapshot.isTurnOpen()) return "turn opened during rebuild";
          if (!oldCaptureSnapshot.isCaptureReady()) return "capture not ready";
          if (oldCaptureSnapshot.getCaptureGeneration() !== leaseGeneration) {
            return "capture generation changed";
          }
          if (inputState.mode !== "passthrough") return "modal/UI owns the input line";
          return null;
        },
        beginInputBarrier: (): void => {
          inputBarrier = [];
        },
        flushInputBarrier: (child: HandoffChild): number => {
          const bytes = inputBarrier === null ? Buffer.alloc(0) : Buffer.concat(inputBarrier);
          inputBarrier = null;
          // Journal delivery is a fail-closed durable transition across the send
          // ambiguity: `delivering` is fsynced BEFORE any byte reaches the child;
          // a crash observed as `delivering` is INDETERMINATE and never replayed.
          // `delivered` is fsynced only after child.write returns.
          const journal = handoffInputJournal;
          if (journal !== null) journal.markDelivering();
          if (bytes.length > 0) {
            child.write(bytes.toString("latin1"));
            // These bytes reached the child without passing the hazard shadow.
            inputState = noteUntrackedDeliveredInput(inputState, bytes);
          }
          if (journal !== null) journal.markDelivered();
          return bytes.length;
        },
        inputBarrierDurable: (): boolean => handoffJournalDurable,
        takeInputBarrierBuffer: (): Buffer => {
          const bytes = inputBarrier === null ? Buffer.alloc(0) : Buffer.concat(inputBarrier);
          inputBarrier = null;
          return bytes;
        },
        closeOldDescriptor: (): void => {
          if (runtimeDescriptorPath === undefined) return;
          const path = runtimeDescriptorPath;
          const current = runtimeDescriptor;
          runtimeDescriptorPath = undefined;
          runtimeDescriptor = undefined;
          const rev = revokeCapability(path, current, "closed", undefined, descriptorIo);
          if (!rev.ok) {
            wrapperLog.warn(`cc-lhc handoff: old descriptor revoke unproven: ${rev.reason}`);
          }
        },
        terminateOldChild: async (): Promise<{ exited: boolean; escalated: boolean }> => {
          const pty = currentPty;
          expectedExitPty = pty;
          const initial = requestPtyTermination(pty, process.platform, "SIGTERM");
          wrapperLog.info(`cc-lhc handoff: requested child termination pid=${pty.pid} via ${initial.method}`);
          const graceful = await waitForExpectedExit(sigtermGraceMs);
          if (graceful) return { exited: true, escalated: false };
          const forced = await forceKillChildTree(pty.pid, {
            platform: process.platform,
            selfPid: process.pid,
            killGroup: (pid) => process.kill(-pid, "SIGKILL"),
            closePty: () => {
              if (process.platform === "win32") pty.kill();
              else pty.kill("SIGKILL");
            },
            taskkill: (pid) => runTaskkillTree(pid),
          });
          wrapperLog.info(
            `cc-lhc handoff: forced child termination pid=${pty.pid} via ${forced.method} ` +
              `(${forced.attempted.join(",") || "none"})`,
          );
          const killed = await waitForExpectedExit(sigkillWaitMs);
          if (!killed) expectedExitPty = null;
          return { exited: killed, escalated: true };
        },
        stopCurrentCapture: async (): Promise<void> => {
          await captureSession?.stop();
        },
        spawnChild: spawnHandoffChild,
        currentChild: (): HandoffChild => ({ write: (data: string) => currentPty.write(data) }),
        killCurrentChild: async (): Promise<void> => {
          const pty = currentPty;
          expectedExitPty = pty;
          expectedExitResolve = null;
          const forced = await forceKillChildTree(pty.pid, {
            platform: process.platform,
            selfPid: process.pid,
            killGroup: (pid) => process.kill(-pid, "SIGKILL"),
            closePty: () => {
              if (process.platform === "win32") pty.kill();
              else pty.kill("SIGKILL");
            },
            taskkill: (pid) => runTaskkillTree(pid),
          });
          wrapperLog.info(
            `cc-lhc handoff: cleanup child pid=${pty.pid} via ${forced.method} ` +
              `(${forced.attempted.join(",") || "none"})`,
          );
        },
        startRebuiltCapture: (handoffRequest: HandoffRequest): void => {
          const ctx = oldCaptureSnapshot?.getCommandContext();
          if (ctx?.sdk === undefined || ctx.threadRef === undefined || oldCaptureSnapshot === undefined) {
            throw new Error("no capture context to continue");
          }
          childDiedDuringHandoff = false;
          captureSession = startCaptureSession({
            startedAt: new Date(),
            noInference,
            continueCapture: {
              threadRef: ctx.threadRef,
              sdk: ctx.sdk,
              stats: oldCaptureSnapshot.stats,
              priorGeneration: oldCaptureSnapshot.getCaptureGeneration(),
            },
            expectedSession: {
              sessionId: handoffRequest.rebuilt.sessionId,
              source: "rebuilt_handoff",
            },
            knownRolloutPath: handoffRequest.rebuilt.rolloutPath,
            prefixBoundary: handoffRequest.rebuilt.prefixBoundary,
            suppressBindLineageRecord: true,
            lineageDbPath: defaultLineageDbPath(),
            log: (message) => wrapperLog.info(message),
            logError: (message) => wrapperLog.warn(message),
            onLifecycle: onCaptureLifecycle,
            onRuntimeSettings,
          });
        },
        startRollbackCapture: (oldSessionId: string): void => {
          const ctx = oldCaptureSnapshot?.getCommandContext();
          if (ctx?.sdk === undefined || ctx.threadRef === undefined || oldCaptureSnapshot === undefined) {
            throw new Error("no capture context to continue");
          }
          childDiedDuringHandoff = false;
          captureSession = startCaptureSession({
            startedAt: new Date(),
            noInference,
            continueCapture: {
              threadRef: ctx.threadRef,
              sdk: ctx.sdk,
              stats: oldCaptureSnapshot.stats,
              priorGeneration: captureSession?.getCaptureGeneration() ?? leaseGeneration,
            },
            expectedSession: { sessionId: oldSessionId, source: "explicit_resume" },
            resumeSessionId: oldSessionId,
            lineageDbPath: defaultLineageDbPath(),
            log: (message) => wrapperLog.info(message),
            logError: (message) => wrapperLog.warn(message),
            onLifecycle: onCaptureLifecycle,
            onRuntimeSettings,
          });
        },
        awaitCaptureReady: awaitCaptureReadyAfterReplay,
        awaitChildStabilized: async (
          timeoutMs: number,
          stableWindowMs: number,
        ): Promise<"stable" | "exited" | "timeout"> => {
          const tickWait = (): Promise<void> =>
            new Promise((resolveTick) => {
              const tick = setTimeout(resolveTick, 25);
              tick.unref?.();
            });
          const startMs = Date.now();
          // Phase 1: first PTY output from the replacement child.
          for (;;) {
            if (childDiedDuringHandoff) return "exited";
            if (currentChildOutputBytes > 0) break;
            if (Date.now() - startMs > timeoutMs) return "timeout";
            await tickWait();
          }
          // Phase 2: bounded stabilization — the child must survive the window.
          const stableStartMs = Date.now();
          for (;;) {
            if (childDiedDuringHandoff) return "exited";
            if (Date.now() - stableStartMs >= stableWindowMs) return "stable";
            await tickWait();
          }
        },
        registerSuccessLineage: async (handoffRequest: HandoffRequest) => {
          const outcome = await registerRebuiltSessionLineage({
            newSessionId: handoffRequest.rebuilt.sessionId,
            threadId: handoffRequest.threadId,
            prefixBoundary: handoffRequest.rebuilt.prefixBoundary,
            lineageDbPath: defaultLineageDbPath(),
            logError: (message) => wrapperLog.warn(message),
          });
          return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason };
        },
        publishReadyDescriptor: (): boolean => {
          publishDescriptorFromCapture();
          return runtimeDescriptor?.state === "ready";
        },
        writeRecoveryArtifact: writeRecoveryArtifactFile,
        log: (message) => wrapperLog.info(message),
      };

      // Concrete automatic-attempt stage port (LIM-80 3B1): proves exact child
      // identities through the native provider and advances durable stages via
      // advanceAttempt CAS. Only built for automatic attempts with a live store;
      // manual compact/prune pass none (no stages, no journal, unchanged).
      const stageDetail = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
      const store = governorReceiptStore;
      const recoveryStages: HandoffRecoveryStagePort | undefined =
        recovery === undefined || store === null
          ? undefined
          : {
              prepareBarrier: (): { ok: true } | { ok: false; reason: string } => {
                // Prove exact old-child identity FIRST; never synthesize from PID.
                const probed = readProcessIdentity(currentPty.pid);
                if (!probed.ok) return { ok: false, reason: `old-child identity ${probed.code}: ${probed.message}` };
                let journal: InputJournal;
                try {
                  journal = createInputJournal({
                    dir: recoveryDirPath(),
                    binding: {
                      receiptId: recovery.receiptId,
                      attemptId: recovery.attemptId,
                      oldSessionId: request.oldSessionId,
                      rebuiltSessionId: request.rebuilt.sessionId,
                    },
                  });
                } catch (cause) {
                  return { ok: false, reason: `input journal create failed: ${stageDetail(cause)}` };
                }
                // Safe order: durable FILE (above) -> durable STAGE (below). A
                // DEFINITE non-advanced result did not write, so SQLite cannot
                // reference the journal -> remove it. An INDETERMINATE thrown store
                // write MAY have landed and SQLite MAY reference the journal ->
                // RETAIN the orphan (bound header on disk), log its path, and cancel;
                // never unlink a possibly-referenced journal, never proceed.
                let adv: ReturnType<typeof store.advanceAttempt>;
                try {
                  adv = store.advanceAttempt({
                    receiptId: recovery.receiptId,
                    attemptId: recovery.attemptId,
                    stage: "rollout_written",
                    artifacts: {
                      oldChild: probed.identity,
                      inputJournalPath: journal.path,
                      inputJournalId: journal.journalId,
                    },
                  });
                } catch (cause) {
                  journal.close();
                  wrapperLog.warn(
                    `cc-lhc handoff: barrier stage write INDETERMINATE; retaining orphan journal ${journal.path}: ${stageDetail(cause)}`,
                  );
                  return { ok: false, reason: `barrier stage write indeterminate: ${stageDetail(cause)}` };
                }
                if (adv.kind !== "advanced" && adv.kind !== "unchanged") {
                  journal.close();
                  try {
                    removeInputJournal(journal.path);
                  } catch {
                    // best effort — the file has no delivered bytes and is unreferenced
                  }
                  return { ok: false, reason: `barrier stage CAS ${adv.kind}` };
                }
                handoffInputJournal = journal;
                handoffJournalDurable = true;
                return { ok: true };
              },
              recordOldChildExited: (): void => {
                const adv = store.advanceAttempt({
                  receiptId: recovery.receiptId,
                  attemptId: recovery.attemptId,
                  stage: "old_child_exited",
                });
                if (adv.kind !== "advanced" && adv.kind !== "unchanged") {
                  throw new Error(`old_child_exited CAS ${adv.kind}`);
                }
              },
              recordReplacementReady: (): { ok: true } | { ok: false; reason: string } => {
                // currentPty is now the replacement child; prove its exact identity.
                const probed = readProcessIdentity(currentPty.pid);
                if (!probed.ok) {
                  return { ok: false, reason: `replacement identity ${probed.code}: ${probed.message}` };
                }
                const adv = store.advanceAttempt({
                  receiptId: recovery.receiptId,
                  attemptId: recovery.attemptId,
                  stage: "replacement_ready",
                  artifacts: { replacementChild: probed.identity },
                });
                if (adv.kind !== "advanced" && adv.kind !== "unchanged") {
                  return { ok: false, reason: `replacement_ready CAS ${adv.kind}` };
                }
                return { ok: true };
              },
              recordLineageRecorded: (): void => {
                const adv = store.advanceAttempt({
                  receiptId: recovery.receiptId,
                  attemptId: recovery.attemptId,
                  stage: "lineage_recorded",
                });
                if (adv.kind !== "advanced" && adv.kind !== "unchanged") {
                  throw new Error(`lineage_recorded CAS ${adv.kind}`);
                }
              },
              recordDescriptorPublished: (): void => {
                const adv = store.advanceAttempt({
                  receiptId: recovery.receiptId,
                  attemptId: recovery.attemptId,
                  stage: "descriptor_published",
                });
                if (adv.kind !== "advanced" && adv.kind !== "unchanged") {
                  throw new Error(`descriptor_published CAS ${adv.kind}`);
                }
              },
            };

      try {
        const result = await executeHandoff(request, ports, {
          captureReadyTimeoutMs,
          childLivenessTimeoutMs,
          childStableWindowMs,
          ...(recoveryStages === undefined ? {} : { recoveryStages }),
        });
        // Last action records ONLY a confirmed handoff; anything else is a
        // last-attempt health note and never claims a successful compact.
        if (result.kind === "success") {
          lastAction = {
            operation: request.operation === "prune" ? "prune" : "compact",
            origin: request.metrics.origin,
            atMs: Date.now(),
            ...(request.metrics.triggerContextTokens === undefined
              ? {}
              : { triggerTokens: request.metrics.triggerContextTokens }),
            ...(request.metrics.viewTokens === undefined ? {} : { viewTokens: request.metrics.viewTokens }),
            ...(request.metrics.targetTokens === undefined ? {} : { targetTokens: request.metrics.targetTokens }),
            ...(request.metrics.zoneTokensBefore === undefined ? {} : { zoneBefore: request.metrics.zoneTokensBefore }),
            ...(request.metrics.zoneTokensAfter === undefined ? {} : { zoneAfter: request.metrics.zoneTokensAfter }),
          };
        } else {
          lastAttempt = {
            summary:
              result.kind === "cancelled"
                ? `${request.operation} cancelled: ${result.reason}`
                : result.kind === "rolled_back"
                  ? `${request.operation} rolled back: ${result.reason}`
                  : `${request.operation} FAILED: ${result.reason}`,
            atMs: Date.now(),
          };
        }
        if (result.kind !== "success" && result.kind !== "cancelled") {
          // Rollback replays the old rollout: its lifecycle re-derives the same
          // provider pressure. Cool down so a failed handoff cannot self-retrigger.
          autoBlockedUntilMs = Date.now() + HANDOFF_FAILURE_COOLDOWN_MS;
        }
        // Automatic path records the final outcome onto its owned attempt via
        // completeAttempt (atomic attempt+receipt). Fires BEFORE any fatal
        // teardown so a no-live-child failure is still durable. Manual path
        // passes no sink and leaves governor receipts alone. The returned bool is
        // whether that terminal completion is DURABLE — it gates journal cleanup.
        const completionDurable = recordOutcome?.(result) ?? false;
        options.onHandoffResult?.(result);
        // Delete a DELIVERED journal ONLY after the full terminal attempt+receipt
        // completion is durable. A failed handoff, a withheld (non-durable) barrier,
        // or a completion-persistence failure RETAINS it for recovery (the artifact
        // references it). The recovery artifact was already written inside
        // executeHandoff while the journal pointer was still live.
        // Cast: the stage port sets handoffInputJournal via a closure the compiler
        // cannot see, so its flow-narrowed `null` type must be widened back.
        const journalToSettle = handoffInputJournal as InputJournal | null;
        handoffInputJournal = null;
        if (journalToSettle !== null) {
          const deliveredCleanly =
            handoffJournalDurable && (result.kind === "success" || result.kind === "rolled_back");
          journalToSettle.close();
          if (completionDurable && deliveredCleanly) {
            // Delete ONLY after the terminal attempt+receipt completion is durable;
            // the unlink also fsyncs the directory removal where supported.
            try {
              removeInputJournal(journalToSettle.path);
            } catch (cause) {
              wrapperLog.warn(
                `cc-lhc handoff: delivered journal cleanup failed (retained): ${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          } else {
            wrapperLog.info(
              `cc-lhc handoff: input journal retained ${journalToSettle.path} (result=${result.kind}, completionDurable=${completionDurable})`,
            );
          }
        }
        if (result.kind === "failed" && !result.childAlive) {
          wrapperLog.warn(
            `cc-lhc handoff failed with no live child; exiting. old=${result.oldSessionId} rebuilt=${result.rebuiltSessionId} recovery=${result.recoveryArtifactPath ?? "UNWRITTEN"}`,
          );
          await teardownAndExit(1);
        }
        return result;
      } finally {
        handoffInProgress = false;
        handoffRuntimeSettings = undefined;
      }
    };

    // ── Automatic operation + recovery (LIM-80 Slice 3A) ────────────────
    // Fresh auto operations and recovery of a crash-interrupted receipt share
    // one mutation path, one concrete store-backed port, and the single-flight
    // command guard. After a claim, EVERY terminal outcome uses completeAttempt
    // (atomic attempt+receipt) — never attachHandoffOutcome.

    const recoveryDetailOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

    const frozenTriggerFromReceipt = (receipt: GovernorDurableReceipt): number | null =>
      receipt.pressure.nextRequestPressureTokens ?? receipt.providerContextTotal;

    /** Build a full recorded verification from durable artifacts, or undefined. */
    const recordedVerificationOf = (
      artifacts: RecoveryAttempt["artifacts"],
    ): RolloutVerificationArtifacts | undefined => {
      const a = artifacts;
      if (
        a.rebuiltSessionId === undefined ||
        a.rebuiltRolloutPath === undefined ||
        a.rolloutFullSha256 === undefined ||
        a.rolloutPrefixSha256 === undefined ||
        a.rolloutPrefixLineCount === undefined ||
        a.rolloutPrefixByteLength === undefined ||
        a.rolloutLineCount === undefined ||
        a.rolloutByteLength === undefined
      ) {
        return undefined;
      }
      return {
        rebuiltSessionId: a.rebuiltSessionId,
        rebuiltRolloutPath: a.rebuiltRolloutPath,
        rolloutFullSha256: a.rolloutFullSha256,
        rolloutPrefixSha256: a.rolloutPrefixSha256,
        rolloutPrefixLineCount: a.rolloutPrefixLineCount,
        rolloutPrefixByteLength: a.rolloutPrefixByteLength,
        rolloutLineCount: a.rolloutLineCount,
        rolloutByteLength: a.rolloutByteLength,
      };
    };

    const makeRecoveryPort = (receiptId: string, attemptId: string, runtime: LhcCommandRuntime): RecoveryPort => {
      if (governorReceiptStore === null) throw new Error("recovery port requires a durable receipt store");
      return createStoreBackedRecoveryPort({
        store: governorReceiptStore,
        receiptId,
        attemptId,
        cwd: runtime.cwd,
        threadId: runtime.threadRef !== undefined ? threadIdFromRef(runtime.threadRef) : "",
        oldSessionId: runtime.sourceSessionId ?? "unknown",
        ...(options.recoveryProjectsRoot !== undefined ? { projectsRoot: options.recoveryProjectsRoot } : {}),
        ...(options.recoverySessionIdFn !== undefined ? { newSessionId: options.recoverySessionIdFn } : {}),
      });
    };

    const buildAutoPlan = (frozenTriggerTokens: number | null, epochChanged: () => boolean): ContextMutationPlan => {
      const policy = resolvedContextPolicy.policy;
      return {
        operation: "auto_compact",
        profile: policy.profile,
        lowerBoundTokens: policy.lowerBoundTokens,
        ...(policy.pruneEnabled && policy.pruneThresholdTokens !== null && policy.pruneTargetTokens !== null
          ? { pruneIfDue: { thresholdTokens: policy.pruneThresholdTokens, targetTokens: policy.pruneTargetTokens } }
          : {}),
        ...(frozenTriggerTokens === null ? {} : { triggerContextTokens: frozenTriggerTokens }),
        inputEpochChanged: epochChanged,
      };
    };

    /**
     * Run the fenced SDK mutation through the concrete port for a claimed
     * attempt. Non-rebuilt outcomes complete the attempt with the truthful
     * mutation result; a rebuilt outcome runs the shared handoff and completes
     * with the final handoff result. Command guard / operationInFlight are owned
     * by the caller.
     */
    /** Material durable progress / terminal completion clears the retry budget. */
    const resetRecoveryRetries = (receiptId: string): void => {
      recoveryRetries.delete(receiptId);
    };

    const scheduleRecoveryRetry = (receiptId: string, trigger: "replay" | "startup", why: string): void => {
      if (exited) return;
      const n = (recoveryRetries.get(receiptId) ?? 0) + 1;
      recoveryRetries.set(receiptId, n);
      if (n > RECOVERY_MAX_RETRIES) {
        // Exhausted: the receipt stays visibly OPEN (scheduled/attempt intact).
        // A later lifecycle trigger (fresh observe, restart scan) can resume once
        // material progress resets the budget.
        wrapperLog.warn(
          `cc-lhc governor: recovery ${receiptId} retries exhausted (${why}); left open for a later pass`,
        );
        return;
      }
      const timer = setTimeout(() => {
        void runRecovery(receiptId, trigger);
      }, RECOVERY_RETRY_DELAY_MS);
      if (typeof timer.unref === "function") timer.unref();
    };

    /** Current durable stage of an attempt (null if unclaimed/unreadable). */
    const attemptStageOf = (receiptId: string): RecoveryStage | null => {
      if (governorReceiptStore === null) return null;
      try {
        return governorReceiptStore.getAttempt(receiptId)?.stage ?? null;
      } catch {
        return null;
      }
    };

    /** True when the durable stage strictly advanced between two observations. */
    const stageAdvanced = (before: RecoveryStage | null, after: RecoveryStage | null): boolean =>
      before !== null && after !== null && recoveryStageIndex(after) > recoveryStageIndex(before);

    /**
     * Run the fenced SDK mutation through the concrete port for a claimed
     * attempt. Repairability (LIM-80 Slice 3A): ONLY proven-terminal results
     * complete the attempt (final handoff result, terminal_noop, permanent
     * capability refusal, structural port CAS conflict). A transient/recoverable
     * outcome (retryable_pre_mutation / recoverable_post_mutation) or a transient
     * store I/O throw leaves the attempt OPEN and schedules a bounded retry; the
     * next recovery pass re-plans from durable facts and never re-compacts a
     * view that already landed. Command guard / operationInFlight are the
     * caller's. Manual behavior is unaffected (this path is auto-only).
     */
    const runMutationClaimed = async (
      receiptId: string,
      attemptId: string,
      frozenTriggerTokens: number | null,
    ): Promise<void> => {
      const stageBefore = attemptStageOf(receiptId);
      const completeTerminal = (outcome: Exclude<GovernorHandoffOutcome, { kind: "scheduled" }>): boolean => {
        const ok = completeGovernorAttempt(receiptId, attemptId, outcome);
        if (ok) resetRecoveryRetries(receiptId);
        return ok;
      };
      const leaveOpen = (label: string): void => {
        if (stageAdvanced(stageBefore, attemptStageOf(receiptId))) resetRecoveryRetries(receiptId);
        wrapperLog.info(`cc-lhc governor: auto operation ${receiptId} left OPEN (${label}); will retry/re-plan`);
        scheduleRecoveryRetry(receiptId, "replay", label);
      };
      try {
        const epochAtStart = governorState.currentInputEpoch;
        const epochChanged = (): boolean => governorState.currentInputEpoch !== epochAtStart;
        const runtime = commandRuntime();
        if (runtime.captureDisabled) {
          // Permanent capability refusal for this launch: terminal.
          completeTerminal({ kind: "mutation_refused", detail: "capture disabled" });
          return;
        }
        const port = makeRecoveryPort(receiptId, attemptId, runtime);
        const plan = buildAutoPlan(frozenTriggerTokens, epochChanged);
        const outcome = await runContextMutation(plan, { ...runtime, inputEpochChanged: epochChanged }, port);
        wrapperLog.info(
          `cc-lhc auto-compact mutation ${outcome.kind}/${outcome.kind === "rebuilt" ? "handoff" : (outcome.disposition ?? "open")}: ${outcome.messages.join(" | ") || "(no receipt)"}`,
        );
        if (outcome.kind === "rebuilt") {
          await performHandoff(
            outcome.handoff,
            epochChanged,
            (result) => completeTerminal(governorOutcomeFromHandoffResult(result)),
            { receiptId, attemptId },
          );
          return;
        }
        lastAttempt = {
          summary: `auto compact ${outcome.kind}: ${outcome.messages[outcome.messages.length - 1] ?? "(no detail)"}`,
          atMs: Date.now(),
        };
        const detail = outcome.messages.join(" | ") || outcome.kind;
        if (outcome.disposition === "terminal_noop") {
          completeTerminal({ kind: "mutation_noop", detail });
          return;
        }
        if (outcome.disposition === "terminal_refused") {
          completeTerminal({ kind: "mutation_refused", detail });
          return;
        }
        // retryable_pre_mutation / recoverable_post_mutation (or, defensively, an
        // unclassified non-rebuilt outcome): OPEN, never terminalized here.
        leaveOpen(`${outcome.kind}:${outcome.disposition ?? "open"}`);
      } catch (cause) {
        if (cause instanceof RecoveryPortCasError) {
          // Structural correlation conflict on the owned attempt: terminal.
          wrapperLog.warn(
            `cc-lhc governor: auto operation ${receiptId} structural conflict (${cause.conflict}); refuse`,
          );
          completeTerminal({ kind: "mutation_refused", detail: `recovery port conflict: ${cause.conflict}` });
          return;
        }
        // Transient store I/O or SDK throw: nothing proven terminal — leave open.
        wrapperLog.warn(`cc-lhc governor: auto operation ${receiptId} threw (transient): ${recoveryDetailOf(cause)}`);
        leaveOpen("operation threw");
      }
    };

    const buildRecoveryObservation = async (
      self: ProcessIdentity,
      attempt: RecoveryAttempt | null,
      runtime: LhcCommandRuntime,
    ): Promise<RecoveryObservation> => {
      const observed: RecoveryObservation = { self };
      if (attempt !== null && !identitiesEqual(attempt.owner, self)) {
        observed.ownerLiveness = probeOwnerLiveness(attempt.owner);
      }
      if (runtime.sdk !== undefined && runtime.threadRef !== undefined) {
        observed.currentView = await observeCurrentStoredView(runtime.sdk, runtime.threadRef);
      }
      return observed;
    };

    /**
     * Recover the rollout stage from durable artifacts and reach one verified
     * HandoffRequest (requirement 5/6). No second native compact: the installed
     * view is authoritative. Records view_installed / reservation / rollout_written
     * as needed, then enters the existing performHandoff and completes the attempt
     * with the final result. retry leaves the receipt open; invalid fails closed.
     */
    const recoverRolloutAndHandoff = async (
      receiptId: string,
      attempt: RecoveryAttempt,
      receipt: GovernorDurableReceipt,
      runtime: LhcCommandRuntime,
      currentView: RecoveryObservation["currentView"],
    ): Promise<void> => {
      const a = attempt.artifacts;
      const stageBefore = attempt.stage;
      const completeTerminal = (outcome: Exclude<GovernorHandoffOutcome, { kind: "scheduled" }>): boolean => {
        const ok = completeGovernorAttempt(receiptId, attempt.attemptId, outcome);
        if (ok) resetRecoveryRetries(receiptId);
        return ok;
      };
      const leaveOpen = (label: string): void => {
        if (stageAdvanced(stageBefore, attemptStageOf(receiptId))) resetRecoveryRetries(receiptId);
        scheduleRecoveryRetry(receiptId, "replay", label);
      };
      // A port write failure: a structural CAS conflict is terminal; any other
      // (transient store I/O) leaves the attempt OPEN and retries.
      const onPortFailure = (cause: unknown, label: string): void => {
        if (cause instanceof RecoveryPortCasError) {
          wrapperLog.warn(
            `cc-lhc governor: recovery ${receiptId} ${label} structural conflict (${cause.conflict}); refuse`,
          );
          completeTerminal({ kind: "mutation_refused", detail: `recovery port conflict: ${cause.conflict}` });
        } else {
          wrapperLog.warn(
            `cc-lhc governor: recovery ${receiptId} ${label} transient store failure; left open: ${recoveryDetailOf(cause)}`,
          );
          leaveOpen(`${label} transient`);
        }
      };

      const port = makeRecoveryPort(receiptId, attempt.attemptId, runtime);

      // Expected installed fingerprint: the recorded one at view_installed+, or
      // the freshly observed install when reconciling from operation_claimed.
      let expectedFingerprint = a.installedViewFingerprint;
      if (expectedFingerprint === undefined) {
        if (currentView === undefined || currentView.kind !== "present") {
          wrapperLog.info(`cc-lhc governor: recovery ${receiptId} — installed view not observed present; retry`);
          leaveOpen("view not present");
          return;
        }
        expectedFingerprint = currentView.fingerprint;
        try {
          port.recordViewInstalled({ viewId: currentView.viewId, installedViewFingerprint: currentView.fingerprint });
        } catch (cause) {
          onPortFailure(cause, "view_installed record");
          return;
        }
      }

      const triggerTokens = frozenTriggerFromReceipt(receipt);
      const durableReceipt =
        a.durableReceipt ??
        formatDurableReceipt("auto_compact", {
          origin: "auto",
          ...(triggerTokens === null ? {} : { triggerContextTokens: triggerTokens }),
        });
      let reserved: { sessionId: string; rolloutPath: string };
      try {
        reserved = port.reserveRebuiltSession(durableReceipt);
      } catch (cause) {
        onPortFailure(cause, "reservation");
        return;
      }

      const recorded = recordedVerificationOf(a);
      const result = await recoverReservedRollout({
        runtime,
        reservedSessionId: reserved.sessionId,
        reservedRolloutPath: reserved.rolloutPath,
        durableReceiptText: durableReceipt,
        expectedInstalledFingerprint: expectedFingerprint,
        operation: "auto_compact",
        ...(recorded === undefined ? {} : { recorded }),
        ...(options.recoveryProjectsRoot !== undefined ? { projectsRoot: options.recoveryProjectsRoot } : {}),
      });

      if (result.kind === "reused" || result.kind === "rematerialized") {
        try {
          port.recordRolloutWritten(result.verification);
        } catch (cause) {
          onPortFailure(cause, "rollout_written record");
          return;
        }
        if (stageAdvanced(stageBefore, attemptStageOf(receiptId))) resetRecoveryRetries(receiptId);
        const epochAtStart = governorState.currentInputEpoch;
        const epochChanged = (): boolean => governorState.currentInputEpoch !== epochAtStart;
        await performHandoff(
          result.handoff,
          epochChanged,
          (r) => completeTerminal(governorOutcomeFromHandoffResult(r)),
          { receiptId, attemptId: attempt.attemptId },
        );
        return;
      }
      if (result.kind === "retry") {
        // Transient: unreadable reserved file / unreadable-or-drifted view / index
        // not yet ensured. Never overwrite; leave open and re-plan.
        wrapperLog.info(`cc-lhc governor: recovery ${receiptId} rollout retry: ${result.reason}`);
        leaveOpen("rollout retry");
        return;
      }
      // Structural correlation contradiction / recorded-verification mismatch:
      // fail closed (terminal).
      completeTerminal({ kind: "mutation_refused", detail: `recovery invalid: ${result.reason}` });
    };

    const dispatchRecoveryAction = async (
      receiptId: string,
      receipt: GovernorDurableReceipt,
      attempt: RecoveryAttempt | null,
      action: RecoveryAction,
      observed: RecoveryObservation,
      runtime: LhcCommandRuntime,
      self: ProcessIdentity,
    ): Promise<void> => {
      if (governorReceiptStore === null) return;
      switch (action.kind) {
        case "claim_scheduled_work": {
          const claim = governorReceiptStore.claimAttempt({ receiptId, owner: self });
          if (claim.kind === "claimed" || claim.kind === "already_owned") {
            await runMutationClaimed(receiptId, claim.attempt.attemptId, frozenTriggerFromReceipt(receipt));
          } else if (claim.kind === "receipt_terminal") {
            wrapperLog.info(
              `cc-lhc governor: recovery ${receiptId} — receipt already terminal (${claim.outcome.kind})`,
            );
          } else if (claim.kind === "held") {
            wrapperLog.info(`cc-lhc governor: recovery ${receiptId} — held by owner (${claim.ownerLiveness}); wait`);
            scheduleRecoveryRetry(receiptId, "replay", "held after claim");
          } else {
            wrapperLog.warn(`cc-lhc governor: recovery ${receiptId} — claim result ${claim.kind}; left open`);
          }
          return;
        }
        case "reclaim_dead_owner": {
          if (attempt === null || observed.ownerLiveness === undefined) {
            wrapperLog.warn(`cc-lhc governor: recovery ${receiptId} — reclaim without attempt/liveness; left open`);
            return;
          }
          const claim = governorReceiptStore.claimAttempt({
            receiptId,
            owner: self,
            reclaim: { expectedAttemptId: attempt.attemptId, ownerLiveness: observed.ownerLiveness },
          });
          if (claim.kind === "reclaimed" || claim.kind === "claimed" || claim.kind === "already_owned") {
            // Follow the resume plan with the now-owned attempt.
            await dispatchRecoveryAction(receiptId, receipt, claim.attempt, action.resume, observed, runtime, self);
          } else if (claim.kind === "held") {
            wrapperLog.info(`cc-lhc governor: recovery ${receiptId} reclaim → held (${claim.ownerLiveness}); wait`);
            scheduleRecoveryRetry(receiptId, "replay", "held on reclaim");
          } else {
            wrapperLog.warn(`cc-lhc governor: recovery ${receiptId} reclaim result ${claim.kind}; re-plan later`);
            scheduleRecoveryRetry(receiptId, "replay", `reclaim ${claim.kind}`);
          }
          return;
        }
        case "reprepare_from_scratch": {
          if (attempt === null) {
            wrapperLog.warn(`cc-lhc governor: recovery ${receiptId} — reprepare without attempt; left open`);
            return;
          }
          await runMutationClaimed(receiptId, attempt.attemptId, frozenTriggerFromReceipt(receipt));
          return;
        }
        case "reconcile_installed_view":
        case "verify_reuse_rollout": {
          if (attempt === null) {
            wrapperLog.warn(`cc-lhc governor: recovery ${receiptId} — ${action.kind} without attempt; left open`);
            return;
          }
          await recoverRolloutAndHandoff(receiptId, attempt, receipt, runtime, observed.currentView);
          return;
        }
        case "wait_for_owner":
        case "retry_observation": {
          scheduleRecoveryRetry(receiptId, "replay", action.kind);
          return;
        }
        case "reconcile_attempt_terminal": {
          if (attempt === null) return;
          const terminal = receipt.handoffOutcome;
          if (terminal === null || terminal.kind === "scheduled") {
            wrapperLog.warn(
              `cc-lhc governor: recovery ${receiptId} reconcile_attempt_terminal without terminal receipt`,
            );
            return;
          }
          // Align bookkeeping using the FULL existing receipt outcome, never a
          // reconstruction from kind alone (requirement 8).
          if (completeGovernorAttempt(receiptId, attempt.attemptId, terminal)) resetRecoveryRetries(receiptId);
          return;
        }
        case "terminal_complete": {
          wrapperLog.info(
            `cc-lhc governor: recovery ${receiptId} terminal_complete (${action.outcomeKind}); nothing to do`,
          );
          resetRecoveryRetries(receiptId);
          return;
        }
        case "terminal_refuse": {
          // Only terminalize when we own an attempt; never fabricate a refusal
          // for ordinary missing/unreadable optional state.
          if (attempt !== null && identitiesEqual(attempt.owner, self)) {
            if (
              completeGovernorAttempt(receiptId, attempt.attemptId, {
                kind: "mutation_refused",
                detail: `recovery refused: ${action.reason}`,
              })
            ) {
              resetRecoveryRetries(receiptId);
            }
          } else {
            wrapperLog.warn(
              `cc-lhc governor: recovery ${receiptId} terminal_refuse (${action.reason}); no owned attempt — left as-is`,
            );
          }
          return;
        }
        default: {
          // Slice 3B: child termination/spawn, replacement/lineage/descriptor
          // advancement, and mid-handoff recovery are not implemented in 3A. The
          // receipt is left open (durable blocked state) rather than faking a stage.
          wrapperLog.warn(
            `cc-lhc governor: recovery ${receiptId} needs Slice 3B (${action.kind}); left open for a later build`,
          );
          return;
        }
      }
    };

    // Fresh automatic operation. Early gates (exited / handoff / command-guard)
    // run BEFORE any claim and terminalize via attach (no attempt exists yet).
    // After the guard is held and self identity resolves, claim the receipt,
    // then run the shared claimed-mutation path.
    runAutoOperation = async (args: { frozenTriggerTokens: number | null; receiptId: string }): Promise<void> => {
      const { frozenTriggerTokens, receiptId } = args;
      let forceExitedForAuto = false;
      options.onBeforeAutoOperation?.({
        markHandoffInProgress: () => {
          handoffInProgress = true;
        },
        clearHandoffInProgress: () => {
          handoffInProgress = false;
        },
        markExited: () => {
          forceExitedForAuto = true;
        },
      });
      if (exited || forceExitedForAuto) {
        attachGovernorHandoffOutcome(
          receiptId,
          {
            kind: "mutation_deferred",
            detail: "wrapper exiting before auto operation claimed receipt",
            reason: "wrapper_exiting",
          },
          { mutationBegan: false },
        );
        return;
      }
      if (handoffInProgress) {
        attachGovernorHandoffOutcome(
          receiptId,
          {
            kind: "mutation_deferred",
            detail: "handoff in progress before auto operation claimed receipt",
            reason: "handoff_in_progress",
          },
          { mutationBegan: false },
        );
        return;
      }
      if (!commandGuard.tryAcquire("auto-compact", Date.now())) {
        const busy = commandGuard.current();
        const busyLabel = busy?.label ?? "unknown";
        attachGovernorHandoffOutcome(
          receiptId,
          {
            kind: "mutation_deferred",
            detail: `command guard busy (${busyLabel}); auto compact not started`,
            reason: "command_guard_busy",
          },
          { mutationBegan: false },
        );
        wrapperLog.info(
          `cc-lhc governor: auto-compact deferred — command guard busy (${busyLabel}) [receipt ${receiptId}]`,
        );
        lastAttempt = { summary: `auto compact deferred: command_guard_busy (${busyLabel})`, atMs: Date.now() };
        return;
      }
      governorState = setGovernorOperationInFlight(governorState, true);
      try {
        if (governorReceiptStore === null) {
          wrapperLog.warn(`cc-lhc governor: auto-compact aborted — receipt store unavailable [receipt ${receiptId}]`);
          return;
        }
        const self = resolveSelfIdentity();
        if (!self.ok) {
          // Self identity unavailable/indeterminate is RECOVERABLE, not a
          // dismissal: leave the receipt scheduled with NO attempt and retry.
          // Never synthesize an identity, never terminalize.
          wrapperLog.info(
            `cc-lhc governor: auto-compact deferred — self identity ${self.code}; left scheduled, will retry [receipt ${receiptId}]`,
          );
          scheduleRecoveryRetry(receiptId, "replay", "self identity unavailable");
          return;
        }
        // Claim the receipt BEFORE any SDK mutation.
        const claim = governorReceiptStore.claimAttempt({ receiptId, owner: self.identity });
        if (claim.kind === "claimed" || claim.kind === "already_owned") {
          await runMutationClaimed(receiptId, claim.attempt.attemptId, frozenTriggerTokens);
          return;
        }
        if (claim.kind === "receipt_terminal") {
          wrapperLog.info(
            `cc-lhc governor: auto-compact skipped — receipt ${receiptId} already terminal (${claim.outcome.kind})`,
          );
          return;
        }
        // A freshly scheduled receipt should claim cleanly. `held` means another
        // owner raced us: leave visibly OPEN and retry (never steal, never mutate).
        // Anything else (store race / gone / stale) is left as-is for a later pass.
        if (claim.kind === "held") {
          wrapperLog.info(
            `cc-lhc governor: auto-compact not started — held by owner (${claim.ownerLiveness}); retry [receipt ${receiptId}]`,
          );
          scheduleRecoveryRetry(receiptId, "replay", "held on fresh claim");
        } else {
          wrapperLog.warn(
            `cc-lhc governor: auto-compact not started — claim result ${claim.kind} [receipt ${receiptId}]`,
          );
        }
      } catch (cause) {
        // A pre-claim receipt-store/native-provider failure is recoverable: no
        // attempt owns the work and no SDK mutation started. Keep the receipt
        // scheduled and retry through the shared recovery path.
        wrapperLog.warn(
          `cc-lhc governor: auto-compact claim failed transiently; left scheduled [receipt ${receiptId}]: ${recoveryDetailOf(cause)}`,
        );
        scheduleRecoveryRetry(receiptId, "replay", "fresh claim exception");
      } finally {
        governorState = setGovernorOperationInFlight(governorState, false);
        commandGuard.release();
      }
    };

    // Single-flight recovery of one durable receipt (exact replay + startup
    // scan coalesce here). Runs under the same command guard as auto ops.
    runRecovery = async (receiptId: string, trigger: "replay" | "startup"): Promise<void> => {
      if (governorReceiptStore === null || exited) return;
      if (recoveryInFlight.has(receiptId)) return; // coalesce concurrent passes
      if (autoOperationScheduled) {
        scheduleRecoveryRetry(receiptId, trigger, "auto operation scheduled");
        return;
      }
      recoveryInFlight.add(receiptId);
      if (!commandGuard.tryAcquire("auto-recovery", Date.now())) {
        recoveryInFlight.delete(receiptId);
        scheduleRecoveryRetry(receiptId, trigger, "command guard busy");
        return;
      }
      governorState = setGovernorOperationInFlight(governorState, true);
      try {
        const self = resolveSelfIdentity();
        if (!self.ok) {
          wrapperLog.info(`cc-lhc governor: recovery ${receiptId} deferred — self identity ${self.code}`);
          scheduleRecoveryRetry(receiptId, trigger, "self identity");
          return;
        }
        const receipt = governorReceiptStore.getById(receiptId);
        if (receipt === null) {
          wrapperLog.warn(`cc-lhc governor: recovery ${receiptId} — receipt missing`);
          return;
        }
        let attempt: RecoveryAttempt | null;
        try {
          // Malformed attempt rows throw: fail loud/closed, do not mutate.
          attempt = governorReceiptStore.getAttempt(receiptId);
        } catch (cause) {
          wrapperLog.warn(
            `cc-lhc governor: recovery ${receiptId} — attempt row unreadable (fail closed): ${recoveryDetailOf(cause)}`,
          );
          return;
        }
        const runtime = commandRuntime();
        const observed = await buildRecoveryObservation(self.identity, attempt, runtime);
        const action = planRecovery({ receiptId, handoffOutcome: receipt.handoffOutcome, attempt, observed });
        wrapperLog.info(`cc-lhc governor: recovery ${receiptId} (${trigger}) → ${action.kind}: ${action.reason}`);
        await dispatchRecoveryAction(receiptId, receipt, attempt, action, observed, runtime, self.identity);
      } catch (cause) {
        wrapperLog.warn(`cc-lhc governor: recovery ${receiptId} error: ${recoveryDetailOf(cause)}; left open`);
        scheduleRecoveryRetry(receiptId, trigger, "recovery exception");
      } finally {
        governorState = setGovernorOperationInFlight(governorState, false);
        commandGuard.release();
        recoveryInFlight.delete(receiptId);
      }
    };

    attachChild(currentPty);
    stdin.on("data", forwardInput);
    // stdin ending/erroring has no wrapper lifecycle of its own (the child
    // and capture run on) — but with no input left there is no keypress to
    // dismiss a modal, so restore the terminal before those semantics apply.
    stdin.on("end", onStdinGone);
    stdin.on("close", onStdinGone);
    stdin.on("error", onStdinError);
  });
}

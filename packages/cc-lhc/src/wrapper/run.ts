import { randomUUID } from "node:crypto";

import { spawn as defaultSpawn, type IPty } from "@lydell/node-pty";

import {
  type ContextMutationPlan,
  formatTokensShort,
  type HandoffRequest,
  runContextMutation,
} from "../commands/context-mutation.js";
import { type DispatchOutcome, dispatchLhcCommand, type LhcCommandRuntime } from "../commands/dispatch.js";
import { formatRebuildRelaunchGuidance, registerRebuiltSessionLineage } from "../commands/rebuild-receipt.js";
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
  formatConfigFallbackNotice,
  isTerminalHandoffOutcome,
  loadContextPolicy,
  noteGovernorInput,
  openGovernorReceiptStore,
  policySourcesSummary,
  projectConfigPath,
  reobserveSettled,
  type ResolvedContextPolicy,
  setGovernorCaptureGeneration,
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
import { openLaunchThread } from "../intake/launch-thread.js";
import { defaultLineageDbPath } from "../intake/lineage-db.js";
import { ccLhcHome, defaultRegistryPath } from "../intake/paths.js";
import { type CaptureSession, createCaptureThread, startCaptureSession } from "../intake/session.js";
import { type LaunchThreadBinding, recordSwapAcceptance } from "../intake/thread-alias.js";
import { asyncWorkIdentity, type OpenAsyncWork } from "../observation/async-work.js";
import type { LifecycleSignal } from "../observation/types.js";
import { injectRetrievalGuidance } from "../retrieval/guidance.js";
import type { ExpectedSession } from "../rollout/expected-session.js";
import { applyClaudeRuntimeSettings, type ClaudeRuntimeSettings } from "../rollout/runtime-settings.js";
import { statRolloutFile } from "../rollout/stat-file.js";
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
import { ProcessIdentityUnavailableError } from "../runtime/process-identity.js";
import { type ThreadOwnerLease, ThreadOwnershipConflictError } from "../runtime/thread-owner.js";
import { emptyCaptureStats, formatCaptureStatsLine } from "../stats.js";
import { forceKillChildTree, requestPtyTermination, runTaskkillTree } from "./child-termination.js";
import { CommandInFlightGuard, formatBusyMessage } from "./command-guard.js";
import { type CompactConfirmDisposition, compactConfirmRows, describeDecline } from "./compact-confirm.js";
import {
  type CandidateChild,
  type CandidateViability,
  DEFAULT_CAPTURE_READY_TIMEOUT_MS,
  DEFAULT_CHILD_LIVENESS_TIMEOUT_MS,
  DEFAULT_CHILD_STABLE_WINDOW_MS,
  DEFAULT_REPLACEMENT_ATTEMPTS,
  executeHandoff,
  formatHandoffResult,
  type HandoffPorts,
  type HandoffResult,
  type SwitchOutcome,
} from "./handoff.js";
import { createInputDebugLogger } from "./input-debug.js";
import { consumeLegacyHandoffState } from "./legacy-handoff-state.js";
import {
  createInputState,
  finishExecuting,
  forceResetInput,
  type InputState,
  openCompactConfirm,
  processInputChunk,
  resolveBareEsc,
  resolveLeaderByte,
  showLateReceipts,
  showReceipts,
} from "./modal.js";
import {
  argvSuppliesNativeAutocompact,
  NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY,
  nativeAutoCompactChildEnv,
} from "./native-auto-compact.js";
import { OutputHold } from "./output-hold.js";
import { createAltScreenGuard, renderPanel } from "./panel.js";
import {
  formatReplacementNonviabilityAlarm,
  formatSurvivalRelaunchNotice,
  NONVIABLE_SWAPS_BEFORE_ALARM,
} from "./replacement-nonviability.js";
import { TYPED_AHEAD_RESEND_NOTICE } from "./typed-ahead-input.js";
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
  noInference?: boolean;
  /**
   * Test seam: the child is not a bound Claude session, so no session is
   * resolved and no capture starts. Never reachable from argv, env, or config
   * — cc-lhc has no capture-disabled product mode; plain `claude` is the
   * passthrough.
   */
  unboundTestChild?: boolean;
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
   * precedence after project config.
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
  /** Test hook: spawn/viability attempts inside one swap before it counts as nonviable. */
  replacementAttempts?: number;
  /** Test hook: nonviable swaps before the standing alarm and survival relaunch. */
  nonviableSwapLimit?: number;
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
  const unboundTestChild = options.unboundTestChild === true;
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

  /** Launch-time anomaly notices: recorded, never a refusal (R11 posture, R12). */
  const startupAnomalyNotices: string[] = [];

  // Configuration always yields a usable policy: bad fields fall back to
  // built-in defaults and automatic compact stays armed. The fallback notice
  // surfaces immediately — stderr while the wrapper still owns the terminal,
  // the wrapper log always — and again in the panel and the compact message.
  let resolvedContextPolicy: ResolvedContextPolicy =
    options.resolvedContextPolicy ??
    loadContextPolicy({
      cwd: process.cwd(),
      ...(options.contextPolicyOverrides !== undefined ? { sessionOverrides: options.contextPolicyOverrides } : {}),
    });
  let configFallbackNotice = formatConfigFallbackNotice(resolvedContextPolicy.fallbacks);
  for (const line of configFallbackNotice) {
    wrapperLog.warn(`cc-lhc context policy: ${line.trim()}`);
    stderr.write(`cc-lhc: ${line}\n`);
  }
  wrapperLog.info(
    `cc-lhc context policy autoCompact=${resolvedContextPolicy.policy.autoCompact} lower=${resolvedContextPolicy.policy.lowerBoundTokens} upper=${resolvedContextPolicy.policy.upperBoundTokens} profile=${resolvedContextPolicy.policy.profile} sources=${policySourcesSummary(resolvedContextPolicy.sources)}`,
  );

  let governorState: GovernorRuntimeState = createGovernorRuntimeState();
  /** Most recent non-success outcome (health visibility; never claims success). */
  let lastAttempt: { summary: string; atMs: number } | null = null;
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

  let observedRuntimeSettings: ClaudeRuntimeSettings = {};
  let handoffRuntimeSettings: ClaudeRuntimeSettings | undefined;
  const onRuntimeSettings = (settings: Readonly<ClaudeRuntimeSettings>): void => {
    // A replacement rollout emits permission mode before its first assistant
    // response. Keep the prior confirmed effort until Claude confirms a newer one.
    observedRuntimeSettings = { ...observedRuntimeSettings, ...settings };
  };

  let expectedSession: ExpectedSession | undefined;
  /** The one thread this wrapper owns; every alias of it contends for this lease. */
  let launchThread: LaunchThreadBinding | undefined;
  let threadOwnerLease: ThreadOwnerLease | undefined;
  const releaseThreadOwner = (): void => {
    threadOwnerLease?.release();
    threadOwnerLease = undefined;
  };
  let childArgv = argv;
  /** Non-selector user argv retained for wrapper-owned respawn. */
  let respawnRest: string[] = [];
  let respawnPassthrough: string[] = [];
  /** Set when the launch form could replay a positional prompt: handoff fails closed. */
  let respawnUnsafeReason: string | null = null;
  if (!unboundTestChild) {
    try {
      const plan = await resolveLaunchSession(argv, {
        cwd: process.cwd(),
        stdin,
        stdout,
        stderr,
      });
      expectedSession = plan.expected;
      childArgv = plan.childArgv;
      respawnRest = plan.rest;
      respawnPassthrough = plan.passthrough;
      wrapperLog.info(`cc-lhc launch alias ${expectedSession.sessionId} (source=${expectedSession.source})`);

      // R15 launch flow: the alias names the thread this launch owns; the
      // session it lands on is the one that thread currently accepts, read
      // under the acquired lock.
      const registryPath = defaultRegistryPath();
      const opened = await openLaunchThread({
        expectedSession,
        registryPath,
        lineageDbPath: defaultLineageDbPath(),
        log: (message) => wrapperLog.info(message),
        createThread: async () => {
          const created = await createCaptureThread(process.cwd(), registryPath);
          if (!created.ok) throw new Error(`cc-lhc thread create failed: ${created.error.reason}`);
          return "threadId" in created.value ? created.value.threadId : "";
        },
      });
      threadOwnerLease = opened.lease;
      launchThread = { threadId: opened.threadId, createdAtLaunch: opened.createdAtLaunch };
      if (opened.correctedFrom !== undefined) {
        expectedSession = opened.expectedSession;
        childArgv = respawnChildArgv(respawnRest, respawnPassthrough, expectedSession.sessionId);
      }
      if (opened.pendingAcceptanceNote !== undefined) wrapperLog.warn(`cc-lhc: ${opened.pendingAcceptanceNote}`);
      for (const artifact of opened.discardedSwapArtifacts) {
        wrapperLog.warn(
          `cc-lhc: rebuilt session ${artifact.sessionId} (reserved ${artifact.updatedAt}) was never accepted; ` +
            "discarded from launch selection",
        );
      }

      // Durable handoff state from a pre-rewrite build is consumed once, here:
      // under the thread lease, and never before it. The recovery directory and
      // the attempt table are shared by every thread on the box, so the lease is
      // what says which of it is ours to settle — a journal or an open attempt
      // row belonging to this thread means input may not have been delivered, so
      // the operator is told to resend and that state is cleared. Anything
      // belonging to another thread, or whose identity cannot be read, is left
      // untouched and says nothing to this operator.
      const legacyHandoffState = consumeLegacyHandoffState({
        home: ccLhcHome(),
        lineageDbPath: defaultLineageDbPath(),
        threadId: opened.threadId,
        knownSessionIds: [expectedSession.sessionId, opened.expectedSession.sessionId],
      });
      for (const notice of legacyHandoffState.notices) {
        wrapperLog.warn(notice);
        stderr.write(`${notice}\n`);
        startupAnomalyNotices.push(notice);
      }

      const safety = respawnArgvSafety(respawnRest, respawnPassthrough);
      if (!safety.safe) {
        respawnUnsafeReason = safety.reason;
        wrapperLog.warn(`cc-lhc handoff disabled for this launch form: ${safety.reason}`);
      }
    } catch (cause) {
      releaseThreadOwner();
      const message =
        cause instanceof ThreadOwnershipConflictError
          ? `cc-lhc refused duplicate thread owner: ${cause.message}`
          : cause instanceof LaunchGrammarError || cause instanceof Error
            ? cause.message
            : String(cause);
      stderr.write(`${message}\n`);
      return 2;
    }
  }

  // R8: cc-lhc owns compaction for a managed session, so every managed Claude
  // child launches with Claude's own automatic compaction off through the
  // per-child DISABLE_AUTO_COMPACT environment variable. Manual `/compact`
  // stays available (DISABLE_COMPACT is never used).
  // R12: an explicit user `--autocompact` passes through verbatim and the
  // injected disable is omitted for that launch, with a visible anomaly notice.
  // Omission is all cc-lhc can claim: inherited environment and Claude settings
  // still govern whether native auto-compact actually runs.
  const userChoseAutocompact = argvSuppliesNativeAutocompact(argv);
  const disableNativeAutoCompact = !userChoseAutocompact;
  if (userChoseAutocompact) {
    wrapperLog.warn(`cc-lhc ${NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY}`);
    startupAnomalyNotices.push(NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY);
  }

  // Per-wrapper runtime descriptor: Bash inherits only the path. Thread/archive
  // selection for retrieval comes exclusively from this file.
  // Undefined descriptorIo uses each API's defaultDescriptorIo (production path).
  let runtimeDescriptorPath: string | undefined;
  let runtimeDescriptor: RuntimeDescriptorV1 | undefined;
  if (expectedSession !== undefined) {
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
        releaseThreadOwner();
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
        releaseThreadOwner();
        return 2;
      }
      wrapperLog.warn(`cc-lhc runtime descriptor create failed: ${message}`);
    }
  }

  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;

  const childEnv: Record<string, string> = disableNativeAutoCompact
    ? nativeAutoCompactChildEnv(process.env as Record<string, string>, false)
    : { ...(process.env as Record<string, string>) };
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
    releaseThreadOwner();
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

  // ---- controlled-handoff state ----
  /**
   * True from the moment compact claims the settled session until the whole
   * operation settles. While it holds, stdin is not forwarded and not buffered:
   * typed-ahead bytes are dropped and the operator is told once to resend.
   */
  let compactOwnsInput = false;
  /** Bytes typed while compact owned input. Counted only to raise the notice. */
  let droppedInputBytes = 0;
  /** True from claim until the operation settles; suppresses teardown-on-exit. */
  let handoffInProgress = false;
  /** The child whose exit a termination is waiting for. */
  let expectedExitPty: IPty | null = null;
  let expectedExitResolve: (() => void) | null = null;
  /** Swaps whose replacement never became viable, this wrapper lifetime. */
  let nonviableSwaps = 0;
  /** The standing alarm once replacements repeatedly will not run. Never cleared. */
  let standingNonviabilityAlarm: string[] = [];
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
  /**
   * Answer callback for a pre-swap confirmation currently on the panel.
   * Present only while the operator is being asked; every path that tears the
   * panel down settles it, so a seam never waits on a prompt nobody can see.
   */
  let pendingCompactConfirm: ((disposition: CompactConfirmDisposition) => void) | null = null;
  /** Settle the confirmation once, whatever ended it. */
  const resolveCompactConfirm = (disposition: CompactConfirmDisposition): void => {
    const answer = pendingCompactConfirm;
    if (answer === null) return;
    pendingCompactConfirm = null;
    answer(disposition);
  };
  /**
   * A terminal the operator can actually answer on. Without one there is
   * nobody to ask, so the swap behaves exactly as it always has — which is
   * also why one-shot launches are exempt by construction.
   */
  const interactiveTerminal = stdin.isTTY === true && stdout.isTTY === true;
  /** Assigned inside the run promise where child/teardown machinery lives. */
  let runAutoOperation: (args: { frozenTriggerTokens: number | null; receiptId: string }) => Promise<void> =
    async () => {};

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
    } catch (cause) {
      // The descriptor is the retrieval capability. It is not an input to
      // compaction: a session that cannot serve `get-turns` still compacts.
      wrapperLog.warn(
        `cc-lhc runtime descriptor update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  /**
   * A settled seam wanted to compact while capture was still catching up.
   * Cleared by the catch-up evaluation once capture reports ready.
   */
  let captureCatchUpPending = false;
  /** Capture generation whose degradation already triggered one rebuild. */
  let captureRebuildForGeneration: number | null = null;
  let captureRebuildInFlight = false;

  /**
   * Everything capture needs to be restarted on whichever session is routed,
   * kept outside the live session object so a capture that failed to start —
   * or one whose object is gone — can still be reconciled forward.
   */
  let captureContinuation:
    | {
        threadRef: import("lhc").ThreadRef;
        sdk: import("lhc").Lhc;
        stats: import("../stats.js").CaptureStats;
        generation: number;
        sessionId: string;
      }
    | undefined;

  /**
   * Degraded, missing, or never-started capture is a reason to reconcile, never
   * a reason to let the session die oversized. The rollout file is the
   * persisted transcript and every intake event carries a content-stable
   * idempotency key, so re-reading it from the top is the same thing a fresh
   * `--resume` does: already-recorded events are skipped and anything missed
   * lands. One rebuild per generation; a later settled seam paces the next one.
   *
   * Runs off the capture batch path — stopping capture inline would deadlock
   * the queue this callback runs on.
   */
  const rebuildCaptureFromTranscript = (force = false): void => {
    if (captureRebuildInFlight) return;
    if (!force && (handoffInProgress || commandGuard.current() !== null)) return;
    const degraded = captureSession;
    const ctx = degraded?.getCommandContext();
    const rollout = degraded?.getRolloutInfo();
    const threadRef = ctx?.threadRef ?? captureContinuation?.threadRef;
    const sdk = ctx?.sdk ?? captureContinuation?.sdk;
    const sessionId = rollout?.sessionId ?? captureContinuation?.sessionId;
    const stats = degraded?.stats ?? captureContinuation?.stats;
    if (sdk === undefined || threadRef === undefined || sessionId === undefined || stats === undefined) return;
    const generation = degraded?.getCaptureGeneration() ?? captureContinuation?.generation ?? 0;
    if (!force && captureRebuildForGeneration === generation) return;
    captureRebuildForGeneration = generation;
    captureRebuildInFlight = true;
    wrapperLog.warn(
      `cc-lhc capture rebuild: re-reading transcript for session ${sessionId} after generation ${generation}`,
    );
    setImmediate(() => {
      void (async () => {
        try {
          await degraded?.stop().catch(() => {});
          captureSession = startCaptureSession({
            startedAt: new Date(),
            noInference,
            continueCapture: { threadRef, sdk, stats, priorGeneration: generation },
            expectedSession: { sessionId, source: "explicit_resume" },
            lineageDbPath: defaultLineageDbPath(),
            log: (message) => wrapperLog.info(message),
            logError: (message) => wrapperLog.warn(message),
            onLifecycle: onCaptureLifecycle,
            onRuntimeSettings,
          });
          captureContinuation = {
            threadRef,
            sdk,
            stats,
            sessionId,
            generation: captureSession.getCaptureGeneration(),
          };
        } catch (cause) {
          wrapperLog.warn(`cc-lhc capture rebuild failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally {
          captureRebuildInFlight = false;
        }
      })();
    });
  };

  /**
   * The sequencing conditions that keep an executable settled seam from
   * starting an operation right now. Named once so the seam's two readers —
   * the pre-authorization check and the operation itself — cannot drift.
   */
  const settledSeamBlocked = (): boolean =>
    exited ||
    handoffInProgress ||
    autoOperationScheduled ||
    standingNonviabilityAlarm.length > 0 ||
    respawnUnsafeReason !== null ||
    captureSession?.isCaptureReady() !== true;

  /**
   * One governor observation: log it, and route an executable settled decision
   * to the operation — through the operator first when a swap would kill live
   * background work.
   */
  const handleGovernorObserve = (record: import("../governor/index.js").GovernorObserveRecord): void => {
    wrapperLog.info(formatGovernorObserveLogLine(record));
    options.onGovernorObserve?.(record);
    // Learn the host overhead floor from predicted next-request pressure.
    const pressureForFloor = record.pressure.nextRequestPressureTokens;
    if (pressureForFloor > 0) {
      minObservedProviderTotal =
        minObservedProviderTotal === null ? pressureForFloor : Math.min(minObservedProviderTotal, pressureForFloor);
    }
    // Capability-limited: executable would_compact only at a settled seam
    // (wouldMutate is false during open turns). Starts ONE automatic operation,
    // scheduled off the capture batch path (the handoff stops capture; doing
    // that inline would deadlock the batch queue it runs on).
    if (record.wouldMutate !== true || record.observePhase !== "settled_seam") {
      persistGovernorObserve(record);
      return;
    }

    // A swap the operator has not authorized must leave nothing behind — not a
    // receipt, not an outcome, not a preference. So the question comes before
    // the record, and the ordinary persist/schedule path starts only on yes.
    if (!settledSeamBlocked() && interactiveTerminal) {
      const liveWork = captureSession?.getLiveAsyncWork() ?? [];
      if (liveWork.length > 0) {
        askBeforeSwap(record, liveWork);
        return;
      }
    }

    runSettledSeam(record);
  };

  /**
   * Ask the operator before a swap kills live background work, and act on the
   * answer. Only yes reaches the ordinary settled-seam path; every other
   * outcome — including a prompt that could not be raised at all — reports in
   * memory and returns, so the next seam asks again while the work is open.
   */
  const askBeforeSwap = (
    record: import("../governor/index.js").GovernorObserveRecord,
    liveWork: readonly OpenAsyncWork[],
  ): void => {
    const notNow = (why: string): void => {
      wrapperLog.info(
        `cc-lhc governor: compact not authorized — ${why}; ${liveWork.length} live background item(s) left running`,
      );
      lastAttempt = { summary: `auto compact not authorized: ${why}`, atMs: Date.now() };
    };
    if (pendingCompactConfirm !== null) {
      notNow("the background-work confirmation is already on screen");
      return;
    }
    if (inputState.mode !== "passthrough") {
      notNow(`the panel is busy (${inputState.mode})`);
      return;
    }

    // What the operator is about to authorize, by stable identity. The session
    // keeps running behind the panel — Claude answers a notification, another
    // launcher starts — so consent is checked against the world at the moment
    // of the keypress, not the one that raised the question.
    const listed = new Set(liveWork.map((work) => asyncWorkIdentity(work)));
    const consentStale = (): string | null => {
      if (governorState.turnOpen || captureSession?.isTurnOpen() === true) {
        return "a new turn opened while the question was on screen";
      }
      if (settledSeamBlocked()) return "the seam stopped being eligible while the question was on screen";
      // Work that finished meanwhile is fine — killing fewer than listed is
      // what the operator agreed to. Work that STARTED meanwhile was never on
      // the list, so nobody has agreed to kill it.
      const unlisted = (captureSession?.getLiveAsyncWork() ?? []).filter(
        (work) => !listed.has(asyncWorkIdentity(work)),
      );
      if (unlisted.length === 0) return null;
      const noun = unlisted.length === 1 ? "another piece" : `${unlisted.length} more pieces`;
      return `${noun} of background work started while the question was on screen`;
    };

    const raised = raiseCompactConfirm(liveWork, (disposition) => {
      if (disposition.kind !== "yes") {
        notNow(describeDecline(disposition.reason));
        return;
      }
      const stale = consentStale();
      if (stale !== null) {
        // Nothing is deferred and nothing waits for the turn to settle: the
        // next otherwise-eligible seam raises a fresh question over whatever
        // is open then.
        notNow(stale);
        return;
      }
      wrapperLog.info(`cc-lhc governor: operator authorized compact over ${liveWork.length} live background item(s)`);
      runSettledSeam(record);
    });
    if (!raised) notNow(describeDecline("render_failed"));
  };

  /**
   * The ordinary executable settled seam: record the classification, then
   * start the automatic operation or route it to a recovery that comes back.
   *
   * Receipts are write-behind. When the store is unavailable the operation runs
   * against an in-memory receipt id and says so; bookkeeping about the compact
   * never decides whether the compact happens.
   */
  const runSettledSeam = (record: import("../governor/index.js").GovernorObserveRecord): void => {
    const persisted = persistGovernorObserve(record);

    if (persisted !== null && !persisted.inserted) {
      // The classification matches one already recorded. What happened to that
      // receipt decides whether this seam is new work.
      const existingOutcome = persisted.receipt.handoffOutcome;
      if (existingOutcome?.kind === "mutation_deferred") {
        // A deferral means the mutation never started — the wrapper was busy,
        // or capture was catching up. That must cost the next seam nothing, so
        // this one runs and re-attaches its own outcome to the same receipt.
        wrapperLog.info(
          `cc-lhc governor: retrying receipt ${persisted.receipt.receiptId} after deferral (${existingOutcome.reason}); no mutation had started`,
        );
      } else if (existingOutcome?.kind === "scheduled") {
        wrapperLog.warn(
          `cc-lhc governor: replay of existing scheduled receipt ${persisted.receipt.receiptId} — an operation already owns it; no re-schedule; inspect handoffOutcome`,
        );
        lastAttempt = {
          summary: `auto compact not re-scheduled: existing scheduled receipt ${persisted.receipt.receiptId} (restart/replay)`,
          atMs: Date.now(),
        };
        return;
      } else if (isTerminalHandoffOutcome(existingOutcome)) {
        // An attempt actually ran against this classification.
        wrapperLog.info(
          `cc-lhc governor: exact replay of receipt ${persisted.receipt.receiptId} with terminal outcome ${existingOutcome?.kind}; no re-schedule`,
        );
        return;
      } else {
        wrapperLog.info(`cc-lhc governor: exact replay of receipt ${persisted.receipt.receiptId}; no re-schedule`);
        return;
      }
    }

    let receiptId: string;
    if (persisted === null) {
      receiptId = `mem-${randomUUID()}`;
      wrapperLog.warn(
        `cc-lhc governor: durable receipt unavailable; running auto compact against in-memory receipt ${receiptId} ` +
          "(restart recovery degraded for this attempt; the session still compacts)",
      );
    } else {
      receiptId = persisted.receipt.receiptId;
    }

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
      if (attached) {
        lastAttempt = { summary: `auto compact deferred: ${reason} (${detail})`, atMs: Date.now() };
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
    } else if (standingNonviabilityAlarm.length > 0) {
      // Replacements repeatedly would not run: the old session was relaunched
      // so native compaction keeps it alive, and the alarm stands until an
      // operator acts. Retrying the swap on every seam from here is the quiet
      // retry loop the ruling forbids. Nothing has ended — capture keeps
      // running on the live old session and manual compact still works.
      attachGovernorHandoffOutcome(
        receiptId,
        {
          kind: "mutation_refused",
          detail: "replacement incompatibility alarm standing; automatic swaps suspended",
        },
        { mutationBegan: false },
      );
      wrapperLog.warn(
        `cc-lhc governor: wouldMutate refused — ${standingNonviabilityAlarm[0] ?? "replacements are not becoming viable"} [receipt ${receiptId}]`,
      );
      lastAttempt = { summary: "auto compact suspended: replacement incompatibility alarm", atMs: Date.now() };
    } else if (respawnUnsafeReason !== null) {
      // Respawn cannot safely replace the child: refuse, do not pretend scheduled.
      attachGovernorHandoffOutcome(
        receiptId,
        { kind: "mutation_refused", detail: `respawn_unsafe: ${respawnUnsafeReason}` },
        { mutationBegan: false },
      );
      wrapperLog.warn(
        `cc-lhc governor: wouldMutate refused — respawn unsafe: ${respawnUnsafeReason} [receipt ${receiptId}]`,
      );
      lastAttempt = {
        summary: `auto compact refused: respawn unsafe (${respawnUnsafeReason})`,
        atMs: Date.now(),
      };
    } else if (captureSession?.isCaptureReady() !== true) {
      // Compacting stale semantic state is not the answer: catch capture up
      // from the transcript and take this seam again the moment it is ready.
      const phase = captureSession?.getCaptureHealth().phase ?? "starting";
      captureCatchUpPending = true;
      if (phase === "degraded") rebuildCaptureFromTranscript();
      deferAuto(
        "capture_catching_up",
        `capture is ${phase}; catching up from the transcript and re-evaluating when ready`,
        "warn",
      );
    } else {
      // Claim ownership: keep `scheduled` only while this operation owns it.
      const frozenTriggerTokens = record.pressure.nextRequestPressureTokens;
      autoOperationScheduled = true;
      setImmediate(() => {
        void runAutoOperation({ frozenTriggerTokens, receiptId }).finally(() => {
          autoOperationScheduled = false;
        });
      });
    }
  };

  /**
   * Put the pre-swap confirmation on the panel and register its answer
   * callback. Returns false when the prompt could not be drawn — the caller
   * treats that exactly like a decline, because nobody was asked.
   */
  const raiseCompactConfirm = (
    work: readonly OpenAsyncWork[],
    onAnswer: (disposition: CompactConfirmDisposition) => void,
  ): boolean => {
    const rows = compactConfirmRows(work, Date.now());
    if (rows.length === 0) return false;
    try {
      outputHold.hold();
      altScreen.enter();
      inputState = openCompactConfirm(inputState, rows);
      pendingCompactConfirm = onAnswer;
      renderModalPanel();
      wrapperLog.info(`cc-lhc governor: asking before compact kills ${work.length} live background item(s)`);
      return true;
    } catch (cause) {
      pendingCompactConfirm = null;
      inputState = forceResetInput(inputState);
      altScreen.leave();
      outputHold.flush();
      wrapperLog.warn(
        `cc-lhc governor: background-work confirmation could not be shown: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return false;
    }
  };

  const onCaptureLifecycle = (signals: readonly LifecycleSignal[]): void => {
    // R8 detection: loud notice only. Intake already captures the summary as
    // one bounded closed turn; nothing pauses, latches, or stands down.
    for (const signal of signals) {
      if (signal.kind !== "native_compact_observed") continue;
      const preview = signal.summaryPreview === undefined ? "" : ` — ${signal.summaryPreview}`;
      const notice = `ANOMALY: native compact ran on a managed session${preview}`;
      wrapperLog.warn(`cc-lhc ${notice}`);
      pendingPanelNotices = [...pendingPanelNotices, notice, "captured as one bounded turn; LHC compaction continues"];
    }

    // Generation is a diagnostic stamp for receipts, not a decision input.
    if (captureSession !== undefined) {
      governorState = setGovernorCaptureGeneration(governorState, captureSession.getCaptureGeneration());
    }

    const observed = applyGovernorLifecycleBatch(governorState, signals, resolvedContextPolicy);
    governorState = observed.state;
    for (const record of observed.observes) handleGovernorObserve(record);

    // Capture is caught up: take the settled seam that was skipped while it
    // was rebuilding. No timer, no latch — the pending flag exists only to
    // aim one re-evaluation at the next ready moment.
    if (captureCatchUpPending && captureSession?.isCaptureReady() === true && !governorState.turnOpen) {
      captureCatchUpPending = false;
      const caughtUp = reobserveSettled(governorState, resolvedContextPolicy);
      governorState = caughtUp.state;
      if (caughtUp.observe !== null) handleGovernorObserve(caughtUp.observe);
    }

    for (const signal of signals) {
      if (signal.kind === "session_bound") {
        publishDescriptorFromCapture();
      } else if (signal.kind === "capture_degraded") {
        // Slice 1 latches multiple distinct reasons per generation. After the
        // descriptor capability is already non-ready/absent, further reasons are
        // diagnostics only — never re-publish or treat as fatal re-transition.
        wrapperLog.warn(`cc-lhc capture degraded: ${signal.reason}`);
        governorState = setGovernorCaptureGeneration(governorState, signal.generation);
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

  if (expectedSession !== undefined && launchThread !== undefined) {
    captureSession = startCaptureSession({
      startedAt,
      noInference,
      expectedSession,
      launchThread,
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
    releaseThreadOwner();
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
      resolveCompactConfirm({ kind: "no", reason: "interrupted" });
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
    if (captureSession === undefined) {
      return {
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
      ...(configFallbackNotice.length === 0 ? {} : { hostNotices: configFallbackNotice }),
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
    resolveCompactConfirm({ kind: "no", reason: "interrupted" });
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
      resolveCompactConfirm({ kind: "no", reason: "interrupted" });
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
      // A panel edit that validates replaces the whole policy; the load-time
      // fallbacks it corrects are no longer in force.
      resolvedContextPolicy = { policy: candidate, sources, fallbacks: [] };
      configFallbackNotice = [];
      wrapperLog.info(
        `cc-lhc policy edit applied (${editLabel}) session scope: auto=${candidate.autoCompact} lower=${candidate.lowerBoundTokens} upper=${candidate.upperBoundTokens}`,
      );
      return [
        `${editLabel} — applied live to this wrapper`,
        "scope: session only — survives child handoffs, lost at wrapper exit",
        "persist by editing user/project config",
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
      // A mutating manual command owns the settled session's input for the
      // whole operation, exactly like the automatic path.
      const mutating = label === "compact" || label.startsWith("prune");
      if (mutating) takeInputOwnership();
      // A synchronous throw (runtime-snapshot construction, dispatch setup)
      // must not escape into the stdin data handler as an uncaught exception —
      // settle it exactly like an async failure.
      let dispatched: Promise<DispatchOutcome>;
      try {
        dispatched = dispatchLhcCommand(commandLine, commandRuntime());
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (mutating) releaseInputOwnership();
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
              const result = await performHandoff(outcome.handoff);
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
          if (mutating) releaseInputOwnership();
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
      // The standing nonviability alarm sits above everything: it is the one
      // condition where cc-lhc has stopped swapping and the operator has to act.
      for (const line of standingNonviabilityAlarm) rows.push(line);

      const capturePhase = captureSession?.getCaptureHealth().phase ?? "starting";
      const retrievalState =
        runtimeDescriptor?.state === "ready" ? "ready" : (runtimeDescriptor?.state ?? "unavailable");
      rows.push(`capture ${capturePhase} · retrieval ${retrievalState}`);

      const provider = governorState.latestProviderContext;
      const providerText =
        provider === null
          ? "provider context: none observed yet"
          : `provider context ${formatTokensShort(provider.total)}`;
      rows.push(
        `${providerText} · auto ${policy.autoCompact ? "on" : "off"} · ` +
          `trigger ${formatTokensShort(policy.upperBoundTokens)} · target ${formatTokensShort(policy.lowerBoundTokens)}`,
      );
      // Bad configuration never disables anything; it says so, here and in the
      // compact message, until the operator fixes it.
      for (const line of configFallbackNotice.slice(0, 4)) rows.push(line);
      rows.push(
        disableNativeAutoCompact
          ? "native auto-compact: disabled for this child (DISABLE_AUTO_COMPACT=1) · manual /compact still available"
          : "native auto-compact: explicit --autocompact passed through; cc-lhc did not inject DISABLE_AUTO_COMPACT " +
              "· inherited env/settings govern",
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

      if (minObservedProviderTotal !== null && policy.upperBoundTokens <= minObservedProviderTotal) {
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
      for (const notice of startupAnomalyNotices) rows.push(notice);
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
            // reaching Claude, so it bumps the governor epoch like any byte and
            // is dropped like any byte while compact owns the session.
            if (compactOwnsInput) droppedInputBytes += action.enterBytes.length;
            else {
              governorState = noteGovernorInput(governorState);
              currentPty.write(Buffer.from(action.enterBytes).toString("latin1"));
            }
          }
        } else if (action.kind === "notifier_return") {
          altScreen.leave();
          outputHold.flush();
        } else if (action.kind === "compact_confirm_answered") {
          // Leave the panel first so the answer lands on the restored screen,
          // then hand the disposition to the seam that raised it.
          altScreen.leave();
          outputHold.flush();
          resolveCompactConfirm(action.disposition);
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
      // No input left means no keypress can answer a pending confirmation.
      resolveCompactConfirm({ kind: "no", reason: "stdin_closed" });
      restoreIfModal();
    };

    const onStdinError = (cause: unknown): void => {
      // Restore the terminal, then let the error do what it always did
      // (propagate as an uncaught exception) — the exit hook's guarded leave
      // makes the rethrow safe.
      resolveCompactConfirm({ kind: "no", reason: "stdin_closed" });
      restoreIfModal();
      throw cause;
    };

    const forwardInput = (data: Buffer): void => {
      const result = processInputChunk(data, inputState);
      inputState = result.state;
      debugInput(data, inputState);
      if (result.toPty.length > 0) {
        // Bytes bound for Claude bump the input epoch. That is a receipt
        // diagnostic — what the operator typed and when — never a veto: bytes
        // typed during a turn belong to the next one and cannot invalidate the
        // history that already settled.
        //
        // While compact owns the settled session they are dropped instead of
        // delivered, and never held for replay into a replacement. The wrapper's
        // own UI keeps working; only the path to Claude is closed.
        if (compactOwnsInput) droppedInputBytes += result.toPty.length;
        else {
          governorState = noteGovernorInput(governorState);
          currentPty.write(result.toPty);
        }
      }
      applyActions(result.actions);
      renderModalPanel();
      armPendingEscTimer();
    };

    /**
     * One Claude child the wrapper spawned. Exactly one record is `routed` at
     * any moment: it owns the terminal and stdin. A candidate is a real,
     * running child that owns neither — its render is held until the switch
     * promotes it, and the child it replaces keeps rendering into a void.
     */
    interface ChildRecord {
      pty: IPty;
      sessionId: string;
      routed: boolean;
      exited: boolean;
      /** Non-semantic liveness signal: bytes counted, never parsed. */
      outputBytes: number;
      /** Render held while off-route, replayed to the terminal at the switch. */
      held: string[];
      heldBytes: number;
    }

    /** Cap on a candidate's held render before older bytes are dropped. */
    const CANDIDATE_HOLD_CAP_BYTES = 1024 * 1024;

    const childRecords = new Map<IPty, ChildRecord>();

    /** Per-child exit routing: an awaited termination resolves its waiter; an
     * unrouted child's exit changes nothing; the routed child's exit tears down
     * — except mid-operation, where the swap decides what happens next. */
    const handleChildExit = (record: ChildRecord, exitCode: number, signal?: number): void => {
      record.exited = true;
      if (expectedExitPty === record.pty) {
        expectedExitPty = null;
        const resolveWaiter = expectedExitResolve;
        expectedExitResolve = null;
        resolveWaiter?.();
        return;
      }
      if (!record.routed) return;
      // Mid-operation the swap decides what happens next: performHandoff checks
      // for a live routed child when it settles, and exits only if there is none.
      if (handoffInProgress) return;
      if (exited) return;
      void teardownAndExit(signal !== undefined && signal !== 0 ? 128 + signal : (exitCode ?? 1));
    };

    const attachChild = (pty: IPty, sessionId: string, routed: boolean): ChildRecord => {
      const record: ChildRecord = {
        pty,
        sessionId,
        routed,
        exited: false,
        outputBytes: 0,
        held: [],
        heldBytes: 0,
      };
      childRecords.set(pty, record);
      if (routed) currentPty = pty;
      pty.onData((data: string) => {
        record.outputBytes += data.length;
        if (record.routed) {
          forwardOutput(data);
          return;
        }
        record.held.push(data);
        record.heldBytes += data.length;
        while (record.heldBytes > CANDIDATE_HOLD_CAP_BYTES && record.held.length > 1) {
          record.heldBytes -= record.held.shift()!.length;
        }
      });
      pty.onExit(({ exitCode, signal }) => {
        handleChildExit(record, exitCode, signal);
      });
      return record;
    };

    /**
     * THE SWITCH. Routing moves from the currently routed child to the
     * candidate in one synchronous step: after those assignments, stdin reaches
     * only the candidate, only the candidate's output reaches the terminal, and
     * every later byte from the old child is dropped on the floor.
     *
     * Which is why the assignments come first and touch nothing that can throw.
     * What follows is what the operator sees — closing the wrapper's own panel
     * (it cannot survive a child swap), resizing, and repainting — and a
     * terminal that misbehaves during that must not leave routing half moved.
     * A repaint failure is returned as a warning on a switch that happened.
     */
    const switchRoutingTo = (record: ChildRecord): string | undefined => {
      const previous = childRecords.get(currentPty);
      if (previous !== undefined) previous.routed = false;
      currentPty = record.pty;
      record.routed = true;
      const held = record.held.join("");
      record.held = [];
      record.heldBytes = 0;
      try {
        restoreIfModal();
        onTerminalResize(record.pty, stdout);
        // The dead session's frame is still on screen; clear before the
        // replacement's own render lands so the two never interleave.
        forwardOutput("\x1b[2J\x1b[3J\x1b[H");
        if (held.length > 0) forwardOutput(held);
        return undefined;
      } catch (cause) {
        return `replacement is routed but its first repaint failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    };

    // ---- Slice 4: controlled handoff machinery ----
    const sigtermGraceMs = options.handoffTimeouts?.sigtermGraceMs ?? 3_000;
    const sigkillWaitMs = options.handoffTimeouts?.sigkillWaitMs ?? 2_000;
    const captureReadyTimeoutMs = options.handoffTimeouts?.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
    const childLivenessTimeoutMs = options.handoffTimeouts?.childLivenessTimeoutMs ?? DEFAULT_CHILD_LIVENESS_TIMEOUT_MS;
    const childStableWindowMs = options.handoffTimeouts?.childStableWindowMs ?? DEFAULT_CHILD_STABLE_WINDOW_MS;
    const replacementAttempts = options.replacementAttempts ?? DEFAULT_REPLACEMENT_ATTEMPTS;
    const nonviableSwapLimit = options.nonviableSwapLimit ?? NONVIABLE_SWAPS_BEFORE_ALARM;

    /**
     * One line the wrapper puts on the terminal over Claude's screen. Reserved
     * for the two facts the operator cannot be allowed to miss: input typed
     * during compaction was dropped, and the standing nonviability alarm.
     */
    const writeWrapperLine = (text: string): void => {
      stdout.write(`\r\n\x1b[2K[cc-lhc] ${text.replace(/\n/g, " ")}\r\n`);
    };

    /**
     * Compact takes ownership of the settled session's input here. From this
     * moment nothing the operator types reaches Claude: it is dropped, counted,
     * and reported once when the operation settles.
     */
    const takeInputOwnership = (): void => {
      compactOwnsInput = true;
      droppedInputBytes = 0;
    };

    const releaseInputOwnership = (): void => {
      compactOwnsInput = false;
      if (droppedInputBytes === 0) return;
      wrapperLog.warn(`cc-lhc: dropped ${droppedInputBytes} typed-ahead byte(s) during compaction`);
      writeWrapperLine(TYPED_AHEAD_RESEND_NOTICE);
      pendingPanelNotices = [...pendingPanelNotices, TYPED_AHEAD_RESEND_NOTICE];
      droppedInputBytes = 0;
    };

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

    /**
     * Spawn `claude --resume <sessionId>` OFF-ROUTE. The candidate is a real
     * running child with its own opening descriptor, but it owns nothing: no
     * terminal, no stdin, no capture generation. The wrapper's active
     * descriptor is untouched — the old child is still serving retrieval and
     * keeps its capability until the switch.
     *
     * `injectNativeDisable` is false only for R16's survival relaunch, where
     * the whole point is to hand the session back to Claude's own compaction.
     */
    interface CandidateSpawn {
      candidate: CandidateChild;
      record: ChildRecord;
      descriptorPath: string | undefined;
      descriptor: RuntimeDescriptorV1 | undefined;
      /** Rollout path + size at spawn: the baseline for session-file evidence. */
      sessionFile: { path: string; baselineBytes: number } | undefined;
    }

    const spawnCandidateChild = (
      sessionId: string,
      injectNativeDisable: boolean,
      sessionFile?: { path: string; baselineBytes: number },
    ): CandidateSpawn => {
      let respawnArgv = respawnChildArgv(respawnRest, respawnPassthrough, sessionId);
      if (handoffRuntimeSettings !== undefined) {
        respawnArgv = applyClaudeRuntimeSettings(respawnArgv, handoffRuntimeSettings);
      }
      let descriptorPath: string | undefined;
      let descriptor: RuntimeDescriptorV1 | undefined;
      try {
        descriptorPath = newDescriptorPath(undefined, descriptorIo);
        descriptor = createOpeningDescriptor(descriptorPath, descriptorIo);
      } catch (cause) {
        descriptorPath = undefined;
        descriptor = undefined;
        wrapperLog.warn(
          `cc-lhc handoff descriptor create failed (retrieval stays unavailable): ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const guided = injectRetrievalGuidance(respawnArgv);
      if (guided.ok) respawnArgv = guided.argv;
      else wrapperLog.warn(`cc-lhc handoff: retrieval guidance not injected: ${guided.reason}`);
      const env: Record<string, string> = injectNativeDisable
        ? nativeAutoCompactChildEnv(process.env as Record<string, string>, false)
        : { ...(process.env as Record<string, string>) };
      if (descriptorPath !== undefined) env[RUNTIME_DESCRIPTOR_ENV] = descriptorPath;
      wrapperLog.info(`cc-lhc handoff spawn: ${claudeBin} ${respawnArgv.join(" ")}`);
      let pty: IPty;
      try {
        pty = spawnPty(claudeBin, respawnArgv, {
          name: TERM_NAME,
          cols: stdout.columns ?? DEFAULT_COLS,
          rows: stdout.rows ?? DEFAULT_ROWS,
          cwd: process.cwd(),
          env,
        });
      } catch (cause) {
        if (descriptorPath !== undefined) {
          const rev = closeAndRemove(descriptorPath, descriptor, descriptorIo);
          if (!rev.ok) wrapperLog.warn(`cc-lhc handoff: candidate descriptor revoke unproven: ${rev.reason}`);
        }
        throw cause;
      }
      const record = attachChild(pty, sessionId, false);
      return {
        candidate: { sessionId, pid: pty.pid, child: { write: (data: string) => pty.write(data) } },
        record,
        descriptorPath,
        descriptor,
        sessionFile,
      };
    };

    const tickWait = (): Promise<void> =>
      new Promise((resolveTick) => {
        const tick = setTimeout(resolveTick, 25);
        tick.unref?.();
      });

    /**
     * Observable viability for a candidate, established while the old session
     * is still live and untouched.
     *
     * The decisive evidence is the process: it rendered and then survived the
     * stabilization window. Session-file growth is collected alongside it as
     * corroborating evidence — a rebuilt rollout Claude accepted and appended
     * to — and recorded either way, because a healthy resumed child may render
     * its whole history without writing a byte until the next interaction.
     * Requiring it would be a stop that can never clear. Prompt intake is never
     * consulted here at all.
     */
    const awaitCandidateViable = async (
      spawn: CandidateSpawn,
      timeoutMs: number,
      stableWindowMs: number,
    ): Promise<CandidateViability> => {
      const record = spawn.record;
      let sessionFileWritten = false;
      let lastFileCheckMs = 0;
      const observeSessionFile = async (): Promise<void> => {
        if (sessionFileWritten || spawn.sessionFile === undefined) return;
        const nowMs = Date.now();
        if (nowMs - lastFileCheckMs < 250) return;
        lastFileCheckMs = nowMs;
        const stat = await statRolloutFile(spawn.sessionFile.path);
        if (stat !== null && stat.size > spawn.sessionFile.baselineBytes) sessionFileWritten = true;
      };
      const evidence = (processAlive: boolean): { processAlive: boolean; sessionFileWritten: boolean } => ({
        processAlive,
        sessionFileWritten,
      });

      const startMs = Date.now();
      for (;;) {
        await observeSessionFile();
        if (record.exited) return { kind: "exited", evidence: evidence(false) };
        if (record.outputBytes > 0) break;
        if (Date.now() - startMs > timeoutMs) return { kind: "no_output", evidence: evidence(false) };
        await tickWait();
      }
      const stableStartMs = Date.now();
      for (;;) {
        await observeSessionFile();
        if (record.exited) return { kind: "exited", evidence: evidence(false) };
        if (Date.now() - stableStartMs >= stableWindowMs) break;
        await tickWait();
      }
      await observeSessionFile();
      return { kind: "viable", evidence: evidence(true) };
    };

    /** Force-kill a child tree and wait, bounded, for it to actually go. */
    const terminateChild = async (pty: IPty, graceful: boolean): Promise<boolean> => {
      expectedExitPty = pty;
      expectedExitResolve = null;
      if (graceful) {
        const initial = requestPtyTermination(pty, process.platform, "SIGTERM");
        wrapperLog.info(`cc-lhc handoff: requested child termination pid=${pty.pid} via ${initial.method}`);
        if (await waitForExpectedExit(sigtermGraceMs)) return true;
        expectedExitPty = pty;
        expectedExitResolve = null;
      }
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
      return killed;
    };

    /**
     * Adopt a candidate's descriptor as the active retrieval capability and
     * close the one the outgoing generation was using.
     */
    const adoptCandidateDescriptor = (spawn: CandidateSpawn): void => {
      const outgoingPath = runtimeDescriptorPath;
      const outgoing = runtimeDescriptor;
      runtimeDescriptorPath = spawn.descriptorPath;
      runtimeDescriptor = spawn.descriptor;
      descriptorCapabilityRevoked = false;
      if (outgoingPath === undefined) return;
      const rev = revokeCapability(outgoingPath, outgoing, "closed", undefined, descriptorIo);
      if (!rev.ok) wrapperLog.warn(`cc-lhc handoff: old descriptor revoke unproven: ${rev.reason}`);
    };

    const awaitCaptureReadyAfterReplay = async (timeoutMs: number): Promise<"ready" | "degraded" | "timeout"> => {
      const startMs = Date.now();
      for (;;) {
        if (captureSession?.isCaptureReady() === true) return "ready";
        if (captureSession?.getCaptureHealth().phase === "degraded") return "degraded";
        if (childRecords.get(currentPty)?.exited === true) return "degraded";
        if (Date.now() - startMs > timeoutMs) return "timeout";
        await tickWait();
      }
    };

    /**
     * Move the capture generation onto the rebuilt session, as part of the
     * switch. The outgoing generation's final flush is fired and forgotten: its
     * rollout file is never deleted, so anything it misses stays recoverable,
     * and a drain that hangs or throws must never reach the live replacement.
     */
    const switchCaptureToRebuilt = (request: HandoffRequest): { captureStarted: boolean; captureWarning?: string } => {
      const dying = captureSession;
      const ctx = dying?.getCommandContext();
      const threadRef = ctx?.threadRef ?? captureContinuation?.threadRef;
      const sdk = ctx?.sdk ?? captureContinuation?.sdk;
      const stats = dying?.stats ?? captureContinuation?.stats;
      const priorGeneration = dying?.getCaptureGeneration() ?? captureContinuation?.generation ?? 0;
      if (dying !== undefined) {
        void dying.stop().catch((cause: unknown) => {
          wrapperLog.warn(
            `cc-lhc handoff: old-generation capture drain failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        });
      }
      if (sdk === undefined || threadRef === undefined || stats === undefined) {
        captureSession = undefined;
        return { captureStarted: false, captureWarning: "no capture context to continue onto the replacement" };
      }
      try {
        captureSession = startCaptureSession({
          startedAt: new Date(),
          noInference,
          continueCapture: { threadRef, sdk, stats, priorGeneration },
          expectedSession: { sessionId: request.rebuilt.sessionId, source: "rebuilt_handoff" },
          knownRolloutPath: request.rebuilt.rolloutPath,
          prefixBoundary: request.rebuilt.prefixBoundary,
          suppressBindLineageRecord: true,
          lineageDbPath: defaultLineageDbPath(),
          log: (message) => wrapperLog.info(message),
          logError: (message) => wrapperLog.warn(message),
          onLifecycle: onCaptureLifecycle,
          onRuntimeSettings,
        });
        captureContinuation = {
          threadRef,
          sdk,
          stats,
          sessionId: request.rebuilt.sessionId,
          generation: captureSession.getCaptureGeneration(),
        };
        return { captureStarted: true };
      } catch (cause) {
        captureSession = undefined;
        captureContinuation = {
          threadRef,
          sdk,
          stats,
          sessionId: request.rebuilt.sessionId,
          generation: priorGeneration,
        };
        return {
          captureStarted: false,
          captureWarning: `replacement capture start failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    };

    /**
     * Execute the controlled handoff for a rebuilt session. Shared by manual
     * compact/prune and the automatic governor path. When `governorReceiptId`
     * is set (automatic path), outcomes attach only to that exact receipt;
     * manual compact/prune leave governor receipts alone.
     */
    const performHandoff = async (
      request: HandoffRequest,
      governorReceiptId?: string | null,
    ): Promise<HandoffResult> => {
      handoffInProgress = true;
      handoffRuntimeSettings = { ...observedRuntimeSettings };
      const oldPty = currentPty;
      const spawns = new Map<number, CandidateSpawn>();
      const ports: HandoffPorts = {
        preHandoffStop: (): string | null => {
          if (respawnUnsafeReason !== null) {
            return `respawn unavailable for this launch form: ${respawnUnsafeReason}`;
          }
          if (exited) return "wrapper exiting";
          return null;
        },
        spawnCandidate: (sessionId: string): CandidateChild => {
          const spawn = spawnCandidateChild(sessionId, disableNativeAutoCompact, {
            path: request.rebuilt.rolloutPath,
            baselineBytes: request.rebuilt.totalByteLength,
          });
          spawns.set(spawn.candidate.pid, spawn);
          return spawn.candidate;
        },
        awaitCandidateViable: async (candidate, timeoutMs, stableWindowMs) => {
          const spawn = spawns.get(candidate.pid);
          if (spawn === undefined) {
            return { kind: "exited", evidence: { processAlive: false, sessionFileWritten: false } };
          }
          return awaitCandidateViable(spawn, timeoutMs, stableWindowMs);
        },
        discardCandidate: async (candidate): Promise<void> => {
          const spawn = spawns.get(candidate.pid);
          if (spawn === undefined) return;
          spawns.delete(candidate.pid);
          childRecords.delete(spawn.record.pty);
          if (spawn.descriptorPath !== undefined) {
            const rev = closeAndRemove(spawn.descriptorPath, spawn.descriptor, descriptorIo);
            if (!rev.ok) {
              wrapperLog.warn(`cc-lhc handoff: candidate descriptor revoke unproven: ${rev.reason}`);
            }
          }
          if (!spawn.record.exited) await terminateChild(spawn.record.pty, false);
        },
        switchToCandidate: (candidate): SwitchOutcome => {
          const spawn = spawns.get(candidate.pid);
          // Last look at the process before anything moves. The candidate
          // proved viable a moment ago; if it has died since, it cannot be
          // routed to, and nothing here has changed yet — the old child keeps
          // the terminal, its capture generation, and its descriptor.
          if (spawn === undefined) return { switched: false, reason: "candidate went missing before the switch" };
          if (spawn.record.exited) {
            // Its capability outlived it by microseconds; take it back.
            spawns.delete(candidate.pid);
            childRecords.delete(spawn.record.pty);
            if (spawn.descriptorPath !== undefined) {
              const rev = closeAndRemove(spawn.descriptorPath, spawn.descriptor, descriptorIo);
              if (!rev.ok) {
                wrapperLog.warn(`cc-lhc handoff: dead candidate descriptor revoke unproven: ${rev.reason}`);
              }
            }
            return { switched: false, reason: `candidate pid=${candidate.pid} exited before the switch` };
          }

          const switchWarnings: string[] = [];
          const repaintWarning = switchRoutingTo(spawn.record);
          // Routed. Nothing below may throw out of here: the switch happened.
          if (repaintWarning !== undefined) switchWarnings.push(repaintWarning);
          try {
            adoptCandidateDescriptor(spawn);
          } catch (cause) {
            switchWarnings.push(
              `retrieval descriptor did not move to the replacement: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
          let capture: { captureStarted: boolean; captureWarning?: string };
          try {
            capture = switchCaptureToRebuilt(request);
          } catch (cause) {
            capture = {
              captureStarted: false,
              captureWarning: `replacement capture switch threw: ${cause instanceof Error ? cause.message : String(cause)}`,
            };
          }
          return {
            switched: true,
            captureStarted: capture.captureStarted,
            ...(capture.captureWarning === undefined ? {} : { captureWarning: capture.captureWarning }),
            ...(switchWarnings.length === 0 ? {} : { switchWarnings }),
          };
        },
        killOldChild: async (): Promise<{ exited: boolean; pid: number }> => {
          const record = childRecords.get(oldPty);
          if (record?.exited === true) return { exited: true, pid: oldPty.pid };
          try {
            return { exited: await terminateChild(oldPty, true), pid: oldPty.pid };
          } catch (cause) {
            // Termination that cannot even be attempted leaves a process the
            // operator has to deal with. Report it by PID and keep going.
            wrapperLog.warn(
              `cc-lhc handoff: terminating old child pid=${oldPty.pid} threw: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return { exited: false, pid: oldPty.pid };
          }
        },
        awaitReplacementCaptureReady: awaitCaptureReadyAfterReplay,
        reconcileCapture: (reason: string): void => {
          wrapperLog.warn(`cc-lhc handoff: reconciling capture from the transcript after ${reason}`);
          rebuildCaptureFromTranscript(true);
        },
        registerSuccessLineage: async (handoffRequest: HandoffRequest) => {
          const outcome = await registerRebuiltSessionLineage({
            newSessionId: handoffRequest.rebuilt.sessionId,
            threadId: handoffRequest.threadId,
            prefixBoundary: handoffRequest.rebuilt.prefixBoundary,
            lineageDbPath: defaultLineageDbPath(),
            logError: (message) => wrapperLog.warn(message),
          });
          // The swap is accepted at this point — the replacement is live and
          // routed — so the thread's current session becomes the replacement:
          // every later launch through any older alias lands here. If the
          // registry cannot take the pointer, the acceptance is kept host-side
          // with the predecessor it observed and the next launch reconciles it
          // under the thread lock. Never a veto: the replacement is live and
          // captured either way.
          const advanced = await recordSwapAcceptance({
            sessionId: handoffRequest.rebuilt.sessionId,
            threadId: handoffRequest.threadId,
            registryPath: defaultRegistryPath(),
            lineageDbPath: defaultLineageDbPath(),
            log: (message) => wrapperLog.warn(message),
          });
          if (!advanced.registryAdvanced) {
            wrapperLog.warn(`cc-lhc: current-session pointer not advanced: ${advanced.reason ?? "unknown reason"}`);
            wrapperLog.warn(
              advanced.recovery === "recorded"
                ? `cc-lhc: recorded accepted session ${handoffRequest.rebuilt.sessionId} for thread ` +
                    `${handoffRequest.threadId}; the next launch advances the registry pointer`
                : `cc-lhc: accepted session ${handoffRequest.rebuilt.sessionId} is live but neither the ` +
                    "registry pointer nor the recovery record could be written; " +
                    `resume it explicitly with cc-lhc --resume ${handoffRequest.rebuilt.sessionId}`,
            );
          }
          if (!outcome.ok) return { ok: false as const, reason: outcome.reason };
          return advanced.registryAdvanced
            ? { ok: true as const }
            : { ok: false as const, reason: advanced.reason ?? "current-session pointer not advanced" };
        },
        publishReadyDescriptor: (): boolean => {
          publishDescriptorFromCapture();
          return runtimeDescriptor?.state === "ready";
        },
        log: (message) => wrapperLog.info(message),
        warn: (message) => wrapperLog.warn(message),
      };

      try {
        const result = await executeHandoff(request, ports, {
          captureReadyTimeoutMs,
          childLivenessTimeoutMs,
          childStableWindowMs,
          replacementAttempts,
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
                : `${request.operation} replacement not viable: ${result.reason}`,
            atMs: Date.now(),
          };
        }
        const handoffOutcome: GovernorHandoffOutcome =
          result.kind === "success"
            ? {
                kind: "handoff_success",
                newSessionId: result.newSessionId,
                droppedInputBytes,
                ...(result.orphanPid === undefined ? {} : { orphanPid: result.orphanPid }),
              }
            : result.kind === "cancelled"
              ? { kind: "handoff_cancelled", detail: result.reason }
              : {
                  kind: "handoff_replacement_nonviable",
                  detail: result.reason,
                  oldSessionId: result.oldSessionId,
                  rebuiltSessionId: result.rebuiltSessionId,
                  attempts: result.attempts,
                };
        // Manual path (no governorReceiptId) must not attach to an unrelated
        // automatic governor receipt. Auto path always has the frozen id.
        if (governorReceiptId !== undefined && governorReceiptId !== null && governorReceiptId !== "") {
          attachGovernorHandoffOutcome(governorReceiptId, handoffOutcome, { mutationBegan: true });
        }
        options.onHandoffResult?.(result);
        if (result.kind === "success" && result.orphanPid !== undefined) {
          pendingPanelNotices = [
            ...pendingPanelNotices,
            `ORPHANED old Claude child pid=${result.orphanPid} — kill it manually to reclaim its memory`,
          ];
        }
        if (result.kind === "replacement_nonviable") {
          await noteNonviableSwap(result.oldSessionId, result.rebuiltSessionId, result.reason);
        }
        // Nothing is routed to a live child any more — the replacement died
        // after the switch, or it never became viable and the old child died
        // on its own meanwhile. There is no session left to serve, so the
        // wrapper exits rather than holding a terminal with nothing behind it.
        if (childRecords.get(currentPty)?.exited === true && !exited) {
          wrapperLog.warn(
            `cc-lhc: no live Claude child after ${request.operation} (old=${request.oldSessionId} ` +
              `rebuilt=${request.rebuilt.sessionId}); exiting`,
          );
          await teardownAndExit(1);
        }
        return result;
      } finally {
        handoffInProgress = false;
        handoffRuntimeSettings = undefined;
        // Children that are gone and route nothing are just bookkeeping.
        for (const [pty, record] of childRecords) {
          if (record.exited && !record.routed) childRecords.delete(pty);
        }
      }
    };

    /**
     * R16 survival relaunch: replace the old child with a fresh one on the SAME
     * session, launched WITHOUT cc-lhc's injected native-auto-compact disable,
     * so Claude's own compaction can keep that session alive in degraded form.
     *
     * It has to happen here and now. The child that is running still carries
     * the disable, and waiting for an incidental relaunch is waiting for the
     * session to hit the provider's hard cutoff. Capture stays attached: it is
     * the same session and the same rollout file, appended to by the new child.
     */
    const relaunchOldSessionForSurvival = async (oldSessionId: string): Promise<boolean> => {
      const oldPty = currentPty;
      let spawn: CandidateSpawn;
      try {
        spawn = spawnCandidateChild(oldSessionId, false);
      } catch (cause) {
        wrapperLog.warn(
          `cc-lhc survival relaunch spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return false;
      }
      const viability = await awaitCandidateViable(spawn, childLivenessTimeoutMs, childStableWindowMs);
      if (viability.kind !== "viable") {
        childRecords.delete(spawn.record.pty);
        if (spawn.descriptorPath !== undefined) closeAndRemove(spawn.descriptorPath, spawn.descriptor, descriptorIo);
        if (!spawn.record.exited) await terminateChild(spawn.record.pty, false);
        wrapperLog.warn(`cc-lhc survival relaunch candidate ${viability.kind}; the old child keeps the terminal`);
        return false;
      }
      // Same last look as the compact swap: a candidate that died between
      // proving viable and being promoted cannot be routed to, and nothing has
      // moved, so the running child keeps the terminal.
      if (spawn.record.exited) {
        childRecords.delete(spawn.record.pty);
        if (spawn.descriptorPath !== undefined) closeAndRemove(spawn.descriptorPath, spawn.descriptor, descriptorIo);
        wrapperLog.warn(
          `cc-lhc survival relaunch candidate pid=${spawn.record.pty.pid} exited before the switch; ` +
            "the old child keeps the terminal",
        );
        return false;
      }
      const repaintWarning = switchRoutingTo(spawn.record);
      // Routed. The relaunch has happened; nothing below may unmake it.
      if (repaintWarning !== undefined) wrapperLog.warn(`cc-lhc survival relaunch: ${repaintWarning}`);
      try {
        adoptCandidateDescriptor(spawn);
        publishDescriptorFromCapture();
      } catch (cause) {
        wrapperLog.warn(
          `cc-lhc survival relaunch: retrieval descriptor did not move: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const record = childRecords.get(oldPty);
      if (record?.exited !== true) {
        try {
          if (!(await terminateChild(oldPty, true))) {
            wrapperLog.warn(`cc-lhc survival relaunch: ORPHANED previous child pid=${oldPty.pid} — kill it manually`);
          }
        } catch (cause) {
          wrapperLog.warn(
            `cc-lhc survival relaunch: terminating previous child pid=${oldPty.pid} threw ` +
              `(${cause instanceof Error ? cause.message : String(cause)}); kill it manually`,
          );
        }
      }
      return true;
    };

    /**
     * One swap whose replacement never became viable. Nothing was switched and
     * nothing was undone, so below the bound the answer is simply to try again
     * at the next settled seam, for free. At the bound, retrying forever is the
     * wrong answer: the standing alarm goes up and R16 hands the old session to
     * Claude's own compaction so it survives in degraded form. The session
     * itself keeps running throughout.
     */
    const noteNonviableSwap = async (oldSessionId: string, rebuiltSessionId: string, reason: string): Promise<void> => {
      nonviableSwaps += 1;
      if (standingNonviabilityAlarm.length > 0 || nonviableSwaps < nonviableSwapLimit) return;
      standingNonviabilityAlarm = formatReplacementNonviabilityAlarm({
        rebuiltSessionId,
        oldSessionId,
        nonviableSwaps,
        lastReason: reason,
      });
      const relaunched = await relaunchOldSessionForSurvival(oldSessionId);
      standingNonviabilityAlarm = [
        ...standingNonviabilityAlarm,
        formatSurvivalRelaunchNotice(oldSessionId, relaunched),
      ];
      for (const line of standingNonviabilityAlarm) {
        wrapperLog.warn(`cc-lhc ${line}`);
        writeWrapperLine(line);
      }
      pendingPanelNotices = [...pendingPanelNotices, ...standingNonviabilityAlarm];
    };

    // Automatic operation: shared mutation op + shared handoff, serialized with
    // manual commands through the same single-flight guard. Outcomes attach only
    // to the exact durable receipt that scheduled this operation.
    //
    // Early gates (exited / handoff / command-guard) MUST terminalize the
    // receipt before returning — a stranded `scheduled` row fails closed forever
    // on replay with no evidence whether mutation began.
    runAutoOperation = async (args: { frozenTriggerTokens: number | null; receiptId: string }): Promise<void> => {
      const { frozenTriggerTokens, receiptId } = args;
      // Test seam: allow race injection before early gates (handoff / exiting).
      // forceExitedForAuto is local so we do not strand the real process-exit flag.
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
        // Tests may leave the flag set; clear so child exit can tear down.
        // Production path only sets handoffInProgress inside performHandoff.
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
        lastAttempt = {
          summary: `auto compact deferred: command_guard_busy (${busyLabel})`,
          atMs: Date.now(),
        };
        return;
      }
      // Mutation claim held: remaining outcomes use mutationBegan so attach
      // failures are loud (receipt may remain scheduled for operator recovery).
      governorState = setGovernorOperationInFlight(governorState, true);
      // Compact owns the settled session from here: input stops being
      // forwarded for the whole operation, construction through swap.
      takeInputOwnership();
      try {
        const runtime = commandRuntime();
        const policy = resolvedContextPolicy.policy;
        const plan: ContextMutationPlan = {
          operation: "auto_compact",
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
          ...(frozenTriggerTokens === null ? {} : { triggerContextTokens: frozenTriggerTokens }),
          ...(configFallbackNotice.length === 0 ? {} : { hostNotices: configFallbackNotice }),
        };
        const outcome = await runContextMutation(plan, runtime);
        wrapperLog.info(
          `cc-lhc auto-compact mutation ${outcome.kind}: ${outcome.messages.join(" | ") || "(no receipt)"}`,
        );
        if (outcome.kind !== "rebuilt") {
          // Never a successful action: a mutation that produced no handoff is
          // health/last-attempt state only.
          lastAttempt = {
            summary: `auto compact ${outcome.kind}: ${outcome.messages[outcome.messages.length - 1] ?? "(no detail)"}`,
            atMs: Date.now(),
          };
          const mutationOutcome: GovernorHandoffOutcome =
            outcome.kind === "refused"
              ? {
                  kind: "mutation_refused",
                  detail: outcome.messages.join(" | ") || "refused",
                }
              : outcome.kind === "partial"
                ? {
                    kind: "mutation_partial",
                    detail: outcome.messages.join(" | ") || "partial",
                  }
                : {
                    kind: "mutation_noop",
                    detail: outcome.messages.join(" | ") || "noop",
                  };
          attachGovernorHandoffOutcome(receiptId, mutationOutcome, { mutationBegan: true });
          return;
        }
        await performHandoff(outcome.handoff, receiptId);
      } catch (cause) {
        wrapperLog.warn(
          `cc-lhc auto-compact operation threw: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        attachGovernorHandoffOutcome(
          receiptId,
          {
            kind: "mutation_refused",
            detail: cause instanceof Error ? cause.message : String(cause),
          },
          { mutationBegan: true },
        );
      } finally {
        releaseInputOwnership();
        governorState = setGovernorOperationInFlight(governorState, false);
        commandGuard.release();
      }
    };

    attachChild(currentPty, expectedSession?.sessionId ?? "", true);
    stdin.on("data", forwardInput);
    // stdin ending/erroring has no wrapper lifecycle of its own (the child
    // and capture run on) — but with no input left there is no keypress to
    // dismiss a modal, so restore the terminal before those semantics apply.
    stdin.on("end", onStdinGone);
    stdin.on("close", onStdinGone);
    stdin.on("error", onStdinError);
  });
}

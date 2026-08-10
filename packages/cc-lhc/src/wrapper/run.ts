import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { spawn as defaultSpawn, type IPty } from "@lydell/node-pty";

import {
  formatTokensShort,
  runContextMutation,
  type ContextMutationPlan,
  type HandoffRequest,
} from "../commands/context-mutation.js";
import { type DispatchOutcome, dispatchLhcCommand, type LhcCommandRuntime } from "../commands/dispatch.js";
import {
  formatRebuildRelaunchGuidance,
  registerRebuiltSessionLineage,
} from "../commands/rebuild-receipt.js";
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
import {
  DEFAULT_CAPTURE_READY_TIMEOUT_MS,
  DEFAULT_CHILD_LIVENESS_TIMEOUT_MS,
  DEFAULT_CHILD_STABLE_WINDOW_MS,
  executeHandoff,
  type HandoffChild,
  type HandoffPorts,
  type HandoffResult,
  type RecoveryArtifact,
} from "./handoff.js";
import {
  applyGovernorLifecycleBatch,
  createGovernorRuntimeState,
  formatGovernorObserveLogLine,
  loadContextPolicy,
  noteGovernorInput,
  policySourcesSummary,
  projectConfigPath,
  userConfigPath,
  validateContextPolicy,
  setGovernorCaptureHealth,
  setGovernorDescriptorReady,
  setGovernorOperationInFlight,
  type ContextPolicyPartial,
  type GovernorRuntimeState,
  type ResolvedContextPolicy,
} from "../governor/index.js";
import type { LifecycleSignal } from "../observation/types.js";
import { injectRetrievalGuidance } from "../retrieval/guidance.js";
import {
  closeAndRemove,
  createOpeningDescriptor,
  type DescriptorIo,
  markDegraded,
  markReady,
  newDescriptorPath,
  revokeCapability,
  revokeDescriptor,
  RUNTIME_DESCRIPTOR_ENV,
  type RevocationResult,
  type RuntimeDescriptorV1,
} from "../runtime/descriptor.js";
import {
  acquireSessionOwner,
  SessionOwnershipConflictError,
  type SessionOwnerLease,
} from "../runtime/session-owner.js";
import { emptyCaptureStats, formatCaptureStatsLine } from "../stats.js";
import type { ExpectedSession } from "../rollout/expected-session.js";
import { CommandInFlightGuard, formatBusyMessage } from "./command-guard.js";
import { createInputDebugLogger } from "./input-debug.js";
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
  const commandGuard = new CommandInFlightGuard();
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
      ...(options.contextPolicyOverrides !== undefined
        ? { sessionOverrides: options.contextPolicyOverrides }
        : {}),
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
      wrapperLog.info(
        `cc-lhc expected session ${expectedSession.sessionId} (source=${expectedSession.source})`,
      );
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
      argv.slice(0, i + 1).every((a) => a !== "--") &&
      (arg === "--autocompact" || arg.startsWith("--autocompact=")),
  );
  const nativeBackstopArgs: string[] =
    !noCapture &&
    !userChoseAutocompact &&
    resolvedContextPolicy.armed &&
    options.disableNativeBackstopArgs !== true
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
      wrapperLog.warn(`cc-lhc runtime descriptor create failed: ${message}`);
      if (runtimeDescriptorPath !== undefined) {
        const rev = revokeDescriptor(runtimeDescriptorPath, runtimeDescriptor, descriptorIo);
        if (!rev.ok) {
          wrapperLog.warn(`cc-lhc: descriptor revoke failed after create error: ${rev.reason}`);
        }
      }
      runtimeDescriptorPath = undefined;
      runtimeDescriptor = undefined;
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
  /** Most recent non-success outcome (health visibility; never claims success). */
  let lastAttempt: { summary: string; atMs: number } | null = null;
  /** Smallest settled provider context seen: the observed Claude host overhead floor. */
  let minObservedProviderTotal: number | null = null;
  /** One auto operation scheduled/coalesced at a time. */
  let autoOperationScheduled = false;
  /** Cooldown after a non-success handoff; replayed rollback lifecycle must not re-trigger. */
  let autoBlockedUntilMs = 0;
  /** Assigned inside the run promise where child/teardown machinery lives. */
  let runAutoOperation: (frozenTriggerTokens: number | null) => Promise<void> = async () => {};
  const HANDOFF_FAILURE_COOLDOWN_MS = 120_000;

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
      currentPty.kill("SIGKILL");
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
      const threadId =
        threadRef !== undefined && "threadId" in threadRef ? threadRef.threadId : "";
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
      wrapperLog.info(
        `cc-lhc runtime descriptor ready thread=${threadId} session=${rollout.sessionId}`,
      );
      governorState = setGovernorDescriptorReady(governorState, true);
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

    // Slice 3 observe-only: pure decide + wrapper-log record; never mutate.
    const observed = applyGovernorLifecycleBatch(
      governorState,
      signals,
      resolvedContextPolicy,
    );
    governorState = observed.state;
    for (const record of observed.observes) {
      wrapperLog.info(formatGovernorObserveLogLine(record));
      options.onGovernorObserve?.(record);
      if (record.providerContextTotal !== null && record.providerContextTotal > 0) {
        minObservedProviderTotal =
          minObservedProviderTotal === null
            ? record.providerContextTotal
            : Math.min(minObservedProviderTotal, record.providerContextTotal);
      }
      // Slice 4: an executable would_compact starts ONE automatic operation,
      // scheduled off the capture batch path (the handoff stops capture; doing
      // that inline would deadlock the batch queue it runs on).
      if (
        record.wouldMutate === true &&
        !exited &&
        !handoffInProgress &&
        !autoOperationScheduled &&
        respawnUnsafeReason === null &&
        Date.now() >= autoBlockedUntilMs
      ) {
        autoOperationScheduled = true;
        // Freeze the trigger at THIS decision: later lifecycle updates must not
        // change what the durable receipt reports as the trigger context.
        const frozenTriggerTokens = record.providerContextTotal;
        setImmediate(() => {
          void runAutoOperation(frozenTriggerTokens).finally(() => {
            autoOperationScheduled = false;
          });
        });
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
        governorState = setGovernorCaptureHealth(
          governorState,
          false,
          signal.generation,
        );
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
      ...(resumeSessionIdForLineage !== undefined
        ? { resumeSessionId: resumeSessionIdForLineage }
        : {}),
      lineageDbPath: defaultLineageDbPath(),
      log: (message) => wrapperLog.info(message),
      logError: (message) => wrapperLog.warn(message),
      onLifecycle: onCaptureLifecycle,
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
      wrapperLog.warn(
        `cc-lhc capture/retrieval FATAL: child-exit revoke unproven: ${rev.reason}`,
      );
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
  let modalGeneration = 0;

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
      currentPty.kill(signal);
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
          currentPty.kill("SIGKILL");
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
      cleanup();
      resolve(exitCode);
    };

    const debugInput = createInputDebugLogger(process.env.CC_LHC_INPUT_DEBUG);

    // A modal-executed command settles here. Receipts go into the alt-screen
    // panel above a fresh prompt, screen still held — the panel owns its own
    // screen, so receipts stay readable whatever the main-screen TUI is doing.
    // One keypress (Esc/ctrl-C/leader) dismisses: leave the alt screen (the
    // terminal restores CC's layout exactly), then flush the held output.
    const settleCommand = (messages: string[], label: string): void => {
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
              const summary =
                result.kind === "success"
                  ? `handoff complete — session ${result.newSessionId} live`
                  : result.kind === "cancelled"
                    ? `handoff cancelled: ${result.reason}`
                    : result.kind === "rolled_back"
                      ? `handoff rolled back to ${result.oldSessionId}: ${result.reason}`
                      : `handoff FAILED: ${result.reason} (recovery: ${result.recoveryArtifactPath ?? "unwritten"})`;
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
              settleCommand([...outcome.messages, summary, ...extra], label);
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
        provider === null ? "provider context: none observed yet" : `provider context ${formatTokensShort(provider.total)}`;
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
        const parts = [`${lastAction.operation === "prune" ? "pruned" : "compacted"} ${formatAgo(lastAction.atMs)} (${lastAction.origin})`];
        if (lastAction.triggerTokens !== undefined) parts.push(`trigger ${formatTokensShort(lastAction.triggerTokens)}`);
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

      rows.push(
        "edits (auto/bounds) are session-scoped: live now, survive handoffs, lost at wrapper exit",
      );
      rows.push(
        `precedence: builtin < user ${userConfigPath()} < project ${projectConfigPath(process.cwd())} < session`,
      );
      return rows;
    };

    const applyActions = (actions: ReturnType<typeof processInputChunk>["actions"]): void => {
      for (const action of actions) {
        if (action.kind === "enter_modal") {
          modalGeneration += 1;
          outputHold.hold();
          altScreen.enter();
          inputState = { ...inputState, panelRows: buildPanelStatusRows() };
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
      // terminal semantics are inferred from buffered bytes.
      if (inputBarrier !== null) {
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
    const captureReadyTimeoutMs =
      options.handoffTimeouts?.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
    const childLivenessTimeoutMs =
      options.handoffTimeouts?.childLivenessTimeoutMs ?? DEFAULT_CHILD_LIVENESS_TIMEOUT_MS;
    const childStableWindowMs =
      options.handoffTimeouts?.childStableWindowMs ?? DEFAULT_CHILD_STABLE_WINDOW_MS;

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

    const writeRecoveryArtifactFile = (artifact: RecoveryArtifact): string | null => {
      try {
        const dir = options.recoveryDir ?? join(ccLhcHome(), "recovery");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `handoff-${Date.now()}-${process.pid}.json`);
        writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
        return path;
      } catch (cause) {
        wrapperLog.warn(
          `cc-lhc handoff recovery artifact write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return null;
      }
    };

    /** Execute the controlled handoff for a rebuilt session. Shared by manual
     * compact/prune and the automatic governor path. */
    const performHandoff = async (
      request: HandoffRequest,
      inputEpochChanged: () => boolean,
    ): Promise<HandoffResult> => {
      handoffInProgress = true;
      childDiedDuringHandoff = false;
      const leaseGeneration = captureSession?.getCaptureGeneration() ?? 0;
      const oldCaptureSnapshot = captureSession;
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
          if (bytes.length > 0) {
            child.write(bytes.toString("latin1"));
            // These bytes reached the child without passing the hazard shadow.
            inputState = noteUntrackedDeliveredInput(inputState, bytes);
          }
          return bytes.length;
        },
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
          try {
            pty.kill("SIGTERM");
          } catch {
            // may already be dead; the waiter resolves via onExit or timeout
          }
          const graceful = await waitForExpectedExit(sigtermGraceMs);
          if (graceful) return { exited: true, escalated: false };
          try {
            process.kill(-pty.pid, "SIGKILL");
          } catch {
            try {
              pty.kill("SIGKILL");
            } catch {
              // fall through to the bounded wait
            }
          }
          const killed = await waitForExpectedExit(sigkillWaitMs);
          if (!killed) expectedExitPty = null;
          return { exited: killed, escalated: true };
        },
        stopCurrentCapture: async (): Promise<void> => {
          await captureSession?.stop();
        },
        spawnChild: spawnHandoffChild,
        currentChild: (): HandoffChild => ({ write: (data: string) => currentPty.write(data) }),
        killCurrentChild: (): void => {
          const pty = currentPty;
          expectedExitPty = pty;
          expectedExitResolve = null;
          try {
            process.kill(-pty.pid, "SIGKILL");
          } catch {
            try {
              pty.kill("SIGKILL");
            } catch {
              // already dead
            }
          }
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

      try {
        const result = await executeHandoff(request, ports, {
          captureReadyTimeoutMs,
          childLivenessTimeoutMs,
          childStableWindowMs,
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
        options.onHandoffResult?.(result);
        if (result.kind === "failed" && !result.childAlive) {
          wrapperLog.warn(
            `cc-lhc handoff failed with no live child; exiting. old=${result.oldSessionId} rebuilt=${result.rebuiltSessionId} recovery=${result.recoveryArtifactPath ?? "UNWRITTEN"}`,
          );
          await teardownAndExit(1);
        }
        return result;
      } finally {
        handoffInProgress = false;
      }
    };

    // Automatic operation: shared mutation op + shared handoff, serialized with
    // manual commands through the same single-flight guard.
    runAutoOperation = async (frozenTriggerTokens: number | null): Promise<void> => {
      if (exited || handoffInProgress) return;
      if (!commandGuard.tryAcquire("auto-compact", Date.now())) return;
      governorState = setGovernorOperationInFlight(governorState, true);
      try {
        const epochAtStart = governorState.currentInputEpoch;
        const epochChanged = (): boolean => governorState.currentInputEpoch !== epochAtStart;
        const runtime = commandRuntime();
        if (runtime.captureDisabled) return;
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
          inputEpochChanged: epochChanged,
        };
        const outcome = await runContextMutation(plan, { ...runtime, inputEpochChanged: epochChanged });
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
          return;
        }
        await performHandoff(outcome.handoff, epochChanged);
      } catch (cause) {
        wrapperLog.warn(
          `cc-lhc auto-compact operation threw: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      } finally {
        governorState = setGovernorOperationInFlight(governorState, false);
        commandGuard.release();
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

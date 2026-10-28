import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn as defaultSpawn, type IPty } from "@lydell/node-pty";
import { exactProcessControl } from "cc-lhc-native";
import {
  type CarryoverAcceptance,
  type ContextMutationPlan,
  formatTokensShort,
  type HandoffRequest,
  runContextMutation,
} from "../commands/context-mutation.js";
import { type DispatchOutcome, dispatchLhcCommand, type LhcCommandRuntime } from "../commands/dispatch.js";
import { registerRebuiltSessionLineage, threadIdFromRef } from "../commands/rebuild-receipt.js";
import { qualifyActiveItems, statPathReal } from "../continuity/adapters.js";
import { stopRelaunchedMonitors } from "../continuity/carried-results.js";
import { cleanupThread } from "../continuity/cleanup.js";
import { defaultResultHookCommand, RESULT_HOOK_TIMEOUT_SECONDS } from "../continuity/delivery.js";

import { invokeCarryover } from "../continuity/handoff.js";
import { applyAsyncWorkEvent, carriedOpenWork } from "../continuity/observe.js";
import { snapshotContinuity } from "../continuity/snapshot.js";
import { type ContinuityStore, openContinuityStore } from "../continuity/store.js";
import {
  type discoverAdoptedTaskProcess,
  reconcileAdoptedShells,
  settleRetainedHost,
  terminateRetainedHostReal,
} from "../continuity/task-process.js";
import {
  applyGovernorLifecycleBatch,
  applySessionAllocation,
  type ContextPolicyPartial,
  createGovernorRuntimeState,
  decideGovernor,
  formatConfigFallbackNotice,
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
  policySourcesSummary,
  projectConfigPath,
  type ResolvedContextPolicy,
  reobserveSettled,
  segmentThresholdTokens as segmentThresholdFromPolicy,
  setGovernorCaptureGeneration,
  setGovernorOperationInFlight,
  setGovernorTokenFamily,
  userConfigPath,
  validateContextPolicy,
} from "../governor/index.js";
import { killAllInferenceChildren } from "../inference/claude-cli.js";
import {
  type LaunchForm,
  LaunchGrammarError,
  launchChildArgv,
  launchFormOf,
  launchModelFlag,
  launchPromptText,
  replacementChildArgv,
  resolveLaunchSession,
  splitLaunchArgv,
} from "../intake/launch-session.js";
import { openLaunchThread } from "../intake/launch-thread.js";
import { defaultLineageDbPath } from "../intake/lineage-db.js";
import { captureThreadRef, ccLhcHome, defaultRegistryPath } from "../intake/paths.js";
import {
  type CaptureSession,
  type CaptureSessionDeps,
  createCaptureThread,
  startCaptureSession,
} from "../intake/session.js";
import { type LaunchThreadBinding, recordSwapAcceptance } from "../intake/thread-alias.js";
import { unlinkedRebuildLaunchGuidance } from "../intake/unlinked-rebuild.js";
import type { OpenAsyncWork } from "../observation/async-work.js";
import { preLaunchEstimate } from "../observation/estimate.js";
import {
  createSessionTokenFamilyState,
  formatTokenFamilyLabel,
  lastAssistantModelFromThread,
  seedTokenFamilyAtLaunch,
} from "../observation/token-family.js";
import type { LifecycleSignal } from "../observation/types.js";
import { injectRetrievalGuidance } from "../retrieval/guidance.js";
import { findExpectedSessionFileOnce } from "../rollout/discover.js";
import {
  type ExpectedSession,
  expectedSessionFromExplicitId,
  rolloutPathForExpectedSession,
} from "../rollout/expected-session.js";
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
import { probeProcessIdentityNative } from "../runtime/native-identity.js";
import { type ProbeProcessIdentity, ProcessIdentityUnavailableError } from "../runtime/process-identity.js";
import { type ThreadOwnerLease, ThreadOwnershipConflictError } from "../runtime/thread-owner.js";
import { emptyCaptureStats, formatCaptureStatsLine } from "../stats.js";
import { forceKillChildTree, requestPtyTermination, runTaskkillTree } from "./child-termination.js";
import { CommandInFlightGuard, formatBusyMessage } from "./command-guard.js";
import {
  type ActionableCondition,
  actionableGuidanceRows,
  firstLoadMarkerPath,
  markShown,
  ONBOARDING_VERSION,
  planStartupPanel,
  readShownVersion,
} from "./first-load.js";
import {
  type CandidateChild,
  type CandidateViability,
  DEFAULT_CAPTURE_READY_TIMEOUT_MS,
  DEFAULT_CHILD_LIVENESS_TIMEOUT_MS,
  DEFAULT_CHILD_STABLE_WINDOW_MS,
  DEFAULT_REPLACEMENT_ATTEMPTS,
  executeHandoff,
  formatHandoffResult,
  formatOldChildCleanup,
  type HandoffPorts,
  type HandoffResult,
  type SwitchOutcome,
} from "./handoff.js";
import {
  type HandoffReceiptStore,
  handoffReceiptPortFromStore,
  openHandoffReceiptStore,
} from "./handoff-receipt-store.js";
import { createInputDebugLogger } from "./input-debug.js";
import { mergeLaunchSettings, readSettingsFileOrNull } from "./launch-settings.js";
import { runLaunchSweep } from "./launch-sweep.js";
import { consumeLegacyHandoffState } from "./legacy-handoff-state.js";
import {
  clampPanelViewport,
  createInputState,
  finishExecuting,
  forceResetInput,
  type InputState,
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
  nativeAutocompactArgvEvidence,
} from "./native-auto-compact.js";
import { observeOldChildCleanup } from "./old-child-cleanup.js";
import { OutputHold } from "./output-hold.js";
import { createAltScreenGuard, renderPanel } from "./panel.js";
import {
  buildPanelViewSnapshot,
  formatPendingResultRows,
  formatPolicySource,
  MODAL_SCOPE_NOTE,
} from "./panel-commands.js";
import {
  formatActiveOperation,
  formatActiveOperationRow,
  formatHandoffFailureSummary,
  formatLastActionRow,
  formatRetrievalStateRow,
  toPanelWording,
} from "./panel-wording.js";
import { type PlainChildSpawn, spawnPlainChild } from "./plain-child.js";
import {
  completedToolCallsInLastTurn,
  REJECTED_AGAIN_NOTICE_LINES,
  rejectionContinueNote,
} from "./rejection-continue.js";
import {
  formatReplacementNonviabilityAlarm,
  formatSurvivalRelaunchNotice,
  NONVIABLE_SWAPS_BEFORE_ALARM,
} from "./replacement-nonviability.js";
import { repairResumedTranscript } from "./resume-repair.js";
import {
  formatAutoDeferredSummary,
  formatAutoGuardBusyDetail,
  formatAutoGuardBusyLog,
  formatAutoInMemoryReceipt,
  formatAutoMutationLog,
  formatAutoMutationSummary,
  formatAutoNotRescheduledSummary,
  formatAutoSuspendedSummary,
  formatAutoThrew,
  formatOneShotCompactedBeforeLaunch,
  formatOneShotMissingThread,
  formatOneShotPreLaunchOutcome,
  formatOneShotPreLaunchThrew,
  formatOneShotStandDown,
  type NativeAutoCompactState,
  nativeAutoCompactStatusLine,
  nativeCompactAdvisoryDetailsRows,
  nativeCompactAdvisoryLine,
  nativeCompactAnomalyNotice,
  SMART_COMPACT,
} from "./terminology.js";
import { countTypedBytes, TYPED_AHEAD_RESEND_NOTICE } from "./typed-ahead-input.js";
import { createWrapperLog, type WrapperLog } from "./wrapper-log.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = "xterm-256color";
const SHOW_CURSOR = "\x1b[?25h";

export const OUTPUT_HOLD_CAP_BYTES = 4 * 1024 * 1024;
export const OUTPUT_HOLD_OVERFLOW_MESSAGE = "output buffer full — command entry cancelled";
export const DEFAULT_PRE_LAUNCH_CAPTURE_TIMEOUT_MS = 60_000;
/**
 * How long a pending ESC may sit unresolved before it is ruled a bare Esc
 * keypress. Split escape sequences deliver their next byte within a few ms;
 * kitty-protocol terminals never send a bare ESC at all.
 */
export const PENDING_ESC_RESOLVE_MS = 50;

export function settleReceipts(outcomeMessages: string[]): string[] {
  return outcomeMessages;
}

export function panelReceiptRows(outcomeMessages: readonly string[]): string[] {
  return outcomeMessages.map(toPanelWording);
}

export type PtySpawn = typeof defaultSpawn;

export type ForceWrapperExit = (code: number) => void;

const REJECTION_CONTINUE_DELAY_MS = 1_000;
const REJECTION_CONTINUE_ENTER_DELAY_MS = 300;

export type RunOptions = {
  claudeBin?: string;
  spawnPty?: PtySpawn;
  rejectionContinueDelayMs?: number;
  spawnPlain?: PlainChildSpawn;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  noInference?: boolean;
  unboundTestChild?: boolean;
  wrapperLog?: WrapperLog;
  outputHoldCapBytes?: number;
  forceWrapperExit?: ForceWrapperExit;
  descriptorIo?: DescriptorIo;
  contextPolicyOverrides?: ContextPolicyPartial;
  resolvedContextPolicy?: ResolvedContextPolicy;
  resultHookCommand?: string;
  onGovernorObserve?: (record: import("../governor/index.js").GovernorObserveRecord) => void;
  governorReceiptDbPath?: string;
  governorReceiptStoreHook?: (store: GovernorReceiptStore) => GovernorReceiptStore;
  handoffReceiptStoreHook?: (store: HandoffReceiptStore) => HandoffReceiptStore;
  probeProcessIdentity?: ProbeProcessIdentity;
  discoverTaskProcess?: typeof discoverAdoptedTaskProcess;
  hostSignal?: (pid: number, signal: NodeJS.Signals) => void;
  readTaskExit?: (proc: {
    pid: number;
    starttime: string;
  }) => import("../continuity/task-process.js").TaskExitOutcome | null;
  commandGuard?: CommandInFlightGuard;
  onBeforeAutoOperation?: (ports: {
    markHandoffInProgress: () => void;
    clearHandoffInProgress: () => void;
    markExited: () => void;
  }) => void;
  onHandoffResult?: (result: HandoffResult) => void;
  handoffTimeouts?: {
    sigtermGraceMs?: number;
    sigkillWaitMs?: number;
    captureReadyTimeoutMs?: number;
    childLivenessTimeoutMs?: number;
    childStableWindowMs?: number;
  };
  replacementAttempts?: number;
  nonviableSwapLimit?: number;
  preLaunchCaptureTimeoutMs?: number;
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

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  const closers: Array<() => void | Promise<void>> = [];
  try {
    return await runWithStores(argv, options, closers);
  } finally {
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch {}
    }
  }
}

async function runWithStores(
  argv: string[],
  options: RunOptions,
  closers: Array<() => void | Promise<void>>,
): Promise<number> {
  const claudeBin = options.claudeBin ?? resolveClaudeBin();
  const spawnPty = options.spawnPty ?? defaultSpawn;
  const spawnPlain =
    options.spawnPlain ??
    (options.spawnPty !== undefined ? (options.spawnPty as unknown as PlainChildSpawn) : spawnPlainChild);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const unboundTestChild = options.unboundTestChild === true;
  const noInference = options.noInference === true || process.env.CC_LHC_NO_INFERENCE === "1";
  const commandGuard = options.commandGuard ?? new CommandInFlightGuard();
  const forceWrapperExit: ForceWrapperExit =
    options.forceWrapperExit ??
    ((code: number) => {
      setImmediate(() => {
        process.exit(code);
      });
    });
  const descriptorIo = options.descriptorIo;

  const wrapperLog = options.wrapperLog ?? createWrapperLog();
  closers.push(() => wrapperLog.drain?.());

  const startupAnomalyNotices: string[] = [];
  const startupActionable: ActionableCondition[] = [];
  let raiseActionable = (condition: ActionableCondition): void => {
    startupActionable.push(condition);
  };

  let resolvedContextPolicy: ResolvedContextPolicy =
    options.resolvedContextPolicy ??
    loadContextPolicy({
      cwd: process.cwd(),
      ...(options.contextPolicyOverrides !== undefined ? { sessionOverrides: options.contextPolicyOverrides } : {}),
    });
  const segmentThresholdTokens = (): number => segmentThresholdFromPolicy(resolvedContextPolicy.policy);
  let configFallbackNotice = formatConfigFallbackNotice(resolvedContextPolicy.fallbacks);
  for (const line of configFallbackNotice) {
    wrapperLog.warn(`cc-lhc context policy: ${line.trim()}`);
    stderr.write(`cc-lhc: ${line}\n`);
  }
  const logContextPolicy = (why: string): void => {
    wrapperLog.info(
      `cc-lhc context policy (${why}) lower=${resolvedContextPolicy.policy.lowerBoundTokens} upper=${resolvedContextPolicy.policy.upperBoundTokens} runway=${resolvedContextPolicy.policy.minRunwayTokens} profile=${resolvedContextPolicy.policy.profile} sources=${policySourcesSummary(resolvedContextPolicy.sources)}`,
    );
  };
  logContextPolicy("launch");

  let sessionTokenFamily = createSessionTokenFamilyState();
  const installLaunchSettings = (childArgs: readonly string[]): string[] => {
    if (continuityStore === null) return [...childArgs];
    const merged = mergeLaunchSettings({
      argv: childArgs,
      readFile: readSettingsFileOrNull,
      deliveryHook: { command: resultHookCommand, timeoutSeconds: RESULT_HOOK_TIMEOUT_SECONDS },
    });
    if (merged.kind === "unmerged") {
      wrapperLog.warn(
        `cc-lhc continuity: result delivery hook not installed (${merged.reason}); results stay pending in the Control Panel`,
      );
      return merged.argv;
    }
    if (merged.deliveryHook.kind === "unavailable") {
      wrapperLog.warn(
        `cc-lhc continuity: result delivery hook not installed (${merged.deliveryHook.reason}); results stay pending in the Control Panel`,
      );
    }
    return merged.argv;
  };

  let governorState: GovernorRuntimeState = createGovernorRuntimeState();
  let lastAttempt: { summary: string; atMs: number } | null = null;
  let governorReceiptStore: GovernorReceiptStore | null = null;
  try {
    const opened = openGovernorReceiptStore(options.governorReceiptDbPath ?? defaultLineageDbPath());
    governorReceiptStore =
      options.governorReceiptStoreHook !== undefined ? options.governorReceiptStoreHook(opened) : opened;
    closers.push(() => {
      governorReceiptStore?.close();
      governorReceiptStore = null;
    });
  } catch (cause) {
    wrapperLog.warn(
      `cc-lhc governor receipt store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let handoffReceiptStore: HandoffReceiptStore | null = null;
  try {
    const opened = openHandoffReceiptStore(options.governorReceiptDbPath ?? defaultLineageDbPath());
    handoffReceiptStore =
      options.handoffReceiptStoreHook !== undefined ? options.handoffReceiptStoreHook(opened) : opened;
    closers.push(() => {
      handoffReceiptStore?.close();
      handoffReceiptStore = null;
    });
  } catch (cause) {
    wrapperLog.warn(
      `cc-lhc handoff receipt store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let continuityStore: ContinuityStore | null = null;
  let retainedHostPty: { pty: IPty; threadId: string; frozen: boolean } | null = null;
  let retainedTerminate: ((pty: IPty) => Promise<boolean>) | undefined;
  const hostSignal =
    options.hostSignal ??
    ((pid: number, signal: NodeJS.Signals): void => {
      if (signal === "SIGSTOP" || signal === "SIGCONT") {
        const control = exactProcessControl();
        const result = signal === "SIGSTOP" ? control.pause(pid) : control.resume(pid);
        if (!result.ok) {
          throw new Error(`${signal === "SIGSTOP" ? "pause" : "resume"} failed: ${result.code}: ${result.message}`);
        }
        return;
      }
      process.kill(pid, signal);
    });
  const settleHost = async (threadId: string, terminatePty?: (pty: IPty) => Promise<boolean>): Promise<void> => {
    if (continuityStore === null || threadId === "") return;
    try {
      const settle = await settleRetainedHost(continuityStore, threadId, {
        probeIdentity: probeProcessIdentity,
        terminateHost: async (host) => {
          if (
            host.frozen !== true &&
            retainedHostPty !== null &&
            retainedHostPty.threadId === threadId &&
            terminatePty !== undefined
          ) {
            const ok = await terminatePty(retainedHostPty.pty);
            if (ok) retainedHostPty = null;
            return ok;
          }
          const ok = await terminateRetainedHostReal(host, probeProcessIdentity, hostSignal);
          if (ok && retainedHostPty?.threadId === threadId) retainedHostPty = null;
          return ok;
        },
      });
      if (settle.kind === "terminated" || settle.kind === "already_gone") {
        if (retainedHostPty?.threadId === threadId) retainedHostPty = null;
        wrapperLog.info(
          `cc-lhc continuity: retained completion host ${settle.kind === "terminated" ? "terminated" : "already gone"}`,
        );
      } else if (settle.kind === "terminate_failed") {
        wrapperLog.warn(`cc-lhc continuity: ${settle.detail}`);
      }
    } catch (cause) {
      wrapperLog.warn(
        `cc-lhc continuity: retained-host settle failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };
  try {
    continuityStore = openContinuityStore(options.governorReceiptDbPath ?? defaultLineageDbPath());
    closers.push(() => {
      continuityStore?.close();
      continuityStore = null;
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    wrapperLog.warn(`cc-lhc continuity store unavailable: ${detail}`);
    raiseActionable({
      kind: "unsafe_capture_or_database_state",
      lines: [`continuity database unavailable: ${detail}; background work is not carried across Smart Compact`],
    });
  }
  const recordAsyncWorkEvent: NonNullable<CaptureSessionDeps["onAsyncWorkEvent"]> = (event, threadId) => {
    if (continuityStore === null) return;
    applyAsyncWorkEvent(continuityStore, threadId, event, Date.now());
  };
  const recordResultDelivery: NonNullable<CaptureSessionDeps["onResultDelivery"]> = (launchIds, threadId) => {
    if (continuityStore === null) return;
    const delivered = continuityStore.markDelivered({ threadId, launchIds, nowMs: Date.now() });
    if (delivered.length > 0) {
      wrapperLog.info(
        `cc-lhc continuity: ${delivered.length} carried result(s) delivered on a real prompt: ${delivered.join(", ")}`,
      );
      void settleHost(threadId, retainedTerminate);
    }
  };
  const resultHookCommand = options.resultHookCommand ?? defaultResultHookCommand();
  const monitorOutputDir = join(dirname(options.governorReceiptDbPath ?? defaultLineageDbPath()), "continuity");
  const carriedSeed = (threadId: string): OpenAsyncWork[] => {
    if (continuityStore === null) return [];
    try {
      return carriedOpenWork(continuityStore, threadId);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      wrapperLog.warn(`cc-lhc continuity: carried work unreadable for thread ${threadId}; nothing seeded: ${detail}`);
      raiseActionable({
        kind: "unmanageable_async_identity",
        lines: [`carried work for thread ${threadId} is unreadable; nothing seeded — see the wrapper log`],
      });
      return [];
    }
  };
  const liveChildPidForDiscovery = (): number | undefined => {
    try {
      return currentPty.pid;
    } catch {
      return undefined;
    }
  };

  const acceptCarryoverAtSeam = (
    threadId: string,
    sourceRolloutPath: string | undefined,
    sourceSessionId: string | undefined,
  ): CarryoverAcceptance => {
    if (continuityStore === null || threadId === "") return { ok: true };
    const report = reconcileAdoptedShells(continuityStore, threadId, {
      ...(options.readTaskExit === undefined ? {} : { readTaskExit: options.readTaskExit }),
    });
    for (const done of report.reconciled) {
      wrapperLog.info(`cc-lhc continuity: adopted ${done.launchId} reconciled ${done.outcome} (${done.evidence})`);
    }
    for (const lost of report.unsupervised) {
      wrapperLog.warn(
        `cc-lhc continuity: adopted ${lost} lost its supervision (host and task gone, no exit marker); ` +
          "state is unknown — its outcome cannot be determined",
      );
    }
    void settleHost(threadId, retainedTerminate);
    const qualified = qualifyActiveItems(
      continuityStore,
      threadId,
      {
        platform: process.platform,
        sourceRolloutPath,
        statPath: statPathReal,
        ...((): { oldChildPid?: number } => {
          const pid = liveChildPidForDiscovery();
          return pid === undefined ? {} : { oldChildPid: pid };
        })(),
        ...(options.discoverTaskProcess === undefined ? {} : { discoverTaskProcess: options.discoverTaskProcess }),
      },
      Date.now(),
    );
    for (const closed of qualified.terminalized) {
      wrapperLog.warn(
        `cc-lhc continuity: ${closed.family} ${closed.launchId} cannot be carried (${closed.reason}); recorded as failed`,
      );
    }
    const snapshot = snapshotContinuity(continuityStore, {
      threadId,
      oldSessionId: sourceSessionId ?? "unknown",
      nowMs: Date.now(),
    });
    if (!snapshot.ok) {
      const detail = `continuity: ${snapshot.reason.replace("_", " ")} cannot be carried: ${snapshot.launchIds.join(", ")}`;
      wrapperLog.warn(`cc-lhc ${detail}; keeping the current session this seam`);
      return { ok: false, detail };
    }
    return { ok: true, carryover: { snapshot: snapshot.snapshot, monitorOutputDir } };
  };
  const probeProcessIdentity = options.probeProcessIdentity ?? probeProcessIdentityNative;
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
    observedRuntimeSettings = { ...observedRuntimeSettings, ...settings };
  };

  let expectedSession: ExpectedSession | undefined;
  let launchThread: LaunchThreadBinding | undefined;
  let threadOwnerLease: ThreadOwnerLease | undefined;
  const releaseThreadOwner = (): void => {
    threadOwnerLease?.release();
    threadOwnerLease = undefined;
  };
  let childArgv = argv;
  let launchRest: string[] = [];
  let launchPassthrough: string[] = [];
  let launchForm: LaunchForm = "interactive";
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
      launchRest = plan.rest;
      launchPassthrough = plan.passthrough;
      launchForm = launchFormOf(launchRest);
      wrapperLog.info(
        `cc-lhc launch alias ${expectedSession.sessionId} (source=${expectedSession.source}, form=${launchForm})`,
      );

      const registryPath = defaultRegistryPath();
      const launchRolloutPath = rolloutPathForExpectedSession(
        join(homedir(), ".claude", "projects"),
        process.cwd(),
        expectedSession.sessionId,
      );
      if (launchForm === "one_shot") {
        const guidance = await unlinkedRebuildLaunchGuidance({
          sessionId: expectedSession.sessionId,
          rolloutPath: launchRolloutPath,
          registryPath,
          lineageDbPath: defaultLineageDbPath(),
        });
        if (guidance !== null) {
          wrapperLog.warn(guidance);
          stderr.write(`${guidance}\n`);
          return 2;
        }
      }
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
        childArgv = launchChildArgv(launchRest, launchPassthrough, expectedSession.sessionId);
      }
      if (opened.pendingAcceptanceNote !== undefined) wrapperLog.warn(`cc-lhc: ${opened.pendingAcceptanceNote}`);
      for (const artifact of opened.discardedSwapArtifacts) {
        wrapperLog.warn(
          `cc-lhc: rebuilt session ${artifact.sessionId} (reserved ${artifact.updatedAt}) was never accepted; ` +
            "discarded from launch selection",
        );
      }
      await runLaunchSweep({
        home: ccLhcHome(),
        cwd: process.cwd(),
        registryPath,
        lineageDbPath: defaultLineageDbPath(),
        ownThreadId: opened.threadId,
        log: wrapperLog,
        ...(descriptorIo === undefined ? {} : { descriptorIo }),
      });
      const { sessionId } = expectedSession;
      repairResumedTranscript({ sessionId, cwd: process.cwd(), home: ccLhcHome(), log: wrapperLog, stderr });

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
      if (legacyHandoffState.notices.length > 0) {
        raiseActionable({ kind: "possible_undelivered_input", lines: legacyHandoffState.notices });
      }

      const argvSplit = splitLaunchArgv(launchRest, launchPassthrough);
      if (argvSplit.droppedAmbiguousOptions.length > 0) {
        wrapperLog.warn(
          `cc-lhc: a wrapper-owned replacement child will not inherit ${argvSplit.droppedAmbiguousOptions
            .map((token) => JSON.stringify(token))
            .join(" ")} — the value/prompt boundary is not provable; use the option=value form to keep it`,
        );
      }

      const launchModel = launchModelFlag(childArgv);
      let resumedAssistantModel: string | null = null;
      if (
        (launchModel === undefined || launchModel === "") &&
        launchThread !== undefined &&
        !launchThread.createdAtLaunch
      ) {
        resumedAssistantModel = await lastAssistantModelFromThread(
          captureThreadRef(launchThread.threadId, defaultRegistryPath()),
        );
      }
      sessionTokenFamily = seedTokenFamilyAtLaunch({
        ...(launchModel === undefined ? {} : { launchModel }),
        ...(resumedAssistantModel === null ? {} : { resumedAssistantModel }),
      });
      wrapperLog.info(
        `cc-lhc token family ${formatTokenFamilyLabel(sessionTokenFamily)}${
          sessionTokenFamily.modelId === null ? "" : ` model=${sessionTokenFamily.modelId}`
        }`,
      );
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

  const startedAt = new Date();

  let preLaunchCapture: CaptureSession | undefined;
  let outgoingCaptureSettled: Promise<void> | undefined;

  const settleOutgoingCapture = async (): Promise<void> => {
    const settling = outgoingCaptureSettled;
    outgoingCaptureSettled = undefined;
    if (settling !== undefined) await settling;
  };

  const releasePreChildOwnership = async (): Promise<void> => {
    const capture = preLaunchCapture;
    preLaunchCapture = undefined;
    if (capture !== undefined) {
      await capture.stop().catch((cause: unknown) => {
        wrapperLog.warn(`cc-lhc: pre-launch capture stop failed: ${detailOf(cause)}`);
      });
    }
    await settleOutgoingCapture();
    releaseThreadOwner();
  };

  let sessionAwaitingPromptIntake: { sessionId: string; threadId: string } | undefined;
  let promptAcceptanceSettled: Promise<void> | undefined;

  const notePromptIntake = (signals: readonly LifecycleSignal[]): void => {
    const accepted = sessionAwaitingPromptIntake;
    if (accepted === undefined) return;
    if (!signals.some((signal) => signal.kind === "turn_opened" && signal.reason === "user_prompt")) return;
    sessionAwaitingPromptIntake = undefined;
    promptAcceptanceSettled = recordSwapAcceptance({
      sessionId: accepted.sessionId,
      threadId: accepted.threadId,
      registryPath: defaultRegistryPath(),
      lineageDbPath: defaultLineageDbPath(),
      log: (message) => wrapperLog.warn(message),
    })
      .then((advance) => {
        if (advance.registryAdvanced) {
          wrapperLog.info(
            `cc-lhc one-shot: prompt intake observed on ${accepted.sessionId}; thread ${accepted.threadId} now current there`,
          );
          return;
        }
        wrapperLog.warn(
          advance.recovery === "recorded"
            ? `cc-lhc one-shot: prompt intake observed on ${accepted.sessionId} but the current-session pointer ` +
                `did not advance (${advance.reason ?? "unknown reason"}); the acceptance is recorded for thread ` +
                `${accepted.threadId} and the next launch reconciles it`
            : `cc-lhc one-shot: prompt intake observed on ${accepted.sessionId} but neither the current-session ` +
                `pointer nor the recovery record could be written (${advance.reason ?? "unknown reason"}); ` +
                `resume it explicitly with cc-lhc --resume ${accepted.sessionId}`,
        );
      })
      .catch((cause: unknown) => {
        wrapperLog.warn(`cc-lhc one-shot: prompt acceptance threw: ${detailOf(cause)}`);
      });
  };

  let captureLifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
  const publishCaptureLifecycle = (signals: readonly LifecycleSignal[]): void => {
    notePromptIntake(signals);
    if (captureLifecycleSink !== undefined) {
      captureLifecycleSink(signals);
      return;
    }
    governorState = setGovernorTokenFamily(governorState, sessionTokenFamily.resolved);
    governorState = applyGovernorLifecycleBatch(governorState, signals, resolvedContextPolicy).state;
  };

  const compactBeforeOneShotLaunch = async (session: ExpectedSession, thread: LaunchThreadBinding): Promise<void> => {
    const cwd = process.cwd();
    const transcriptPath = await findExpectedSessionFileOnce(cwd, session.sessionId);
    if (transcriptPath === null) {
      wrapperLog.info(
        `cc-lhc one-shot: session ${session.sessionId} has no persisted transcript yet; launching directly`,
      );
      return;
    }

    preLaunchCapture = startCaptureSession({
      startedAt,
      noInference,
      expectedSession: session,
      launchThread: thread,
      knownRolloutPath: transcriptPath,
      lineageDbPath: defaultLineageDbPath(),
      log: (message) => wrapperLog.info(message),
      logError: (message) => wrapperLog.warn(message),
      onLifecycle: publishCaptureLifecycle,
      onAsyncWorkEvent: recordAsyncWorkEvent,
      seedAsyncWork: carriedSeed,
      onResultDelivery: recordResultDelivery,
      onRuntimeSettings,
      segmentThresholdTokens,
      tokenFamily: sessionTokenFamily,
    });

    const catchUp = preLaunchCapture;
    const deadline = Date.now() + (options.preLaunchCaptureTimeoutMs ?? DEFAULT_PRE_LAUNCH_CAPTURE_TIMEOUT_MS);
    while (!catchUp.isCaptureReady() && catchUp.getCaptureHealth().phase === "binding" && Date.now() < deadline) {
      await new Promise<void>((resolveTick) => {
        const tick = setTimeout(resolveTick, 25);
        tick.unref?.();
      });
    }

    const standDown = (why: string): void => {
      wrapperLog.warn(formatOneShotStandDown(why, session.sessionId));
    };
    if (!catchUp.isCaptureReady()) {
      standDown(`capture is ${catchUp.getCaptureHealth().phase} after catching up from the transcript`);
      return;
    }
    if (catchUp.isTurnOpen()) {
      standDown("the persisted transcript ends in an unfinished turn");
      return;
    }

    const promptText = launchPromptText(launchRest, launchPassthrough);
    const decision = decideGovernor({
      policy: resolvedContextPolicy.policy,
      turnOpen: false,
      operationInFlight: false,
      providerContext: governorState.latestProviderContext,
      providerContextFreshness: governorState.latestProviderContext === null ? "none" : "last_known",
      postMeasurementEstimate: preLaunchEstimate(
        governorState.postMeasurementEstimate,
        promptText,
        sessionTokenFamily.estimator,
      ),
      contextLimitRejected: governorState.contextLimitRejected,
    });
    wrapperLog.info(`cc-lhc one-shot pre-launch seam: ${decision.kind} — ${decision.reason}`);
    if (decision.kind !== "would_compact") return;

    const policy = resolvedContextPolicy.policy;
    const hostNotices = configFallbackNotice;
    const outcome = await runContextMutation(
      {
        operation: "auto_compact",
        profile: policy.profile,
        lowerBoundTokens: policy.lowerBoundTokens,
        ...(policy.pruneEnabled && policy.pruneThresholdTokens !== null && policy.pruneTargetTokens !== null
          ? { pruneIfDue: { thresholdTokens: policy.pruneThresholdTokens, targetTokens: policy.pruneTargetTokens } }
          : {}),
        triggerContextTokens: decision.pressure.nextRequestPressureTokens,
        ...(hostNotices.length === 0 ? {} : { hostNotices }),
        omitContinuityNote: true,
        tokenFamily: sessionTokenFamily.resolved.family,
        tokenFamilySeedSource: sessionTokenFamily.seedSource,
      },
      {
        ...catchUp.getCommandContext(),
        cwd,
        sourceRolloutPath: transcriptPath,
        sourceSessionId: session.sessionId,
        isTurnOpen: () => catchUp.isTurnOpen(),
        isCaptureReady: () => catchUp.isCaptureReady(),
        isCaptureHealthy: () => catchUp.isCaptureHealthy(),
        closeSettledSegment: () =>
          catchUp.closeSettledSegment?.() ??
          Promise.resolve({ kind: "skipped" as const, detail: "capture not started" }),
      },
    );
    wrapperLog.info(formatOneShotPreLaunchOutcome(outcome.kind, outcome.messages.join(" | ") || "(no receipt)"));
    if (outcome.kind !== "rebuilt") {
      return;
    }

    const rebuilt = outcome.handoff.rebuilt;
    const lineage = await registerRebuiltSessionLineage({
      newSessionId: rebuilt.sessionId,
      threadId: outcome.handoff.threadId,
      prefixBoundary: rebuilt.prefixBoundary,
      accepted: false,
      lineageDbPath: defaultLineageDbPath(),
      logError: (message) => wrapperLog.warn(message),
    });
    if (!lineage.ok) {
      wrapperLog.warn(`cc-lhc one-shot: rebuilt session lineage not persisted: ${lineage.reason}`);
    }

    const outgoing = catchUp;
    const ctx = outgoing.getCommandContext();
    const threadRef = ctx.threadRef;
    const sdk = ctx.sdk;
    if (threadRef === undefined || sdk === undefined) {
      wrapperLog.warn(formatOneShotMissingThread());
      return;
    }
    let rebuiltCapture: CaptureSession;
    try {
      rebuiltCapture = startCaptureSession({
        startedAt,
        noInference,
        continueCapture: {
          threadRef,
          sdk,
          stats: ctx.stats,
          priorGeneration: outgoing.getCaptureGeneration(),
        },
        expectedSession: expectedSessionFromExplicitId(rebuilt.sessionId, "rebuilt_handoff"),
        knownRolloutPath: rebuilt.rolloutPath,
        prefixBoundary: rebuilt.prefixBoundary,
        suppressBindLineageRecord: true,
        lineageDbPath: defaultLineageDbPath(),
        log: (message) => wrapperLog.info(message),
        logError: (message) => wrapperLog.warn(message),
        onLifecycle: publishCaptureLifecycle,
        onAsyncWorkEvent: recordAsyncWorkEvent,
        seedAsyncWork: carriedSeed,
        onResultDelivery: recordResultDelivery,
        onRuntimeSettings,
        segmentThresholdTokens,
        tokenFamily: sessionTokenFamily,
      });
    } catch (cause) {
      wrapperLog.warn(
        `cc-lhc one-shot: capture would not start on rebuilt session ${rebuilt.sessionId} ` +
          `(${detailOf(cause)}); launching on ${session.sessionId} with its capture unchanged`,
      );
      return;
    }
    preLaunchCapture = rebuiltCapture;
    outgoingCaptureSettled = outgoing.stop().catch((cause: unknown) => {
      wrapperLog.warn(`cc-lhc one-shot: capture drain before pre-launch ${SMART_COMPACT} failed: ${detailOf(cause)}`);
    });

    expectedSession = expectedSessionFromExplicitId(rebuilt.sessionId, "rebuilt_handoff");
    childArgv = launchChildArgv(launchRest, launchPassthrough, rebuilt.sessionId);
    sessionAwaitingPromptIntake = { sessionId: rebuilt.sessionId, threadId: outcome.handoff.threadId };
    wrapperLog.info(formatOneShotCompactedBeforeLaunch(session.sessionId, rebuilt.sessionId));
  };

  if (launchForm === "one_shot" && expectedSession !== undefined && launchThread !== undefined) {
    try {
      await compactBeforeOneShotLaunch(expectedSession, launchThread);
    } catch (cause) {
      wrapperLog.warn(formatOneShotPreLaunchThrew(detailOf(cause)));
    }
  }

  const userChoseAutocompact = argvSuppliesNativeAutocompact(argv);
  const disableNativeAutoCompact = !userChoseAutocompact;
  const nativeAutoCompact: NativeAutoCompactState = disableNativeAutoCompact ? "disabled" : "passthrough";
  if (userChoseAutocompact) {
    wrapperLog.warn(`cc-lhc ${NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY}`);
    startupAnomalyNotices.push(nativeCompactAdvisoryLine());
    raiseActionable({
      kind: "native_auto_compact_conflict",
      lines: ["explicit --autocompact on this launch — see /details for the cause and the way back"],
    });
  }

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
        await releasePreChildOwnership();
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
        stderr.write(`cc-lhc: ${message}\n`);
        await releasePreChildOwnership();
        return 2;
      }
      wrapperLog.warn(`cc-lhc runtime descriptor create failed: ${message}`);
    }
  }

  if (!unboundTestChild && expectedSession !== undefined) {
    childArgv = installLaunchSettings(childArgv);
  }

  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;

  const childEnv: Record<string, string> = disableNativeAutoCompact
    ? nativeAutoCompactChildEnv(process.env as Record<string, string>, false)
    : { ...(process.env as Record<string, string>) };
  if (runtimeDescriptorPath !== undefined) {
    childEnv[RUNTIME_DESCRIPTOR_ENV] = runtimeDescriptorPath;
  }

  const plainChild = launchForm === "one_shot";
  let currentPty: IPty;
  try {
    currentPty = plainChild
      ? spawnPlain(claudeBin, childArgv, {
          cwd: process.cwd(),
          env: childEnv,
          bindToWrapperJob: (pid) => {
            const bound = exactProcessControl().bindChildToWrapperJob(pid);
            return bound.ok ? { ok: true } : { ok: false, reason: `${bound.code}: ${bound.message}` };
          },
          onCoupling: (coupling, detail) => {
            wrapperLog.info(
              `cc-lhc one-shot: Claude runs as a plain process (parent-death coupling: ${coupling})` +
                (detail === undefined ? "" : `; ${detail}`),
            );
          },
        })
      : spawnPty(claudeBin, childArgv, {
          name: TERM_NAME,
          cols,
          rows,
          cwd: process.cwd(),
          env: childEnv,
        });
  } catch (cause) {
    if (runtimeDescriptorPath !== undefined) {
      const rev = closeAndRemove(runtimeDescriptorPath, runtimeDescriptor, descriptorIo);
      if (!rev.ok) {
        wrapperLog.warn(`cc-lhc: spawn-failure descriptor revoke unproven: ${rev.reason}`);
      }
      runtimeDescriptorPath = undefined;
      runtimeDescriptor = undefined;
    }
    await releasePreChildOwnership();
    throw cause;
  }

  let exited = false;
  let captureSession: CaptureSession | undefined;
  let fatalRevocationExit = false;
  let descriptorCapabilityRevoked = false;
  let resolveRun: ((code: number) => void) | undefined;

  let compactOwnsInput = false;
  let droppedInputBytes = 0;
  let handoffInProgress = false;
  let expectedExitPty: IPty | null = null;
  let expectedExitResolve: (() => void) | null = null;
  let nonviableSwaps = 0;
  let standingNonviabilityAlarm: string[] = [];
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
  let pendingPanelNotices: string[] = [];
  let rejectionContinueSent = false;
  let minObservedProviderTotal: number | null = null;
  let autoOperationScheduled = false;
  let runAutoOperation: (args: {
    frozenTriggerTokens: number | null;
    receiptId: string;
    liveAsyncWork: readonly OpenAsyncWork[];
    afterRejection?: boolean;
  }) => Promise<void> = async () => {};

  const triggerFatalRevocation = (reason: string): void => {
    if (fatalRevocationExit && exited) return;
    fatalRevocationExit = true;
    wrapperLog.warn(`cc-lhc capture/retrieval FATAL: ${reason}`);
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {}
    try {
      stdin.removeAllListeners("data");
    } catch {}
    try {
      requestPtyTermination(currentPty, process.platform, "SIGKILL");
    } catch {}
    killAllInferenceChildren();
    try {
      altScreen.leave();
    } catch {}
    try {
      if (!plainChild) restoreTerminal(stdin, stdout);
    } catch {}
    forceWrapperExit(1);
    if (!exited) {
      exited = true;
      resolveRun?.(1);
    }
  };

  const altScreen = createAltScreenGuard((data) => stdout.write(data));

  const printExitStats = (): void => {
    if (captureSession === undefined) return;
    stderr.write(`${formatCaptureStatsLine(captureSession.stats)}\n`);
  };

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
      runtimeDescriptor = { ...runtimeDescriptor, tokenFamily: sessionTokenFamily.resolved.family };
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
      wrapperLog.warn(
        `cc-lhc runtime descriptor update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  let captureCatchUpPending = false;
  let captureRebuildForGeneration: number | null = null;
  let captureRebuildInFlight = false;

  let captureContinuation:
    | {
        threadRef: import("lhc").ThreadRef;
        sdk: import("lhc").Lhc;
        stats: import("../stats.js").CaptureStats;
        generation: number;
        sessionId: string;
      }
    | undefined;

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
            onLifecycle: publishCaptureLifecycle,
            onAsyncWorkEvent: recordAsyncWorkEvent,
            seedAsyncWork: carriedSeed,
            onResultDelivery: recordResultDelivery,
            onRuntimeSettings,
            segmentThresholdTokens,
            tokenFamily: sessionTokenFamily,
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

  const noteGovernorObservation = (record: import("../governor/index.js").GovernorObserveRecord): void => {
    wrapperLog.info(formatGovernorObserveLogLine(record));
    options.onGovernorObserve?.(record);
    const pressureForFloor = record.pressure.nextRequestPressureTokens;
    if (pressureForFloor > 0) {
      minObservedProviderTotal =
        minObservedProviderTotal === null ? pressureForFloor : Math.min(minObservedProviderTotal, pressureForFloor);
    }
  };

  const handleGovernorObserve = (record: import("../governor/index.js").GovernorObserveRecord): void => {
    noteGovernorObservation(record);
    if (record.wouldMutate !== true || record.observePhase !== "settled_seam") {
      persistGovernorObserve(record);
      return;
    }

    runSettledSeam(record, captureSession?.getLiveAsyncWork() ?? []);
  };

  const runSettledSeam = (
    record: import("../governor/index.js").GovernorObserveRecord,
    liveAsyncWork: readonly OpenAsyncWork[] = [],
  ): void => {
    const afterRejection = governorState.contextLimitRejected;
    if (!afterRejection) rejectionContinueSent = false;
    const persisted = persistGovernorObserve(record);

    if (persisted !== null && !persisted.inserted) {
      const existingOutcome = persisted.receipt.handoffOutcome;
      if (existingOutcome?.kind === "mutation_deferred") {
        wrapperLog.info(
          `cc-lhc governor: retrying receipt ${persisted.receipt.receiptId} after deferral (${existingOutcome.reason}); no mutation had started`,
        );
      } else if (existingOutcome?.kind === "scheduled") {
        wrapperLog.warn(
          `cc-lhc governor: replay of existing scheduled receipt ${persisted.receipt.receiptId} — an operation already owns it; no re-schedule; inspect handoffOutcome`,
        );
        lastAttempt = {
          summary: formatAutoNotRescheduledSummary(persisted.receipt.receiptId),
          atMs: Date.now(),
        };
        return;
      } else if (isTerminalHandoffOutcome(existingOutcome)) {
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
      wrapperLog.warn(formatAutoInMemoryReceipt(receiptId));
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
      if (attached) {
        lastAttempt = { summary: formatAutoDeferredSummary(reason, detail), atMs: Date.now() };
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
      lastAttempt = { summary: formatAutoSuspendedSummary(), atMs: Date.now() };
    } else if (launchForm === "one_shot") {
      deferAuto(
        "one_shot_next_invocation",
        "one-shot seat: this turn completes and the next invocation compacts before it launches",
      );
    } else if (captureSession?.isCaptureReady() !== true) {
      const phase = captureSession?.getCaptureHealth().phase ?? "starting";
      captureCatchUpPending = true;
      if (phase === "degraded") rebuildCaptureFromTranscript();
      deferAuto(
        "capture_catching_up",
        `capture is ${phase}; catching up from the transcript and re-evaluating when ready`,
        "warn",
      );
    } else {
      const frozenTriggerTokens = record.pressure.nextRequestPressureTokens;
      autoOperationScheduled = true;
      setImmediate(() => {
        void runAutoOperation({ frozenTriggerTokens, receiptId, liveAsyncWork, afterRejection }).finally(() => {
          autoOperationScheduled = false;
        });
      });
    }
  };

  const onCaptureLifecycle = (signals: readonly LifecycleSignal[]): void => {
    for (const signal of signals) {
      if (signal.kind !== "native_compact_observed") continue;
      const notice = nativeCompactAnomalyNotice(signal.summaryPreview);
      wrapperLog.warn(`cc-lhc ${notice}`);
      pendingPanelNotices = [...pendingPanelNotices, notice, "captured as one bounded turn; LHC compaction continues"];
    }

    if (captureSession !== undefined) {
      governorState = setGovernorCaptureGeneration(governorState, captureSession.getCaptureGeneration());
    }

    governorState = setGovernorTokenFamily(governorState, sessionTokenFamily.resolved);
    const observed = applyGovernorLifecycleBatch(governorState, signals, resolvedContextPolicy);
    governorState = observed.state;
    for (const record of observed.observes) handleGovernorObserve(record);

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

  captureLifecycleSink = onCaptureLifecycle;
  if (preLaunchCapture !== undefined) {
    captureSession = preLaunchCapture;
    publishDescriptorFromCapture();
    process.on("SIGUSR1", onSigusr1);
  } else if (expectedSession !== undefined && launchThread !== undefined) {
    captureSession = startCaptureSession({
      startedAt,
      noInference,
      expectedSession,
      launchThread,
      lineageDbPath: defaultLineageDbPath(),
      log: (message) => wrapperLog.info(message),
      logError: (message) => wrapperLog.warn(message),
      onLifecycle: publishCaptureLifecycle,
      onAsyncWorkEvent: recordAsyncWorkEvent,
      seedAsyncWork: carriedSeed,
      onResultDelivery: recordResultDelivery,
      onRuntimeSettings,
      segmentThresholdTokens,
      tokenFamily: sessionTokenFamily,
    });
    process.on("SIGUSR1", onSigusr1);
  }

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
    if (!plainChild) restoreTerminal(stdin, stdout);
    process.removeListener("SIGUSR1", onSigusr1);
    cleanupDescriptor();
    releaseThreadOwner();
  };

  process.on("exit", cleanup);

  if (stdin.isTTY && !plainChild) {
    stdin.setRawMode(true);
  }

  const leaderByte = resolveLeaderByte(process.env.CC_LHC_LEADER, (message) => {
    wrapperLog.warn(message);
  });
  const notifierEnabled = options.notifierDisabled !== true;
  let inputState: InputState = createInputState(leaderByte, { notifierEnabled });
  let _modalGeneration = 0;

  const outputHold = new OutputHold(
    options.outputHoldCapBytes ?? OUTPUT_HOLD_CAP_BYTES,
    (data) => stdout.write(data),
    () => {
      inputState = forceResetInput(inputState);
      altScreen.leave();
      wrapperLog.warn(OUTPUT_HOLD_OVERFLOW_MESSAGE);
      outputHold.flush();
    },
  );

  const forwardOutput = (data: string): void => {
    outputHold.feed(data);
  };

  const commandRuntime = (): LhcCommandRuntime => {
    const rollout = captureSession?.getRolloutInfo();
    const policy = resolvedContextPolicy.policy;
    const statusSnapshot = {
      latestProviderContextTokens: governorState.latestProviderContext?.total ?? null,
      targetTokens: policy.lowerBoundTokens,
      triggerTokens: policy.upperBoundTokens,
      nativeAutoCompact,
    };
    if (captureSession === undefined) {
      return {
        stats: emptyCaptureStats(),
        sdk: undefined,
        threadRef: undefined,
        cwd: process.cwd(),
        sourceRolloutPath: undefined,
        sourceSessionId: undefined,
        statusSnapshot,
        tokenFamily: sessionTokenFamily.resolved.family,
        tokenFamilySeedSource: sessionTokenFamily.seedSource,
      };
    }
    const ctx = captureSession.getCommandContext();
    return {
      ...ctx,
      cwd: process.cwd(),
      sourceRolloutPath: rollout?.path,
      sourceSessionId: rollout?.sessionId,
      ...(configFallbackNotice.length === 0 ? {} : { hostNotices: configFallbackNotice }),
      statusSnapshot,
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
      closeSettledSegment: () =>
        captureSession?.closeSettledSegment?.() ??
        Promise.resolve({ kind: "skipped" as const, detail: "capture not started" }),
      isCaptureHealthy: () => captureSession?.isCaptureHealthy() ?? false,
      isCaptureReady: () => captureSession?.isCaptureReady() ?? false,
      getCaptureGeneration: () => captureSession?.getCaptureGeneration() ?? 0,
      captureDegraded: captureSession?.getCaptureHealth().phase === "degraded",
      captureGeneration: captureSession?.getCaptureGeneration(),
      capturePhase: captureSession?.getCaptureHealth().phase,
      lineageDbPath: defaultLineageDbPath(),
      logLineageError: (message) => wrapperLog.warn(message),
      warnings: { count: wrapperLog.warningCount(), logPath: wrapperLog.path },
      getLiveAsyncWork: () => captureSession?.getLiveAsyncWork() ?? [],
      acceptCarryover: () =>
        acceptCarryoverAtSeam(
          ctx.threadRef !== undefined && "threadId" in ctx.threadRef ? ctx.threadRef.threadId : "",
          rollout?.path,
          rollout?.sessionId,
        ),
      tokenFamily: sessionTokenFamily.resolved.family,
      tokenFamilySeedSource: sessionTokenFamily.seedSource,
    };
  };

  const formatAgo = (atMs: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
  };

  const snapshotPanelView = () => {
    const policy = resolvedContextPolicy.policy;
    const capturePhase = captureSession?.getCaptureHealth().phase ?? "starting";
    const retrievalState = runtimeDescriptor?.state === "ready" ? "ready" : (runtimeDescriptor?.state ?? "unavailable");
    const inFlight = commandGuard.current();
    const activeOperation = handoffInProgress
      ? "handoff in progress"
      : inFlight !== null
        ? formatActiveOperation(inFlight.label)
        : null;
    const lastActionText =
      lastAction === null
        ? "none this wrapper session"
        : formatLastActionRow({
            operation: lastAction.operation,
            origin: lastAction.origin,
            ago: formatAgo(lastAction.atMs),
            ...(lastAction.triggerTokens === undefined
              ? {}
              : { triggerTokens: formatTokensShort(lastAction.triggerTokens) }),
            ...(lastAction.zoneBefore === undefined || lastAction.zoneAfter === undefined
              ? {}
              : {
                  zoneBefore: formatTokensShort(lastAction.zoneBefore),
                  zoneAfter: formatTokensShort(lastAction.zoneAfter),
                }),
            ...(lastAction.viewTokens === undefined ? {} : { viewTokens: formatTokensShort(lastAction.viewTokens) }),
          });

    const extraStatusRows: string[] = [];
    if (activeOperation !== null) extraStatusRows.push(formatActiveOperationRow(activeOperation));
    if (lastAttempt !== null && (lastAction === null || lastAttempt.atMs > lastAction.atMs)) {
      extraStatusRows.push(`last attempt: ${lastAttempt.summary} (${formatAgo(lastAttempt.atMs)})`);
    }
    if (retrievalState !== "ready") extraStatusRows.push(formatRetrievalStateRow(retrievalState));
    extraStatusRows.push(...startupAnomalyNotices);
    if (continuityStore !== null) {
      const panelThreadRef = captureSession?.getCommandContext().threadRef;
      const panelThreadId = panelThreadRef !== undefined && "threadId" in panelThreadRef ? panelThreadRef.threadId : "";
      if (panelThreadId !== "") {
        try {
          extraStatusRows.push(...formatPendingResultRows(continuityStore.listPendingResults(panelThreadId)));
        } catch (cause) {
          wrapperLog.warn(
            `cc-lhc continuity: results unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          extraStatusRows.push("carried work results unreadable (see log)");
        }
      }
    }

    const alarms: string[] = standingNonviabilityAlarm.map(toPanelWording);
    if (minObservedProviderTotal !== null && policy.upperBoundTokens <= minObservedProviderTotal) {
      alarms.push(
        `WARNING: trigger ${formatTokensShort(policy.upperBoundTokens)} is at/below observed Claude host overhead ` +
          `(${formatTokensShort(minObservedProviderTotal)}) — every settled turn would run /smart-compact`,
      );
    }

    const sources = resolvedContextPolicy.sources;
    const sourceOf = (source: (typeof sources)[keyof typeof sources]): string => formatPolicySource(source);
    const details = [
      { label: "Retrieval", value: retrievalState },
      {
        label: "Family",
        value: formatTokenFamilyLabel(sessionTokenFamily),
      },
      {
        label: "Policy",
        value:
          `target ${policy.lowerBoundTokens.toLocaleString("en-US")} (${sourceOf(sources.lowerBoundTokens)})` +
          ` · trigger ${policy.upperBoundTokens.toLocaleString("en-US")} (${sourceOf(sources.upperBoundTokens)})` +
          ` · minimum runway ${policy.minRunwayTokens.toLocaleString("en-US")} (${sourceOf(sources.minRunwayTokens)})`,
      },
      ...(nativeAutoCompact === "disabled"
        ? [{ label: "", value: nativeAutoCompactStatusLine(nativeAutoCompact) }]
        : nativeCompactAdvisoryDetailsRows(nativeAutocompactArgvEvidence(argv) ?? "--autocompact")),
      { label: "Operation", value: activeOperation ?? "none" },
      { label: "Last action", value: lastActionText },
      { label: "Scope", value: MODAL_SCOPE_NOTE },
      {
        label: "Precedence",
        value: `builtin < user ${userConfigPath()} < project ${projectConfigPath(process.cwd())} < session`,
      },
    ];

    return buildPanelViewSnapshot({
      providerContextTokens: governorState.latestProviderContext?.total ?? null,
      targetTokens: policy.lowerBoundTokens,
      triggerTokens: policy.upperBoundTokens,
      nativeAutoCompact,
      minRunwayTokens: policy.minRunwayTokens,
      policySources: {
        target: sources.lowerBoundTokens,
        trigger: sources.upperBoundTokens,
        runway: sources.minRunwayTokens,
      },
      captureHealth: capturePhase,
      profile: policy.profile,
      alarms,
      degradedNotices: configFallbackNotice,
      fallbacks: resolvedContextPolicy.fallbacks,
      extraStatusRows,
      details,
    });
  };

  const renderModalPanel = (): void => {
    if (inputState.mode === "passthrough") return;
    const cols = stdout.columns ?? DEFAULT_COLS;
    const rows = stdout.rows ?? DEFAULT_ROWS;
    if (inputState.mode === "modal" || inputState.mode === "executing") {
      inputState = clampPanelViewport({ ...inputState, panelView: snapshotPanelView() }, cols, rows);
    }
    const inFlight = commandGuard.current();
    const elapsedSeconds =
      inputState.mode === "executing" && inFlight !== null
        ? Math.floor((Date.now() - inFlight.startedAtMs) / 1000)
        : undefined;
    stdout.write(renderPanel(inputState, cols, rows, elapsedSeconds));
  };

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
      const rev = revokeDescriptorNow();
      if (fatalRevocationExit || !rev.ok) {
        try {
          requestPtyTermination(currentPty, process.platform, "SIGKILL");
        } catch {}
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
      if (promptAcceptanceSettled !== undefined) await promptAcceptanceSettled;
      await settleOutgoingCapture();
      if (governorReceiptStore !== null) {
        try {
          governorReceiptStore.close();
        } catch {}
        governorReceiptStore = null;
      }
      if (retainedHostPty !== null) {
        wrapperLog.info(
          `cc-lhc continuity: terminating retained ${retainedHostPty.frozen ? "frozen " : ""}completion host ` +
            `pid ${retainedHostPty.pty.pid} on orderly exit`,
        );
        try {
          if (retainedHostPty.frozen) {
            try {
              hostSignal(retainedHostPty.pty.pid, "SIGKILL");
            } catch {}
          } else {
            await (retainedTerminate?.(retainedHostPty.pty) ?? Promise.resolve(false));
          }
        } catch {}
        retainedHostPty = null;
      }
      if (continuityStore !== null) {
        let boundThreadId = "";
        try {
          boundThreadId = threadIdFromRef(captureSession?.getCommandContext().threadRef);
        } catch {
          boundThreadId = "";
        }
        if (boundThreadId === "") {
          wrapperLog.info("cc-lhc continuity cleanup: no bound thread; nothing cleaned up");
        } else {
          try {
            const stoppedMonitors = stopRelaunchedMonitors(continuityStore, boundThreadId, {
              probeIdentity: probeProcessIdentity,
              log: (message) => wrapperLog.info(message),
            }).stopped;
            const deadline = Date.now() + 1_000;
            const alive = (proc: { pid: number }): boolean => probeProcessIdentity(proc.pid).ok;
            while (stoppedMonitors.some(alive) && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          } catch (cause) {
            wrapperLog.warn(`cc-lhc continuity: relaunched monitor stop failed: ${String(cause)}`);
          }
          try {
            cleanupThread(continuityStore, boundThreadId, monitorOutputDir, {
              probeIdentity: probeProcessIdentity,
              log: (message) => wrapperLog.info(message),
            });
          } catch (cause) {
            wrapperLog.warn(
              `cc-lhc continuity cleanup failed; tracking kept: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
        try {
          continuityStore.close();
        } catch {}
        continuityStore = null;
      }
      if (handoffReceiptStore !== null) {
        try {
          handoffReceiptStore.close();
        } catch {}
        handoffReceiptStore = null;
      }
      cleanup();
      resolve(exitCode);
    };

    const debugInput = createInputDebugLogger(process.env.CC_LHC_INPUT_DEBUG);

    const settleCommand = (messages: string[], label: string, retainForNextPanel = false): void => {
      stopExecutingTicker();
      if (inputState.mode === "executing") {
        if (messages.length === 0) {
          inputState = finishExecuting(inputState);
          altScreen.leave();
          outputHold.flush();
          return;
        }
        inputState = showReceipts(inputState, panelReceiptRows(messages));
        renderModalPanel();
        return;
      }
      if (inputState.mode === "modal") {
        if (messages.length === 0) return;
        inputState = showLateReceipts(inputState, label, panelReceiptRows(messages));
        renderModalPanel();
        return;
      }
      for (const message of messages) wrapperLog.warn(`command receipt (modal dismissed early): [${label}] ${message}`);
      if (messages.length > 0) {
        pendingPanelNotices = [
          `${label} finished:`,
          ...panelReceiptRows(messages).flatMap((message) => message.split("\n")),
        ];
      }
    };

    const applyPolicyEdit = (commandLine: string): string[] => {
      const parts = commandLine.trim().split(/\s+/);
      const current = resolvedContextPolicy.policy;
      const lower = Number.parseInt(parts[1] ?? "", 10);
      const upper = Number.parseInt(parts[2] ?? "", 10);
      const candidate: typeof current = { ...current, lowerBoundTokens: lower, upperBoundTokens: upper };
      const changedKeys: Array<"lowerBoundTokens" | "upperBoundTokens"> = ["lowerBoundTokens", "upperBoundTokens"];
      const editLabel = `/bounds ${lower} ${upper}`;
      const errors = validateContextPolicy(candidate);
      if (errors.length > 0) {
        return [`rejected — nothing changed (${editLabel}):`, ...errors];
      }
      const sources = { ...resolvedContextPolicy.sources };
      for (const key of changedKeys) sources[key] = "session";
      resolvedContextPolicy = { ...resolvedContextPolicy, policy: candidate, sources, fallbacks: [] };
      configFallbackNotice = [];
      wrapperLog.info(
        `cc-lhc policy edit applied (${editLabel}) session scope: lower=${candidate.lowerBoundTokens} upper=${candidate.upperBoundTokens}`,
      );
      return [
        `${editLabel} — applied live to this wrapper`,
        "scope: session only — survives child handoffs, lost at wrapper exit",
        "persist by editing user/project config",
      ];
    };

    const runModalCommand = (commandLine: string): void => {
      const dispatchLabel = commandLine.replace(/^\/lhc-/, "");
      const label = inputState.line.trim() === "" ? dispatchLabel : inputState.line.trim();
      if (commandLine.startsWith("/lhc-bounds ")) {
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
      const mutating = dispatchLabel === "compact" || dispatchLabel.startsWith("prune");
      if (mutating) takeInputOwnership();
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
            governorState = setGovernorOperationInFlight(governorState, true);
            stopExecutingTicker();
            inputState = forceResetInput(inputState);
            altScreen.leave();
            outputHold.flush();
            try {
              const result = await performHandoff(outcome.handoff);
              settleCommand([...outcome.messages, formatHandoffResult(result)], label, true);
            } finally {
              governorState = setGovernorOperationInFlight(governorState, false);
            }
            return;
          }
          if (mutating) {
            lastAttempt = {
              summary: `manual ${label} did not hand off: ${toPanelWording(
                outcome.messages[outcome.messages.length - 1] ?? "(no detail)",
              )}`,
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

    const applyActions = (actions: ReturnType<typeof processInputChunk>["actions"]): void => {
      for (const action of actions) {
        if (action.kind === "enter_modal") {
          _modalGeneration += 1;
          outputHold.hold();
          altScreen.enter();
          inputState = {
            ...inputState,
            panelView: snapshotPanelView(),
            panelRows: [...pendingPanelNotices],
            route: "home",
            viewport: { scrollOffset: 0, selectedIndex: -1 },
          };
          pendingPanelNotices = [];
        } else if (action.kind === "select_allocation") {
          resolvedContextPolicy = applySessionAllocation(resolvedContextPolicy, action.id);
          inputState = {
            ...inputState,
            panelView: snapshotPanelView(),
            route: "home",
            viewport: { scrollOffset: 0, selectedIndex: -1 },
          };
        } else if (action.kind === "exit_modal") {
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
            if (compactOwnsInput) droppedInputBytes += action.enterBytes.length;
            else {
              governorState = noteGovernorInput(governorState);
              currentPty.write(Buffer.from(action.enterBytes).toString("latin1"));
            }
          }
        } else if (action.kind === "notifier_return") {
          altScreen.leave();
          outputHold.flush();
        } else if (action.kind === "execute") runModalCommand(action.commandLine);
      }
    };

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
      restoreIfModal();
      throw cause;
    };

    const forwardInput = (data: Buffer): void => {
      const result = processInputChunk(data, inputState);
      inputState = result.state;
      debugInput(data, inputState);
      if (result.toPty.length > 0) {
        if (compactOwnsInput) droppedInputBytes += countTypedBytes(result.toPty);
        else {
          governorState = noteGovernorInput(governorState);
          currentPty.write(result.toPty);
        }
      }
      applyActions(result.actions);
      renderModalPanel();
      armPendingEscTimer();
    };

    interface ChildRecord {
      pty: IPty;
      sessionId: string;
      routed: boolean;
      exited: boolean;
      outputBytes: number;
      held: string[];
      heldBytes: number;
    }

    const CANDIDATE_HOLD_CAP_BYTES = 1024 * 1024;

    const childRecords = new Map<IPty, ChildRecord>();

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
        forwardOutput("\x1b[2J\x1b[3J\x1b[H");
        if (held.length > 0) forwardOutput(held);
        return undefined;
      } catch (cause) {
        return `replacement is routed but its first repaint failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    };

    const sigtermGraceMs = options.handoffTimeouts?.sigtermGraceMs ?? 3_000;
    const sigkillWaitMs = options.handoffTimeouts?.sigkillWaitMs ?? 2_000;
    const captureReadyTimeoutMs = options.handoffTimeouts?.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
    const childLivenessTimeoutMs = options.handoffTimeouts?.childLivenessTimeoutMs ?? DEFAULT_CHILD_LIVENESS_TIMEOUT_MS;
    const childStableWindowMs = options.handoffTimeouts?.childStableWindowMs ?? DEFAULT_CHILD_STABLE_WINDOW_MS;
    const replacementAttempts = options.replacementAttempts ?? DEFAULT_REPLACEMENT_ATTEMPTS;
    const nonviableSwapLimit = options.nonviableSwapLimit ?? NONVIABLE_SWAPS_BEFORE_ALARM;

    const takeInputOwnership = (): void => {
      compactOwnsInput = true;
      droppedInputBytes = 0;
    };

    const releaseInputOwnership = (): void => {
      compactOwnsInput = false;
      if (droppedInputBytes === 0) return;
      wrapperLog.warn(`cc-lhc: dropped ${droppedInputBytes} typed-ahead byte(s) during compaction`);
      droppedInputBytes = 0;
      raiseActionable({ kind: "possible_undelivered_input", lines: [TYPED_AHEAD_RESEND_NOTICE] });
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

    interface CandidateSpawn {
      candidate: CandidateChild;
      record: ChildRecord;
      descriptorPath: string | undefined;
      descriptor: RuntimeDescriptorV1 | undefined;
      sessionFile: { path: string; baselineBytes: number } | undefined;
    }

    const spawnCandidateChild = (
      sessionId: string,
      injectNativeDisable: boolean,
      sessionFile?: { path: string; baselineBytes: number },
    ): CandidateSpawn => {
      let replacementArgv = replacementChildArgv(launchRest, launchPassthrough, sessionId);
      if (handoffRuntimeSettings !== undefined) {
        replacementArgv = applyClaudeRuntimeSettings(replacementArgv, handoffRuntimeSettings);
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
      const guided = injectRetrievalGuidance(replacementArgv);
      if (guided.ok) replacementArgv = guided.argv;
      else wrapperLog.warn(`cc-lhc handoff: retrieval guidance not injected: ${guided.reason}`);
      replacementArgv = installLaunchSettings(replacementArgv);
      const env: Record<string, string> = injectNativeDisable
        ? nativeAutoCompactChildEnv(process.env as Record<string, string>, false)
        : { ...(process.env as Record<string, string>) };
      if (descriptorPath !== undefined) env[RUNTIME_DESCRIPTOR_ENV] = descriptorPath;
      wrapperLog.info(`cc-lhc handoff spawn: ${claudeBin} ${replacementArgv.join(" ")}`);
      let pty: IPty;
      try {
        pty = spawnPty(claudeBin, replacementArgv, {
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
    retainedTerminate = (pty) => terminateChild(pty, true);

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
            `cc-lhc handoff: stopping the old capture after handoff failed: ${cause instanceof Error ? cause.message : String(cause)}`,
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
          onLifecycle: publishCaptureLifecycle,
          onAsyncWorkEvent: recordAsyncWorkEvent,
          seedAsyncWork: carriedSeed,
          onResultDelivery: recordResultDelivery,
          onRuntimeSettings,
          segmentThresholdTokens,
          tokenFamily: sessionTokenFamily,
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

    const performHandoff = async (
      request: HandoffRequest,
      governorReceiptId?: string | null,
    ): Promise<HandoffResult> => {
      handoffInProgress = true;
      handoffRuntimeSettings = { ...observedRuntimeSettings };
      const oldPty = currentPty;
      const spawns = new Map<number, CandidateSpawn>();
      const ports: HandoffPorts = {
        preHandoffStop: (): string | null => (exited ? "wrapper exiting" : null),
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
          if (spawn === undefined) return { switched: false, reason: "candidate went missing before the switch" };
          if (spawn.record.exited) {
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
        killOldChild: async () => {
          const items = request.carryover?.snapshot.items ?? [];
          const adoptItems = items.filter((item) => item.carryMode === "adopt");
          const nonShell = items.length - adoptItems.length;
          const mixed = adoptItems.length > 0 && nonShell > 0;
          const threadIdForPins = request.carryover?.snapshot.threadId ?? "";
          const unpinned =
            mixed && continuityStore !== null
              ? adoptItems.filter(
                  (item) =>
                    continuityStore?.getItem(threadIdForPins, item.launchId)?.continuation?.taskProcess === undefined,
                )
              : [];
          if (unpinned.length > 0) {
            wrapperLog.warn(
              "cc-lhc handoff: mixed carryover cannot pause the supervised child — no task process pinned for " +
                `${unpinned.map((item) => item.launchId).join(", ")}; terminating it gracefully instead, those ` +
                "shell(s) close from Claude's own marker",
            );
          }
          const canRetain =
            adoptItems.length > 0 &&
            unpinned.length === 0 &&
            childRecords.get(oldPty)?.exited !== true &&
            continuityStore !== null;
          if (canRetain) {
            const store = continuityStore as NonNullable<typeof continuityStore>;
            const carried = request.carryover as NonNullable<typeof request.carryover>;
            const probed = probeProcessIdentity(oldPty.pid);
            if (probed.ok) {
              let froze = true;
              if (mixed) {
                try {
                  hostSignal(oldPty.pid, "SIGSTOP");
                } catch (cause) {
                  froze = false;
                  wrapperLog.warn(
                    "cc-lhc handoff: could not pause the supervised child for a mixed carryover " +
                      `(${cause instanceof Error ? cause.message : String(cause)}); it will be terminated`,
                  );
                }
              }
              if (froze) {
                const host = {
                  pid: probed.identity.pid,
                  bootId: probed.identity.bootId,
                  starttime: probed.identity.starttime,
                  retainedAtMs: Date.now(),
                  ...(mixed ? { frozen: true } : {}),
                };
                try {
                  store.setRetainedHost({
                    threadId: carried.snapshot.threadId,
                    generation: carried.snapshot.generation,
                    host,
                    nowMs: host.retainedAtMs,
                  });
                  retainedHostPty = { pty: oldPty, threadId: carried.snapshot.threadId, frozen: mixed };
                  wrapperLog.info(
                    `cc-lhc handoff: old child pid ${oldPty.pid} retained as ${mixed ? "paused " : ""}completion host ` +
                      `for ${adoptItems.length} adopted background task(s)` +
                      (mixed ? `; ${nonShell} non-shell item(s) carried by the replacement` : ""),
                  );
                  return { kind: "retained_task_host", pid: oldPty.pid };
                } catch (cause) {
                  if (mixed) {
                    try {
                      hostSignal(oldPty.pid, "SIGCONT");
                    } catch {}
                  }
                  wrapperLog.warn(
                    "cc-lhc handoff: retained-host record failed; terminating instead: " +
                      `${cause instanceof Error ? cause.message : String(cause)}`,
                  );
                }
              }
            } else {
              wrapperLog.warn(
                `cc-lhc handoff: old-child identity unreadable (${probed.code}); adopted task(s) cannot be ` +
                  "hosted and will close as killed",
              );
            }
          }
          return observeOldChildCleanup({
            pid: oldPty.pid,
            alreadyExited: childRecords.get(oldPty)?.exited === true,
            probe: probeProcessIdentity,
            terminate: () => terminateChild(oldPty, true),
            onWarn: (message) => wrapperLog.warn(message),
          });
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
          ...(handoffReceiptStore === null
            ? {}
            : { handoffReceipts: handoffReceiptPortFromStore(handoffReceiptStore) }),
        });
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
          if (request.carryover !== undefined && continuityStore !== null) {
            const transfer = invokeCarryover(
              continuityStore,
              request.carryover.snapshot,
              { monitorOutputDir, cwd: process.cwd(), log: (message) => wrapperLog.info(message) },
              Date.now(),
            );
            const notCarried = transfer.results.filter((r) => r.kind === "failed");
            wrapperLog.info(
              `cc-lhc continuity: generation ${transfer.generation} ${transfer.closure.closed ? "closed" : `left open (${transfer.closure.refusal})`}: ` +
                `${transfer.results.length - notCarried.length} carried, ${notCarried.length} not carried`,
            );
            if (notCarried.length > 0) {
              pendingPanelNotices = [
                ...pendingPanelNotices,
                `continuity: ${notCarried.length} item(s) not carried across /smart-compact (see log)`,
              ];
            }
          }
        } else {
          lastAttempt = {
            summary: formatHandoffFailureSummary(
              request.operation,
              result.kind === "cancelled" ? "cancelled" : "nonviable",
              result.reason,
            ),
            atMs: Date.now(),
          };
        }
        const handoffOutcome: GovernorHandoffOutcome =
          result.kind === "success"
            ? {
                kind: "handoff_success",
                newSessionId: result.newSessionId,
                droppedInputBytes,
                handoffId: result.handoffId,
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
        if (governorReceiptId !== undefined && governorReceiptId !== null && governorReceiptId !== "") {
          attachGovernorHandoffOutcome(governorReceiptId, handoffOutcome, { mutationBegan: true });
        }
        options.onHandoffResult?.(result);
        if (result.kind === "success" && request.metrics.origin === "auto") {
          pendingPanelNotices = [...pendingPanelNotices, formatOldChildCleanup(result.oldChildCleanup)];
        }
        if (result.kind === "replacement_nonviable") {
          await noteNonviableSwap(result.oldSessionId, result.rebuiltSessionId, result.reason);
        }
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
        for (const [pty, record] of childRecords) {
          if (record.exited && !record.routed) childRecords.delete(pty);
        }
      }
    };

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
      for (const line of standingNonviabilityAlarm) wrapperLog.warn(`cc-lhc ${line}`);
      raiseActionable({ kind: "repeated_replacement_failure", lines: standingNonviabilityAlarm.map(toPanelWording) });
    };

    runAutoOperation = async (args: {
      frozenTriggerTokens: number | null;
      receiptId: string;
      liveAsyncWork: readonly OpenAsyncWork[];
      afterRejection?: boolean;
    }): Promise<void> => {
      const { frozenTriggerTokens, receiptId, liveAsyncWork } = args;
      let continueFrom: string | null = null;
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
            detail: formatAutoGuardBusyDetail(busyLabel),
            reason: "command_guard_busy",
          },
          { mutationBegan: false },
        );
        wrapperLog.info(formatAutoGuardBusyLog(busyLabel, receiptId));
        lastAttempt = {
          summary: formatAutoDeferredSummary("command_guard_busy", formatActiveOperation(busyLabel)),
          atMs: Date.now(),
        };
        return;
      }
      governorState = setGovernorOperationInFlight(governorState, true);
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
          liveAsyncWork,
        };
        const outcome = await runContextMutation(plan, runtime);
        wrapperLog.info(formatAutoMutationLog(outcome.kind, outcome.messages.join(" | ") || "(no receipt)"));
        if (outcome.kind !== "rebuilt") {
          lastAttempt = {
            summary: formatAutoMutationSummary(
              outcome.kind,
              toPanelWording(outcome.messages[outcome.messages.length - 1] ?? "(no detail)"),
            ),
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
        const handoff = await performHandoff(outcome.handoff, receiptId);
        if (args.afterRejection === true && handoff.kind === "success") continueFrom = outcome.handoff.oldSessionId;
      } catch (cause) {
        wrapperLog.warn(formatAutoThrew(cause instanceof Error ? cause.message : String(cause)));
        attachGovernorHandoffOutcome(
          receiptId,
          {
            kind: "mutation_refused",
            detail: cause instanceof Error ? cause.message : String(cause),
          },
          { mutationBegan: true },
        );
      } finally {
        const continuing = continueFrom !== null && !rejectionContinueSent;
        governorState = setGovernorOperationInFlight(governorState, false);
        if (!continuing) {
          releaseInputOwnership();
          commandGuard.release();
        }
      }
      if (continueFrom !== null) await continueAfterRejection(continueFrom);
    };

    const continueAfterRejection = async (oldSessionId: string): Promise<void> => {
      if (rejectionContinueSent) {
        wrapperLog.warn("cc-lhc: rejected as too long again after the automatic continue; not continuing again");
        raiseActionable({ kind: "possible_undelivered_input", lines: REJECTED_AGAIN_NOTICE_LINES });
        return;
      }
      rejectionContinueSent = true;
      try {
        await submitRejectionContinue(oldSessionId);
      } finally {
        releaseInputOwnership();
        commandGuard.release();
      }
    };

    const submitRejectionContinue = async (oldSessionId: string): Promise<void> => {
      let completed: string[] = [];
      try {
        const oldRollout = await findExpectedSessionFileOnce(process.cwd(), oldSessionId);
        if (oldRollout !== null) completed = completedToolCallsInLastTurn(await readFile(oldRollout, "utf8"));
      } catch (cause) {
        wrapperLog.warn(`cc-lhc: rejected turn's tool calls unreadable: ${detailOf(cause)}`);
      }
      const note = rejectionContinueNote(completed);
      const delayMs = options.rejectionContinueDelayMs ?? REJECTION_CONTINUE_DELAY_MS;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      if (exited || handoffInProgress) return;
      wrapperLog.info(
        `cc-lhc: continuing the turn rejected as too long, once (${completed.length} completed tool call(s) listed)`,
      );
      const target = currentPty;
      target.write(note);
      await new Promise((resolveEnter) => setTimeout(resolveEnter, REJECTION_CONTINUE_ENTER_DELAY_MS));
      if (!exited && currentPty === target) target.write("\r");
    };

    const openPanelFor = (rows: readonly string[]): boolean => {
      if (inputState.mode === "passthrough") {
        pendingPanelNotices = [...pendingPanelNotices, ...rows];
        if (!stdin.isTTY || plainChild) return false;
        const opened = processInputChunk(Buffer.from([leaderByte]), inputState);
        inputState = opened.state;
        applyActions(opened.actions);
        renderModalPanel();
        return inputState.mode === "modal";
      }
      if (inputState.mode === "modal") {
        inputState = { ...inputState, panelRows: [...inputState.panelRows, ...rows] };
        renderModalPanel();
        return true;
      }
      pendingPanelNotices = [...pendingPanelNotices, ...rows];
      return false;
    };
    const startup = planStartupPanel({
      shownVersion: readShownVersion(firstLoadMarkerPath(ccLhcHome())),
      version: ONBOARDING_VERSION,
      facts: {
        targetTokens: resolvedContextPolicy.policy.lowerBoundTokens,
        triggerTokens: resolvedContextPolicy.policy.upperBoundTokens,
        nativeAutoCompact,
        leaderByte,
      },
      conditions: startupActionable,
    });
    raiseActionable = (condition) => {
      openPanelFor(actionableGuidanceRows([condition]));
    };
    if (startup.open && (!stdin.isTTY || plainChild)) {
      pendingPanelNotices = [...pendingPanelNotices, ...actionableGuidanceRows(startupActionable)];
    } else if (startup.open && openPanelFor(startup.rows)) {
      if (startup.firstLoad) {
        try {
          markShown(firstLoadMarkerPath(ccLhcHome()), ONBOARDING_VERSION);
        } catch (cause) {
          wrapperLog.warn(`cc-lhc first-load marker not written: ${detailOf(cause)}`);
        }
      }
      wrapperLog.info(
        `cc-lhc Control Panel opened at launch (${startup.firstLoad ? `onboarding v${ONBOARDING_VERSION}` : "actionable condition"})`,
      );
    }

    attachChild(currentPty, expectedSession?.sessionId ?? "", true);
    if (plainChild) return;
    stdin.on("data", forwardInput);
    stdin.on("end", onStdinGone);
    stdin.on("close", onStdinGone);
    stdin.on("error", onStdinError);
  });
}

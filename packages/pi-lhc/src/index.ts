// Extension entry. PI loads this module and calls `activate(pi)`; it registers
// the PI hook rail and routes each hook to a fail-closed handler. The connector
// owns only plain-data `SessionState` plus the live `LhcInstance` it constructs
// per PI session, never a PI `ctx` or session object, which PI replaces on new,
// resume, and fork.

import type { BatchResult, MessageEventInput, OpResult, SdkConfig, ThreadRef } from "lhc";
import { threads } from "lhc";
import { capture, captureGap } from "./capture/converter.js";
import { type MapCtx, mapMessage } from "./capture/map-message.js";
import { mapModelSelect, mapThinkingLevelSelect } from "./capture/runtime-changes.js";
import { TurnAccumulator } from "./capture/turn-accumulator.js";
import { handleExportPiSession, LHC_EXPORT_PI_SESSION_COMMAND } from "./commands/export-pi-session.js";
import { handleExportThreadview, LHC_EXPORT_THREADVIEW_COMMAND } from "./commands/export-threadview.js";

export { LHC_EXPORT_PI_SESSION_COMMAND } from "./commands/export-pi-session.js";
export { LHC_EXPORT_THREADVIEW_COMMAND } from "./commands/export-threadview.js";

import { handleToolPrune, LHC_TOOL_PRUNE_COMMAND } from "./commands/tool-prune.js";
import { createCompactDiagnosticsBuffer, recordCompactCancel } from "./compact/diagnostics.js";
import { type CompactDiagnostic, handleSessionBeforeCompact } from "./compact/handler.js";
import {
  loadModelCompactSettings as loadModelCompactSettingsImpl,
  resolveModelCompactSettings,
  shouldTriggerModelCompact,
  toCompactParams,
} from "./compact/model-profiles.js";
import { findSeedEntryMapInBranch } from "./compact/seed-entry-map.js";
import { defaultNewThreadFilePath, defaultRegistryPath } from "./home.js";
import { loadAssignments as loadAssignmentsImpl } from "./inference/assignments.js";
import { createModelCall } from "./inference/model-call.js";
import { report, type StartupValidationReporter, validateReachable } from "./inference/startup-validation.js";
import { detectForkFromSessionTree, forkInfoFromHook, seedFork } from "./lifecycle/fork.js";
import { disposeInstance, initInstance } from "./lifecycle/instance.js";
import { takeLauncherOwnedStartup } from "./lifecycle/launcher-startup.js";
import { readLhcLaunchFlags, registerLhcFlags } from "./lifecycle/lhc-launch-flags.js";
import { pickThread, type ThreadChoice } from "./lifecycle/picker.js";
import {
  clearPendingRehydrate,
  LHC_REHYDRATE_COMMAND,
  rehydratePiSessionFromLhc,
  setPendingRehydrate,
  takePendingRehydrateModelPrefs,
  takePendingRehydrateSetup,
} from "./lifecycle/rehydrate.js";
import type { CaptureFailureDiagnostic, SessionState } from "./lifecycle/state.js";
import { createSessionState } from "./lifecycle/state.js";
import { type DurableThreadEntry, durableThreadEntryOf, LHC_THREAD_ENTRY_TYPE } from "./lifecycle/thread-entry.js";
import {
  type LaunchFlags,
  type ResolveDeps,
  resolveReloadThread,
  resolveThread,
  threadRefById,
} from "./lifecycle/thread-resolution.js";
import type {
  AgentMessage,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  PiCommandHandler,
  PiHookHandler,
  PiHookName,
  PiVoidHookHandler,
  ReplacedSessionContext,
  SessionEntry,
} from "./pi/types.js";
import type { LhcInstance } from "./shared/instance.js";

export {
  type CompactCancelCode,
  type CompactDiagnostic,
  compactCancelLogMessage,
  createCompactDiagnosticsBuffer,
  recordCompactCancel,
  writeCompactCancelLog,
} from "./compact/diagnostics.js";
export { handleSessionBeforeCompact } from "./compact/handler.js";
export {
  AUTO_COMPACT_RETRY_GROWTH_TOKENS,
  DEFAULT_MODEL_COMPACT_SETTINGS,
  FALLBACK_COMPACT_SETTINGS,
  loadModelCompactSettings,
  type ModelCompactSettings,
  resolveModelCompactSettings,
  shouldTriggerModelCompact,
  toCompactParams,
} from "./compact/model-profiles.js";
export { DEFAULT_COMPACT_PROFILE } from "./compact/profile.js";
export {
  assembleCompactionResult,
  assembleSummaryFromRenderedBands,
  type FirstKeptMapping,
  mapFirstKeptToEntryId,
} from "./compact/result-mapping.js";
export {
  findSeedEntryMapInBranch,
  findSeedEntryMapInSession,
  LHC_SEED_ENTRY_MAP_TYPE,
  type LhcSeedEntryMap,
  type LhcSeedEntryMapRow,
} from "./compact/seed-entry-map.js";
export {
  extensionFlagValuesFromLaunch,
  launcherHelpText,
  type ParsedLauncherArgv,
  parseLauncherArgv,
  piSessionFlagsConflict,
} from "./launcher/parse-args.js";
export { resolveStartupThread } from "./launcher/resolve-startup.js";
export { piLhcExtensionEntryPath, type RunPiLhcLauncherDeps, runPiLhcLauncher } from "./launcher/run.js";
export { createLauncherRuntimeFactory, type LauncherRuntimeFactoryOptions } from "./launcher/runtime-factory.js";
export { seedPiSessionFromLhc } from "./launcher/seed-session.js";
export { type LhcLauncherStartup, type LhcLauncherStartupDeps, prepareLhcLauncherStartup } from "./launcher/startup.js";
export { disposeInstance, initInstance, initLhc } from "./lifecycle/instance.js";
export {
  clearLauncherOwnedStartup,
  type LauncherOwnedStartup,
  setLauncherOwnedStartup,
  takeLauncherOwnedStartup,
} from "./lifecycle/launcher-startup.js";
export {
  getFlagFromValues,
  LHC_EXTENSION_FLAG_SPECS,
  LHC_FLAG_CONTINUE,
  LHC_FLAG_RESUME,
  LHC_FLAG_THREAD,
  readLhcLaunchFlags,
  registerLhcFlags,
} from "./lifecycle/lhc-launch-flags.js";
export {
  clearPendingRehydrate,
  LHC_REHYDRATE_COMMAND,
  type RehydrateModelPrefs,
  rehydratePiSessionFromLhc,
  setPendingRehydrate,
  takePendingRehydrateModelPrefs,
  takePendingRehydrateSetup,
} from "./lifecycle/rehydrate.js";
export { durableThreadEntryOf, LHC_THREAD_ENTRY_TYPE } from "./lifecycle/thread-entry.js";
export { applySessionThreadViewToSessionManager } from "./serving/context.js";
export type { LhcInstance } from "./shared/instance.js";

/** Capture-bearing hooks from Epic 1 (observe + record). */
export const EPIC_1_HOOKS = [
  "session_start",
  "message_end",
  "turn_end",
  "agent_end",
  "model_select",
  "thinking_level_select",
  "session_before_fork",
  "session_before_switch",
  "session_shutdown",
] as const satisfies readonly PiHookName[];

/** Compact hooks for LHC smart compact (Story 1). */
export const COMPACT_HOOKS = ["session_before_compact", "session_compact"] as const satisfies readonly PiHookName[];

/** Guard hooks: registered to protect the linear LHC record, not to capture. */
export const GUARD_HOOKS = ["session_before_tree"] as const satisfies readonly PiHookName[];

/** Hooks registered by the connector. Context is loaded via SessionManager seeding, not the context hook. */
export const CONNECTOR_HOOKS = [
  ...EPIC_1_HOOKS,
  ...COMPACT_HOOKS,
  ...GUARD_HOOKS,
] as const satisfies readonly PiHookName[];

export type CompactHook = (typeof COMPACT_HOOKS)[number];

export type Epic1Hook = (typeof EPIC_1_HOOKS)[number];

export type ConnectorHook = (typeof CONNECTOR_HOOKS)[number];

/** What the connector needs from the host to run a session. Every dependency
 *  has a working production default; the overrides exist for test isolation
 *  (temp registry/thread, scripted launch/selection) and for swapping in
 *  PI-auth-backed inference config.
 *
 *  `buildSdkConfig` returns the SdkConfig the instance is constructed from. Its
 *  default is the real PI inference config below, with assignment overrides
 *  layered over shipped defaults. */
export interface ConnectorDeps {
  buildSdkConfig?: (ctx: ExtensionContext) => OpResult<SdkConfig>;
  registryPath?: string;
  newThreadFilePath?: () => string;
  /** Override launch-flag read for test isolation. Production reads pi.getFlag. */
  readLaunchFlags?: () => OpResult<LaunchFlags>;
  selectThread?: (choices: readonly ThreadChoice[], ctx: ExtensionContext) => Promise<string | null>;
  startupValidationReporter?: StartupValidationReporter;
  /** Operator overrides for provider/model/prompt per derivation kind. Uses
   *  loadAssignments to merge over shipped defaults. */
  assignmentConfig?: unknown;
  /** Operator override for per-model compact settings (trigger threshold,
   *  lowerBound, band percentages). Replaces the shipped table wholesale;
   *  fails loud on malformed entries. */
  compactSettingsConfig?: unknown;
}

/** Everything the connector retains across hooks as PLAIN data — by
 *  construction structuredClone-able. The live `LhcInstance` is held separately
 *  in the closure (it is the connector's own engine, rebuilt on reload) and is
 *  deliberately not part of the snapshot. */
export interface ConnectorSnapshot {
  state: SessionState | null;
  lastDiagnostic: CaptureFailureDiagnostic | null;
}

export interface Connector {
  /** Register the PI hook rail on the PI extension API. */
  register(pi: ExtensionAPI): void;
  /** The plain-data state retained across hooks. `null` until a session
   *  resolves a thread; never holds a PI ctx. */
  getState(): SessionState | null;
  /** The live LHC instance for the current session, or `null`. A test/inspection
   *  seam — held by the connector but never part of the plain-data snapshot. */
  getInstance(): LhcInstance | null;
  /** Plain-data snapshot of all retained state (inspection/test seam). */
  snapshot(): ConnectorSnapshot;
  /** The hook handlers, keyed by event — exposed so tests can drive them with
   *  synthetic ctx/events without a live PI. */
  readonly handlers: Readonly<Record<Epic1Hook, PiVoidHookHandler<Epic1Hook>>>;
  readonly treeHandler: (
    event: import("./pi/types.js").SessionBeforeTreeEvent,
    ctx: ExtensionContext,
  ) => Promise<import("./pi/types.js").SessionBeforeTreeResult>;
  readonly compactHandlers: Readonly<{
    session_before_compact: PiHookHandler<"session_before_compact">;
    session_compact: PiVoidHookHandler<"session_compact">;
  }>;
  /** Compact cancel diagnostics accumulated this PI session; cleared on session boundary and successful `session_compact`. */
  getCompactDiagnostics(): readonly CompactDiagnostic[];
  /** Most recent compact cancel diagnostic, if any. */
  getLastCompactDiagnostic(): CompactDiagnostic | null;
}

/** The connector's live capture state for one session: the open-turn
 *  accumulator plus the stable PI session id used to scope idempotency keys.
 *  Held in the closure alongside the live `LhcInstance` — engine state rebuilt
 *  per session, never part of the plain-data snapshot and never a PI object. */
interface CaptureSession {
  piSessionId: string;
  accumulator: TurnAccumulator;
  sourceSeq: number;
  pendingMessages: PendingMessage[];
  claimedEntryIds: Set<string>;
}

interface PendingMessage {
  message: AgentMessage;
  beforeCount: number;
  beforeEntryIds: Set<string>;
  fallbackId: string;
  legacyEntryId?: string | undefined;
}

/** Fork state captured from `session_before_fork` and used on the next
 *  `session_start{fork}` to create and seed the forked thread. Plain data
 *  only — no PI objects retained across the fork boundary. */
interface PendingFork {
  sourceThreadRef: ThreadRef;
  forkEntryId: string;
}

/** A stable per-session id for idempotency-key scoping — the resolved thread's
 *  identity, which survives reload/replay (the same thread re-resolves to the
 *  same id). */
function sessionIdOf(ref: ThreadRef): string {
  return "threadId" in ref ? ref.threadId : ref.filePath;
}

function readDurableThreadId(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (
      entry === undefined ||
      (entry.type !== LHC_THREAD_ENTRY_TYPE && !(entry.type === "custom" && entry.customType === LHC_THREAD_ENTRY_TYPE))
    ) {
      continue;
    }
    const data =
      typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : entry;
    const threadId = data.threadId;
    if (typeof threadId === "string" && threadId !== "") return threadId;
  }
  return null;
}

/** The default SDK config injects the host ModelCall function that resolves
 *  provider/model through PI's registry and completes through pi-ai when
 *  available. Assignment config is merged over shipped defaults. */
function defaultBuildSdkConfig(ctx: ExtensionContext, assignmentConfig: unknown = undefined): OpResult<SdkConfig> {
  const assignments = loadAssignmentsImpl(assignmentConfig);

  return {
    ok: true,
    value: {
      inference: {
        call: createModelCall(ctx),
        assignments,
      },
      mode: "background",
    },
  };
}

/** Render the cwd-scoped `--lhc-resume` candidates as an operator-facing list, each
 *  line carrying the title, creation time, and id. */
function renderResumeCandidates(choices: readonly ThreadChoice[]): string {
  const lines = choices.map((choice, i) => {
    const title = choice.title ?? "(untitled)";
    return `  ${i + 1}. ${title}  ·  created ${choice.createdAt}  ·  ${choice.threadId}`;
  });
  return [
    `pi-lhc --lhc-resume: ${choices.length} thread(s) in this directory:`,
    ...lines,
    choices.length === 1
      ? "One candidate found; resuming it."
      : "Select a thread from the picker, or relaunch with --lhc-thread <id> in headless mode.",
  ].join("\n");
}

/** Default `--lhc-resume` selection. The PI extension UI exposes an async
 *  selector in interactive/RPC modes, so multiple candidates are resolved by
 *  operator choice. Headless mode has no input surface, so ambiguous resume
 *  fails closed and the operator can use `--lhc-thread <id>` for explicit attach. */
async function defaultSelectThread(choices: readonly ThreadChoice[], ctx: ExtensionContext): Promise<string | null> {
  if (choices.length === 0) return null;
  if (choices.length === 1) {
    if (ctx.hasUI) ctx.ui.notify(renderResumeCandidates(choices), "info");
    return choices[0]?.threadId ?? null;
  }

  if (!ctx.hasUI || ctx.ui.select === undefined) {
    if (ctx.hasUI) ctx.ui.notify(renderResumeCandidates(choices), "warning");
    return null;
  }

  const labels = choices.map((choice, i) => {
    const title = choice.title ?? "(untitled)";
    return `${i + 1}. ${title} · created ${choice.createdAt} · ${choice.threadId}`;
  });
  const selected = await ctx.ui.select("pi-lhc --lhc-resume: select a thread", labels);
  if (selected === undefined) return null;
  const index = labels.indexOf(selected);
  return index >= 0 ? (choices[index]?.threadId ?? null) : null;
}

/** Build a connector instance. Its mutable state lives in this closure; the
 *  registered handlers capture it, so the instance stays live for the session
 *  even when `activate` discards the returned object. The connector holds NO
 *  module-level state of its own — reload reconstructs the thread from the
 *  durable PI session entry and resolves that threadId through the LHC registry,
 *  so a fresh connector with an empty closure reattaches correctly. */
export function createConnector(deps: ConnectorDeps = {}): Connector {
  // The connector's retained state. `state` is plain data (the durable thread
  // reference + flags); `instance` is the live SDK engine (rebuilt on reload);
  // `lastDiagnostic` is the plain-data health signal. None is a PI object, and
  // none survives the connector — reload re-resolves from the registry.
  let state: SessionState | null = null;
  let instance: LhcInstance | null = null;
  let lastDiagnostic: CaptureFailureDiagnostic | null = null;
  let captureSession: CaptureSession | null = null;
  let pendingFork: PendingFork | null = null;
  const compactDiagnostics = createCompactDiagnosticsBuffer();
  let appendThreadEntry: ((entry: DurableThreadEntry) => void) | null = null;
  let readLaunchFromPi: (() => OpResult<LaunchFlags>) | null = null;
  let extensionPi: ExtensionAPI | null = null;

  const buildSdkConfig =
    deps.buildSdkConfig ?? ((ctx: ExtensionContext) => defaultBuildSdkConfig(ctx, deps.assignmentConfig));
  const modelCompactSettings = loadModelCompactSettingsImpl(deps.compactSettingsConfig);
  // Connector-side auto-compact trigger state. In-flight prevents overlap;
  // last-attempt + growth guard prevents hammering a cancelling compact
  // (e.g. capture_incomplete) every turn at the same context size.
  let autoCompactInFlight = false;
  let autoCompactLastAttemptTokens: number | null = null;
  // Production defaults resolve under ~/.pi-lhc (or PI_LHC_HOME). Tests inject
  // temp registry/thread paths via deps so optional registryPath plumbing stays.
  const registryPath = deps.registryPath ?? defaultRegistryPath();
  const newThreadFilePath = deps.newThreadFilePath ?? defaultNewThreadFilePath;
  const readLaunchFlags =
    deps.readLaunchFlags ?? (() => (readLaunchFromPi === null ? { ok: true, value: {} } : readLaunchFromPi()));
  const selectThread = deps.selectThread ?? defaultSelectThread;

  function diag(code: string, message: string): CaptureFailureDiagnostic {
    return { code, message, recordedGap: false };
  }

  // The registry/file deps every resolver path shares. Production always fills
  // registryPath from the home module (tests override via ConnectorDeps).
  function buildResolveDeps(ctx: ExtensionContext): ResolveDeps {
    return { cwd: ctx.cwd, newThreadFilePath, registryPath };
  }

  // Normal launch resolution: `--lhc-resume` runs the cwd-scoped operator picker;
  // `--lhc-thread` / `--lhc-continue` / no-flag go through the registry resolver (only
  // no-flag creates).
  async function resolveForLaunch(launch: LaunchFlags, ctx: ExtensionContext): Promise<OpResult<ThreadRef | null>> {
    if (launch.resume === true) {
      return pickThread(ctx.cwd, {
        registryPath,
        select: (choices) => selectThread(choices, ctx),
      });
    }
    return resolveThread(launch, buildResolveDeps(ctx));
  }

  // Reload resolution: read the exact prior threadId PI durably replayed in
  // the current session entries. No cwd-most-recent fallback.
  async function resolveReloadFor(ctx: ExtensionContext): Promise<OpResult<ThreadRef | null>> {
    return resolveReloadThread(readDurableThreadId(ctx), buildResolveDeps(ctx));
  }

  // session_start: resolve the recording thread and construct one background
  // instance against it. Config is gated first so a session with no usable
  // inference config resolves/creates nothing (no orphan thread). On reload the
  // thread is re-resolved from the durable registry (reattach, never create);
  // every other reason runs the normal launch resolution. Fork creates a new
  // thread and seeds it from the source thread.
  const onSessionStart: PiHookHandler<"session_start"> = async (event, ctx) => {
    compactDiagnostics.clear();
    autoCompactInFlight = false;
    autoCompactLastAttemptTokens = null;
    const config = buildSdkConfig(ctx);
    if (!config.ok) {
      lastDiagnostic = diag("instance_not_configured", config.error.reason);
      return;
    }

    let resolved: OpResult<ThreadRef | null> | undefined;
    let forkAttempted = false;

    // Fork path: create a new thread and seed it from the source.
    // Detection relies on pendingFork from session_before_fork hook, with PI's
    // session tree as fallback evidence. Not dependent on event.reason.
    if (pendingFork !== null) {
      forkAttempted = true;
      // Hook-based fork detection: session_before_fork fired.
      const { sourceThreadRef, forkEntryId } = pendingFork;

      // Create a new thread for the fork.
      const resolveDeps = buildResolveDeps(ctx);
      const newFilePath = resolveDeps.newThreadFilePath();
      const newThreadInput: { filePath: string; cwd: string; registryPath?: string } = {
        filePath: newFilePath,
        cwd: resolveDeps.cwd,
      };
      if (resolveDeps.registryPath !== undefined) {
        newThreadInput.registryPath = resolveDeps.registryPath;
      }
      const created = await threads.newThread(newThreadInput);
      if (!created.ok) {
        lastDiagnostic = diag("fork_thread_creation_failed", created.error.reason);
        pendingFork = null;
        state = null;
        captureSession = null;
        return;
      } else {
        const targetThreadRef: ThreadRef = threadRefById(created.value.threadId, registryPath);

        // Initialize the instance against the target thread first (required for seedFork).
        const built = await initInstance(targetThreadRef, config.value);
        if (!built.ok) {
          lastDiagnostic = diag("instance_init_failed", built.error.reason);
          pendingFork = null;
          state = null;
          captureSession = null;
          return;
        } else {
          instance = built.value;

          // Seed the fork by replaying source events up to the fork point.
          const seeded = await seedFork(sourceThreadRef, targetThreadRef, forkEntryId, instance);
          if (!seeded.ok) {
            // Seed failure is fatal because the forked thread would be incomplete.
            lastDiagnostic = diag("fork_seed_failed", seeded.error.reason);
            pendingFork = null;
            await disposeInstance(instance);
            instance = null;
            state = null;
            captureSession = null;
            return;
          } else {
            // Fork succeeded - clear pending fork state and use the forked thread.
            pendingFork = null;
            resolved = { ok: true, value: targetThreadRef };
          }
        }
      }
    }

    // PI session-tree fallback when session_before_fork was absent.
    // If pendingFork is null but we have a previous session, detect fork from session tree.
    if (resolved === undefined && !forkAttempted && state !== null && event.previousSessionFile !== undefined) {
      const forkFromTree = detectForkFromSessionTree(ctx, event, state.threadRef);
      if (forkFromTree !== null) {
        forkAttempted = true;
        // Session tree indicates a fork; create and seed as above.
        const { sourceThreadRef, forkEntryId } = forkFromTree;

        const resolveDeps = buildResolveDeps(ctx);
        const newFilePath = resolveDeps.newThreadFilePath();
        const newThreadInput: { filePath: string; cwd: string; registryPath?: string } = {
          filePath: newFilePath,
          cwd: resolveDeps.cwd,
        };
        if (resolveDeps.registryPath !== undefined) {
          newThreadInput.registryPath = resolveDeps.registryPath;
        }
        const created = await threads.newThread(newThreadInput);
        if (!created.ok) {
          lastDiagnostic = diag("fork_thread_creation_failed", created.error.reason);
          state = null;
          captureSession = null;
          return;
        } else {
          const targetThreadRef: ThreadRef = threadRefById(created.value.threadId, registryPath);

          const built = await initInstance(targetThreadRef, config.value);
          if (!built.ok) {
            lastDiagnostic = diag("instance_init_failed", built.error.reason);
            state = null;
            captureSession = null;
            return;
          } else {
            instance = built.value;

            const seeded = await seedFork(sourceThreadRef, targetThreadRef, forkEntryId, instance);
            if (!seeded.ok) {
              lastDiagnostic = diag("fork_seed_failed", seeded.error.reason);
              await disposeInstance(instance);
              instance = null;
              state = null;
              captureSession = null;
              return;
            } else {
              resolved = { ok: true, value: targetThreadRef };
            }
          }
        }
      }
    }

    // Launcher-owned startup: thread was resolved and context seeded before PI
    // session creation; do not re-resolve or create a different LHC thread here.
    if (resolved === undefined) {
      const launcherStartup = takeLauncherOwnedStartup();
      if (launcherStartup !== null) {
        resolved = { ok: true, value: launcherStartup.threadRef };
      }
    }

    // Pre-attached pi-lhc.thread entry (launcher seeds this into in-memory sessions).
    if (resolved === undefined) {
      const preattachedId = readDurableThreadId(ctx);
      if (preattachedId !== null) {
        resolved = await resolveReloadThread(preattachedId, buildResolveDeps(ctx));
      }
    }

    // Normal launch resolution (if not resolved by fork or launcher paths above).
    if (resolved === undefined) {
      const launchRead = readLaunchFlags();
      if (!launchRead.ok) {
        lastDiagnostic = diag("thread_resolution_failed", launchRead.error.reason);
        return;
      }
      const launch = launchRead.value;
      const isReload = event.reason === "reload";
      resolved = isReload ? await resolveReloadFor(ctx) : await resolveForLaunch(launch, ctx);
    }

    if (!resolved.ok) {
      lastDiagnostic = diag("thread_resolution_failed", resolved.error.reason);
      return;
    }
    if (resolved.value === null) {
      const isReload = event.reason === "reload";
      lastDiagnostic = isReload
        ? diag("no_thread_to_reattach", "reload found no thread to reattach for this cwd")
        : diag("no_thread_selected", "--lhc-resume resolved no thread");
      return;
    }

    // If instance wasn't created during fork path, create it now.
    if (instance === null) {
      const built = await initInstance(resolved.value, config.value);
      if (!built.ok) {
        lastDiagnostic = diag("instance_init_failed", built.error.reason);
        return;
      }
      instance = built.value;
    }

    state = createSessionState(resolved.value);
    const durableEntry = durableThreadEntryOf(resolved.value);
    if (durableEntry !== null && readDurableThreadId(ctx) === null) {
      appendThreadEntry?.(durableEntry);
    }
    const piSessionId = sessionIdOf(resolved.value);
    captureSession = {
      piSessionId,
      accumulator: new TurnAccumulator({ piSessionId }),
      sourceSeq: 0,
      pendingMessages: [],
      claimedEntryIds: new Set(),
    };

    const rehydrateModelPrefs = takePendingRehydrateModelPrefs();
    if (rehydrateModelPrefs !== null && extensionPi !== null) {
      if (rehydrateModelPrefs.model !== null) {
        const model = ctx.modelRegistry.find(rehydrateModelPrefs.model.provider, rehydrateModelPrefs.model.id);
        if (model !== undefined) {
          await extensionPi.setModel(model);
        }
      }
      extensionPi.setThinkingLevel(rehydrateModelPrefs.thinkingLevel);
    }

    // Probe inference assignments before first use. Validation failures are
    // reported but do not stop capture.
    if (config.value.inference === undefined) {
      lastDiagnostic = diag("inference_config_missing", "SDK config missing inference block");
      return;
    }
    const assignments = config.value.inference.assignments;
    const validationReport = validateReachable(assignments, ctx);
    if (deps.startupValidationReporter === undefined) {
      report(validationReport, ctx, state);
    } else {
      report(validationReport, ctx, state, { reporter: deps.startupValidationReporter });
    }
  };

  // Dispose with flush before any session swap (session_before_switch fires
  // pre-new/resume) and on shutdown/reload. Non-UI `quit` paths (print/json)
  // skip drain-settling so one-shot commands return promptly; intake is already
  // durable at that point. Idempotent: disposing twice or with no live instance
  // is a no-op. No reload-handoff state is kept — a reload re-resolves its
  // thread from the durable registry on the next session_start.
  const onDispose: PiVoidHookHandler<"session_before_switch" | "session_shutdown"> = async (event, ctx) => {
    await flushPendingMessages(ctx);
    const settle = !(event.type === "session_shutdown" && event.reason === "quit" && ctx.hasUI === false);
    const result = await disposeInstance(instance, { settle });
    if (!result.ok) lastDiagnostic = diag("dispose_failed", result.error.reason);
    instance = null;
    captureSession = null;
    compactDiagnostics.clear();
  };

  // Record a capture failure as a plain-data health diagnostic. The converter
  // already recorded a durable gap for a writable-thread malformed event
  // (`invalid_event`); a store-unavailable failure could not, so it surfaces as
  // an extension health signal with no gap. Neither path throws.
  function recordCaptureOutcome(result: OpResult<BatchResult>, events: readonly MessageEventInput[]): void {
    if (result.ok) {
      if (state !== null) delete state.health.lastCaptureFailure;
      return;
    }
    const recordedGap = result.error.code === "invalid_event";
    const failure: CaptureFailureDiagnostic = {
      code: result.error.code,
      message: result.error.reason,
      recordedGap,
    };
    if (events[0] !== undefined) failure.eventKey = events[0].idempotencyKey;
    lastDiagnostic = failure;
    if (state !== null) state.health.lastCaptureFailure = failure;
  }

  function nextSourceSeq(session: CaptureSession): number {
    const sourceSeq = session.sourceSeq;
    session.sourceSeq += 1;
    return sourceSeq;
  }

  function fallbackIdFor(kind: string, sourceSeq: number): string {
    // Last-resort discriminator. Current PI gives message identity through the
    // persisted SessionEntry, so this path is for malformed/unmatched inputs or
    // a future host that exposes neither an entry id nor a durable position.
    return `${kind}:sourceSeq:${sourceSeq}`;
  }

  async function recordMappingFailure(hook: string, sourceSeq: number, cause: unknown): Promise<void> {
    if (instance === null) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    const result = await captureGap(fallbackIdFor(hook, sourceSeq), `${hook}: ${message}`, instance);
    if (!result.ok) {
      recordCaptureOutcome(result, []);
      return;
    }
    const failure: CaptureFailureDiagnostic = {
      code: "invalid_event",
      message: `${hook}: ${message}`,
      recordedGap: true,
    };
    lastDiagnostic = failure;
    if (state !== null) state.health.lastCaptureFailure = failure;
  }

  function sortedJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
  }

  function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  }

  function sameMessage(left: AgentMessage, right: AgentMessage): boolean {
    return sortedJson(left) === sortedJson(right);
  }

  function entryIdOf(entry: SessionEntry): string | null {
    return typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
  }

  function stringField(record: unknown, field: string): string | null {
    if (typeof record !== "object" || record === null) return null;
    const value = (record as Record<string, unknown>)[field];
    return typeof value === "string" && value !== "" ? value : null;
  }

  function numberField(record: unknown, field: string): number | null {
    if (typeof record !== "object" || record === null) return null;
    const value = (record as Record<string, unknown>)[field];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function isMatchingMessageEntry(entry: SessionEntry, message: AgentMessage): boolean {
    return entry.type === "message" && entry.message !== undefined && sameMessage(entry.message, message);
  }

  function findPersistedEntryId(
    ctx: ExtensionContext,
    session: CaptureSession,
    pending: PendingMessage,
  ): string | null {
    const entries = ctx.sessionManager.getEntries();
    const appended = entries.slice(pending.beforeCount);

    for (const entry of appended) {
      const id = entryIdOf(entry);
      if (id === null || pending.beforeEntryIds.has(id) || session.claimedEntryIds.has(id)) continue;
      if (!isMatchingMessageEntry(entry, pending.message)) continue;
      return id;
    }

    // Redelivery of an already-persisted PI message can arrive with no newly
    // appended entry. Use the latest matching session entry so the idempotency
    // key lands on the same persisted PI entry instead of connector sourceSeq.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const id = entryIdOf(entry);
      if (id === null) continue;
      if (!isMatchingMessageEntry(entry, pending.message)) continue;
      return id;
    }

    if (pending.legacyEntryId !== undefined) return pending.legacyEntryId;
    return null;
  }

  async function flushPendingMessages(ctx: ExtensionContext): Promise<void> {
    if (instance === null || captureSession === null) return;
    if (captureSession.pendingMessages.length === 0) return;
    const pending = captureSession.pendingMessages.splice(0);
    let hadFailure = false;
    for (const message of pending) {
      const persistedEntryId = findPersistedEntryId(ctx, captureSession, message);
      if (persistedEntryId !== null) captureSession.claimedEntryIds.add(persistedEntryId);
      const mapCtx: MapCtx =
        persistedEntryId !== null
          ? { piSessionId: captureSession.piSessionId, entryId: persistedEntryId }
          : { piSessionId: captureSession.piSessionId, fallbackId: message.fallbackId };

      let events: MessageEventInput[];
      try {
        events = mapMessage(message.message, mapCtx);
      } catch (cause) {
        await recordMappingFailure("message_end", nextSourceSeq(captureSession), cause);
        hadFailure = true;
        continue;
      }
      captureSession.accumulator.onMessage(events, message.message);
      if (events.length === 0) continue;
      const result = await capture(events, instance);
      recordCaptureOutcome(result, events);
      if (!result.ok) hadFailure = true;
    }
    if (!hadFailure && state !== null) delete state.health.lastCaptureFailure;
  }

  function latestRuntimeEntryId(
    ctx: ExtensionContext,
    kind: "model_change" | "thinking_level_change",
    matches: (entry: SessionEntry) => boolean,
  ): string | null {
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined || entry.type !== kind || !matches(entry)) continue;
      return entryIdOf(entry);
    }
    return null;
  }

  // message_end: map the finalized PI message to ordered LHC events, track the
  // open turn, and flush through the converter after PI persists the message
  // entry. Current PI appends the SessionEntry after message_end handlers
  // return, so this hook queues the message and the next hook flushes the prior
  // pending message against ctx.sessionManager.getEntries().
  const onMessageEnd: PiHookHandler<"message_end"> = async (event, ctx) => {
    if (instance === null || captureSession === null) return;
    await flushPendingMessages(ctx);
    const sourceSeq = nextSourceSeq(captureSession);
    const entries = ctx.sessionManager.getEntries();
    const legacyEntryId = stringField(event, "entryId") ?? undefined;
    const legacyPosition = numberField(event, "position");
    captureSession.pendingMessages.push({
      message: event.message,
      beforeCount: entries.length,
      beforeEntryIds: new Set(entries.map(entryIdOf).filter((id): id is string => id !== null)),
      fallbackId: legacyPosition !== null ? `message_end:${legacyPosition}` : fallbackIdFor("message_end", sourceSeq),
      legacyEntryId,
    });
  };

  // model_select / thinking_level_select fire only in-stream; capture each as
  // typed LHC events. PI persists these entries before emitting the hook, so
  // the current SessionEntry id is available synchronously.
  const onModelSelect: PiHookHandler<"model_select"> = async (event, ctx) => {
    if (instance === null || captureSession === null) return;
    await flushPendingMessages(ctx);
    const sourceSeq = nextSourceSeq(captureSession);
    const entryId = latestRuntimeEntryId(
      ctx,
      "model_change",
      (entry) => entry.provider === event.model.provider && entry.modelId === event.model.id,
    );
    const mapCtx: MapCtx = {
      piSessionId: captureSession.piSessionId,
      entryId: entryId ?? undefined,
      fallbackId: fallbackIdFor("model_select", sourceSeq),
    };
    const change = mapModelSelect(event, mapCtx);
    recordCaptureOutcome(await capture([change], instance), [change]);
  };

  const onThinkingLevelSelect: PiHookHandler<"thinking_level_select"> = async (event, ctx) => {
    if (instance === null || captureSession === null) return;
    await flushPendingMessages(ctx);
    const sourceSeq = nextSourceSeq(captureSession);
    const entryId = latestRuntimeEntryId(ctx, "thinking_level_change", (entry) => entry.thinkingLevel === event.level);
    const mapCtx: MapCtx = {
      piSessionId: captureSession.piSessionId,
      entryId: entryId ?? undefined,
      fallbackId: fallbackIdFor("thinking_level_select", sourceSeq),
    };
    const change = mapThinkingLevelSelect(event, mapCtx);
    recordCaptureOutcome(await capture([change], instance), [change]);
  };

  // agent_end closes the LHC turn exactly once per agent run.
  // PI's per-step turn_end is ignored as a boundary (it stays a no-op below).
  // Final assistant stopReason on event.messages governs turn outcome (schema
  // v5); hard-kill never reaches here and leaves the turn open with NULL facts.
  const onAgentEnd: PiHookHandler<"agent_end"> = async (event, ctx) => {
    if (instance !== null && captureSession !== null) {
      await flushPendingMessages(ctx);
      const turnEnd = captureSession.accumulator.onAgentEnd({ messages: event.messages });
      if (turnEnd.length !== 0) {
        recordCaptureOutcome(await capture(turnEnd, instance), turnEnd);
      }
    }
    maybeTriggerAutoCompact(ctx);
  };

  // Contain every handler: an observe-only hook must never throw back into PI
  // (a thrown hook breaks the user's session). A caught error becomes a
  // plain-data diagnostic; it is never rethrown.
  const guard = (name: Epic1Hook, body: PiVoidHookHandler<Epic1Hook>): PiVoidHookHandler<Epic1Hook> => {
    return async (event, ctx): Promise<void> => {
      try {
        await body(event, ctx);
      } catch (err) {
        lastDiagnostic = {
          code: "hook_handler_error",
          message: `${name}: ${err instanceof Error ? err.message : String(err)}`,
          recordedGap: false,
        };
      }
    };
  };

  // Per-model auto-compact trigger. Runs at agent_end ONLY — never per model
  // turn: ctx.compact() routes through PI's MANUAL compact path, which aborts
  // any in-flight agent run first. Between runs the abort is a no-op, and the full
  // session_before_compact preflight (capture gate, mapping) still runs.
  // Mid-run growth stays covered by PI's native machinery: its own threshold
  // check (contextWindow − reserve) and overflow recovery are loop-integrated
  // and safe to fire between model turns.
  const maybeTriggerAutoCompact = (ctx: ExtensionContext): void => {
    if (state === null || instance === null) return;
    if (ctx.compact === undefined) return;
    // Queued follow-ups start a new run immediately; compacting now would race
    // it. The next agent_end re-checks.
    if (ctx.hasPendingMessages?.() === true) return;
    const settings = resolveModelCompactSettings(ctx.model?.id, modelCompactSettings);
    const usage = ctx.getContextUsage?.();
    const trigger = settings.triggerTokens;
    if (
      !shouldTriggerModelCompact({
        contextTokens: usage?.tokens,
        triggerTokens: trigger,
        inFlight: autoCompactInFlight,
        lastAttemptTokens: autoCompactLastAttemptTokens,
      })
    ) {
      return;
    }
    autoCompactInFlight = true;
    autoCompactLastAttemptTokens = usage?.tokens ?? null;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `lhc: context ~${Math.round((usage?.tokens ?? 0) / 1000)}k ≥ ${Math.round((trigger ?? 0) / 1000)}k threshold for ${ctx.model?.id ?? "model"} — triggering smart compact`,
        "info",
      );
    }
    ctx.compact({
      onComplete: () => {
        autoCompactInFlight = false;
        autoCompactLastAttemptTokens = null;
      },
      onError: () => {
        // Cancelled or failed: stay armed but only retry after real growth.
        autoCompactInFlight = false;
      },
    });
  };

  // Observe-only foundation: PI's per-step turn_end stays a no-op — it is not
  // an LHC turn boundary, and it must NOT host the auto-compact trigger (see
  // maybeTriggerAutoCompact above for why).
  const noop: PiVoidHookHandler<Epic1Hook> = () => {
    // Intentionally empty.
  };

  // session_before_fork: capture the fork point for use on the next session_start{fork}.
  // The source thread ref is captured from the current session state; the hook
  // provides entryId/position identifying the fork point. No writes to the source
  // thread occur; the fork happens on the next session_start.
  const onBeforeFork: PiHookHandler<"session_before_fork"> = async (event, ctx) => {
    if (state === null) return;
    await flushPendingMessages(ctx);
    const forkInfo = forkInfoFromHook(event.entryId, event.position);
    // Store the fork info for use on session_start{fork}.
    pendingFork = {
      sourceThreadRef: state.threadRef,
      forkEntryId: forkInfo.forkEntryId,
    };
  };

  const onBeforeCompact: PiHookHandler<"session_before_compact"> = async (event, ctx) => {
    try {
      return (
        (await handleSessionBeforeCompact(event, ctx, {
          state,
          instance,
          piSessionId: captureSession?.piSessionId ?? null,
          flushPendingCapture: flushPendingMessages,
          getSessionView: async () => {
            if (instance === null || state === null) {
              return {
                ok: false,
                error: { code: "storage_failure", reason: "no active LHC thread", errorClass: "system_error" },
              };
            }
            return instance.sdk.threadView.getSessionThreadView(state.threadRef);
          },
          findSeedEntryMap: findSeedEntryMapInBranch,
          compactParams: toCompactParams(resolveModelCompactSettings(ctx.model?.id, modelCompactSettings)),
          recordCancel: async (diagnostic) => {
            await recordCompactCancel({
              diagnostic,
              buffer: compactDiagnostics,
              instance,
              threadRef: state?.threadRef ?? null,
              ctx,
            });
          },
        })) ?? { cancel: true }
      );
    } catch (err) {
      const diagnostic: CompactDiagnostic = {
        code: "compact_error",
        reason: err instanceof Error ? err.message : String(err),
      };
      await recordCompactCancel({
        diagnostic,
        buffer: compactDiagnostics,
        instance,
        threadRef: state?.threadRef ?? null,
        ctx,
      });
      return { cancel: true };
    }
  };

  const onAfterCompact: PiVoidHookHandler<"session_compact"> = async () => {
    compactDiagnostics.clear();
    autoCompactInFlight = false;
    autoCompactLastAttemptTokens = null;
  };

  // /tree navigation switches the PI session's active branch. The LHC record
  // is one linear stream per thread — capture cannot represent a branch
  // switch, and continuing to capture after one silently diverges the record
  // from what the model sees. Refuse loudly while a thread is attached; /fork
  // (which creates and seeds a NEW thread) is the supported branching path.
  const onBeforeTree = async (
    _event: import("./pi/types.js").SessionBeforeTreeEvent,
    ctx: ExtensionContext,
  ): Promise<import("./pi/types.js").SessionBeforeTreeResult> => {
    if (state === null) return {};
    if (ctx.hasUI) {
      ctx.ui.notify(
        "pi-lhc: /tree navigation is blocked — the LHC thread record is linear and cannot follow a branch switch. Use /fork to branch onto a new thread.",
        "warning",
      );
    }
    return { cancel: true };
  };

  const compactHandlers = {
    session_before_compact: onBeforeCompact,
    session_compact: onAfterCompact,
  };

  // Bodies per hook: session lifecycle, event capture, and fork handling.
  const bodies: Record<Epic1Hook, PiVoidHookHandler<Epic1Hook>> = {
    session_start: onSessionStart as PiVoidHookHandler<Epic1Hook>,
    session_before_switch: onDispose as PiVoidHookHandler<Epic1Hook>,
    session_shutdown: onDispose as PiVoidHookHandler<Epic1Hook>,
    message_end: onMessageEnd as PiVoidHookHandler<Epic1Hook>,
    turn_end: noop,
    agent_end: onAgentEnd as PiVoidHookHandler<Epic1Hook>,
    model_select: onModelSelect as PiVoidHookHandler<Epic1Hook>,
    thinking_level_select: onThinkingLevelSelect as PiVoidHookHandler<Epic1Hook>,
    session_before_fork: onBeforeFork as PiVoidHookHandler<Epic1Hook>,
  };

  const handlers = {} as Record<Epic1Hook, PiVoidHookHandler<Epic1Hook>>;
  for (const name of EPIC_1_HOOKS) handlers[name] = guard(name, bodies[name]);

  const onRehydrate: PiCommandHandler = async (_args, ctx) => {
    if (state === null) {
      ctx.ui.notify("pi-lhc: no LHC thread attached — rehydrate requires an active thread", "error");
      return;
    }
    await runRehydrate(ctx, state.threadRef);
  };

  async function runRehydrate(ctx: ExtensionCommandContext, threadRef: ThreadRef): Promise<void> {
    const config = buildSdkConfig(ctx);
    if (!config.ok) {
      ctx.ui.notify(`pi-lhc: rehydrate failed — ${config.error.reason}`, "error");
      return;
    }

    await ctx.waitForIdle();
    await flushPendingMessages(ctx);

    const modelPrefs = {
      model:
        ctx.model === undefined
          ? null
          : {
              provider: ctx.model.provider,
              id: ctx.model.id,
            },
      thinkingLevel: extensionPi?.getThinkingLevel() ?? "medium",
    };

    setPendingRehydrate({
      threadRef,
      sdkConfig: config.value,
      modelPrefs,
    });

    const result = await ctx.newSession({
      setup: async (sessionManager) => {
        const setupPrefs = takePendingRehydrateSetup();
        if (setupPrefs === null) {
          throw new Error("pi-lhc rehydrate setup handoff missing");
        }
        const built = await initInstance(setupPrefs.threadRef, setupPrefs.sdkConfig);
        if (!built.ok) {
          clearPendingRehydrate();
          throw new Error(built.error.reason);
        }
        try {
          const rehydrated = await rehydratePiSessionFromLhc(
            built.value,
            setupPrefs.threadRef,
            sessionManager as unknown as import("@earendil-works/pi-coding-agent").SessionManager,
          );
          if (!rehydrated.ok) {
            clearPendingRehydrate();
            throw new Error(rehydrated.error.reason);
          }
        } finally {
          await disposeInstance(built.value);
        }
      },
      withSession: async (replacementCtx: ReplacedSessionContext) => {
        replacementCtx.ui.notify("pi-lhc: rehydrated PI session from latest LHC thread-view", "info");
      },
    });

    if (result.cancelled) {
      clearPendingRehydrate();
      ctx.ui.notify("pi-lhc: rehydrate cancelled", "warning");
    }
  }

  return {
    handlers,
    compactHandlers,
    treeHandler: onBeforeTree,
    register(pi: ExtensionAPI): void {
      registerLhcFlags(pi);
      extensionPi = pi;
      readLaunchFromPi = () => readLhcLaunchFlags(pi.getFlag.bind(pi));
      appendThreadEntry = (entry) => {
        pi.appendEntry(LHC_THREAD_ENTRY_TYPE, entry);
      };
      pi.registerCommand(LHC_REHYDRATE_COMMAND, {
        description:
          "Replace the live PI session with a fresh in-memory session hydrated from the latest LHC thread-view",
        handler: onRehydrate,
      });
      pi.registerCommand(LHC_EXPORT_THREADVIEW_COMMAND, {
        description: "Write the current LHC thread-view to a timestamped text file in the working directory",
        handler: async (_args, ctx) => handleExportThreadview(ctx, state?.threadRef ?? null, instance),
      });
      pi.registerCommand(LHC_EXPORT_PI_SESSION_COMMAND, {
        description: "Write the live PI SessionManager entries to a timestamped text file in the working directory",
        handler: async (_args, ctx) => handleExportPiSession(ctx),
      });
      pi.registerCommand(LHC_TOOL_PRUNE_COMMAND, {
        description:
          "Advance the LHC visibility boundary so older tool results render truncated — relieves context pressure without a compact. Optional arg: target tokens (default 32k).",
        handler: async (args, ctx) =>
          handleToolPrune(ctx, args, state?.threadRef ?? null, instance, {
            rehydrate: runRehydrate,
          }),
      });
      for (const name of EPIC_1_HOOKS) pi.on(name, handlers[name]);
      for (const name of COMPACT_HOOKS) {
        if (name === "session_before_compact") {
          pi.on(name, compactHandlers.session_before_compact);
        } else {
          pi.on(name, compactHandlers.session_compact);
        }
      }
      pi.on("session_before_tree", onBeforeTree);
    },
    getCompactDiagnostics(): readonly CompactDiagnostic[] {
      return compactDiagnostics.snapshot();
    },
    getLastCompactDiagnostic(): CompactDiagnostic | null {
      return compactDiagnostics.last();
    },
    getState(): SessionState | null {
      return state;
    },
    getInstance(): LhcInstance | null {
      return instance;
    },
    snapshot(): ConnectorSnapshot {
      return { state, lastDiagnostic };
    },
  };
}

/** PI entry point: PI calls this with the ExtensionAPI when the extension
 *  loads (and again on `/reload`). Registers explicit LHC launch flags and the
 *  capture hook rail with production defaults — the `~/.pi-lhc` registry, `pi.getFlag` launch control, the PI inference SDK
 *  config, and the `--lhc-resume` selector that presents cwd-scoped titled
 *  candidates through `ctx.ui.notify` — so a live session_start resolves/creates
 *  and initializes for real. On `/reload` the connector re-resolves the same
 *  thread from PI's durable `pi-lhc.thread` session entry and the LHC registry
 *  (it keeps no module-level handoff state). */
export function activate(pi: ExtensionAPI): void {
  createConnector().register(pi);
}

export default activate;

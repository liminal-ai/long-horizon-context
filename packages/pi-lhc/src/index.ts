// Extension entry. PI loads this module and calls `activate(pi)`; it registers
// the PI hook rail and routes each hook to a fail-closed handler. The connector
// owns only plain-data `SessionState` plus the live `LhcInstance` it constructs
// per PI session, never a PI `ctx` or session object, which PI replaces on new,
// resume, and fork.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BatchResult, MessageEventInput, OpResult, SdkConfig, ThreadRef } from "lhc";
import { threads } from "lhc";
import { capture, captureGap } from "./capture/converter.js";
import { type MapCtx, mapMessage } from "./capture/map-message.js";
import { mapModelSelect, mapThinkingLevelSelect } from "./capture/runtime-changes.js";
import { TurnAccumulator } from "./capture/turn-accumulator.js";
import { loadAssignments as loadAssignmentsImpl } from "./inference/assignments.js";
import { createModelCall } from "./inference/model-call.js";
import { report, type StartupValidationReporter, validateReachable } from "./inference/startup-validation.js";
import { detectForkFromSessionTree, forkInfoFromHook, seedFork } from "./lifecycle/fork.js";
import { disposeInstance, initInstance } from "./lifecycle/instance.js";
import { pickThread, type ThreadChoice } from "./lifecycle/picker.js";
import type { CaptureFailureDiagnostic, SessionState } from "./lifecycle/state.js";
import { createSessionState } from "./lifecycle/state.js";
import {
  type LaunchFlags,
  parseLaunchFlags,
  type ResolveDeps,
  resolveReloadThread,
  resolveThread,
  threadRefById,
} from "./lifecycle/thread-resolution.js";
import type {
  AgentMessage,
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
  PiContextHookHandler,
  PiHookHandler,
  PiHookName,
  SessionEntry,
} from "./pi/types.js";
import { type ContextServeDiagnostic, serveContextFromLhc } from "./serving/context.js";
import type { LhcInstance } from "./shared/instance.js";

export { disposeInstance, initInstance, initLhc } from "./lifecycle/instance.js";
export {
  buildContextServePreview,
  CONTEXT_SERVE_PREVIEW_MAX_MESSAGES,
  CONTEXT_SERVE_PREVIEW_MAX_TEXT,
  type ContextServeDiagnostic,
  type ContextServeMessagePreview,
  mapLlmMessagesToPi,
  serveContextFromLhc,
} from "./serving/context.js";
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

/** Context hook registered in the smoke-serving slice (Feature 2 entry). */
export const CONTEXT_HOOK = "context" as const satisfies PiHookName;

/** Full hook rail: Epic 1 capture + context serving. */
export const CONNECTOR_HOOKS = [...EPIC_1_HOOKS, CONTEXT_HOOK] as const satisfies readonly PiHookName[];

export type Epic1Hook = (typeof EPIC_1_HOOKS)[number];
export type ContextHook = typeof CONTEXT_HOOK;
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
  parseLaunch?: () => LaunchFlags;
  selectThread?: (choices: readonly ThreadChoice[], ctx: ExtensionContext) => Promise<string | null>;
  startupValidationReporter?: StartupValidationReporter;
  /** Operator overrides for provider/model/prompt per derivation kind. Uses
   *  loadAssignments to merge over shipped defaults. */
  assignmentConfig?: unknown;
}

/** Everything the connector retains across hooks as PLAIN data — by
 *  construction structuredClone-able. The live `LhcInstance` is held separately
 *  in the closure (it is the connector's own engine, rebuilt on reload) and is
 *  deliberately not part of the snapshot. */
export interface ConnectorSnapshot {
  state: SessionState | null;
  lastDiagnostic: CaptureFailureDiagnostic | null;
  lastContextServe: ContextServeDiagnostic | null;
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
  /** Last context-serving attempt (inspection/test seam). */
  getLastContextServe(): ContextServeDiagnostic | null;
  /** The hook handlers, keyed by event — exposed so tests can drive them with
   *  synthetic ctx/events without a live PI. */
  readonly handlers: Readonly<Record<Epic1Hook, PiHookHandler<Epic1Hook>> & { context: PiContextHookHandler }>;
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

const THREAD_ENTRY_TYPE = "pi-lhc.thread";

interface DurableThreadEntry {
  threadId: string;
  registryPath?: string;
}

/** A stable per-session id for idempotency-key scoping — the resolved thread's
 *  identity, which survives reload/replay (the same thread re-resolves to the
 *  same id). */
function sessionIdOf(ref: ThreadRef): string {
  return "threadId" in ref ? ref.threadId : ref.filePath;
}

function durableThreadEntryOf(ref: ThreadRef): DurableThreadEntry | null {
  if (!("threadId" in ref)) return null;
  const entry: DurableThreadEntry = { threadId: ref.threadId };
  if (ref.registryPath !== undefined) entry.registryPath = ref.registryPath;
  return entry;
}

function readDurableThreadId(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (
      entry === undefined ||
      (entry.type !== THREAD_ENTRY_TYPE && !(entry.type === "custom" && entry.customType === THREAD_ENTRY_TYPE))
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

const DEFAULT_LHC_DIR = join(homedir(), ".lhc");

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

/** Render the cwd-scoped `--resume` candidates as an operator-facing list, each
 *  line carrying the title, creation time, and id. */
function renderResumeCandidates(choices: readonly ThreadChoice[]): string {
  const lines = choices.map((choice, i) => {
    const title = choice.title ?? "(untitled)";
    return `  ${i + 1}. ${title}  ·  created ${choice.createdAt}  ·  ${choice.threadId}`;
  });
  return [
    `pi-lhc --resume: ${choices.length} thread(s) in this directory:`,
    ...lines,
    choices.length === 1
      ? "One candidate found; resuming it."
      : "Select a thread from the picker, or relaunch with --session <id> in headless mode.",
  ].join("\n");
}

/** Default `--resume` selection. The PI extension UI exposes an async
 *  selector in interactive/RPC modes, so multiple candidates are resolved by
 *  operator choice. Headless mode has no input surface, so ambiguous resume
 *  fails closed and the operator can use `--session <id>` for explicit attach. */
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
  const selected = await ctx.ui.select("pi-lhc --resume: select a thread", labels);
  if (selected === undefined) return null;
  const index = labels.indexOf(selected);
  return index >= 0 ? (choices[index]?.threadId ?? null) : null;
}

/** Default new-thread file location: `~/.lhc/threads/<uuid>.sqlite`. The id is
 *  generated by the registry at creation, so the file name is just a unique
 *  handle; the directory is ensured up front (DatabaseSync does not create
 *  parents). */
function defaultNewThreadFilePath(): string {
  const dir = join(DEFAULT_LHC_DIR, "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
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
  let lastContextServe: ContextServeDiagnostic | null = null;
  let captureSession: CaptureSession | null = null;
  let pendingFork: PendingFork | null = null;
  let appendThreadEntry: ((entry: DurableThreadEntry) => void) | null = null;

  const buildSdkConfig =
    deps.buildSdkConfig ?? ((ctx: ExtensionContext) => defaultBuildSdkConfig(ctx, deps.assignmentConfig));
  const newThreadFilePath = deps.newThreadFilePath ?? defaultNewThreadFilePath;
  const parseLaunch = deps.parseLaunch ?? (() => parseLaunchFlags(process.argv));
  const selectThread = deps.selectThread ?? defaultSelectThread;

  function diag(code: string, message: string): CaptureFailureDiagnostic {
    return { code, message, recordedGap: false };
  }

  // The registry/file deps every resolver path shares. `registryPath` is set
  // only when provided (omitted → LHC's default ~/.lhc registry), per
  // exactOptionalPropertyTypes; the new-thread title defaults to the cwd leaf.
  function buildResolveDeps(ctx: ExtensionContext): ResolveDeps {
    const resolveDeps: ResolveDeps = { cwd: ctx.cwd, newThreadFilePath };
    if (deps.registryPath !== undefined) resolveDeps.registryPath = deps.registryPath;
    return resolveDeps;
  }

  // Normal launch resolution: `--resume` runs the cwd-scoped operator picker;
  // `--session` / `--continue` / no-flag go through the registry resolver (only
  // no-flag creates).
  async function resolveForLaunch(launch: LaunchFlags, ctx: ExtensionContext): Promise<OpResult<ThreadRef | null>> {
    if (launch.resume === true) {
      const pickerDeps: {
        registryPath?: string;
        select: (choices: readonly ThreadChoice[]) => Promise<string | null>;
      } = { select: (choices) => selectThread(choices, ctx) };
      if (deps.registryPath !== undefined) pickerDeps.registryPath = deps.registryPath;
      return pickThread(ctx.cwd, pickerDeps);
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
        const targetThreadRef: ThreadRef = threadRefById(created.value.threadId, deps.registryPath);

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
          const targetThreadRef: ThreadRef = threadRefById(created.value.threadId, deps.registryPath);

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

    // Normal launch resolution (if not resolved by fork paths above).
    if (resolved === undefined) {
      const launch = parseLaunch();
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
        : diag("no_thread_selected", "--resume resolved no thread");
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
    if (durableEntry !== null) appendThreadEntry?.(durableEntry);
    const piSessionId = sessionIdOf(resolved.value);
    captureSession = {
      piSessionId,
      accumulator: new TurnAccumulator({ piSessionId }),
      sourceSeq: 0,
      pendingMessages: [],
      claimedEntryIds: new Set(),
    };

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
  // pre-new/resume) and on shutdown/reload. Idempotent: disposing twice or with
  // no live instance is a no-op. No reload-handoff state is kept — a reload
  // re-resolves its thread from the durable registry on the next session_start.
  const onDispose: PiHookHandler<Epic1Hook> = async (_event, ctx) => {
    await flushPendingMessages(ctx);
    const result = await disposeInstance(instance);
    if (!result.ok) lastDiagnostic = diag("dispose_failed", result.error.reason);
    instance = null;
    captureSession = null;
  };

  // Record a capture failure as a plain-data health diagnostic. The converter
  // already recorded a durable gap for a writable-thread malformed event
  // (`invalid_event`); a store-unavailable failure could not, so it surfaces as
  // an extension health signal with no gap. Neither path throws.
  function recordCaptureOutcome(result: OpResult<BatchResult>, events: readonly MessageEventInput[]): void {
    if (result.ok) return;
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
    if (instance === null || captureSession === null || captureSession.pendingMessages.length === 0) return;
    const pending = captureSession.pendingMessages.splice(0);
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
        continue;
      }
      captureSession.accumulator.onMessage(events);
      if (events.length === 0) continue;
      recordCaptureOutcome(await capture(events, instance), events);
    }
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
  const onAgentEnd: PiHookHandler<"agent_end"> = async (_event, ctx) => {
    if (instance === null || captureSession === null) return;
    await flushPendingMessages(ctx);
    const turnEnd = captureSession.accumulator.onAgentEnd();
    if (turnEnd.length === 0) return;
    recordCaptureOutcome(await capture(turnEnd, instance), turnEnd);
  };

  // context: serve LHC thread-view on each model call when a session is active.
  // Returns void to keep PI's original messages when inactive or on read failure.
  const onContext: PiContextHookHandler = async (event, ctx) => {
    const originalCount = event.messages.length;
    if (instance === null || state === null) {
      lastContextServe = {
        served: false,
        reason: "no_active_session",
        messageCount: originalCount,
        preview: [],
      };
      return;
    }

    await flushPendingMessages(ctx);

    const served = await serveContextFromLhc(instance, state.threadRef, originalCount);
    lastContextServe = served.diagnostic;
    if (!served.ok) return;
    return { messages: served.messages };
  };

  // Contain every handler: an observe-only hook must never throw back into PI
  // (a thrown hook breaks the user's session). A caught error becomes a
  // plain-data diagnostic; it is never rethrown.
  const guard = (name: Epic1Hook, body: PiHookHandler<Epic1Hook>): PiHookHandler<Epic1Hook> => {
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

  function contextMessageCount(event: unknown): number {
    if (typeof event !== "object" || event === null) return 0;
    const messages = (event as { messages?: unknown }).messages;
    return Array.isArray(messages) ? messages.length : 0;
  }

  function isContextEvent(event: unknown): event is Parameters<PiContextHookHandler>[0] {
    if (typeof event !== "object" || event === null) return false;
    return Array.isArray((event as { messages?: unknown }).messages);
  }

  const guardContext = (body: PiContextHookHandler): PiContextHookHandler => {
    return async (event, ctx): Promise<ContextEventResult | undefined> => {
      if (!isContextEvent(event)) {
        lastContextServe = {
          served: false,
          reason: "malformed_context_event",
          messageCount: 0,
          preview: [],
        };
        return;
      }
      try {
        return await body(event, ctx);
      } catch (err) {
        lastDiagnostic = {
          code: "hook_handler_error",
          message: `context: ${err instanceof Error ? err.message : String(err)}`,
          recordedGap: false,
        };
        lastContextServe = {
          served: false,
          reason: `handler_error:${err instanceof Error ? err.message : String(err)}`,
          messageCount: contextMessageCount(event),
          preview: [],
        };
        return;
      }
    };
  };

  // Observe-only foundation: the remaining capture-bearing hook (PI's per-step
  // turn_end) stays a no-op here. Each receives a fresh ctx and retains none of
  // it.
  const noop: PiHookHandler<Epic1Hook> = () => {
    // Intentionally empty — turn_end is ignored as a boundary.
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

  // Bodies per hook: session lifecycle, event capture, and fork handling.
  const bodies: Record<Epic1Hook, PiHookHandler<Epic1Hook>> = {
    session_start: onSessionStart as PiHookHandler<Epic1Hook>,
    session_before_switch: onDispose,
    session_shutdown: onDispose,
    message_end: onMessageEnd as PiHookHandler<Epic1Hook>,
    turn_end: noop,
    agent_end: onAgentEnd as PiHookHandler<Epic1Hook>,
    model_select: onModelSelect as PiHookHandler<Epic1Hook>,
    thinking_level_select: onThinkingLevelSelect as PiHookHandler<Epic1Hook>,
    session_before_fork: onBeforeFork as PiHookHandler<Epic1Hook>,
  };

  const handlers = {} as Record<Epic1Hook, PiHookHandler<Epic1Hook>> & { context: PiContextHookHandler };
  for (const name of EPIC_1_HOOKS) handlers[name] = guard(name, bodies[name]);
  handlers.context = guardContext(onContext);

  return {
    handlers,
    register(pi: ExtensionAPI): void {
      appendThreadEntry = (entry) => {
        pi.appendEntry(THREAD_ENTRY_TYPE, entry);
      };
      for (const name of EPIC_1_HOOKS) pi.on(name, handlers[name]);
      pi.on(CONTEXT_HOOK, handlers.context);
    },
    getState(): SessionState | null {
      return state;
    },
    getInstance(): LhcInstance | null {
      return instance;
    },
    getLastContextServe(): ContextServeDiagnostic | null {
      return lastContextServe;
    },
    snapshot(): ConnectorSnapshot {
      return { state, lastDiagnostic, lastContextServe };
    },
  };
}

/** PI entry point: PI calls this with the ExtensionAPI when the extension
 *  loads (and again on `/reload`). Registers the capture hook rail plus the
 *  context-serving hook with production defaults — the `~/.lhc` registry,
 *  `process.argv` launch flags, the PI inference SDK config, and the
 *  `--resume` selector that presents the cwd-scoped titled candidates through
 *  `ctx.ui.notify` — so a live session_start resolves/creates and initializes
 *  for real. On `/reload` the connector re-resolves the same thread from PI's
 *  durable `pi-lhc.thread` session entry and the LHC registry (it keeps no
 *  module-level handoff state). */
export function activate(pi: ExtensionAPI): void {
  createConnector().register(pi);
}

export default activate;

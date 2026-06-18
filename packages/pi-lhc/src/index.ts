// Extension entry. PI loads this module and calls `activate(pi)`; it registers
// the Epic 1 observe-only hook rail and routes each hook to a fail-closed
// handler. The connector owns only plain-data `SessionState` plus the live
// `LhcInstance` it constructs per session — never a PI `ctx`/session object,
// which PI replaces on new/resume/fork (tech design Flow 1, plain-data rule).
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BatchResult,
  MessageEventInput,
  OpResult,
  SdkConfig,
  ThreadRef,
} from "lhc";
import type {
  ExtensionAPI,
  ExtensionContext,
  PiHookHandler,
  PiHookName,
} from "./pi/types.js";
import type { CaptureFailureDiagnostic, SessionState } from "./lifecycle/state.js";
import { createSessionState } from "./lifecycle/state.js";
import { disposeInstance, initInstance } from "./lifecycle/instance.js";
import { createModelCall, defaultAssignments } from "./inference/model-call.js";
import { loadAssignments as loadAssignmentsImpl } from "./inference/assignments.js";
import { report, validateReachable } from "./inference/startup-validation.js";
import {
  detectForkFromSessionTree,
  forkInfoFromHook,
  seedFork,
} from "./lifecycle/fork.js";
import {
  parseLaunchFlags,
  resolveReloadThread,
  resolveThread,
  threadRefById,
  type LaunchFlags,
  type ResolveDeps,
} from "./lifecycle/thread-resolution.js";
import { pickThread, type ThreadChoice } from "./lifecycle/picker.js";
import { threads } from "lhc";
import { capture, captureGap } from "./capture/converter.js";
import { mapMessage, type MapCtx } from "./capture/map-message.js";
import { mapModelSelect, mapThinkingLevelSelect } from "./capture/runtime-changes.js";
import { TurnAccumulator } from "./capture/turn-accumulator.js";
import type { LhcInstance } from "./shared/instance.js";

export { disposeInstance, initInstance, initLhc } from "./lifecycle/instance.js";
export type { LhcInstance } from "./shared/instance.js";

/** The Epic 1 observe-only hook rail: every PI hook the connector consumes.
 *  Deliberately NOT `context` — context serving is Epic 2 and this epic
 *  registers no handler for it (story Scope Out). */
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

export type Epic1Hook = (typeof EPIC_1_HOOKS)[number];

/** What the connector needs from the host to run a session. Every dependency
 *  has a working production default; the overrides exist for test isolation
 *  (temp registry/thread, scripted launch/selection) and for Stories 5/6 to swap
 *  in the PI-auth-backed inference config.
 *
 *  `buildSdkConfig` returns the SdkConfig the instance is constructed from. Its
 *  default is the observe-only config below (a real, construction-valid SDK);
 *  Stories 5/6 inject the PI-model-registry-backed `ModelCall` + assignments. */
export interface ConnectorDeps {
  buildSdkConfig?: (ctx: ExtensionContext) => OpResult<SdkConfig>;
  registryPath?: string;
  newThreadFilePath?: () => string;
  parseLaunch?: () => LaunchFlags;
  selectThread?: (
    choices: readonly ThreadChoice[],
    ctx: ExtensionContext,
  ) => Promise<string | null>;
  /** Assignment config for Story 6: operator overrides for provider/model/prompt
   *  per derivation kind. Uses loadAssignments to merge over shipped defaults. */
  assignmentConfig?: unknown;
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
  /** Register the observe-only hook rail on the PI extension API. */
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
  readonly handlers: Readonly<Record<Epic1Hook, PiHookHandler<Epic1Hook>>>;
}

/** The connector's live capture state for one session: the open-turn
 *  accumulator plus the stable PI session id used to scope idempotency keys.
 *  Held in the closure alongside the live `LhcInstance` — engine state rebuilt
 *  per session, never part of the plain-data snapshot and never a PI object. */
interface CaptureSession {
  piSessionId: string;
  accumulator: TurnAccumulator;
  sourceSeq: number;
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
    if (entry === undefined || entry.type !== THREAD_ENTRY_TYPE) continue;
    const data = typeof entry.data === "object" && entry.data !== null
      ? (entry.data as Record<string, unknown>)
      : entry;
    const threadId = data.threadId;
    if (typeof threadId === "string" && threadId !== "") return threadId;
  }
  return null;
}

const DEFAULT_LHC_DIR = join(homedir(), ".lhc");

/** The production SDK config for Story 5+: injects the host ModelCall function
 *  that resolves provider/model through PI's registry and completes through
 *  pi-ai when available. Story 6 loads assignments from config with shipped
 *  defaults. */
function defaultBuildSdkConfig(
  ctx: ExtensionContext,
  assignmentConfig: unknown = undefined,
): OpResult<SdkConfig> {
  // Load assignments from config (Story 6: AC-5.4, AC-5.5)
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
 *  line carrying the title, creation time, and id AC-1.7 requires the picker to
 *  show. */
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
async function defaultSelectThread(
  choices: readonly ThreadChoice[],
  ctx: ExtensionContext,
): Promise<string | null> {
  if (choices.length === 0) return null;
  if (choices.length === 1) {
    if (ctx.hasUI) ctx.ui.notify(renderResumeCandidates(choices), { level: "info" });
    return choices[0]?.threadId ?? null;
  }

  if (!ctx.hasUI || ctx.ui.select === undefined) {
    if (ctx.hasUI) ctx.ui.notify(renderResumeCandidates(choices), { level: "warn" });
    return null;
  }

  const labels = choices.map((choice, i) => {
    const title = choice.title ?? "(untitled)";
    return `${i + 1}. ${title} · created ${choice.createdAt} · ${choice.threadId}`;
  });
  const selected = await ctx.ui.select("pi-lhc --resume: select a thread", labels);
  if (selected === undefined) return null;
  const index = labels.indexOf(selected);
  return index >= 0 ? choices[index]?.threadId ?? null : null;
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
 *  so a fresh connector with an empty closure reattaches correctly (AC-1.5). */
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
  let appendThreadEntry: ((entry: DurableThreadEntry) => void) | null = null;

  // Build SDK config with assignment config if provided (Story 6)
  const buildSdkConfig = deps.buildSdkConfig ??
    ((ctx: ExtensionContext) => defaultBuildSdkConfig(ctx, deps.assignmentConfig));
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
  async function resolveForLaunch(
    launch: LaunchFlags,
    ctx: ExtensionContext,
  ): Promise<OpResult<ThreadRef | null>> {
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

  // Reload resolution (AC-1.5): read the exact prior threadId PI durably
  // replayed in the current session entries. No cwd-most-recent fallback.
  async function resolveReloadFor(ctx: ExtensionContext): Promise<OpResult<ThreadRef | null>> {
    return resolveReloadThread(readDurableThreadId(ctx), buildResolveDeps(ctx));
  }

  // session_start: resolve the recording thread and construct one background
  // instance against it. Config is gated first so a session with no usable
  // inference config resolves/creates nothing (no orphan thread). On reload the
  // thread is re-resolved from the durable registry (reattach, never create);
  // every other reason runs the normal launch resolution. Fork creates a new
  // thread and seeds it from the source thread (Story 4).
  const onSessionStart: PiHookHandler<"session_start"> = async (ctx, event) => {
    const config = buildSdkConfig(ctx);
    if (!config.ok) {
      lastDiagnostic = diag("instance_not_configured", config.error.reason);
      return;
    }

    let resolved: OpResult<ThreadRef | null> | undefined = undefined;
    let forkAttempted = false;

    // Fork path (Story 4): create a new thread and seed it from the source.
    // Detection relies on pendingFork from session_before_fork hook, with PI's
    // session tree as Epic 1 fallback evidence. NOT dependent on event.reason.
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
          // Seeding must succeed for AC-3.2 - an unseeded fork violates requirements.
          const seeded = await seedFork(sourceThreadRef, targetThreadRef, forkEntryId, instance);
          if (!seeded.ok) {
            // Seed failure is fatal - AC-3.2 requires seeded read-back to match source.
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

    // Epic 1 fallback: PI session-tree evidence when hook was absent.
    // If pendingFork is null but we have a previous session, detect fork from session tree.
    if (resolved === undefined && !forkAttempted && state !== null && event.previousSessionFile !== undefined) {
      const forkFromTree = detectForkFromSessionTree(ctx, event, state.threadRef);
      if (forkFromTree !== null) {
        forkAttempted = true;
        // Session tree indicates a fork - create and seed as above.
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
      resolved = isReload
        ? await resolveReloadFor(ctx)
        : await resolveForLaunch(launch, ctx);
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
    };

    // Story 6: Startup validation - probe inference assignments before first use
    // This runs after instance creation but before capture begins (AC-5.1).
    // Validation failures are reported but do NOT stop capture (AC-5.3).
    if (config.value.inference === undefined) {
      lastDiagnostic = diag("inference_config_missing", "SDK config missing inference block");
      return;
    }
    const assignments = config.value.inference.assignments;
    const validationReport = validateReachable(assignments, ctx);
    report(validationReport, ctx, state);
  };

  // Dispose with flush before any session swap (session_before_switch fires
  // pre-new/resume) and on shutdown/reload. Idempotent: disposing twice or with
  // no live instance is a no-op. No reload-handoff state is kept — a reload
  // re-resolves its thread from the durable registry on the next session_start.
  const onDispose: PiHookHandler<Epic1Hook> = async () => {
    const result = await disposeInstance(instance);
    if (!result.ok) lastDiagnostic = diag("dispose_failed", result.error.reason);
    instance = null;
    captureSession = null;
  };

  // Record a capture failure as a plain-data health diagnostic (AC-2.7). The
  // converter already recorded a durable gap for a writable-thread malformed
  // event (`invalid_event`); a store-unavailable failure could not, so it
  // surfaces as an extension health signal with no gap. Neither path throws.
  function recordCaptureOutcome(
    result: OpResult<BatchResult>,
    events: readonly MessageEventInput[],
  ): void {
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

  function fallbackIdFor(kind: string, position: number | undefined, sourceSeq: number): string {
    // Last-resort id-less discriminator. PI position wins when present; the
    // connector ordinal is used only when PI gives no event identity at all.
    // For id-less + position-less reload replay, PI's deterministic redelivery
    // order yields the same ordinal, which is the best identity available.
    return position !== undefined ? `${kind}:${position}` : `${kind}:sourceSeq:${sourceSeq}`;
  }

  async function recordMappingFailure(
    hook: string,
    position: number | undefined,
    sourceSeq: number,
    cause: unknown,
  ): Promise<void> {
    if (instance === null) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    const result = await captureGap(
      fallbackIdFor(hook, position, sourceSeq),
      `${hook}: ${message}`,
      instance,
    );
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

  // message_end: map the finalized PI message to ordered LHC events, track the
  // open turn, and flush through the converter (AC-2.1).
  const onMessageEnd: PiHookHandler<"message_end"> = async (_ctx, event) => {
    if (instance === null || captureSession === null) return;
    const sourceSeq = nextSourceSeq(captureSession);
    const mapCtx: MapCtx =
      event.entryId !== undefined && event.entryId !== ""
        ? { piSessionId: captureSession.piSessionId, entryId: event.entryId }
        : {
            piSessionId: captureSession.piSessionId,
            fallbackId: fallbackIdFor("message_end", event.position, sourceSeq),
          };
    let events: MessageEventInput[];
    try {
      events = mapMessage(event.message, mapCtx);
    } catch (cause) {
      await recordMappingFailure("message_end", event.position, sourceSeq, cause);
      return;
    }
    captureSession.accumulator.onMessage(events);
    if (events.length === 0) return;
    recordCaptureOutcome(await capture(events, instance), events);
  };

  // model_select / thinking_level_select fire only in-stream — capture each as
  // an ordered runtime_note the moment it fires (AC-2.8).
  const onModelSelect: PiHookHandler<"model_select"> = async (_ctx, event) => {
    if (instance === null || captureSession === null) return;
    const sourceSeq = nextSourceSeq(captureSession);
    const mapCtx: MapCtx = {
      piSessionId: captureSession.piSessionId,
      fallbackId: fallbackIdFor("model_select", event.position, sourceSeq),
    };
    const note = mapModelSelect(event, mapCtx);
    recordCaptureOutcome(await capture([note], instance), [note]);
  };

  const onThinkingLevelSelect: PiHookHandler<"thinking_level_select"> = async (_ctx, event) => {
    if (instance === null || captureSession === null) return;
    const sourceSeq = nextSourceSeq(captureSession);
    const mapCtx: MapCtx = {
      piSessionId: captureSession.piSessionId,
      fallbackId: fallbackIdFor("thinking_level_select", event.position, sourceSeq),
    };
    const note = mapThinkingLevelSelect(event, mapCtx);
    recordCaptureOutcome(await capture([note], instance), [note]);
  };

  // agent_end closes the LHC turn — exactly one turn_end per agent run (AC-2.2).
  // PI's per-step turn_end is ignored as a boundary (it stays a no-op below).
  const onAgentEnd: PiHookHandler<"agent_end"> = async () => {
    if (instance === null || captureSession === null) return;
    const turnEnd = captureSession.accumulator.onAgentEnd();
    if (turnEnd.length === 0) return;
    recordCaptureOutcome(await capture(turnEnd, instance), turnEnd);
  };

  // Contain every handler: an observe-only hook must never throw back into PI
  // (a thrown hook breaks the user's session). A caught error becomes a
  // plain-data diagnostic; it is never rethrown.
  const guard = (
    name: Epic1Hook,
    body: PiHookHandler<Epic1Hook>,
  ): PiHookHandler<Epic1Hook> => {
    return async (ctx, event): Promise<void> => {
      try {
        await body(ctx, event);
      } catch (err) {
        lastDiagnostic = {
          code: "hook_handler_error",
          message: `${name}: ${err instanceof Error ? err.message : String(err)}`,
          recordedGap: false,
        };
      }
    };
  };

  // Observe-only foundation: the remaining capture-bearing hooks (PI's per-step
  // turn_end) stay no-ops here — turn_end is deliberately ignored as an
  // LHC turn boundary (AC-2.2). Each receives a FRESH ctx and retains none of it.
  const noop: PiHookHandler<Epic1Hook> = () => {
    // Intentionally empty — turn_end is ignored as a boundary.
  };

  // session_before_fork: capture the fork point for use on the next session_start{fork}.
  // The source thread ref is captured from the current session state; the hook
  // provides entryId/position identifying the fork point. No writes to the source
  // thread occur — the fork happens on the next session_start (Story 4).
  const onBeforeFork: PiHookHandler<"session_before_fork"> = async (_ctx, event) => {
    if (state === null) return;
    const forkInfo = forkInfoFromHook(event.entryId, event.position);
    // Store the fork info for use on session_start{fork}.
    pendingFork = {
      sourceThreadRef: state.threadRef,
      forkEntryId: forkInfo.forkEntryId,
    };
  };

  // Bodies per hook: session lifecycle (Story 1) and event capture (Story 2)
  // are live; fork handling (Story 4) is wired.
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

  const handlers = {} as Record<Epic1Hook, PiHookHandler<Epic1Hook>>;
  for (const name of EPIC_1_HOOKS) handlers[name] = guard(name, bodies[name]);

  return {
    handlers,
    register(pi: ExtensionAPI): void {
      appendThreadEntry = (entry) => {
        pi.appendEntry(THREAD_ENTRY_TYPE, entry);
      };
      for (const name of EPIC_1_HOOKS) pi.registerHook(name, handlers[name]);
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
 *  loads (and again on `/reload`). Registers the observe-only hook rail with the
 *  production defaults — the `~/.lhc` registry, `process.argv` launch flags, the
 *  observe-only SDK config, and the `--resume` selector that presents the
 *  cwd-scoped titled candidates through `ctx.ui.notify` — so a live session_start
 *  resolves/creates and initializes for real. On `/reload` the connector
 *  re-resolves the same thread from PI's durable `pi-lhc.thread` session entry
 *  and the LHC registry (it keeps no module-level handoff state). Stories 5/6
 *  swap in the PI-auth-backed inference config. */
export function activate(pi: ExtensionAPI): void {
  createConnector().register(pi);
}

export default activate;

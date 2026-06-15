// Shared, assertion-free scaffolding for the Story 2 capture suite. Like the
// fixtures (synthetic.ts, thread.ts) this is test infrastructure, not a test:
// it drives the PRODUCTION connector path (createConnector → hook handlers →
// converter → real LHC intake) so every capture test asserts on recorded
// thread state, never on a mocked intake. The two external edges stay as the
// tech design fixes them — the PI hook surface is fed synthetic events, and the
// SDK runs real against a temp SQLite thread with the deterministic provider
// (selected by explicit name, never a production default).
import {
  inspect,
  intakeStream,
  type EventKind,
  type MessageEventInput,
  type OpResult,
  type SdkConfig,
  type ThreadRef,
} from "lhc";
import { createConnector, type Connector } from "../../src/index.js";
import type { LaunchFlags } from "../../src/lifecycle/thread-resolution.js";
import { fakeModelCallText } from "../fixtures/model-call.js";
import { DEFAULT_PROMPT_NAMES } from "lhc";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionStartReason } from "../../src/pi/types.js";
import { makeSessionStart } from "../fixtures/synthetic.js";
import type { TempStore } from "../fixtures/thread.js";

/** A per-hook ctx carrying methods (not plain data), exactly as PI hands each
 *  hook a fresh context object. Headless (`hasUI:false`) — capture must not
 *  assume a TUI. */
const sessionEntriesByStore = new WeakMap<TempStore, SessionEntry[]>();

function entriesFor(store: TempStore): SessionEntry[] {
  let entries = sessionEntriesByStore.get(store);
  if (entries === undefined) {
    entries = [];
    sessionEntriesByStore.set(store, entries);
  }
  return entries;
}

function registerConnector(connector: Connector, entries: SessionEntry[]): void {
  const pi: ExtensionAPI = {
    registerHook: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (type, data) => {
      entries.push({ type, data });
    },
  };
  connector.register(pi);
}

export function syntheticCtx(cwd = "/work/capture", entries: SessionEntry[] = []): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => entries },
  };
}

/** The capture-suite SDK config: a real background instance on the
 *  deterministic provider, so a captured user_prompt's queued derivation has a
 *  handler to settle and never strands background work. */
export function captureConfig(): OpResult<SdkConfig> {
  return {
    ok: true,
    value: {
      inference: {
        call: fakeModelCallText("deterministic text"),
        assignments: {
          smoothed_prompt: { provider: "deterministic", model: "default", prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt },
          tool_call_summary: { provider: "deterministic", model: "default", prompt: DEFAULT_PROMPT_NAMES.tool_call_summary },
          tool_result_summary: { provider: "deterministic", model: "default", prompt: DEFAULT_PROMPT_NAMES.tool_result_summary },
          turn_rendering: { provider: "deterministic", model: "default", prompt: DEFAULT_PROMPT_NAMES.turn_rendering },
          lower_band_projection: { provider: "deterministic", model: "default", prompt: DEFAULT_PROMPT_NAMES.lower_band_projection },
          chunk_summary_detailed: { provider: "deterministic", model: "default", prompt: DEFAULT_PROMPT_NAMES.chunk_summary_detailed },
          chunk_summary_brief: { provider: "deterministic", model: "default", prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief },
        },
      },
      mode: "background",
    },
  };
}

export interface StartedCapture {
  connector: Connector;
  ctx: ExtensionContext;
  threadRef: ThreadRef;
}

/** Start a connector against a temp store under the given launch flags and fire
 *  `session_start{reason}`. The driver for existing-thread reattach: pass
 *  `{ session: threadId }` with reason `"resume"`/`"reload"` to attach a fresh
 *  connector to a thread a prior connector created. */
export async function attachCapture(
  store: TempStore,
  launch: LaunchFlags,
  reason: SessionStartReason,
  cwd = "/work/capture",
): Promise<StartedCapture> {
  const connector = createConnector({
    registryPath: store.registryPath,
    newThreadFilePath: () => store.threadPath(),
    parseLaunch: () => launch,
    buildSdkConfig: () => captureConfig(),
  });
  const entries = entriesFor(store);
  registerConnector(connector, entries);
  const ctx = syntheticCtx(cwd, entries);
  await connector.handlers.session_start(ctx, makeSessionStart(reason));
  const state = connector.getState();
  if (state === null) throw new Error("attachCapture: session_start did not resolve a thread");
  return { connector, ctx, threadRef: state.threadRef };
}

/** Start a connector against a temp store and fire `session_start{new}` so a
 *  background instance + thread exist and the capture hooks are live. */
export async function startCapture(store: TempStore, cwd = "/work/capture"): Promise<StartedCapture> {
  return attachCapture(store, {}, "new", cwd);
}

/** Settle background work and dispose, then read the durable event log back in
 *  recorded order — capture's product is the stored thread, so tests assert on
 *  this. */
export async function eventsAfterShutdown(started: StartedCapture): Promise<MessageEventInput[]> {
  await started.connector.handlers.session_shutdown(started.ctx, { reason: "shutdown" });
  const read = await intakeStream.listEvents(started.threadRef);
  if (!read.ok) throw new Error(`listEvents failed: ${read.error.reason}`);
  // Strip the server-stamped fields so the comparison is over the logical
  // intake shape the converter produced.
  return read.value.map((record) => ({
    eventKind: record.eventKind,
    idempotencyKey: record.idempotencyKey,
    actor: record.actor,
    harness: record.harness,
    payload: record.payload,
  })) as MessageEventInput[];
}

/** The ordered event-kind sequence — the spine every capture test checks. */
export function kindsOf(events: readonly MessageEventInput[]): EventKind[] {
  return events.map((event) => event.eventKind);
}

/** Counts open/closed turns and total recorded events from the inspect
 *  overview (the real read-back surface, not a private query). */
export async function turnCounts(
  threadRef: ThreadRef,
): Promise<{ open: number; closed: number; events: number }> {
  const overview = await inspect.overview(threadRef);
  if (!overview.ok) throw new Error(`overview failed: ${overview.error.reason}`);
  return {
    open: overview.value.turns.open,
    closed: overview.value.turns.closed,
    events: overview.value.events.count,
  };
}

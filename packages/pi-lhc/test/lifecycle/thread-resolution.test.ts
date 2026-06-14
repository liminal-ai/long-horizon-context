// Story 1 — launch-driven thread resolution, plain-data state, and reload
// reconstruction. Two layers are covered: the resolver/picker functions
// directly (launch modes, partial-id, ambiguity, cwd-scoping), and the
// PRODUCTION connector path through createConnector with real defaults (no
// injected SDK config or selector) for AC-1.2/1.5/1.7. Real temp registry
// throughout; the module-level reload memory is reset per test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeterministicProvider,
  inspect,
  threads,
  type SdkConfig,
  type ThreadRef,
} from "lhc";
import { createConnector } from "../../src/index.js";
import { disposeInstance, initInstance } from "../../src/lifecycle/instance.js";
import {
  defaultThreadTitle,
  parseLaunchFlags,
  resolveThread,
  type ResolveDeps,
} from "../../src/lifecycle/thread-resolution.js";
import { pickThread, type ThreadChoice } from "../../src/lifecycle/picker.js";
import type { ExtensionContext } from "../../src/pi/types.js";
import { eventBatch, makeMessageEnd, makeSessionStart, makeUserMessage } from "../fixtures/synthetic.js";
import { tempStore, type TempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
  // No connector reset needed: the connector keeps no module-level state — reload
  // reconstructs from the durable registry, and each test uses a fresh temp store.
});
afterEach(() => {
  store.cleanup();
});

function backgroundConfig(): SdkConfig {
  return { provider: createDeterministicProvider(), mode: "background" };
}

function idOf(ref: ThreadRef): string {
  if (!("threadId" in ref)) throw new Error("expected a { threadId } ref");
  return ref.threadId;
}

function deps(cwd = "/work/default"): ResolveDeps {
  return { cwd, registryPath: store.registryPath, newThreadFilePath: () => store.threadPath() };
}

// Create a thread directly with explicit cwd/title, for picker fixtures and
// existing-thread setup. (Connector-created threads get cwd plus a default title
// from defaultThreadTitle(cwd) — see TC-1.1 and the reload test.)
async function makeThread(opts: { cwd?: string; title?: string } = {}): Promise<string> {
  const input: { filePath: string; registryPath: string; cwd?: string; title?: string } = {
    filePath: store.threadPath(),
    registryPath: store.registryPath,
  };
  if (opts.cwd !== undefined) input.cwd = opts.cwd;
  if (opts.title !== undefined) input.title = opts.title;
  const created = await threads.newThread(input);
  if (!created.ok) throw new Error(`makeThread failed: ${created.error.reason}`);
  return created.value.threadId;
}

// A synthetic per-hook ctx carrying METHODS (not plain data) — so a retained
// ctx would break the structuredClone plain-data guard. Each call is a distinct
// object, modelling PI handing a fresh ctx to each hook.
function syntheticCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => false,
      getAvailable: () => [],
    },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
  };
}

// A connector wired with production defaults (real SDK config + selector) and
// only environment overrides — the activate() path, minus the global registry
// and process.argv.
function productionConnector(launch: () => { resume?: boolean; continue?: boolean; session?: string }) {
  return createConnector({
    registryPath: store.registryPath,
    newThreadFilePath: () => store.threadPath(),
    parseLaunch: launch,
  });
}

async function threadCount(): Promise<number> {
  const listed = await threads.listThreads({ registryPath: store.registryPath });
  return listed.ok ? listed.value.length : -1;
}

describe("Story 1: launch-driven thread resolution (resolver/picker)", () => {
  it("TC-1.6: launch modes resolve correctly; bad/ambiguous id fails loud and creates no thread", async () => {
    // no flag → a new thread
    const first = await resolveThread({}, deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = idOf(first.value);

    // --session full id → the same thread
    const byFull = await resolveThread({ session: firstId }, deps());
    expect(byFull.ok).toBe(true);
    if (byFull.ok) expect(idOf(byFull.value)).toBe(firstId);

    // --session partial id → the same thread
    const byPartial = await resolveThread({ session: firstId.slice(0, 8) }, deps());
    expect(byPartial.ok).toBe(true);
    if (byPartial.ok) expect(idOf(byPartial.value)).toBe(firstId);

    // a second thread, then --continue → the most recently created
    const second = await resolveThread({}, deps());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondId = idOf(second.value);
    const continued = await resolveThread({ continue: true }, deps());
    expect(continued.ok).toBe(true);
    if (continued.ok) expect(idOf(continued.value)).toBe(secondId);

    // unresolvable id → actionable error, no thread created
    const before = await threadCount();
    const bad = await resolveThread({ session: "th_zzzzzzzzzzzzzzzz" }, deps());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("thread_not_found");
    expect(await threadCount()).toBe(before);

    // ambiguous prefix (matches both threads) → actionable error, no thread created
    const ambiguous = await resolveThread({ session: "th_" }, deps());
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error.code).toBe("ambiguous_thread_id");
    expect(await threadCount()).toBe(before);
  });

  it("parseLaunchFlags maps the launch argv (the production launch source) to launch modes", () => {
    expect(parseLaunchFlags(["node", "pi"])).toEqual({});
    expect(parseLaunchFlags(["node", "pi", "--resume"])).toEqual({ resume: true });
    expect(parseLaunchFlags(["node", "pi", "-r"])).toEqual({ resume: true });
    expect(parseLaunchFlags(["node", "pi", "--continue"])).toEqual({ continue: true });
    expect(parseLaunchFlags(["node", "pi", "-c"])).toEqual({ continue: true });
    expect(parseLaunchFlags(["node", "pi", "--session", "th_abc"])).toEqual({ session: "th_abc" });
    expect(parseLaunchFlags(["node", "pi", "--session=th_xyz"])).toEqual({ session: "th_xyz" });
  });

  it("no-flag resolution titles the new thread with the cwd leaf (A-8 title metadata)", async () => {
    const created = await resolveThread({}, deps("/work/proj-x"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await threads.resolve({ threadId: idOf(created.value), registryPath: store.registryPath });
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    expect(row.value.cwd).toBe("/work/proj-x");
    expect(row.value.title).toBe(defaultThreadTitle("/work/proj-x")); // "proj-x"
  });

  it("TC-1.7 (picker): lists cwd-scoped threads (title + created), resolves selection, empty-safe", async () => {
    const a1 = await makeThread({ cwd: "/work/a", title: "alpha" });
    const a2 = await makeThread({ cwd: "/work/a", title: "beta" });
    await makeThread({ cwd: "/work/b", title: "other-cwd" });

    let offered: readonly ThreadChoice[] = [];
    const picked = await pickThread("/work/a", {
      registryPath: store.registryPath,
      select: (choices) => {
        offered = choices;
        return Promise.resolve(choices[0]!.threadId);
      },
    });
    expect(picked.ok).toBe(true);

    // Only the current cwd's threads are offered, each with title + creation time.
    expect(new Set(offered.map((c) => c.threadId))).toEqual(new Set([a1, a2]));
    for (const choice of offered) {
      expect(choice.createdAt).toBeTruthy();
      expect(choice.title).toBeTruthy();
    }

    // The operator's selection resolves to that thread.
    if (picked.ok && picked.value !== null) {
      expect(idOf(picked.value)).toBe(offered[0]!.threadId);
    }

    // An empty cwd reports an empty list (null) without failing or prompting.
    let selectCalled = false;
    const empty = await pickThread("/work/empty", {
      registryPath: store.registryPath,
      select: () => {
        selectCalled = true;
        return Promise.resolve(null);
      },
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toBeNull();
    expect(selectCalled).toBe(false);
  });

  it("TC-1.5 (risk: restart): re-resolve the same thread by its durable id from the registry after process death", async () => {
    const cwd = "/work/tc-1-5";
    const created = await resolveThread({}, deps(cwd));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = idOf(created.value);

    const first = await initInstance(created.value, backgroundConfig());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.value.sdk.intakeStream.messageEvents(
      first.value.threadRef,
      eventBatch(["user_prompt", "assistant_text", "turn_end"]),
    );
    await disposeInstance(first.value);

    // Discard ALL in-memory state. Only the durable id survives (as a relaunch
    // flag would across process death). Reconstruct purely from it.
    const reattached = await resolveThread({ session: threadId }, deps(cwd));
    expect(reattached.ok).toBe(true);
    if (!reattached.ok) return;
    expect(idOf(reattached.value)).toBe(threadId);

    const rebuilt = await initInstance(reattached.value, backgroundConfig());
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    await rebuilt.value.sdk.intakeStream.messageEvents(
      rebuilt.value.threadRef,
      eventBatch(["user_prompt", "assistant_text", "turn_end"]),
    );
    const overview = await inspect.overview(reattached.value);
    expect(overview.ok).toBe(true);
    if (overview.ok) expect(overview.value.events.count).toBe(6); // 3 before + 3 after
    await disposeInstance(rebuilt.value);
  });
});

describe("Story 1: launch-driven thread resolution (production connector path)", () => {
  it("TC-1.2: session_start resolving an existing thread creates no second thread", async () => {
    const existingId = await makeThread({ cwd: "/work/a", title: "existing" });
    const before = await threadCount();

    const connector = productionConnector(() => ({ session: existingId }));
    await connector.handlers.session_start(syntheticCtx("/work/a"), makeSessionStart("startup"));

    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;
    expect(idOf(state.threadRef)).toBe(existingId);
    expect(connector.getInstance()).not.toBeNull(); // a real instance, not a fail-closed branch
    expect(await threadCount()).toBe(before); // no second thread
  });

  it("TC-1.7: production --resume presents the cwd-scoped titled candidates via ctx.ui.notify and resolves a selection", async () => {
    await makeThread({ cwd: "/work/resume", title: "older" });
    const recent = await makeThread({ cwd: "/work/resume", title: "newer" });
    await makeThread({ cwd: "/work/other", title: "different cwd" });
    const before = await threadCount();

    // A ctx WITH a UI captures exactly what the picker presents to the operator.
    const notes: string[] = [];
    const ctx: ExtensionContext = {
      cwd: "/work/resume",
      hasUI: true,
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
      ui: { notify: (message) => notes.push(message) },
      sessionManager: { getEntries: () => [] },
    };

    const connector = productionConnector(() => ({ resume: true }));
    await connector.handlers.session_start(ctx, makeSessionStart("resume"));

    // The operator was shown the cwd-scoped candidate list — only this cwd's
    // threads, each with title and creation time — through ctx.ui.notify (the
    // only PI v0.79.2 surface; selection resolves to the best available default).
    expect(notes).toHaveLength(1);
    const shown = notes[0]!;
    expect(shown).toContain("older");
    expect(shown).toContain("newer");
    expect(shown).not.toContain("different cwd"); // a different cwd is not offered
    const recentRow = await threads.resolve({ threadId: recent, registryPath: store.registryPath });
    if (recentRow.ok) expect(shown).toContain(recentRow.value.createdAt); // creation time shown

    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;
    expect(idOf(state.threadRef)).toBe(recent); // best available explicit default selection
    expect(connector.getInstance()).not.toBeNull();
    expect(await threadCount()).toBe(before); // resumed, not created
  });

  it("TC-1.7: production --resume is headless-safe — no notify when ctx.hasUI is false, still resolves", async () => {
    await makeThread({ cwd: "/work/headless", title: "only" });
    const before = await threadCount();

    const connector = productionConnector(() => ({ resume: true }));
    // syntheticCtx has hasUI:false and a no-op notify; the picker must not assume
    // a UI (tech design I-9: guard on headless, not on ctx.ui absence).
    await connector.handlers.session_start(syntheticCtx("/work/headless"), makeSessionStart("resume"));

    const state = connector.getState();
    expect(state).not.toBeNull();
    if (state === null) return;
    expect(connector.getInstance()).not.toBeNull();
    expect(await threadCount()).toBe(before); // resolved without failing
  });
});

describe("Story 1: plain-data state across hooks", () => {
  it("TC-1.3: the connector retains only plain data and continues across a ctx replacement", async () => {
    const connector = productionConnector(() => ({})); // no flag → new thread, default config

    // session_start with a ctx carrying methods.
    await connector.handlers.session_start(syntheticCtx("/work/a"), makeSessionStart("new"));
    expect(connector.getState()).not.toBeNull();
    expect(connector.getInstance()).not.toBeNull(); // a live instance is held...
    // ...but the snapshot is plain data only — it survives structuredClone even
    // though the live ctx and instance carry methods (they are not in it).
    expect(() => structuredClone(connector.snapshot())).not.toThrow();
    const threadRefBefore = connector.getState()?.threadRef;

    // A later hook receives a DIFFERENT ctx object; capture is not broken and the
    // holder still references no prior ctx.
    await connector.handlers.message_end(
      syntheticCtx("/work/a"),
      makeMessageEnd(makeUserMessage("hi")),
    );
    expect(() => structuredClone(connector.snapshot())).not.toThrow();
    expect(connector.getState()?.threadRef).toEqual(threadRefBefore); // same plain-data thread ref
  });
});

describe("Story 1: reload reconstruction from durable registry state (AC-1.5)", () => {
  it("TC-1.5: a FRESH connector reattaches to the same thread from the registry on reload — no module handoff, no duplicate", async () => {
    const cwd = "/work/reload";

    // Connector A: a no-flag session creates the thread (cwd + default title).
    const connectorA = productionConnector(() => ({}));
    await connectorA.handlers.session_start(syntheticCtx(cwd), makeSessionStart("new"));
    const stateA = connectorA.getState();
    expect(stateA).not.toBeNull();
    if (stateA === null) return;
    const firstId = idOf(stateA.threadRef);
    const countAfterNew = await threadCount();

    const row = await threads.resolve({ threadId: firstId, registryPath: store.registryPath });
    expect(row.ok).toBe(true);
    if (row.ok) {
      expect(row.value.cwd).toBe(cwd);
      expect(row.value.title).toBe(defaultThreadTitle(cwd));
    }

    // Reload: shutdown{reload}, then connector A is TORN DOWN and never
    // referenced again. A brand-new connector handles the reload with an EMPTY
    // closure and a still-no-flag launch (which would otherwise create a
    // duplicate). The connector keeps NO module-level handoff state, so the only
    // thing bridging the teardown is the durable registry — this is what proves
    // reconstruction survives loss of every in-memory holder (SV-001).
    await connectorA.handlers.session_shutdown(syntheticCtx(cwd), { reason: "reload" });

    const connectorB = productionConnector(() => ({}));
    await connectorB.handlers.session_start(syntheticCtx(cwd), makeSessionStart("reload"));

    const stateB = connectorB.getState();
    expect(stateB).not.toBeNull();
    if (stateB === null) return;
    expect(idOf(stateB.threadRef)).toBe(firstId); // re-resolved from the registry
    expect(connectorB.getInstance()).not.toBeNull(); // a fresh instance on the same thread
    expect(await threadCount()).toBe(countAfterNew); // no duplicate thread created
  });

  it("reload reattaches by re-resolving --session from the registry (durable id evidence), creating nothing", async () => {
    const cwd = "/work/reload-session";
    const existing = await makeThread({ cwd, title: "carried" });
    const before = await threadCount();

    // Launched with --session <id>: reload re-resolves the SAME id from the
    // durable registry, independent of any in-memory state.
    const connectorA = productionConnector(() => ({ session: existing }));
    await connectorA.handlers.session_start(syntheticCtx(cwd), makeSessionStart("startup"));
    await connectorA.handlers.session_shutdown(syntheticCtx(cwd), { reason: "reload" });

    const connectorB = productionConnector(() => ({ session: existing }));
    await connectorB.handlers.session_start(syntheticCtx(cwd), makeSessionStart("reload"));
    expect(idOf(connectorB.getState()!.threadRef)).toBe(existing);
    expect(await threadCount()).toBe(before); // no thread created on reload
  });

  it("a no-flag 'new' session always creates a new thread — reattach is reload-only, keyed on the start reason, not on retained memory", async () => {
    const cwd = "/work/fresh";
    const connectorA = productionConnector(() => ({}));
    await connectorA.handlers.session_start(syntheticCtx(cwd), makeSessionStart("new"));
    const firstId = idOf(connectorA.getState()!.threadRef);

    await connectorA.handlers.session_shutdown(syntheticCtx(cwd), { reason: "shutdown" });

    const connectorB = productionConnector(() => ({}));
    await connectorB.handlers.session_start(syntheticCtx(cwd), makeSessionStart("new"));
    const secondId = idOf(connectorB.getState()!.threadRef);

    expect(secondId).not.toBe(firstId); // a genuinely new session → a new thread
    expect(await threadCount()).toBe(2);
  });
});

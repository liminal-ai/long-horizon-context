// Design F — the `context` hook (epic AC-7.2: TC-7.2a, TC-7.2d, TC-7.2e).
// Real connector, real LHC thread, synthetic Pi: the session manager is a
// plain entry list the test appends to exactly as Pi persists (after the
// message_end handlers return), and the context event's message list is a
// deep copy of those entries' messages — Pi's own objects.
import { createDeterministicInferenceCallbacks, type ThreadRef, threadView, turns } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Connector,
  clearLauncherOwnedStartup,
  createConnector,
  setLauncherOwnedStartup,
} from "../../src/index.js";
import type { AgentMessage, ContextEvent, ExtensionContext, SessionEntry } from "../../src/pi/types.js";
import { estimateAgentMessageTokens, estimateContextPressure } from "../../src/serving/context-hook.js";
import { makeBeforeCompactEvent } from "../compact/fixtures.js";
import {
  FIXTURE_TIMESTAMP_MS,
  makeAgentEnd,
  makeAssistantMessage,
  makeMessageEnd,
  makeSessionStart,
  makeToolResult,
  makeUserMessage,
  zeroUsage,
} from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
  clearLauncherOwnedStartup();
});
afterEach(() => {
  store.cleanup();
  clearLauncherOwnedStartup();
});

/** One synthetic Pi session: entries, a ctx over them, and a driver that
 *  delivers a message the way Pi does (message_end, then persistence). */
interface PiSession {
  ctx: ExtensionContext;
  entries: SessionEntry[];
  deliver(message: AgentMessage): Promise<void>;
  stepEnd(): Promise<void>;
  contextEvent(): ContextEvent;
}

function piSession(connector: Connector, modelId = "claude-fable-5"): PiSession {
  const entries: SessionEntry[] = [];
  const ctx: ExtensionContext = {
    cwd: "/work/context-hook",
    hasUI: false,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: { notify: () => {} },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      buildContextEntries: () => entries,
    },
    model: { provider: "anthropic", id: modelId },
  };
  let seq = 0;
  return {
    ctx,
    entries,
    async deliver(message) {
      await connector.handlers.message_end(makeMessageEnd(message), ctx);
      seq += 1;
      entries.push({ type: "message", id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}`, message });
    },
    async stepEnd() {
      await connector.handlers.turn_end(
        { type: "turn_end", turnIndex: 0, message: makeAssistantMessage(), toolResults: [] },
        ctx,
      );
    },
    contextEvent() {
      return { type: "context", messages: structuredClone(entries.map((e) => e.message as AgentMessage)) };
    },
  };
}

async function startedConnector(): Promise<{ connector: Connector; ref: ThreadRef; pi: PiSession }> {
  const created = await makeTempThread(store);
  const ref: ThreadRef = { threadId: created.threadId, registryPath: store.registryPath };
  setLauncherOwnedStartup({ threadRef: ref, launchFlags: { thread: created.threadId } });
  const connector = createConnector({
    registryPath: store.registryPath,
    newThreadFilePath: () => store.threadPath(),
    buildSdkConfig: () => ({
      ok: true,
      value: { inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "background" },
    }),
    // A tiny trigger so a few kilotokens of tool output is pressure.
    compactSettingsConfig: [
      {
        match: "claude",
        triggerTokens: 3000,
        lowerBound: 1200,
        percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
      },
    ],
  });
  const pi = piSession(connector);
  await connector.handlers.session_start(makeSessionStart("startup"), pi.ctx);
  expect(connector.getState()).not.toBeNull();
  return { connector, ref, pi };
}

const t0 = FIXTURE_TIMESTAMP_MS;
const usageOf = (contextTokens: number) =>
  zeroUsage({ input: contextTokens, output: 10, totalTokens: contextTokens + 10 });

/** A closed research turn: prompt, a tool step with a large result, a final answer. */
async function closedTurn(pi: PiSession, connector: Connector, n: number, at: number): Promise<void> {
  const user = makeUserMessage(`task ${n}`, at);
  const call = makeAssistantMessage({
    toolCalls: [{ id: `c${n}`, name: "read", arguments: { path: `f${n}` } }],
    stopReason: "toolUse",
    timestamp: at + 1,
    usage: usageOf(200),
  });
  const result = makeToolResult({ id: `c${n}`, content: `finding ${n} `.repeat(400), timestamp: at + 2 });
  const answer = makeAssistantMessage({ text: `answer ${n}`, timestamp: at + 3, usage: usageOf(1400) });
  await pi.deliver(user);
  await pi.deliver(call);
  await pi.deliver(result);
  await pi.stepEnd();
  await pi.deliver(answer);
  await pi.stepEnd();
  await connector.handlers.agent_end(makeAgentEnd([user, call, result, answer]), pi.ctx);
}

describe("the context hook", () => {
  it("pressure: provider-reported context of the last usable assistant plus LHC estimates since", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("x", t0),
      makeAssistantMessage({ text: "a", usage: usageOf(5000), timestamp: t0 + 1 }),
      makeToolResult({ id: "c", content: "word ".repeat(100), timestamp: t0 + 2 }),
      makeAssistantMessage({ text: "gone", stopReason: "aborted", usage: usageOf(9000), timestamp: t0 + 3 }),
    ];
    const pressure = estimateContextPressure(messages);
    expect(pressure).toBeGreaterThan(5010);
    expect(pressure).toBeLessThan(5010 + 400);
    expect(estimateContextPressure([makeUserMessage("hello there", t0)])).toBeGreaterThan(0);
  });

  it("TC-7.2a/7.2d: over the trigger mid-run, the handler compacts in the same turn and serves bands + Pi's tail from step k+1; Pi state untouched", async () => {
    const { connector, ref, pi } = await startedConnector();
    for (let n = 1; n <= 3; n += 1) await closedTurn(pi, connector, n, t0 + n * 100);

    // The live turn: two complete steps with big results, a third in flight.
    const at = t0 + 1000;
    const user = makeUserMessage("big task", at);
    await pi.deliver(user);
    for (let step = 0; step < 2; step += 1) {
      await pi.deliver(
        makeAssistantMessage({
          toolCalls: [{ id: `live${step}`, name: "read", arguments: {} }],
          stopReason: "toolUse",
          timestamp: at + 10 * step + 1,
          usage: usageOf(2500 + step * 800),
        }),
      );
      await pi.deliver(
        makeToolResult({ id: `live${step}`, content: `live ${step} `.repeat(500), timestamp: at + 10 * step + 2 }),
      );
      await pi.stepEnd();
    }
    const entriesBefore = pi.entries.length;
    const turnsBefore = await turns.listTurns(ref);
    expect(turnsBefore.ok && turnsBefore.value.filter((t) => t.status === "open").map((t) => t.turnId)).toEqual(["t4"]);

    const event = pi.contextEvent();
    const served = await connector.contextHandler(event, pi.ctx);
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "served", compacted: true });
    expect(served?.messages).toBeDefined();
    const messages = served?.messages ?? [];

    // Turn identity unchanged, no continuation turn, no forced-boundary marker.
    const turnsAfter = await turns.listTurns(ref);
    expect(turnsAfter.ok && turnsAfter.value.filter((t) => t.status === "open").map((t) => t.turnId)).toEqual(["t4"]);
    expect(turnsAfter.ok && turnsAfter.value.length).toBe(turnsBefore.ok ? turnsBefore.value.length : -1);
    // Served-only durability: nothing appended to the Pi session.
    expect(pi.entries.length).toBe(entriesBefore);

    // The served list: rendered bands, then Pi's own objects from the first
    // kept message — the tail is a suffix of the event's list, byte for byte.
    const described = await threadView.describe(ref);
    expect(described.ok && described.value?.bands.length).toBeGreaterThan(0);
    const bandCount = described.ok && described.value ? described.value.bands.length : 0;
    const bands = messages.slice(0, bandCount);
    for (const band of bands) expect(band.role === "user" && String(band.content).startsWith("[context ·")).toBe(true);
    const tail = messages.slice(bandCount);
    const outcome = connector.getLastContextOutcome();
    const tailIndex = outcome?.kind === "served" ? outcome.tailIndex : -1;
    expect(JSON.stringify(tail)).toBe(JSON.stringify(event.messages.slice(tailIndex)));
    // The tail begins at a step edge inside the live turn: a tool pair never splits.
    expect(tail[0]?.role).toBe("assistant");
    const calls = tail
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        (m as { content: Array<{ type: string; id?: string }> }).content
          .filter((p) => p.type === "toolCall")
          .map((p) => p.id),
      );
    const results = tail.filter((m) => m.role === "toolResult").map((m) => (m as { toolCallId: string }).toolCallId);
    expect(results).toEqual(calls);
    // The live turn was split: its complete steps serve as a part inside a
    // band, the seam marker with them, never in the tail.
    expect(described.ok && described.value?.arrangement.some((e) => e.part !== undefined)).toBe(true);
    expect(bands.some((b) => String(b.content).includes("[seam · t4 ·"))).toBe(true);
    expect(tail.some((m) => JSON.stringify(m).includes("[seam ·"))).toBe(false);

    // Provider input drops: the served list is smaller than the raw one.
    const size = (list: readonly AgentMessage[]) => list.reduce((sum, m) => sum + estimateAgentMessageTokens(m), 0);
    expect(size(messages)).toBeLessThan(size(event.messages));

    // AC-7.5 in Pi: the same pressure again (served-only, raw unchanged) does
    // not compact again — the next attempt waits for real growth.
    const again = await connector.contextHandler(pi.contextEvent(), pi.ctx);
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "served", compacted: false });
    expect(JSON.stringify(again?.messages)).toBe(JSON.stringify(messages));
    const describedAgain = await threadView.describe(ref);
    expect(describedAgain.ok && described.ok && describedAgain.value?.viewId).toBe(
      described.ok ? described.value?.viewId : null,
    );
  });

  it("TC-7.2e: below the trigger with an installed view, every step serves it unchanged — byte-stable prefix, no compact; the raw list only without a view", async () => {
    const { connector, ref, pi } = await startedConnector();
    // No installed view yet: raw.
    await closedTurn(pi, connector, 1, t0 + 100);
    await pi.deliver(makeUserMessage("next", t0 + 500));
    expect(await connector.contextHandler(pi.contextEvent(), pi.ctx)).toBeUndefined();
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "raw", reason: "no installed view" });

    // Install a view the ordinary way (boundary compact), then serve steady-state.
    for (let n = 2; n <= 3; n += 1) await closedTurn(pi, connector, n, t0 + n * 100);
    const instance = connector.getInstance();
    const compacted = await instance!.sdk.threadView.compact(ref, {
      params: { lowerBound: 1200, percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 } },
    });
    expect(compacted.ok).toBe(true);
    const viewBefore = await threadView.describe(ref);

    // A Pi compaction summary at the head of Pi's list is dropped in favor of the view.
    const summary = {
      role: "compactionSummary",
      summary: "pi's own summary",
      tokensBefore: 1,
      timestamp: t0,
    } as unknown as AgentMessage;
    pi.entries.unshift({
      type: "compaction",
      id: "pi-c",
      parentId: null,
      summary: "pi's own summary",
      firstKeptEntryId: "e1",
      tokensBefore: 1,
      timestamp: new Date(t0).toISOString(),
    } as SessionEntry);
    const withSummary = (): ContextEvent => ({
      type: "context",
      messages: [
        structuredClone(summary),
        ...structuredClone(pi.entries.slice(1).map((e) => e.message as AgentMessage)),
      ],
    });

    await pi.deliver(makeUserMessage("small step", t0 + 900));
    const firstMessages = (await connector.contextHandler(withSummary(), pi.ctx))?.messages ?? [];
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "served", compacted: false });
    expect(firstMessages.length).toBeGreaterThan(0);
    expect(firstMessages.some((m) => (m as { role: string }).role === "compactionSummary")).toBe(false);

    await pi.deliver(makeAssistantMessage({ text: "tiny", timestamp: t0 + 901, usage: usageOf(300) }));
    await pi.stepEnd();
    const secondMessages = (await connector.contextHandler(withSummary(), pi.ctx))?.messages ?? [];
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "served", compacted: false });
    const prefixLen = firstMessages.length - 1;
    expect(JSON.stringify(secondMessages.slice(0, prefixLen))).toBe(JSON.stringify(firstMessages.slice(0, prefixLen)));
    expect(secondMessages.length).toBe(firstMessages.length + 1);
    const viewAfter = await threadView.describe(ref);
    expect(viewAfter.ok && viewBefore.ok && viewAfter.value?.viewId).toBe(
      viewBefore.ok ? viewBefore.value?.viewId : null,
    );
  });

  it("steer during a split: a user message landing at the split's step edge survives verbatim in the served tail", async () => {
    const { connector, ref, pi } = await startedConnector();
    for (let n = 1; n <= 3; n += 1) await closedTurn(pi, connector, n, t0 + n * 100);
    const at = t0 + 1000;
    await pi.deliver(makeUserMessage("big task", at));
    for (let step = 0; step < 2; step += 1) {
      await pi.deliver(
        makeAssistantMessage({
          toolCalls: [{ id: `live${step}`, name: "read", arguments: {} }],
          stopReason: "toolUse",
          timestamp: at + 10 * step + 1,
          usage: usageOf(2500 + step * 800),
        }),
      );
      await pi.deliver(
        makeToolResult({ id: `live${step}`, content: `live ${step} `.repeat(500), timestamp: at + 10 * step + 2 }),
      );
      await pi.stepEnd();
    }
    await connector.contextHandler(pi.contextEvent(), pi.ctx);
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "served", compacted: true });
    const split = await threadView.describe(ref);
    expect(split.ok && split.value?.arrangement.some((e) => e.part !== undefined)).toBe(true);

    // Pi drains a steer at the same step edge: a user message in the record.
    const steer = makeUserMessage("actually, focus on the tests", at + 50);
    await pi.deliver(steer);
    const served = (await connector.contextHandler(pi.contextEvent(), pi.ctx))?.messages ?? [];
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "served", compacted: false });
    expect(served.at(-1)).toEqual(steer);
    // Still the same installed view: the steer rides in the verbatim tail.
    const after = await threadView.describe(ref);
    expect(after.ok && split.ok && after.value?.viewId).toBe(split.ok ? split.value?.viewId : null);
  });

  it("overflow backstop: a raw-served step that bounces reaches Pi's overflow recovery, and the boundary-compact path serves LHC's view", async () => {
    const { connector, ref, pi } = await startedConnector();
    for (let n = 1; n <= 3; n += 1) await closedTurn(pi, connector, n, t0 + n * 100);
    await pi.deliver(makeUserMessage("go", t0 + 900));
    // The handler fails open (here: Pi's list drifted from its entries).
    const drifted = pi.contextEvent();
    for (const m of drifted.messages) (m as { timestamp: number }).timestamp = 1;
    expect(await connector.contextHandler(drifted, pi.ctx)).toBeUndefined();

    // Pi's overflow recovery: session_before_compact{overflow} on the raw
    // request — the existing boundary path, unchanged, produces the LHC view.
    const result = await connector.compactHandlers.session_before_compact(
      makeBeforeCompactEvent({ reason: "overflow", branchEntries: pi.entries }),
      pi.ctx,
    );
    expect(result).not.toEqual({ cancel: true });
    const compaction = (result as { compaction?: { summary: string; firstKeptEntryId: string } })?.compaction;
    expect(compaction?.summary).toContain("[context ·");
    expect(pi.entries.some((e) => e.id === compaction?.firstKeptEntryId)).toBe(true);
    const installed = await threadView.describe(ref);
    expect(installed.ok && installed.value !== null).toBe(true);

    // From here the context hook serves the installed view again.
    await pi.deliver(makeAssistantMessage({ text: "recovered", timestamp: t0 + 901, usage: usageOf(300) }));
    await pi.stepEnd();
    expect((await connector.contextHandler(pi.contextEvent(), pi.ctx))?.messages?.length ?? 0).toBeGreaterThan(0);
    expect(connector.getLastContextOutcome()).toMatchObject({ kind: "served", compacted: false });
  });

  it("fails open to the raw list: alignment refused, or the session manager cannot list context entries", async () => {
    const { connector, ref, pi } = await startedConnector();
    for (let n = 1; n <= 3; n += 1) await closedTurn(pi, connector, n, t0 + n * 100);
    const instance = connector.getInstance();
    expect(
      (
        await instance!.sdk.threadView.compact(ref, {
          params: { lowerBound: 1200, percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 } },
        })
      ).ok,
    ).toBe(true);
    await pi.deliver(makeUserMessage("go", t0 + 900));

    // Pi's list no longer matches its entries (timestamps drifted): refused, raw.
    const drifted = pi.contextEvent();
    for (const m of drifted.messages) (m as { timestamp: number }).timestamp = 1;
    expect(await connector.contextHandler(drifted, pi.ctx)).toBeUndefined();
    expect(connector.getLastContextOutcome()).toMatchObject({
      kind: "raw",
      reason: expect.stringContaining("alignment refused"),
    });

    const noList: ExtensionContext = { ...pi.ctx, sessionManager: { getEntries: () => pi.entries } };
    expect(await connector.contextHandler(pi.contextEvent(), noList)).toBeUndefined();
    expect(connector.getLastContextOutcome()).toMatchObject({
      kind: "raw",
      reason: expect.stringContaining("no context entry list"),
    });
  });
});

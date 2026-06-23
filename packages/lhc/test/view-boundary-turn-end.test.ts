// Epic 05 Story 6: the turn-end boundary advance (TC-5.1–TC-5.3). The Epic 03
// advance trigger moves from every intake commit to turn close; eviction
// becomes whole-turn, oldest-first, with a peek-ahead stop and a never-evicted
// newest closed turn; the floor budget is retired (two-field config, 64k/32k
// defaults). Every advance here fires through a REAL `intake.messageEvents`
// commit — no host-called advance surface exists and no test invents one;
// rendering is proven through real `getLlmRequestContext` reads.
import { afterEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type SdkViewConfig } from "../src/index.js";
import {
  boundaryTokens,
  createInferenceCallbacksDouble,
  openRaw,
  seedTurnedToolResults,
  setViewInjectionHook,
  type TempStore,
  tempStore,
  turnedToolResultEvents,
  validEvent,
} from "./fixtures/index.js";

// The story's small test budgets: max 100 > target 60 (AC-5.4 ordering); the
// G2 leg runs the 64k/32k defaults instead.
const BUDGETS = { maxTokens: 100, targetTokens: 60 };

const stores: TempStore[] = [];
afterEach(() => {
  setViewInjectionHook("post-commit-advance", null);
  for (const store of stores.splice(0)) store.cleanup();
});

function visSdk(view: SdkViewConfig = { visibility: BUDGETS }): Lhc {
  return initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual", view });
}

async function newThread(sdk: Lhc): Promise<string> {
  const store = tempStore();
  stores.push(store);
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function boundaryOf(filePath: string): Promise<number> {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT position FROM view_boundary`).get() as { position: number | bigint };
    return Number(row.position);
  } finally {
    db.close();
  }
}

async function zoneTokensOf(sdk: Lhc, filePath: string): Promise<number> {
  const status = await sdk.threadView.status({ filePath });
  if (!status.ok) throw new Error(`status failed: ${status.error.reason}`);
  return status.value.visibility.zoneTokens;
}

interface ResultRow {
  messageId: string;
  sourceEventOrder: number;
  tokenEstimate: number;
  turnId: string | null;
}

async function toolResults(sdk: Lhc, filePath: string): Promise<ResultRow[]> {
  const listed = await sdk.messages.list({ filePath });
  if (!listed.ok) throw new Error(`list failed: ${listed.error.reason}`);
  return listed.value
    .filter((m) => m.kind === "tool_result")
    .map((m) => ({
      messageId: m.messageId,
      sourceEventOrder: m.sourceEventOrder,
      tokenEstimate: m.tokenEstimate,
      turnId: m.turnId ?? null,
    }));
}

function messageText(message: { content: readonly { text: string }[] }): string {
  return message.content.map((part) => part.text).join("");
}

function messageTexts(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): string[] {
  return messages.map((message) => messageText(message));
}

function abridgedCount(messages: ReadonlyArray<{ content: readonly { text: string }[] }>): number {
  return messages.filter((m) => {
    const text = messageText(m);
    return text.startsWith("[tool result · ") && text.includes(" · abridged]");
  }).length;
}

// Per-turn all-or-nothing (AC-5.2): with the boundary at `position`, every
// turn's results sit uniformly at-or-behind it or uniformly ahead of it —
// no turn is ever partially flipped.
function expectNoPartialTurn(results: readonly ResultRow[], position: number): void {
  const byTurn = new Map<string, boolean[]>();
  for (const r of results) {
    if (r.turnId === null) continue; // turnless: a singleton is whole by construction
    const flips = byTurn.get(r.turnId) ?? [];
    flips.push(r.sourceEventOrder <= position);
    byTurn.set(r.turnId, flips);
  }
  for (const [turnId, flips] of byTurn) {
    const flipped = flips.filter(Boolean).length;
    expect(
      flipped === 0 || flipped === flips.length,
      `turn ${turnId} is partially flipped (${flipped}/${flips.length})`,
    ).toBe(true);
  }
}

// A counting (non-throwing) hook on the Story-0 injection point: it fires
// once per advance check, so it counts how many times the gated advance ran.
function countAdvances(): { count: () => number } {
  let fired = 0;
  setViewInjectionHook("post-commit-advance", () => {
    fired += 1;
  });
  return { count: () => fired };
}

async function intakeRaw(
  sdk: Lhc,
  filePath: string,
  events: Parameters<Lhc["intakeStream"]["messageEvents"]>[1],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
}

describe("TC-5.1 (AC-5.1, AC-5.2): the advance runs only at turn close; eviction is whole-turn, oldest-first", () => {
  it("advances when a new user prompt closes the previous populated turn", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    const advances = countAdvances();

    await seedTurnedToolResults(sdk, filePath, [{ results: [30, 30] }]);
    expect(advances.count()).toBe(1);
    expect(await boundaryOf(filePath)).toBe(0);

    await intakeRaw(sdk, filePath, turnedToolResultEvents([{ results: [40, 40], close: false }]));
    expect(advances.count()).toBe(1);
    expect(await zoneTokensOf(sdk, filePath)).toBe(140);

    const closedByPrompt = await sdk.intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "next prompt closes the prior turn" } }),
    ]);
    expect(closedByPrompt.ok).toBe(true);
    if (!closedByPrompt.ok) return;
    expect(closedByPrompt.value.turnTransitions.map((transition) => transition.action)).toEqual(["closed", "opened"]);
    expect(advances.count()).toBe(2);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(4);
    const position = await boundaryOf(filePath);
    expect(position).toBe(results[1]?.sourceEventOrder);
    expect(await zoneTokensOf(sdk, filePath)).toBe(80);
    expectNoPartialTurn(results, position);
  });

  it("holds position and bytes through mid-turn batches past max, advances exactly once at close, flips whole oldest turns", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    const advances = countAdvances();

    // One small closed turn (zone 60 ≤ 100): the close runs the check, the
    // boundary holds.
    await seedTurnedToolResults(sdk, filePath, [{ results: [30, 30] }]);
    expect(advances.count()).toBe(1);
    expect(await boundaryOf(filePath)).toBe(0);

    // A second turn opens and accumulates tool results across mid-turn
    // batches, crossing max (zone 60+40 = 100, then 140 > 100): no batch runs
    // the check, the boundary never moves, and the over-budget condition is
    // visible in status.
    await intakeRaw(sdk, filePath, turnedToolResultEvents([{ results: [40], close: false }]));
    await intakeRaw(sdk, filePath, turnedToolResultEvents([{ results: [40], turnless: true }]));
    expect(advances.count()).toBe(1); // mid-turn batches never even check
    expect(await boundaryOf(filePath)).toBe(0);
    expect(await zoneTokensOf(sdk, filePath)).toBe(140);

    // Consecutive context reads during the open turn are byte-identical (AC-5.1).
    const firstContextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    const secondContextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(firstContextRead.ok && secondContextRead.ok).toBe(true);
    if (!firstContextRead.ok || !secondContextRead.ok) return;
    expect(secondContextRead.value.messages).toEqual(firstContextRead.value.messages);
    expect(abridgedCount(firstContextRead.value.messages)).toBe(0);

    // The batch closing the turn commits: exactly one advance runs. Zone 140
    // > 100; groups t1=60, t2=80 (newest closed, never a candidate). Evicting
    // t1 leaves 80 ≥ target 60 → t1 flips whole; the advance lands at t1's
    // last result.
    await intakeRaw(sdk, filePath, [validEvent("turn_end")]);
    expect(advances.count()).toBe(2);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(4);
    const position = await boundaryOf(filePath);
    expect(position).toBe(results[1]?.sourceEventOrder);
    expect(await zoneTokensOf(sdk, filePath)).toBe(80);

    // Whole-turn, all-or-nothing: both of t1's results flipped together,
    // both of t2's stayed full.
    expectNoPartialTurn(results, position);
    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    expect(abridgedCount(contextRead.value.messages)).toBe(2);
    expect(messageTexts(contextRead.value.messages)).toContain(`[tool result · read_file]\n${boundaryTokens(40)}`);

    // A small next turn closes under max (zone 90 ≤ 100): the check runs, no
    // movement.
    await seedTurnedToolResults(sdk, filePath, [{ results: [10] }]);
    expect(advances.count()).toBe(3);
    expect(await boundaryOf(filePath)).toBe(position);
    expect(await zoneTokensOf(sdk, filePath)).toBe(90);
  });

  it("evicts a turnless tool result as a singleton group", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);

    // One closed turn (50), a turnless result in the gap (30), then a closed
    // turn (70): zone 150 > 100. Walk excluding the newest closed turn:
    // evict t1 (remaining 100 ≥ 60), evict the singleton (remaining 70 ≥ 60),
    // stop. The boundary lands on the turnless result.
    await seedTurnedToolResults(sdk, filePath, [
      { results: [50] },
      { results: [30], turnless: true },
      { results: [70] },
    ]);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(3);
    expect(results[1]?.turnId).toBe("t2");
    expect(await boundaryOf(filePath)).toBe(results[1]?.sourceEventOrder);
    expect(await zoneTokensOf(sdk, filePath)).toBe(70);

    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    expect(abridgedCount(contextRead.value.messages)).toBe(2); // t1's result + the singleton
    expect(messageTexts(contextRead.value.messages)).toContain(`[tool result · read_file]\n${boundaryTokens(70)}`);
  });
});

describe("TC-5.2 (AC-5.3, AC-5.4): peek-ahead landing, newest-turn protection, two-field config", () => {
  it("golden G2: 30k/25k/20k/15k turns under the 64k/32k defaults advance past the 25k group and land the zone at 35k", async () => {
    // Default visibility on purpose: this leg proves the 64k/32k defaults by
    // behavior and by the status read.
    const sdk = visSdk({});
    const filePath = await newThread(sdk);

    // One batch, four closed turns: total 90k > max 64k. Evict 30k → 60k ≥
    // 32k ✓; evict 25k → 35k ≥ 32k ✓; peek 20k: 35k − 20k = 15k < 32k → stop.
    // The 15k newest closed turn was never a candidate.
    await seedTurnedToolResults(sdk, filePath, [
      { results: [30000] },
      { results: [25000] },
      { results: [20000] },
      { results: [15000] },
    ]);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(4);
    expect(await boundaryOf(filePath)).toBe(results[1]?.sourceEventOrder);

    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(35000);
    expect(status.value.visibility.maxTokens).toBe(64000);

    // The landing rule: zone in [target, target + one turn).
    expect(status.value.visibility.zoneTokens).toBeGreaterThanOrEqual(32000);
    expect(status.value.visibility.zoneTokens).toBeLessThan(32000 + 20000);
  });

  it("advances through a turn when the remaining sum is exactly target (≥, not >)", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    // Turns 40/40/60: total 140 > 100. Evict t1 → 100 ≥ 60 ✓; evict t2 →
    // 60 ≥ 60 ✓ (the exact-target boundary condition); the newest closed
    // turn (60) is never a candidate. Zone lands exactly at target.
    await seedTurnedToolResults(sdk, filePath, [{ results: [40] }, { results: [40] }, { results: [60] }]);
    const results = await toolResults(sdk, filePath);
    expect(await boundaryOf(filePath)).toBe(results[1]?.sourceEventOrder);
    expect(await zoneTokensOf(sdk, filePath)).toBe(60);
  });

  it("never evicts the newest closed turn, even when it alone exceeds target and max", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    // Turns 30/120: total 150 > 100. t1 evicts (remaining 120 ≥ 60); the
    // oversized newest closed turn stays whole and the zone legally sits
    // above max until newer closes or a compact create room.
    await seedTurnedToolResults(sdk, filePath, [{ results: [30] }, { results: [120] }]);
    const results = await toolResults(sdk, filePath);
    expect(await boundaryOf(filePath)).toBe(results[0]?.sourceEventOrder);
    expect(await zoneTokensOf(sdk, filePath)).toBe(120);

    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    expect(messageTexts(contextRead.value.messages)).toContain(`[tool result · read_file]\n${boundaryTokens(120)}`);
  });

  it("never evicts the newest closed turn when a legal trailing turnless singleton sits after it", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    // A legal zone shape: two closed turns, then a tool result recorded after
    // the newest turn closed (turn_id NULL — a trailing turnless singleton).
    // Turns 50/45 then turnless 70: total 165 > 100. The newest closed turn
    // (45) and the trailing turnless (70) are both protected — the boundary
    // lands on a group's last order, so walking past either would flip the
    // newest closed turn short. Only t1 (50) is evictable (remaining 115 ≥ 60);
    // the walk stops before the newest closed turn and the zone legally stays
    // above max. (The pre-fix code evicted the newest closed turn here: it
    // protected only the trailing turnless as the last candidate.)
    await seedTurnedToolResults(sdk, filePath, [
      { results: [50] },
      { results: [45] },
      { results: [70], turnless: true },
    ]);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(3);
    expect(results[2]?.turnId).toBe("t3");

    const position = await boundaryOf(filePath);
    expect(position).toBe(results[0]?.sourceEventOrder); // lands on t1, before the newest closed turn
    expect(await zoneTokensOf(sdk, filePath)).toBe(115); // 45 (newest closed) + 70 (trailing turnless)

    // The newest closed turn stays intact: no turn is partially flipped, and
    // both it and the trailing turnless render full — only t1 is abridged.
    expectNoPartialTurn(results, position);
    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    expect(abridgedCount(contextRead.value.messages)).toBe(1); // only t1's result
    expect(messageTexts(contextRead.value.messages)).toContain(
      `[tool result · read_file]\n${boundaryTokens(45)}`, // newest closed turn, full
    );
    expect(messageTexts(contextRead.value.messages)).toContain(
      `[tool result · read_file]\n${boundaryTokens(70)}`, // trailing turnless, full
    );
  });

  it("holds the boundary when the only closed turn is oversized: no candidate exists", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await seedTurnedToolResults(sdk, filePath, [{ results: [150] }]);
    expect(await boundaryOf(filePath)).toBe(0);
    expect(await zoneTokensOf(sdk, filePath)).toBe(150);
  });

  it("rejects maxTokens ≤ targetTokens at construction with a TypeError naming the constraint", () => {
    expect(() => visSdk({ visibility: { maxTokens: 100, targetTokens: 200 } })).toThrow(TypeError);
    expect(() => visSdk({ visibility: { maxTokens: 100, targetTokens: 200 } })).toThrow(
      /visibility\.maxTokens \(100\) must be greater than targetTokens \(200\)/,
    );
    expect(() => visSdk({ visibility: { maxTokens: 100, targetTokens: 100 } })).toThrow(
      /visibility\.maxTokens \(100\) must be greater than targetTokens \(100\)/,
    );
  });

  it("resolves the two-field defaults to 64k/32k", () => {
    const sdk = visSdk({});
    expect(sdk.config.view.visibility).toEqual({ maxTokens: 64000, targetTokens: 32000 });
  });
});

describe("TC-5.3 (AC-5.5): remaining Epic 03 contracts under the new trigger", () => {
  it("keeps flipped results flipped across later turn closes and replays the same trajectory from the same record", async () => {
    // Determinism (golden G1 lives in view-select-golden.test.ts, re-cut for
    // turn grouping); this leg replays a small script twice end-to-end and
    // demands identical boundary trajectories.
    const script = [[{ results: [30, 30] }], [{ results: [40] }], [{ results: [40] }], [{ results: [10] }]] as const;

    const trajectories: number[][] = [];
    for (let run = 0; run < 2; run += 1) {
      const sdk = visSdk();
      const filePath = await newThread(sdk);
      const trajectory: number[] = [];
      for (const turns of script) {
        await seedTurnedToolResults(sdk, filePath, [...turns]);
        trajectory.push(await boundaryOf(filePath));
      }
      trajectories.push(trajectory);
    }
    expect(trajectories[1]).toEqual(trajectories[0]);

    // Forward-only within the window: positions never decrease.
    const [trajectory] = trajectories;
    expect(trajectory).toBeDefined();
    if (trajectory === undefined) return;
    for (let i = 1; i < trajectory.length; i += 1) {
      expect(trajectory[i]).toBeGreaterThanOrEqual(trajectory[i - 1] as number);
    }
    // The script crossed max at the third close (zone 60+40+40 = 140 > 100):
    // the boundary moved and later closes held it.
    expect(trajectory[2]).toBeGreaterThan(0);
    expect(trajectory[3]).toBe(trajectory[2]);
  });
});

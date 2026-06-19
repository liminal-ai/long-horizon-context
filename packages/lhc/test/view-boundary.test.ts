// Epic 03 Story 4: the visibility boundary (TC-4.1–4.6, the seam-isolation
// legs both directions, the both-host-modes in-process proof, and the DoD's
// status-sum/advance-sum equality check) — AMENDED by Epic 05 Story 6 per the
// test plan's Epic 03 Test Amendment Ledger:
//   - per-intake-advance legs are re-cut for the turn-end trigger and
//     whole-turn eviction (TC-5.1 owns the inverted mid-turn-never-moves
//     assertions in view-boundary-turn-end.test.ts);
//   - floor-protection legs (the old TC-4.3 monster-turn and oversized-newest
//     cases) are superseded by the newest-turn-protection legs in TC-5.2
//     (view-boundary-turn-end.test.ts);
//   - construction tests drop floorTokens for the two-field budgets and gain
//     the rejected-unknown-config leg;
//   - status zoneTokens legs are unchanged (shared-query invariant holds).
// Every advance here fires through a REAL `intake.messageEvents` commit — no
// host-called advance surface exists and no test invents one (story Anti-Shim
// Requirements); rendering is proven through real `pull` calls. Budgets
// resolve through SDK view config (the per-instance seam); the one
// direct-domain-call leg proves the below-SDK default-budget fallback while
// it proves poke-failure isolation.
import { afterEach, describe, expect, it } from "vitest";
import {
  initLhc,
  intakeStream,
  type Lhc,
  type MessageEventInput,
  type SdkViewConfig,
  setSchedulerPoke,
} from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  setViewInjectionHook,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

// "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
// so a content of n joined "tok" words carries token_estimate n — the same
// hand-derivable unit the Boundary G1 golden uses.
function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

// The story's test budgets: max 100 > target 60 (the two-field surface,
// Epic 05 AC-5.4).
const BUDGETS = { maxTokens: 100, targetTokens: 60 };

const stores: TempStore[] = [];
afterEach(() => {
  setViewInjectionHook("post-commit-advance", null);
  setSchedulerPoke(null);
  for (const store of stores.splice(0)) store.cleanup();
});

function visSdk(view: SdkViewConfig = { visibility: BUDGETS }, mode: "manual" | "background" = "manual"): Lhc {
  return initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode, view });
}

async function newThread(sdk: Lhc): Promise<string> {
  const store = tempStore();
  stores.push(store);
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return filePath;
}

let callCounter = 0;

// One tool run: call + result with the given token count.
function toolRun(resultTokens: number): MessageEventInput[] {
  callCounter += 1;
  const toolCallId = `call-vb-${callCounter}`;
  return [
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: `vb-${callCounter}.txt` } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: tokens(resultTokens), isError: false },
    }),
  ];
}

// One scripted turn: prompt, a tool run per entry, optional turn_end.
function toolTurn(resultTokens: readonly number[], opts: { turnEnd?: boolean } = {}): MessageEventInput[] {
  const events: MessageEventInput[] = [validEvent("user_prompt", { payload: { text: "scripted boundary turn" } })];
  for (const n of resultTokens) events.push(...toolRun(n));
  if (opts.turnEnd !== false) events.push(validEvent("turn_end"));
  return events;
}

async function intake(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`intake failed: ${result.error.reason}`);
}

async function boundaryOf(sdk: Lhc, filePath: string): Promise<number> {
  const pulled = await sdk.threadView.pull({ filePath });
  if (!pulled.ok) throw new Error(`pull failed: ${pulled.error.reason}`);
  return pulled.value.meta.boundaryPosition;
}

async function toolResults(
  sdk: Lhc,
  filePath: string,
): Promise<Array<{ messageId: string; sourceEventOrder: number; tokenEstimate: number }>> {
  const listed = await sdk.messages.list({ filePath });
  if (!listed.ok) throw new Error(`list failed: ${listed.error.reason}`);
  return listed.value
    .filter((m) => m.kind === "tool_result")
    .map((m) => ({
      messageId: m.messageId,
      sourceEventOrder: m.sourceEventOrder,
      tokenEstimate: m.tokenEstimate,
    }));
}

function abridgedCount(messages: ReadonlyArray<{ content: string }>): number {
  return messages.filter((m) => m.content.startsWith("[tool result · ") && m.content.includes(" · abridged]")).length;
}

describe("TC-4.1 (AC-4.3, re-cut for turn grouping): under-max closes never move the boundary; the crossing close evicts whole oldest turns", () => {
  it("holds position and bytes below max, then flips exactly the oldest whole turn", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);

    // Two under-max closed turns (zone 40, then 80 ≤ max 100): boundary unmoved.
    await intake(sdk, filePath, toolTurn([20, 20]));
    const afterFirst = await sdk.threadView.pull({ filePath });
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(afterFirst.value.meta.boundaryPosition).toBe(0);

    await intake(sdk, filePath, toolTurn([20, 20]));
    const afterSecond = await sdk.threadView.pull({ filePath });
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(afterSecond.value.meta.boundaryPosition).toBe(0);
    // Rendered bytes do not change below max: the earlier pull's messages are
    // a byte-identical prefix of the later one (AC-4.3's no-churn half).
    expect(afterSecond.value.messages.slice(0, afterFirst.value.messages.length)).toEqual(afterFirst.value.messages);
    expect(abridgedCount(afterSecond.value.messages)).toBe(0);

    // The crossing close (zone 120 > 100): one advance, whole-turn — turns
    // are 40/40/40 oldest→newest; the newest closed turn is never a
    // candidate; evicting t1 leaves 80 ≥ target 60, peeking t2 would leave
    // 40 < 60 → stop. Both of t1's results flip together (Epic 05 AC-5.2).
    await intake(sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(6);
    const expectedPosition = results[1]?.sourceEventOrder;
    const crossed = await sdk.threadView.pull({ filePath });
    expect(crossed.ok).toBe(true);
    if (!crossed.ok) return;
    expect(crossed.value.meta.boundaryPosition).toBe(expectedPosition);
    expect(abridgedCount(crossed.value.messages)).toBe(2);

    // Oldest-first: precisely the first turn's two results render abridged.
    const abridgedIds = results.filter((r) => r.sourceEventOrder <= (expectedPosition ?? 0)).map((r) => r.messageId);
    expect(abridgedIds).toEqual(results.slice(0, 2).map((r) => r.messageId));

    // DoD: status's zone sum equals the advance's decision sum on the same
    // state — the live tool-result estimates ahead of the boundary.
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const expectedZone = results
      .filter((r) => r.sourceEventOrder > (expectedPosition ?? 0))
      .reduce((sum, r) => sum + r.tokenEstimate, 0);
    expect(status.value.visibility.zoneTokens).toBe(expectedZone);
    expect(status.value.visibility.zoneTokens).toBe(80);

    // The next under-max close (zone 90 ≤ 100): no movement.
    await intake(sdk, filePath, toolTurn([10]));
    expect(await boundaryOf(sdk, filePath)).toBe(expectedPosition);
  });
});

describe("TC-4.2 (AC-4.1, AC-4.2): flipped renders — full-band boundary uses deterministic truncation; non-tool content untouched", () => {
  it("renders deterministic tool-result floors even when a ready summary exists", async () => {
    const double = createInferenceCallbacksDouble();
    const sdk = initLhc({ inferenceCallbacks: double, mode: "manual", view: { visibility: BUDGETS } });
    const filePath = await newThread(sdk);

    // r1 (60 tokens, 239 chars — over the 200-char abbreviation limit) will
    // have its summary FAIL terminally; r2 (20 tokens) drains a ready
    // summary; an assistant message sits between them.
    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "flip rendering prompt" } }),
      ...toolRun(60),
      validEvent("assistant_text", { payload: { text: "interleaved assistant text" } }),
      ...toolRun(20),
      validEvent("turn_end"),
    ]);
    // First tool_result_summary execution fails non-retryably (r1's — queue
    // order is walk order); r2's succeeds. Real drain, production paths.
    double.failKind("tool_result_summary", 1, {
      retryable: false,
      reason: "content_refusal: scripted permanent failure (boundary test)",
    });
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);

    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const results = listed.value.filter((m) => m.kind === "tool_result");
    const [r1, r2] = results;
    expect(r1 && r2).toBeTruthy();
    if (r1 === undefined || r2 === undefined) return;
    expect(r1.derivations?.find((f) => f.derivationType === "tool_result_summary")?.state).toBe("ready");
    const r2Summary = r2.derivations?.find(
      (f) => f.derivationType === "tool_result_summary" && f.state === "ready",
    )?.content;
    expect(r2Summary).toBeDefined();

    // The crossing close: an 80-token turn (zone 60+20+80 = 160 > max).
    // Turn grouping: t1 {r1, r2} = 80 evicts whole (remaining 80 ≥ target
    // 60); the newest closed turn is never a candidate.
    await intake(sdk, filePath, toolTurn([80]));
    expect(await boundaryOf(sdk, filePath)).toBe(r2.sourceEventOrder);

    const pulled = await sdk.threadView.pull({ filePath });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    const contents = pulled.value.messages.map((m) => m.content);

    // r1: failed summary ⇒ deterministic truncation rung — fixed 200-char
    // prefix, exact dropped-count marker, abridged marker, record pointer.
    expect(contents).toContain(
      `[tool result · read_file · abridged]\n${tokens(60).slice(0, 200)}… [truncated 39 chars] [full content in record §${r1.messageId}]`,
    );
    // r2: usable summary exists, but full-band boundary rendering still uses
    // the deterministic raw-result floor, never model summary content.
    expect(contents).toContain(
      `[tool result · read_file · abridged]\n${tokens(20)} [full content in record §${r2.messageId}]`,
    );
    expect(contents).not.toContain(
      `[tool result · read_file · abridged]\n${r2Summary} [full content in record §${r2.messageId}]`,
    );
    // The interleaved assistant message renders full — non-tool-result
    // content is never affected by the boundary (AC-4.1).
    expect(contents).toContain("interleaved assistant text");
    // The newest (protected) turn's result renders full.
    expect(contents).toContain(`[tool result · read_file]\n${tokens(80)}`);
  });
});

// The old TC-4.3 (monster open turn entered by the advance; oversized-newest
// floor protection) is SUPERSEDED per the Epic 05 amendment ledger: the
// turn-end trigger makes the open turn structurally untouchable (TC-5.1's
// mid-turn legs) and the newest-closed-turn protection replaces the floor
// (TC-5.2's legs) — both in view-boundary-turn-end.test.ts.

describe("TC-4.4 (AC-4.6, AC-4.7): never backward within a window; compact resets to the compact point", () => {
  it("keeps flipped results flipped across small batches, then resets to the compact point with a full fresh tail", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    for (let i = 0; i < 3; i += 1) await intake(sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(sdk, filePath);
    // Turns 40/40/40: the third close crosses max (120 > 100); evict the
    // whole oldest turn (remaining 80 ≥ target 60), peek stops at t2.
    const advanced = results[1]?.sourceEventOrder ?? 0;
    expect(await boundaryOf(sdk, filePath)).toBe(advanced);

    // Small tool-free closes: no backward motion, flipped stay flipped.
    for (let i = 0; i < 2; i += 1) {
      await intake(sdk, filePath, [
        validEvent("user_prompt", { payload: { text: `small batch ${i}` } }),
        validEvent("assistant_text", { payload: { text: `small answer ${i}` } }),
        validEvent("turn_end"),
      ]);
      const pulled = await sdk.threadView.pull({ filePath });
      expect(pulled.ok).toBe(true);
      if (!pulled.ok) return;
      expect(pulled.value.meta.boundaryPosition).toBe(advanced);
      expect(abridgedCount(pulled.value.messages)).toBe(2);
    }

    // Compact: the boundary resets to the compact point (AC-4.7 — the reset
    // transaction landed in Story 2; this proves it end-to-end against a
    // boundary the production advance moved).
    const receipt = await sdk.threadView.compact({ filePath }, { params: { lowerBound: 40 }, sweep: false });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const afterCompact = await sdk.threadView.pull({ filePath });
    expect(afterCompact.ok).toBe(true);
    if (!afterCompact.ok) return;
    expect(afterCompact.value.meta.compactPoint).toBe(receipt.value.compactPoint);
    expect(afterCompact.value.meta.boundaryPosition).toBe(receipt.value.compactPoint);

    // Fresh tail renders full: a new under-max tool result is not abridged.
    await intake(sdk, filePath, toolTurn([20]));
    const fresh = await sdk.threadView.pull({ filePath });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    const tail = fresh.value.messages.filter((m) => m.band === undefined);
    expect(abridgedCount(tail)).toBe(0);
    expect(tail.map((m) => m.content)).toContain(`[tool result · read_file]\n${tokens(20)}`);
  });
});

describe("TC-4.5 (AC-4.8 as amended by Epic 05 AC-5.4): budget validation names the violated constraint", () => {
  it("rejects max ≤ target at construction, naming the constraint", () => {
    expect(() => visSdk({ visibility: { maxTokens: 100, targetTokens: 200 } })).toThrow(
      /maxTokens \(100\) must be greater than targetTokens \(200\)/,
    );
  });
});

describe("TC-4.6 (AC-4.9): a failed advance leaves intake intact and the condition visible; the next turn close heals — and the poke still fires", () => {
  it("background mode: intake succeeds, boundary holds, status shows over-max, the drain still ran; cleared, the next close lands in the target window", async () => {
    const sdk = visSdk({ visibility: BUDGETS }, "background");
    const filePath = await newThread(sdk);

    // The Story-0 facility's named post-commit point — not a mock of
    // boundary.ts: an installed throw stands in for an advance failure.
    let fired = 0;
    setViewInjectionHook("post-commit-advance", () => {
      fired += 1;
      throw new Error("injected advance failure");
    });

    // One crossing batch of three closed turns: zone 120 > max 100. The
    // batch commits turn_ends, so the (failing) advance runs exactly once.
    const result = await sdk.intakeStream.messageEvents({ filePath }, [
      ...toolTurn([40]),
      ...toolTurn([40]),
      ...toolTurn([40]),
    ]);
    expect(result.ok).toBe(true); // intake's outcome never depends on the advance
    if (!result.ok) return;
    expect(result.value.events.every((e) => e.outcome === "recorded")).toBe(true);
    expect(fired).toBe(1);

    // All messages committed; boundary unchanged; the over-budget condition
    // is visible in status — computed live, the same sum the advance reads.
    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(3);
    expect(await boundaryOf(sdk, filePath)).toBe(0);
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(120);
    expect(status.value.visibility.zoneTokens).toBeGreaterThan(status.value.visibility.maxTokens);

    // Seam isolation, direction one: the throwing advance never ate the queue
    // poke — the background drain ran and the summaries landed ready.
    await sdk.drainSettled({ filePath });
    const listed = await sdk.messages.list({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    for (const m of listed.value.filter((msg) => msg.kind === "tool_result")) {
      expect(m.derivations?.find((f) => f.derivationType === "tool_result_summary")?.state).toBe("ready");
    }

    // Clear the injection; the next turn close re-evaluates and heals: zone
    // 130 > 100; turns 40/40/40/10 — evict t1 (remaining 90 ≥ 60), peek t2
    // would leave 50 < 60 → stop; the newest closed turn never a candidate.
    setViewInjectionHook("post-commit-advance", null);
    await intake(sdk, filePath, toolTurn([10]));
    const all = await toolResults(sdk, filePath);
    expect(await boundaryOf(sdk, filePath)).toBe(all[0]?.sourceEventOrder);
    const healed = await sdk.threadView.status({ filePath });
    expect(healed.ok).toBe(true);
    if (!healed.ok) return;
    expect(healed.value.visibility.zoneTokens).toBe(90);
  });
});

describe("seam isolation, direction two (architecture-risk): a failing poke never blocks the advance", () => {
  it("advances through a direct domain call (default budgets) even when the fallback poke throws", async () => {
    // Thread built through a manual SDK; the intake under test is a DIRECT
    // domain call with no SDK seam in scope, so budgets fall back to the
    // built-in defaults (64000/32000) and the poke falls back to the
    // below-SDK slot — which this leg makes throw.
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    setSchedulerPoke(() => {
      throw new Error("injected poke failure");
    });

    // Two closed turns of 40000 each: the second close crosses the default
    // max (80000 > 64000); evicting the older whole turn leaves 40000 ≥
    // target 32000; the newest closed turn is never a candidate.
    await intakeStream.messageEvents({ filePath }, toolTurn([40000]));
    await intakeStream.messageEvents({ filePath }, toolTurn([40000]));
    setSchedulerPoke(null);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(2); // the batches committed
    // The advance ran before the throwing poke: position = the older turn.
    expect(await boundaryOf(sdk, filePath)).toBe(results[0]?.sourceEventOrder);
  });
});

describe("deleted-filter consistency (story DoD): the advance's sum and status's zone sum both skip deleted results", () => {
  it("drops a deleted zone result from the live sum, and the next advance decides over the filtered population", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    // Zone 80 ≤ max 100: no advance yet.
    await intake(sdk, filePath, toolTurn([40, 40]));
    expect(await boundaryOf(sdk, filePath)).toBe(0);

    // Delete the older result: the live zone drops to 40 — status computes
    // the deleted-filtered sum, the same query the advance reads.
    const results = await toolResults(sdk, filePath);
    const deleted = await sdk.messages.remove({ filePath }, { messageId: results[0]?.messageId ?? "" });
    expect(deleted.ok).toBe(true);
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(40);

    // The next close's advance decides over the filtered population: live
    // zone 40+40+40 = 120 > max; the deleted row neither sums nor flips.
    // Turn grouping: t1's surviving live result (40) evicts whole (remaining
    // 80 ≥ target 60); the newest closed turn {40, 40} is never a candidate.
    await intake(sdk, filePath, toolTurn([40, 40]));
    const all = await toolResults(sdk, filePath); // list is deleted-filtered too
    expect(all).toHaveLength(3);
    expect(await boundaryOf(sdk, filePath)).toBe(all[0]?.sourceEventOrder);
    const after = await sdk.threadView.status({ filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.visibility.zoneTokens).toBe(80);
  });
});

describe("both host modes advance in-process (story DoD)", () => {
  it.each(["manual", "background"] as const)("%s-mode SDK intake advances to the same position", async (mode) => {
    const sdk = visSdk({ visibility: BUDGETS }, mode);
    const filePath = await newThread(sdk);
    // Three closed turns of 40 in one batch: zone 120 > 100; evict the
    // whole oldest turn (remaining 80 ≥ 60), peek stops at t2; the newest
    // closed turn is never a candidate.
    await intake(sdk, filePath, [...toolTurn([40]), ...toolTurn([40]), ...toolTurn([40])]);
    const results = await toolResults(sdk, filePath);
    expect(await boundaryOf(sdk, filePath)).toBe(results[0]?.sourceEventOrder);
    if (mode === "background") await sdk.drainSettled({ filePath });
  });
});

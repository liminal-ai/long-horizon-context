// Epic 03 Story 4: the visibility boundary (TC-4.1–4.6, the seam-isolation
// legs both directions, the both-host-modes in-process proof, and the DoD's
// status-sum/advance-sum equality check). Every advance here fires through a
// REAL `intake.messageEvents` commit — no host-called advance surface exists
// and no test invents one (story Anti-Shim Requirements); rendering is proven
// through real `pull` calls. Budgets resolve through SDK view config (the
// per-instance seam); the one direct-domain-call leg proves the below-SDK
// default-budget fallback while it proves poke-failure isolation.
import { afterEach, describe, expect, it } from "vitest";
import {
  createSdk,
  intakeStream,
  setSchedulerPoke,
  type Lhc,
  type MessageEventInput,
  type SdkViewConfig,
} from "../src/index.js";
import {
  createProviderDouble,
  setViewInjectionHook,
  tempStore,
  validEvent,
  type TempStore,
} from "./fixtures/index.js";

// "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
// so a content of n joined "tok" words carries token_estimate n — the same
// hand-derivable unit the Boundary G1 golden uses.
function tokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

// The story's test budgets: max 100 > target 60 ≥ floor 30 (AC-4.8 ordering).
const BUDGETS = { maxTokens: 100, targetTokens: 60, floorTokens: 30 };

const stores: TempStore[] = [];
afterEach(() => {
  setViewInjectionHook("post-commit-advance", null);
  setSchedulerPoke(null);
  for (const store of stores.splice(0)) store.cleanup();
});

function visSdk(view: SdkViewConfig = { visibility: BUDGETS }, mode: "manual" | "background" = "manual"): Lhc {
  return createSdk({ provider: createProviderDouble(), mode, view });
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
  const events: MessageEventInput[] = [
    validEvent("user_prompt", { payload: { text: "scripted boundary turn" } }),
  ];
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
  const listed = await sdk.messages.listMessages({ filePath });
  if (!listed.ok) throw new Error(`listMessages failed: ${listed.error.reason}`);
  return listed.value
    .filter((m) => m.kind === "tool_result")
    .map((m) => ({
      messageId: m.messageId,
      sourceEventOrder: m.sourceEventOrder,
      tokenEstimate: m.tokenEstimate,
    }));
}

function abridgedCount(messages: ReadonlyArray<{ content: string }>): number {
  return messages.filter((m) => m.content.startsWith("[tool result · ") && m.content.includes(" · abridged]"))
    .length;
}

describe("TC-4.1 (AC-4.3): under-max batches never move the boundary; the crossing batch moves once to target, oldest-first", () => {
  it("holds position and bytes below max, then flips exactly one oldest-first batch of results", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);

    // Two under-max batches (zone 40, then 80 ≤ max 100): boundary unmoved.
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
    expect(afterSecond.value.messages.slice(0, afterFirst.value.messages.length)).toEqual(
      afterFirst.value.messages,
    );
    expect(abridgedCount(afterSecond.value.messages)).toBe(0);

    // The crossing batch (zone 120 > 100): one advance to target — the three
    // oldest results flip (120→100→80→60 = target), the newer three stay
    // full; the protected set (newest joined to 40 ≥ floor 30) is untouched.
    await intake(sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(6);
    const expectedPosition = results[2]?.sourceEventOrder;
    const crossed = await sdk.threadView.pull({ filePath });
    expect(crossed.ok).toBe(true);
    if (!crossed.ok) return;
    expect(crossed.value.meta.boundaryPosition).toBe(expectedPosition);
    expect(abridgedCount(crossed.value.messages)).toBe(3);

    // Oldest-first: precisely the first three results render abridged.
    const abridgedIds = results
      .filter((r) => r.sourceEventOrder <= (expectedPosition ?? 0))
      .map((r) => r.messageId);
    expect(abridgedIds).toEqual(results.slice(0, 3).map((r) => r.messageId));

    // DoD: status's zone sum equals the advance's decision sum on the same
    // state — the live tool-result estimates ahead of the boundary.
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const expectedZone = results
      .filter((r) => r.sourceEventOrder > (expectedPosition ?? 0))
      .reduce((sum, r) => sum + r.tokenEstimate, 0);
    expect(status.value.visibility.zoneTokens).toBe(expectedZone);
    expect(status.value.visibility.zoneTokens).toBe(60);

    // The next under-max batch (zone 70 ≤ 100): no movement.
    await intake(sdk, filePath, toolTurn([10]));
    expect(await boundaryOf(sdk, filePath)).toBe(expectedPosition);
  });
});

describe("TC-4.2 (AC-4.1, AC-4.2): flipped renders — summary when usable, deterministic truncation with marker when not; non-tool content untouched", () => {
  it("renders the ready summary, the truncation rung for the failed summary, and the interleaved assistant text full", async () => {
    const double = createProviderDouble();
    const sdk = createSdk({ provider: double, mode: "manual", view: { visibility: BUDGETS } });
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

    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const results = listed.value.filter((m) => m.kind === "tool_result");
    const [r1, r2] = results;
    expect(r1 && r2).toBeTruthy();
    if (r1 === undefined || r2 === undefined) return;
    expect(
      r1.forms?.find((f) => f.form === "tool_result_summary")?.state,
    ).toBe("failed");
    const r2Summary = r2.forms?.find(
      (f) => f.form === "tool_result_summary" && f.state === "ready",
    )?.content;
    expect(r2Summary).toBeDefined();

    // The crossing batch: an 80-token result (zone 60+20+80 = 160 > max).
    // Flips r1 and r2 (160→100→80); the newest is protected alone (≥ floor).
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
    // r2: usable summary ⇒ the summary verbatim.
    expect(contents).toContain(
      `[tool result · read_file · abridged]\n${r2Summary} [full content in record §${r2.messageId}]`,
    );
    // The interleaved assistant message renders full — non-tool-result
    // content is never affected by the boundary (AC-4.1).
    expect(contents).toContain("interleaved assistant text");
    // The newest (protected) result renders full.
    expect(contents).toContain(`[tool result · read_file]\n${tokens(80)}`);
  });
});

describe("TC-4.3 (AC-4.5): monster turn — the advance enters the open turn but stops at the whole-message protected set", () => {
  it("flips into the open turn, keeps the newest whole results (joined ≥ floor) full, and leaves the turn's text full", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    // One small closed turn, then one open turn whose tool results alone
    // cross max: zone 20+40+40+40+25 = 165 > 100.
    await intake(sdk, filePath, toolTurn([20]));
    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "monster prompt" } }),
      validEvent("assistant_thinking", { payload: { text: "monster thought" } }),
      ...toolRun(40),
      ...toolRun(40),
      ...toolRun(40),
      ...toolRun(25),
      validEvent("assistant_text", { payload: { text: "monster narration" } }),
      // No turn_end: the turn stays open.
    ]);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(5);
    // Protected set, newest-backward joined to ≥ floor 30: m4 (25) alone is
    // under the floor, so m3 joins (65) — whole messages, never a partial.
    // Flips stop there with the zone at 65, legally above target 60.
    const expectedPosition = results[2]?.sourceEventOrder; // m2: inside the open turn
    expect(await boundaryOf(sdk, filePath)).toBe(expectedPosition);

    const pulled = await sdk.threadView.pull({ filePath });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    const contents = pulled.value.messages.map((m) => m.content);
    expect(abridgedCount(pulled.value.messages)).toBe(3); // r0, m1, m2
    // The protected newest results render full.
    expect(contents).toContain(`[tool result · read_file]\n${tokens(40)}`);
    expect(contents).toContain(`[tool result · read_file]\n${tokens(25)}`);
    // The turn's own text messages all render full.
    expect(contents).toContain("monster prompt");
    expect(contents).toContain("[thinking]\nmonster thought\n[/thinking]");
    expect(contents).toContain("monster narration");

    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(65);
  });

  it("oversized-newest leg: a single result larger than the floor is protected alone; the zone legally sits above target", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    await intake(sdk, filePath, toolTurn([20]));
    // Open turn: 40 + 40 + 80; zone 180 > max. The newest (80) exceeds the
    // floor by itself and is protected alone (AC-4.5).
    await intake(sdk, filePath, [
      validEvent("user_prompt", { payload: { text: "oversized prompt" } }),
      ...toolRun(40),
      ...toolRun(40),
      ...toolRun(80),
    ]);
    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(4);
    expect(await boundaryOf(sdk, filePath)).toBe(results[2]?.sourceEventOrder);

    const pulled = await sdk.threadView.pull({ filePath });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    // The oversized newest renders full; everything older flipped.
    expect(pulled.value.messages.map((m) => m.content)).toContain(
      `[tool result · read_file]\n${tokens(80)}`,
    );
    expect(abridgedCount(pulled.value.messages)).toBe(3);

    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(80); // above target until room appears
  });
});

describe("TC-4.4 (AC-4.6, AC-4.7): never backward within a window; compact resets to the compact point", () => {
  it("keeps flipped results flipped across small batches, then resets to the compact point with a full fresh tail", async () => {
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    for (let i = 0; i < 3; i += 1) await intake(sdk, filePath, toolTurn([20, 20]));
    const results = await toolResults(sdk, filePath);
    const advanced = results[2]?.sourceEventOrder ?? 0;
    expect(await boundaryOf(sdk, filePath)).toBe(advanced);

    // Small tool-free batches: no backward motion, flipped stay flipped.
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
      expect(abridgedCount(pulled.value.messages)).toBe(3);
    }

    // Compact: the boundary resets to the compact point (AC-4.7 — the reset
    // transaction landed in Story 2; this proves it end-to-end against a
    // boundary the production advance moved).
    const receipt = await sdk.threadView.compact(
      { filePath },
      { params: { lowerBound: 40 }, sweep: false },
    );
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

describe("TC-4.5 (AC-4.8): budget validation names the violated constraint (replay equality lives in the Boundary G1 golden)", () => {
  it("rejects max ≤ target at construction, naming the constraint", () => {
    expect(() =>
      visSdk({ visibility: { maxTokens: 100, targetTokens: 200, floorTokens: 50 } }),
    ).toThrow(/maxTokens \(100\) must be greater than targetTokens \(200\)/);
  });

  it("rejects target < floor at construction, naming the constraint", () => {
    expect(() =>
      visSdk({ visibility: { maxTokens: 300, targetTokens: 100, floorTokens: 200 } }),
    ).toThrow(/targetTokens \(100\) must be at least floorTokens \(200\)/);
  });
});

describe("TC-4.6 (AC-4.9): a failed advance leaves intake intact and the condition visible; the next batch heals — and the poke still fires", () => {
  it("background mode: intake succeeds, boundary holds, status shows over-max, the drain still ran; cleared, the next batch lands at target", async () => {
    const sdk = visSdk({ visibility: BUDGETS }, "background");
    const filePath = await newThread(sdk);

    // The Story-0 facility's named post-commit point — not a mock of
    // boundary.ts: an installed throw stands in for an advance failure.
    let fired = 0;
    setViewInjectionHook("post-commit-advance", () => {
      fired += 1;
      throw new Error("injected advance failure");
    });

    // One crossing batch: zone 120 > max 100.
    const result = await sdk.intakeStream.messageEvents({ filePath }, toolTurn([40, 40, 40]));
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
    const listed = await sdk.messages.listMessages({ filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    for (const m of listed.value.filter((msg) => msg.kind === "tool_result")) {
      expect(m.forms?.find((f) => f.form === "tool_result_summary")?.state).toBe("ready");
    }

    // Clear the injection; the next batch re-evaluates and lands at target:
    // zone 130 → flip the two oldest (130→90→50 ≤ 60), stop before the
    // protected set (r3+r4 joined to 50 ≥ floor 30).
    setViewInjectionHook("post-commit-advance", null);
    await intake(sdk, filePath, toolTurn([10]));
    const all = await toolResults(sdk, filePath);
    expect(await boundaryOf(sdk, filePath)).toBe(all[1]?.sourceEventOrder);
    const healed = await sdk.threadView.status({ filePath });
    expect(healed.ok).toBe(true);
    if (!healed.ok) return;
    expect(healed.value.visibility.zoneTokens).toBe(50);
  });
});

describe("seam isolation, direction two (architecture-risk): a failing poke never blocks the advance", () => {
  it("advances through a direct domain call (default budgets) even when the fallback poke throws", async () => {
    // Thread built through a manual SDK; the intake under test is a DIRECT
    // domain call with no SDK seam in scope, so budgets fall back to the
    // built-in defaults (32000/24000/8000) and the poke falls back to the
    // below-SDK slot — which this leg makes throw.
    const sdk = visSdk();
    const filePath = await newThread(sdk);
    setSchedulerPoke(() => {
      throw new Error("injected poke failure");
    });

    // Zone 40000 > default max 32000: flip the older result (→ 20000 ≤
    // target 24000); the newest (20000 ≥ floor 8000) is protected alone.
    await intakeStream.messageEvents({ filePath }, toolTurn([20000, 20000]));
    setSchedulerPoke(null);

    const results = await toolResults(sdk, filePath);
    expect(results).toHaveLength(2); // the batch committed
    // The advance ran before the throwing poke: position = the older result.
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
    const deleted = await sdk.messages.deleteMessage(
      { filePath },
      { messageId: results[0]?.messageId ?? "" },
    );
    expect(deleted.ok).toBe(true);
    const status = await sdk.threadView.status({ filePath });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.visibility.zoneTokens).toBe(40);

    // The next batch's advance decides over the filtered population: live
    // zone 40+40+40 = 120 > max; the deleted row neither sums nor flips.
    // Flips: the two oldest LIVE results (120→80→40 ≤ target 60); the newest
    // (40 ≥ floor 30) is protected alone.
    await intake(sdk, filePath, toolTurn([40, 40]));
    const all = await toolResults(sdk, filePath); // listMessages is deleted-filtered too
    expect(all).toHaveLength(3);
    expect(await boundaryOf(sdk, filePath)).toBe(all[1]?.sourceEventOrder);
    const after = await sdk.threadView.status({ filePath });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.visibility.zoneTokens).toBe(40);
  });
});

describe("both host modes advance in-process (story DoD; the process-boundary CLI leg is Story 5's named debt)", () => {
  it.each(["manual", "background"] as const)("%s-mode SDK intake advances to the same position", async (mode) => {
    const sdk = visSdk({ visibility: BUDGETS }, mode);
    const filePath = await newThread(sdk);
    // Zone 120 > 100: flip the two oldest (120→80→40 ≤ 60); the newest (40 ≥
    // floor 30) is protected alone.
    await intake(sdk, filePath, toolTurn([40, 40, 40]));
    const results = await toolResults(sdk, filePath);
    expect(await boundaryOf(sdk, filePath)).toBe(results[1]?.sourceEventOrder);
    if (mode === "background") await sdk.drainSettled({ filePath });
  });
});

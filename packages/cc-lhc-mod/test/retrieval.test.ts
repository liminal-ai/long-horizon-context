import { RETRIEVAL_MAX_IDS } from "claude-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, harness, Script, SESSION, type Served, serve, writeTranscript } from "./fixture.ts";

let h: Harness;
let s: Served;
beforeEach(async () => {
  h = harness();
  s = await serve(h);
});
afterEach(async () => {
  await s.close();
  h.cleanup();
});

async function sessionWithBigRead(): Promise<void> {
  const script = new Script();
  script.toolTurn("turn-1", "remember the deploy region is eu-north-7", "toolu_a");
  script.prompt("read the big log");
  script.turnStart("turn-2");
  script.step("turn-2", 0);
  script.answer({ type: "tool_use", id: "toolu_big", name: "Read", input: { file_path: "big.log" } });
  const big = Array.from({ length: 6000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  script.entries.push({
    kind: "row",
    sessionId: SESSION,
    uuid: "big-result",
    door: "tool-result",
    origin: "tool",
    message: { type: "user", role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: big }] },
    at: Date.now(),
  });
  script.step("turn-2", 1);
  script.answer({ type: "text", text: "read it" });
  script.turnEnd("turn-2");
  writeTranscript(h, script.lines);
  await s.call("/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "startup" });
  await s.call("/capture", { entries: script.entries });
}

const retrieve = (op: string, ids: string[], fromToken?: number) =>
  s.call("/retrieve", { sessionId: SESSION, op, ids, ...(fromToken === undefined ? {} : { fromToken }) });

describe("retrieval", () => {
  it("serves a turn inside the recalled-history envelope and records the impression", async () => {
    await sessionWithBigRead();

    const { json } = await retrieve("get_turns", ["t1", "t99"]);

    expect(json.isError).toBe(false);
    const text = String(json.text);
    expect(text).toMatch(/^<recalled-history op="get_turns">/);
    expect(text).toContain("eu-north-7");
    expect(text).toContain("</recalled-history>");
    expect(text).toContain("not served: t99 (no such id in this conversation)");
    if (s.state.recording?.kind !== "recording") throw new Error("not recording");
    const impressions = await h.lhc.retrieval.listImpressions(s.state.recording.recorder.thread);
    if (!impressions.ok) throw new Error(impressions.error.reason);
    expect(impressions.value.map((i) => [i.surface, i.entityId, i.served])).toEqual([
      ["claude-code:get_turns", "t1", true],
      ["claude-code:get_turns", "t99", false],
    ]);
  });

  it("slices an item over budget, keeps the result under Claude Code's 50,000 characters, and serves the next slice", async () => {
    await sessionWithBigRead();
    const messageId = await bigMessageId();

    const first = String((await retrieve("get_messages", [messageId])).json.text);
    const next = /"fromToken":(\d+)/.exec(first)?.[1];

    expect(first).toContain("line 0 x");
    expect(first).not.toContain("line 5999 x");
    expect(first.length).toBeLessThanOrEqual(50_000);
    expect(first).toMatch(
      new RegExp(`\\[${messageId}: served tok 0–\\d+ of \\d+ — \\d+ tok remain\\. Next slice: get_messages`),
    );
    expect(next).toBeDefined();
    const second = String((await retrieve("get_messages", [messageId], Number(next))).json.text);
    expect(second).toContain(`[${messageId}: served tok ${next}–`);
  });

  it("refuses more ids than one call serves, and a session it is not bound to", async () => {
    await sessionWithBigRead();
    const ids = Array.from({ length: RETRIEVAL_MAX_IDS + 1 }, (_, i) => `t${i + 1}`);

    expect((await retrieve("get_turns", ids)).status).toBe(400);
    const other = await s.call("/retrieve", { sessionId: "other", op: "get_turns", ids: ["t1"] });
    expect(other.json).toEqual({
      text: "get_turns unavailable: the sidecar is bound to 11111111-2222-3333-4444-555555555555",
      isError: true,
    });
  });
});

async function bigMessageId(): Promise<string> {
  if (s.state.recording?.kind !== "recording") throw new Error("not recording");
  const thread = s.state.recording.recorder.thread;
  const listed = await h.lhc.messages.list(thread, { from: 1, limit: 100 });
  if (!listed.ok) throw new Error(listed.error.reason);
  const found = listed.value.find((m) => m.kind === "tool_result" && JSON.stringify(m).includes("toolu_big"));
  if (found === undefined) throw new Error("big result not recorded");
  return found.messageId;
}

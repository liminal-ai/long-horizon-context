import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NATIVE_SUMMARY_LABEL } from "../sidecar/src/capture/map.ts";
import { answerCompact } from "../sidecar/src/compact.ts";
import { type Harness, harness, messages, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

const homes: Harness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of homes.splice(0)) h.cleanup();
});
const fresh = () => {
  const h = harness();
  homes.push(h);
  return h;
};

it("native fallback summary is recovered from the shipped real transcript", async () => {
  const h = fresh();
  const lines = readFileSync(join(import.meta.dirname, "fixtures/native-compact-transcript.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const summary = lines.find((line) => line.isCompactSummary === true);
  expect(summary).toBeDefined();
  writeTranscript(h, lines);
  const r = await recorder(h);
  const notes = (await messages(r)).filter((text) => text.includes(NATIVE_SUMMARY_LABEL));
  expect(notes).toHaveLength(1);
});

it("a hot-reloaded open turn uses the mid-turn entry point", async () => {
  const h = fresh();
  const script = new Script();
  script.prompt("continue this running task");
  script.turnStart("running");
  script.step("running", 0);
  script.answer({ type: "tool_use", id: "toolu_a", name: "Bash", input: {} });
  script.results("toolu_a");
  writeTranscript(h, script.lines);
  const r = await recorder(h);
  const mid = vi.spyOn(h.lhc.threadView, "midTurnCompact");
  const settled = vi.spyOn(h.lhc.threadView, "compact");
  const answer = await answerCompact(r, { sessionId: SESSION, trigger: "auto", target: 10_000 }, () => {});
  expect(mid).toHaveBeenCalledOnce();
  expect(settled).not.toHaveBeenCalled();
  expect(answer.kind === "view" && answer.isMidTurn).toBe(true);
});

it("a recovered large open turn either reduces or falls back", async () => {
  const h = fresh();
  const script = new Script();
  script.prompt("read these files and continue working");
  script.turnStart("running");
  for (let index = 0; index < 4; index++) {
    script.step("running", index);
    script.answer({ type: "tool_use", id: `toolu_${index}`, name: "Read", input: { file_path: `${index}.txt` } });
    script.results(`toolu_${index}`);
    const row = script.lines.at(-1)!;
    (row.message as { content: Array<{ content: string }> }).content[0]!.content =
      "alpha beta gamma delta epsilon ".repeat(2_000);
  }
  writeTranscript(h, script.lines);
  const r = await recorder(h);
  await r.capture([{ kind: "step", sessionId: SESSION, turnId: "running", index: 4, at: Date.now() }]);
  const control = fresh();
  const live = await recorder(control);
  writeTranscript(control, script.lines);
  await live.capture(script.entries);
  const controlAnswer = await answerCompact(live, { sessionId: SESSION, trigger: "auto", target: 10_000 }, () => {});
  expect(controlAnswer.kind === "view" && controlAnswer.viewTokens).toBeLessThan(30_000);
  const sizes: number[] = [];
  for (let n = 0; n < 3; n++) {
    const answer = await answerCompact(r, { sessionId: SESSION, trigger: "auto", target: 10_000 }, () => {});
    if (answer.kind !== "view") return;
    sizes.push(answer.viewTokens);
    const from = script.entries.length;
    script.compactBoundary();
    script.installed(answer.messages);
    script.step("running", 4 + n);
    writeTranscript(h, script.lines);
    await r.capture(script.entries.slice(from));
  }
  expect(sizes.at(-1)).toBeLessThan(30_000);
});

it("a normal next prompt after an LHC install preserves the prior record", async () => {
  const h = fresh();
  const script = new Script();
  script.toolTurn("first", "first ask", "toolu_a");
  writeTranscript(h, script.lines);
  const r = await recorder(h);
  await r.capture(script.entries);
  const answer = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 10_000 }, () => {});
  if (answer.kind !== "view") throw new Error(answer.reason);
  const before = await messages(r);
  script.compactBoundary();
  script.installed(answer.messages);
  const start = script.entries.length;
  script.prompt("second ask");
  writeTranscript(h, script.lines);
  await r.capture(script.entries.slice(start));
  await r.recover();
  expect(h.log.filter((s) => s.includes("rollback"))).toEqual([]);
  expect(await messages(r)).toEqual([...before, "t2 user_prompt second ask"]);
});

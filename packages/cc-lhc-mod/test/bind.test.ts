import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { globalAgent } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { threads } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureEntry } from "../src/capture.ts";
import type { BuiltMessage } from "../src/compact.ts";
import { type Harness, harness, messages, Script, SESSION, type Served, serve } from "./fixture.ts";

const CLEARED = "22222222-2222-3333-4444-555555555555";
const FORK = "33333333-2222-3333-4444-555555555555";
const EARLIER_FORK = "44444444-2222-3333-4444-555555555555";
const OLDER = "55555555-2222-3333-4444-555555555555";

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

const transcriptOf = (sessionId: string): string => join(h.home, `${sessionId}.jsonl`);
const registryPath = (): string => join(h.home, "registry.sqlite");

function writeLines(sessionId: string, lines: ReadonlyArray<Record<string, unknown>>): void {
  writeFileSync(transcriptOf(sessionId), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

const as = (sessionId: string, entries: readonly CaptureEntry[]): CaptureEntry[] =>
  entries.map((entry) => ({ ...entry, sessionId }));

async function bind(sessionId: string, source: string): Promise<Record<string, unknown>> {
  const { status, json } = await s.call("/bind", { sessionId, transcriptPath: transcriptOf(sessionId), source });
  expect(status).toBe(200);
  return json;
}

async function capture(sessionId: string, entries: readonly CaptureEntry[]): Promise<Record<string, unknown>> {
  const { status, json } = await s.call("/capture", { entries: as(sessionId, entries) });
  expect(status).toBe(200);
  return json;
}

const history = (threadId: unknown): Promise<string[]> =>
  messages({ thread: { threadId: String(threadId), registryPath: registryPath() } });

/** Records one tool turn for a session and leaves its transcript on disk, as Claude Code would. */
async function turn(sessionId: string, script: Script, turnId: string, text: string): Promise<void> {
  const from = script.entries.length;
  script.toolTurn(turnId, text, `toolu_${turnId}`);
  writeLines(sessionId, script.lines);
  await capture(sessionId, script.entries.slice(from));
}

describe("bind", () => {
  it("starts a new thread on /clear and returns to the first on /resume", async () => {
    const first = await bind(SESSION, "startup");
    const original = new Script();
    await turn(SESSION, original, "a", "before clear");
    const cleared = await bind(CLEARED, "clear");
    await turn(CLEARED, new Script(), "b", "after clear");
    const resumed = await bind(SESSION, "resume");
    await turn(SESSION, original, "c", "after resume");

    expect(first).toMatchObject({ how: "new" });
    expect(cleared).toMatchObject({ how: "new" });
    expect(cleared.threadId).not.toBe(first.threadId);
    expect(resumed).toMatchObject({ how: "resumed", threadId: first.threadId });
    expect((await history(first.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt before clear",
      "t2 user_prompt after resume",
    ]);
    expect((await history(cleared.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt after clear",
    ]);
  });

  it("copies the source thread for a fork at its first row, and records only the fork's own rows into the copy", async () => {
    const source = await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "shared");
    const sourceHistory = await history(source.threadId);
    const lastLine = script.lines.at(-1)?.uuid ?? null;
    writeLines(EARLIER_FORK, [...script.lines, { uuid: randomUUID(), parentUuid: lastLine, type: "system" }]);

    const forked = await bind(FORK, "fork");
    expect(forked.threadId).toBeUndefined();
    const from = script.entries.length;
    script.toolTurn("b", "only in the fork", "toolu_b");
    writeLines(FORK, script.lines);
    const opened = await capture(FORK, script.entries.slice(from));

    expect(opened).toMatchObject({ how: "forked" });
    expect(opened.threadId).not.toBe(source.threadId);
    expect(await history(opened.threadId)).toEqual([
      ...sourceHistory,
      "t2 user_prompt only in the fork",
      "t2 tool_call toolu_b",
      "t2 tool_result toolu_b",
      "t2 assistant_text done b",
    ]);
    expect(await history(source.threadId)).toEqual(sourceHistory);
    await bind(CLEARED, "clear");
    expect(await bind(FORK, "resume")).toMatchObject({ how: "resumed", threadId: opened.threadId });
  });

  it("waits past a typed-ahead queue row for the first transcript row before copying a fork", async () => {
    const source = await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "shared");
    await bind(FORK, "fork");
    const from = script.entries.length;
    script.queued("typed ahead");
    script.toolTurn("b", "forked", "toolu_b");
    writeLines(FORK, script.lines);

    const opened = await capture(FORK, script.entries.slice(from));

    expect(opened).toMatchObject({ how: "forked" });
    expect(opened.threadId).not.toBe(source.threadId);
  });

  it("forks a source its process left mid-turn past Claude Code's own reply, ends that turn, and gives the fork's prompt its own turn", async () => {
    await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "finished");
    const from = script.entries.length;
    script.prompt("cut off");
    script.turnStart("b");
    script.step("b", 0);
    script.answer({ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "b" } });
    writeLines(SESSION, script.lines);
    await capture(SESSION, script.entries.slice(from));
    const copied = [...script.lines];

    await bind(FORK, "fork");
    // On resume Claude Code answers the cut-off turn itself, in the fork's transcript only.
    const synthetic = {
      uuid: randomUUID(),
      parentUuid: copied.at(-1)?.uuid ?? null,
      type: "assistant",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
    };
    const forked = new Script();
    forked.rewindTo(synthetic.uuid);
    forked.notification("<task-notification>job done</task-notification>");
    forked.toolTurn("c", "forked", "toolu_c");
    writeLines(FORK, [...copied, synthetic, ...forked.lines]);
    const opened = await capture(FORK, forked.entries);
    const exported = await threads.exportHistory({ threadId: String(opened.threadId), registryPath: registryPath() });
    if (!exported.ok) throw new Error(exported.error.reason);

    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt finished",
      "t2 user_prompt cut off",
      "t4 user_prompt forked",
    ]);
    expect(opened).toMatchObject({ how: "forked" });
    expect(exported.value.turns.map((turn) => `${turn.turnId} ${turn.status} ${turn.outcome}`)).toEqual([
      "t1 closed completed",
      "t2 closed aborted",
      "t3 closed null",
      "t4 closed completed",
      "t5 open null",
    ]);
  });

  it("keeps a forked session's running turn open across a sidecar restart in the same process", async () => {
    await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "source");
    await bind(FORK, "fork");
    const forked = new Script();
    forked.rewindTo(script.lines.at(-1)?.uuid as string);
    forked.toolTurn("b", "fork settled", "toolu_b");
    writeLines(FORK, [...script.lines, ...forked.lines]);
    await capture(FORK, forked.entries);
    const from = forked.entries.length;
    forked.prompt("fork running");
    forked.turnStart("c");
    forked.step("c", 0);
    forked.answer({ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "c" } });
    writeLines(FORK, [...script.lines, ...forked.lines]);
    await capture(FORK, forked.entries.slice(from));
    await s.close();
    globalAgent.destroy();
    s = await serve(h);

    await bind(FORK, "restart");

    expect(s.state.recording).toMatchObject({ kind: "recording" });
    expect(s.state.recording?.kind === "recording" && s.state.recording.recorder.isTurnOpen).toBe(true);
  });

  it("leaves out of the fork the view an LHC compact installed in the source", async () => {
    await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "first");
    await turn(SESSION, script, "b", "second");
    const compacted = await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000 });
    expect(compacted.json).toMatchObject({ kind: "view" });
    const from = script.entries.length;
    script.compactBoundary();
    script.installed(compacted.json.messages as BuiltMessage[]);
    writeLines(SESSION, script.lines);
    await capture(SESSION, script.entries.slice(from));
    const source = (await s.call("/health")).json.recording as { threadId: string };
    const sourceHistory = await history(source.threadId);

    await bind(FORK, "fork");
    const forkFrom = script.entries.length;
    script.toolTurn("c", "after the fork", "toolu_c");
    writeLines(FORK, script.lines);
    const opened = await capture(FORK, script.entries.slice(forkFrom));

    expect(opened).toMatchObject({ how: "forked" });
    expect((await history(opened.threadId)).slice(0, sourceHistory.length)).toEqual(sourceHistory);
    expect((await history(opened.threadId)).slice(sourceHistory.length)).toEqual([
      "t3 user_prompt after the fork",
      "t3 tool_call toolu_c",
      "t3 tool_result toolu_c",
      "t3 assistant_text done c",
    ]);
  });

  it("copies a source compacted twice and records neither installed view", async () => {
    const source = await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "only request");
    for (let round = 0; round < 2; round++) {
      const compacted = await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000 });
      const from = script.entries.length;
      script.compactBoundary();
      script.installed(compacted.json.messages as BuiltMessage[]);
      writeLines(SESSION, script.lines);
      await capture(SESSION, script.entries.slice(from));
    }
    const sourceHistory = await history(source.threadId);
    await bind(FORK, "fork");
    const from = script.entries.length;
    script.toolTurn("b", "forked", "toolu_b");
    writeLines(FORK, script.lines);

    const opened = await capture(FORK, script.entries.slice(from));

    expect(opened).toMatchObject({ how: "forked" });
    expect((await history(opened.threadId)).slice(0, sourceHistory.length)).toEqual(sourceHistory);
    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt only request",
      "t2 user_prompt forked",
    ]);
  });

  it("copies a compacted source its process left mid-turn, and keeps its installed view out", async () => {
    await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "first");
    await turn(SESSION, script, "b", "second");
    const compacted = await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000 });
    let from = script.entries.length;
    script.compactBoundary();
    script.installed(compacted.json.messages as BuiltMessage[]);
    script.prompt("third");
    script.turnStart("c");
    script.step("c", 0);
    script.answer({ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "c" } });
    writeLines(SESSION, script.lines);
    await capture(SESSION, script.entries.slice(from));

    await bind(FORK, "fork");
    from = script.entries.length;
    script.toolTurn("d", "after the fork", "toolu_d");
    writeLines(FORK, script.lines);
    const opened = await capture(FORK, script.entries.slice(from));

    expect(opened).toMatchObject({ how: "forked" });
    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt first",
      "t2 user_prompt second",
      "t3 user_prompt third",
      "t4 user_prompt after the fork",
    ]);
  });

  it("keeps a fork's first prompt in an open turn when no transcript holds its source rows", async () => {
    const script = new Script();
    script.toolTurn("a", "source gone", "toolu_a");
    const copied = [...script.lines];
    await bind(FORK, "fork");
    const from = script.entries.length;
    script.prompt("forked");
    script.turnStart("b");
    writeLines(FORK, script.lines);

    const opened = await capture(FORK, script.entries.slice(from));
    expect(s.state.recording?.kind === "recording" && s.state.recording.recorder.isTurnOpen).toBe(true);
    const next = script.entries.length;
    script.step("b", 0);
    script.answer({ type: "text", text: "done b" });
    script.turnEnd("b");
    writeLines(FORK, [...copied, ...script.lines.slice(copied.length)]);
    await capture(FORK, script.entries.slice(next));

    expect(opened).toMatchObject({ how: "new", notice: expect.stringContaining("no transcript holds") });
    const exported = await threads.exportHistory({ threadId: String(opened.threadId), registryPath: registryPath() });
    if (!exported.ok) throw new Error(exported.error.reason);
    expect(
      exported.value.turns.map(
        (turn) => `${turn.status} ${turn.outcome} ${turn.messages.map((m) => m.kind).join(",")}`,
      ),
    ).toEqual([
      "closed null user_prompt,tool_call,tool_result,assistant_text",
      "closed completed user_prompt,assistant_text",
      "open null ",
    ]);
  });

  it("records a fork whose source has no thread into a new thread, transcript and all", async () => {
    const script = new Script();
    script.toolTurn("a", "unrecorded", "toolu_a");
    writeLines(SESSION, script.lines);
    await bind(FORK, "fork");
    const from = script.entries.length;
    script.toolTurn("b", "forked", "toolu_b");
    writeLines(FORK, script.lines);

    const opened = await capture(FORK, script.entries.slice(from));

    expect(opened).toMatchObject({ how: "new", notice: expect.stringContaining("has no LHC thread") });
    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt unrecorded",
      "t2 user_prompt forked",
    ]);
  });

  it("fills into a fork's copy the source turns its thread missed, once each", async () => {
    const source = await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "recorded");
    script.toolTurn("b", "unrecorded", "toolu_b");
    script.prompt("interrupted before any response");
    script.system("turn_duration");
    writeLines(SESSION, script.lines);
    const sourceHistory = await history(source.threadId);
    await bind(FORK, "fork");
    const from = script.entries.length;
    script.toolTurn("c", "forked", "toolu_c");
    writeLines(FORK, script.lines);

    const opened = await capture(FORK, script.entries.slice(from));

    expect(opened).toMatchObject({ how: "forked" });
    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt recorded",
      "t2 user_prompt unrecorded",
      "t3 user_prompt interrupted before any response",
      "t4 user_prompt forked",
    ]);
    expect(await history(source.threadId)).toEqual(sourceHistory);
  });

  it("keeps a source's installed view out of a fork when the source went on past the fork point", async () => {
    await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "first");
    const compacted = await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000 });
    const from = script.entries.length;
    script.compactBoundary();
    script.installed(compacted.json.messages as BuiltMessage[]);
    writeLines(SESSION, script.lines);
    await capture(SESSION, script.entries.slice(from));
    const copied = [...script.lines];
    const forkPoint = script.lines.at(-1)?.uuid ?? null;
    await bind(FORK, "fork");
    script.toolTurn("b", "source went on", "toolu_b");
    writeLines(SESSION, script.lines);
    const forked = new Script();
    forked.rewindTo(forkPoint as string);
    forked.toolTurn("c", "forked", "toolu_c");
    writeLines(FORK, [...copied, ...forked.lines]);

    const opened = await capture(FORK, forked.entries);

    expect(opened).toMatchObject({ how: "new", notice: expect.stringContaining("went on past the fork point") });
    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt first",
      "t2 user_prompt forked",
    ]);
  });

  it("takes the receipt of the source that holds the nearest fork point, not an older session that ends farther back", async () => {
    await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "first");
    const compacted = await s.call("/compact", { sessionId: SESSION, trigger: "manual", target: 10_000 });
    const from = script.entries.length;
    script.compactBoundary();
    script.installed(compacted.json.messages as BuiltMessage[]);
    writeLines(SESSION, script.lines);
    await capture(SESSION, script.entries.slice(from));
    await turn(SESSION, script, "b", "second");
    writeLines(OLDER, script.lines);
    await turn(SESSION, script, "c", "third");
    const copied = [...script.lines];
    await bind(FORK, "fork");
    script.toolTurn("d", "source went on", "toolu_d");
    writeLines(SESSION, script.lines);
    const forked = new Script();
    forked.rewindTo(copied.at(-1)?.uuid as string);
    forked.toolTurn("e", "forked", "toolu_e");
    writeLines(FORK, [...copied, ...forked.lines]);

    const opened = await capture(FORK, forked.entries);

    expect(opened).toMatchObject({ how: "new", notice: expect.stringContaining(`source session ${SESSION} went on`) });
    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt first",
      "t2 user_prompt second",
      "t3 user_prompt third",
      "t4 user_prompt forked",
    ]);
  });

  it("copies a source whose last row is on a live branch after a rewind, and leaves the abandoned turn out", async () => {
    const source = await bind(SESSION, "startup");
    const script = new Script();
    await turn(SESSION, script, "a", "kept");
    const anchor = script.lines.at(-1)?.uuid as string;
    script.toolTurn("b", "abandoned", "toolu_b");
    script.rewindTo(anchor);
    script.system("informational");
    writeLines(SESSION, script.lines);
    await bind(FORK, "fork");
    const from = script.entries.length;
    script.toolTurn("c", "forked", "toolu_c");
    writeLines(FORK, script.lines);

    const opened = await capture(FORK, script.entries.slice(from));

    expect(opened).toMatchObject({ how: "forked" });
    expect(opened.threadId).not.toBe(source.threadId);
    expect((await history(opened.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt kept",
      "t2 user_prompt forked",
    ]);
  });

  it("refuses to adopt a thread with forced compact boundaries and records the session to a new thread", async () => {
    const first = await bind(SESSION, "startup");
    await turn(SESSION, new Script(), "a", "older host");
    await bind(CLEARED, "clear");
    await bind(SESSION, "resume");
    await bind(CLEARED, "clear");
    const found = await threads.resolve({ threadId: String(first.threadId), registryPath: registryPath() });
    if (!found.ok) throw new Error(found.error.reason);
    const db = new DatabaseSync(found.value.filePath);
    db.prepare(
      `INSERT INTO compact_continuation_boundary
         (continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at)
       VALUES ('t1', 'attempt', 'complete', 1, 'done', '2026-01-01T00:00:00Z')`,
    ).run();
    db.close();

    const resumed = await bind(SESSION, "resume");
    await bind(CLEARED, "clear");
    const again = await bind(SESSION, "resume");

    expect(resumed).toMatchObject({ how: "replaced", notice: expect.stringContaining("not adopted") });
    expect(resumed.threadId).not.toBe(first.threadId);
    expect(again).toMatchObject({ how: "resumed", threadId: resumed.threadId });
    expect((await history(resumed.threadId)).filter((line) => line.includes("user_prompt"))).toEqual([
      "t1 user_prompt older host",
    ]);
  });
});

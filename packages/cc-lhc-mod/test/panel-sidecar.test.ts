import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { answerCompact } from "../sidecar/src/compact.ts";
import { createSidecarServer, stopRecording } from "../sidecar/src/server.ts";
import type { Derivations } from "../src/panel.ts";
import { harness, recorder, Script, SESSION, writeTranscript } from "./fixture.ts";

const BIG = 40_000;

function bigTurns(script: Script, count: number): void {
  for (let n = 0; n < count; n++) {
    const turn = `turn-${n}`;
    const tool = `toolu_${n}`;
    script.prompt(`read part ${n}`);
    script.turnStart(turn);
    script.step(turn, 0);
    script.answer({ type: "tool_use", id: tool, name: "Read", input: { file_path: `part${n}.txt` } });
    script.resultsOf((id) => `${id} `.repeat(BIG / 8), tool);
    script.step(turn, 1);
    script.answer({ type: "text", text: `read part ${n}` });
    script.turnEnd(turn);
  }
}

it("prune shortens older tool output in the installed view and keeps the newest whole", async () => {
  const h = harness();
  try {
    const script = new Script();
    bigTurns(script, 6);
    writeTranscript(h, script.lines);
    const r = await recorder(h);
    await r.capture(script.entries);
    const answer = await answerCompact(
      r,
      { sessionId: SESSION, trigger: "manual", target: 10_000, op: "prune" },
      () => {},
    );
    if (answer.kind !== "view") throw new Error(answer.reason);
    const results = answer.messages.flatMap((message) => message.toolResults ?? []);
    expect(results).toHaveLength(6);
    expect(results[0]?.text.length).toBeLessThan(1000);
    expect(results.at(-1)?.text.length).toBeGreaterThan(BIG / 2);
    const resultTokens = results.reduce((sum, result) => sum + result.text.length / 4, 0);
    expect(answer.viewTokens).toBeGreaterThan(resultTokens);
    expect(answer.viewTokens).toBeLessThan(resultTokens * 1.2);
    expect(r.receipts.current?.expected).toHaveLength(answer.messages.length);
  } finally {
    h.cleanup();
  }
});

it("a prune whose view would not get below the trigger is refused before any receipt is begun", async () => {
  const h = harness();
  try {
    const script = new Script();
    bigTurns(script, 6);
    writeTranscript(h, script.lines);
    const r = await recorder(h);
    await r.capture(script.entries);
    const receipt = r.receipts.current;
    const guard = { trigger: 20_000, fixed: 15_000 };
    const answer = await answerCompact(
      r,
      { sessionId: SESSION, trigger: "manual", target: 10_000, op: "prune", guard },
      () => {},
    );
    expect(answer.kind).toBe("native");
    expect(answer.kind === "native" && answer.reason).toMatch(/would not get below the 20k trigger$/);
    expect(r.receipts.current).toEqual(receipt);
  } finally {
    h.cleanup();
  }
});

it("a prune with nothing to shorten leaves the context and the install receipt as they were", async () => {
  const h = harness();
  try {
    const script = new Script();
    script.toolTurn("turn-1", "list files", "toolu_ls");
    writeTranscript(h, script.lines);
    const r = await recorder(h);
    await r.capture(script.entries);
    const compacted = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 10_000 }, () => {});
    expect(compacted.kind).toBe("view");
    const receipt = r.receipts.current;
    const pruned = await answerCompact(
      r,
      { sessionId: SESSION, trigger: "manual", target: 10_000, op: "prune" },
      () => {},
    );
    expect(pruned).toEqual({ kind: "unchanged", reason: "no older tool output is left to shorten" });
    expect(r.receipts.current).toEqual(receipt);
  } finally {
    h.cleanup();
  }
});

const call = (socketPath: string, method: "GET" | "POST", path: string, body?: unknown) =>
  new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath, path, method }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

it("health reports derivation counts and export writes the thread's history under the LHC home", async () => {
  const h = harness();
  const { server, state } = createSidecarServer({
    lhc: h.lhc,
    home: h.home,
    ownerPid: process.pid,
    log: (line) => h.log.push(line),
  });
  const socket = join(h.home, "panel.sock");
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const script = new Script();
    script.toolTurn("turn-1", "list files", "toolu_ls");
    writeTranscript(h, script.lines);
    expect(
      (await call(socket, "POST", "/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "startup" }))
        .status,
    ).toBe(200);
    expect((await call(socket, "POST", "/capture", { entries: script.entries })).status).toBe(200);

    const { derivations } = (await call(socket, "GET", "/health")).json as { derivations: Derivations };
    expect(Object.keys(derivations).sort()).toEqual(["blocked", "failed", "pending", "ready"]);
    expect(derivations.ready + derivations.pending).toBeGreaterThan(0);

    const exported = await call(socket, "POST", "/export", { sessionId: SESSION });
    expect(exported.status).toBe(200);
    const { path, turns } = exported.json as { path: string; turns: number };
    expect(path.startsWith(join(h.home, "exports"))).toBe(true);
    expect(turns).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path, "utf8")).turns).toHaveLength(turns);

    expect((await call(socket, "POST", "/export", { sessionId: "other" })).status).toBe(400);
  } finally {
    stopRecording(state);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    h.cleanup();
  }
});

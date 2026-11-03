import { mkdirSync } from "node:fs";
import { request } from "node:http";
import { expect, it, vi } from "vitest";
import { createSidecarServer, stopRecording } from "../sidecar/src/server.ts";
import { harness, messages, Script, SESSION, writeTranscript } from "./fixture.ts";

it("a reload, then a delayed restart bind that recovers a later turn, keeps that turn whole", async () => {
  vi.resetModules();
  const wire = await import("../mod/hooks/sidecar.ts");
  const h = harness();
  const s = new Script();
  s.prompt("first");
  s.turnStart("a");
  s.step("a", 0);
  s.answer({ type: "tool_use", id: "a", name: "Bash", input: {} });
  writeTranscript(h, s.lines);
  const _ended = false;
  let hold = false;
  let sawHeld = false;
  let resume!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const traces: Array<{ path: string; body: unknown; status: number | undefined; reply: unknown }> = [];
  const children: Array<{ server: ReturnType<typeof createSidecarServer>; kill: () => void }> = [];
  const logs: string[] = [];
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("timed out");
  };
  const engine = {
    plugin: { root: "/unused" },
    env: { get: async (n: string) => (n === "LHC_HOME" ? h.home : undefined) },
    ui: { log: (s: string) => logs.push(s) },
    fs: { write: async () => {} },
    state: { set: async () => {} },
    clock: { sleep: async () => new Promise((r) => setTimeout(r, 5)) },
    process: {
      spawn: async function* ({ argv }: { argv: string[] }) {
        const id = argv[argv.indexOf("--id") + 1];
        mkdirSync(`${h.home}/run`, { recursive: true });
        const sock = `${h.home}/run/${id}.sock`;
        const server = createSidecarServer({
          lhc: h.lhc,
          home: h.home,
          ownerPid: process.pid,
          log: (x) => h.log.push(x),
        });
        let kill!: () => void;
        const death = new Promise<void>((r) => (kill = r));
        children.push({ server, kill });
        await new Promise<void>((r) => server.server.listen(sock, r));
        yield { stream: "stdout", text: `listening ${sock}\n` };
        await death;
        await new Promise<void>((r) => server.server.close(() => r()));
      },
    },
    http: {
      fetch: async (url: string, init: { body: string; method: string; socketPath: string }) => {
        const path = new URL(url).pathname,
          body = JSON.parse(init.body);
        if (path === "/bind" && body.source === "restart" && hold) {
          sawHeld = true;
          await gate;
        }
        return await new Promise((resolve, reject) => {
          const req = request({ socketPath: init.socketPath, path, method: init.method, agent: false }, (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => {
              traces.push({ path, body, status: res.statusCode, reply: JSON.parse(text) });
              resolve({ status: res.statusCode, ok: res.statusCode === 200, text });
            });
          });
          req.on("error", reject);
          req.end(init.body);
        });
      },
    },
  };
  // The mod talks to Claude Code only through these few calls; the rest of its engine is not needed here.
  const $ = engine as unknown as Parameters<typeof wire.bind>[0];
  try {
    wire.bind($, { sessionId: SESSION, transcriptPath: h.transcript, source: "reload" });
    await wait(() => traces.some((x) => x.path === "/bind"));

    children[0].kill();
    await wait(() => logs.includes("sidecar exited"));
    hold = true;
    const n = s.entries.length;
    s.results("a");
    s.step("a", 1);
    s.answer({ type: "text", text: "done a" });
    s.turnEnd("a");
    writeTranscript(h, s.lines);
    const replay = s.entries.slice(n);
    for (const e of replay) wire.enqueue($, e);
    await wait(() => sawHeld);
    const k = s.entries.length;
    s.prompt("second");
    s.turnStart("b");
    s.step("b", 0);
    s.answer({ type: "tool_use", id: "b", name: "Bash", input: {} });
    s.results("b");
    writeTranscript(h, s.lines);
    for (const e of s.entries.slice(k)) wire.enqueue($, e);
    // Model work and transcript append continue while the sidecar's bind/recovery is delayed.
    resume();
    let drained = false;
    wire.runInBackground($, "drain", async () => {
      drained = true;
    });
    await wait(() => drained);
    const current = children[1].server.state.recording;
    if (current?.kind !== "recording") throw Error("not recording");
    const j = s.entries.length;
    s.step("b", 1);
    s.answer({ type: "text", text: "done b" });
    s.turnEnd("b");
    writeTranscript(h, s.lines);
    for (const e of s.entries.slice(j)) wire.enqueue($, e);
    drained = false;
    wire.runInBackground($, "drain", async () => {
      drained = true;
    });
    await wait(() => drained);
    const got = await messages(current.recorder);
    expect(got).toContain("t2 assistant_text done b");
  } finally {
    resume();
    for (const c of children) {
      stopRecording(c.server.state);
      c.kill();
    }
    await new Promise((r) => setTimeout(r, 30));
    h.cleanup();
  }
}, 10000);

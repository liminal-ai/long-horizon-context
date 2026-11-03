import { request } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSidecarServer, stopRecording } from "../sidecar/src/server.ts";
import { harness, Script, SESSION, writeTranscript } from "./fixture.ts";

const call = (socketPath: string, path: string, body: unknown) =>
  new Promise<{ status: number; json: { recorded?: number } }>((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST" }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
async function serverTest(
  fn: (
    h: ReturnType<typeof harness>,
    socket: string,
    state: ReturnType<typeof createSidecarServer>["state"],
  ) => Promise<void>,
) {
  const h = harness();
  const { server, state } = createSidecarServer({
    lhc: h.lhc,
    home: h.home,
    ownerPid: process.pid,
    log: (l) => h.log.push(l),
  });
  const socket = join(h.home, "audit.sock");
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await fn(h, socket, state);
  } finally {
    stopRecording(state);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    h.cleanup();
  }
}
it("round2 server: foreign and mixed session capture returns 400 and own resend commits once", async () =>
  serverTest(async (h, socket, _state) => {
    expect(
      (await call(socket, "/bind", { sessionId: SESSION, transcriptPath: h.transcript, source: "startup" })).status,
    ).toBe(200);
    const s = new Script();
    s.toolTurn("a", "own", "a");
    writeTranscript(h, s.lines);
    const wrong = { ...s.entries[0], sessionId: "wrong" };
    expect((await call(socket, "/capture", { entries: [wrong] })).status).toBe(400);
    expect((await call(socket, "/capture", { entries: [s.entries[0], wrong] })).status).toBe(400);
    expect((await call(socket, "/capture", { entries: s.entries })).json.recorded).toBe(5);
    expect((await call(socket, "/capture", { entries: s.entries })).json.recorded).toBe(0);
  }));
it("round2 server: a recovery 400 must not let the uninitialized replacement acknowledge later rows", async () =>
  serverTest(async (h, socket, state) => {
    const s = new Script();
    s.toolTurn("a", "recovered prompt", "a");
    writeTranscript(h, s.lines);
    const intake = h.lhc.intakeStream.messageEvents;
    let fails = 1;
    h.lhc.intakeStream.messageEvents = ((...args: Parameters<typeof intake>) =>
      fails-- > 0
        ? Promise.resolve({ ok: false, error: { code: "storage_error", reason: "injected single recovery failure" } })
        : intake(...args)) as typeof intake;
    const binding = { sessionId: SESSION, transcriptPath: h.transcript, source: "restart" };
    const bound = await call(socket, "/bind", binding);
    expect(bound.status).toBe(400);
    expect(state.recording).toBeNull();
    const captured = await call(socket, "/capture", { entries: s.entries });

    expect(captured.status).not.toBe(200);
  }));

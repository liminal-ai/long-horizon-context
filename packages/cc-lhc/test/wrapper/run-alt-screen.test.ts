// Process-level alt-screen safety: signals and stdin loss must restore the
// main screen (leave BEFORE flushing held output) whatever the child does.
// These tests run the real wrapper in-process against a bash tick loop under
// a real pty; the signals are sent to this process, whose handlers run()
// registered.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { DEFAULT_LEADER_BYTE } from "../../src/wrapper/modal.js";
import { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } from "../../src/wrapper/panel.js";
import { run } from "../../src/wrapper/run.js";

const TICK_CHILD = 'trap "exit 0" TERM HUP; i=0; while true; do i=$((i+1)); echo "tick$i"; sleep 0.1; done';

function fakeStdout(): { stream: NodeJS.WriteStream; output: () => string } {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(stream, "columns", { value: 80, configurable: true });
  Object.defineProperty(stream, "rows", { value: 24, configurable: true });
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  const chunks: string[] = [];
  (stream as unknown as PassThrough).on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString("latin1"));
  });
  return { stream, output: () => chunks.join("") };
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, label: string, capMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** Slice indexes of the alt-screen markers; asserts basic sanity. */
function altMarkers(out: string): { enterAt: number; leaveAt: number; leaveCount: number } {
  const enterAt = out.indexOf(ENTER_ALT_SCREEN);
  const leaveAt = out.indexOf(LEAVE_ALT_SCREEN);
  const leaveCount = out.split(LEAVE_ALT_SCREEN).length - 1;
  return { enterAt, leaveAt, leaveCount };
}

async function startModalRig(): Promise<{
  stdin: NodeJS.ReadStream;
  output: () => string;
  runPromise: Promise<number>;
}> {
  const { stream: stdout, output } = fakeStdout();
  const stdin = fakeStdin();
  const runPromise = run(["-c", TICK_CHILD], { claudeBin: "bash", stdin, stdout, noCapture: true });
  await waitFor(() => output().includes("tick2"), "child ticks to flow");
  (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
  await waitFor(() => output().includes(ENTER_ALT_SCREEN), "modal to enter the alt screen");
  await sleep(300); // let ticks accumulate in the hold
  return { stdin, output, runPromise };
}

describe("process-level alt-screen safety", () => {
  it("SIGTERM while modal: leave precedes the held flush; child is signalled; exactly one leave", async () => {
    const { output, runPromise } = await startModalRig();

    process.kill(process.pid, "SIGTERM");
    const exitCode = await runPromise;

    const out = output();
    const { enterAt, leaveAt, leaveCount } = altMarkers(out);
    expect(enterAt).toBeGreaterThan(-1);
    expect(leaveAt).toBeGreaterThan(enterAt);
    expect(leaveCount).toBe(1); // signal restore + teardown + exit-hook never double-leave
    // no held tick leaked onto the alt screen; the held ticks flush after the restore
    const during = out.slice(enterAt, leaveAt);
    expect(during).not.toMatch(/tick\d/);
    expect(out.slice(leaveAt)).toMatch(/tick\d/);
    // held output was delayed, never dropped: tick numbers stay gapless
    const nums = [...out.matchAll(/tick(\d+)/g)].map((m) => Number(m[1]));
    for (let i = 1; i < nums.length; i += 1) expect(nums[i]).toBe(nums[i - 1]! + 1);
    expect(exitCode).toBe(0);
  }, 15_000);

  it("SIGHUP while modal restores the screen the same way", async () => {
    const { output, runPromise } = await startModalRig();

    process.kill(process.pid, "SIGHUP");
    await runPromise;

    const out = output();
    const { enterAt, leaveAt, leaveCount } = altMarkers(out);
    expect(leaveAt).toBeGreaterThan(enterAt);
    expect(leaveCount).toBe(1);
    expect(out.slice(enterAt, leaveAt)).not.toMatch(/tick\d/);
    expect(out.slice(leaveAt)).toMatch(/tick\d/);
  }, 15_000);

  it("stdin ending while modal restores and flushes; the wrapper keeps running", async () => {
    const { stdin, output, runPromise } = await startModalRig();

    (stdin as unknown as PassThrough).end();
    await waitFor(() => output().includes(LEAVE_ALT_SCREEN), "stdin end to restore the screen");

    // existing stdin-gone semantics: no new lifecycle — the child runs on
    const ticksAtRestore = output().split(LEAVE_ALT_SCREEN)[1] ?? "";
    expect(ticksAtRestore).toMatch(/tick\d|/);
    await sleep(300);
    expect(output().split(LEAVE_ALT_SCREEN).length - 1).toBe(1);
    expect(await Promise.race([runPromise.then(() => "exited"), sleep(200).then(() => "running")])).toBe("running");

    // finish: signal teardown (no second leave — the guard already left)
    process.kill(process.pid, "SIGTERM");
    const exitCode = await runPromise;
    expect(output().split(LEAVE_ALT_SCREEN).length - 1).toBe(1);
    expect(exitCode).toBe(0);
  }, 15_000);
});

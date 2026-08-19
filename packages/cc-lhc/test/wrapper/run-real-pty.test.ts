/**
 * Real PTY transport gate — runs on EVERY platform, including native Windows.
 *
 * run.test.ts proves the wrapper's above-PTY behavior through a pipe-backed
 * seam; this file closes the native transport gap it leaves: run() driving
 * the real @lydell/node-pty (ConPTY on Windows) with an ABSOLUTE native
 * executable — the same production spawn contract the Windows claude-bin
 * resolver guarantees. CI runners have no Claude, so this proves resolver
 * contract + transport, not a real Claude launch (that remains the XP4
 * real-machine smoke). No POSIX signals: the child ends the run by exiting.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { run } from "../../src/wrapper/run.js";

function fakeStdout(cols: number, rows: number): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(stream, "columns", { value: cols, configurable: true });
  Object.defineProperty(stream, "rows", { value: rows, configurable: true });
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

describe("run() over the real platform PTY (no spawnPty seam)", () => {
  it("spawns an absolute native executable, forwards its bytes, and propagates its exit code", async () => {
    // Wide columns so the marker can never be reflowed across lines by ConPTY.
    const stdout = fakeStdout(200, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("latin1"));
    });

    const exitCode = await run(
      ["-e", "process.stdout.write('pty-transport-ok'); setTimeout(() => process.exit(7), 50);"],
      {
        // process.execPath is an absolute native executable on every platform
        // (node.exe on Windows) — exactly what resolveClaudeBin guarantees
        // production hands to node-pty.
        claudeBin: process.execPath,
        stdin,
        stdout,
        unboundTestChild: true,
      },
    );

    expect(output.join("")).toContain("pty-transport-ok");
    expect(exitCode).toBe(7);
  }, 30_000);
});

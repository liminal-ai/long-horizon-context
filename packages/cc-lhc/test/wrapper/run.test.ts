import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onTerminalResize, resizePty, run } from "../../src/wrapper/run.js";

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

describe("resizePty", () => {
  it("calls pty.resize with the given dimensions", () => {
    const resize = vi.fn();
    resizePty({ resize }, 120, 40);
    expect(resize).toHaveBeenCalledWith(120, 40);
  });
});

describe("onTerminalResize", () => {
  it("reads cols/rows from stdout", () => {
    const resize = vi.fn();
    const stdout = fakeStdout(100, 30);
    onTerminalResize({ resize }, stdout);
    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it("falls back when stdout has no dimensions", () => {
    const resize = vi.fn();
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    onTerminalResize({ resize }, stdout);
    expect(resize).toHaveBeenCalledWith(80, 24);
  });
});

describe("run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards stub child stdout and propagates exit code", async () => {
    const stdout = fakeStdout(80, 24);
    const stdin = fakeStdin();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString());
    });

    const exitCode = await run(["-c", "echo hello; exit 3"], {
      claudeBin: "bash",
      stdin,
      stdout,
      noCapture: true,
    });

    expect(output.join("")).toContain("hello");
    expect(exitCode).toBe(3);
  });
});

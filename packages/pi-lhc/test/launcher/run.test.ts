import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { createDeterministicInferenceCallbacks } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPrintLikeMode, preparePrintPrompt, resolveAppMode, toPrintOutputMode } from "../../src/launcher/app-mode.js";
import { unsupportedLauncherFlagError } from "../../src/launcher/unsupported-flags.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

const runPrintModeMock = vi.hoisted(() => vi.fn<typeof piCodingAgent.runPrintMode>().mockResolvedValue(0));
const createAgentSessionRuntimeMock = vi.hoisted(() =>
  vi.fn<typeof piCodingAgent.createAgentSessionRuntime>().mockResolvedValue({
    session: { model: { provider: "openai", id: "gpt-4o" } },
    diagnostics: [],
  } as never),
);

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof piCodingAgent>();
  return {
    ...actual,
    runPrintMode: runPrintModeMock,
    createAgentSessionRuntime: createAgentSessionRuntimeMock,
  };
});

const { runPiLhcLauncher } = await import("../../src/launcher/run.js");

let store: TempStore;

function withInteractiveTty<T>(run: () => T): T {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    return run();
  } finally {
    if (stdinDescriptor !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    }
    if (stdoutDescriptor !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    }
  }
}

beforeEach(() => {
  store = tempStore();
  runPrintModeMock.mockClear();
  createAgentSessionRuntimeMock.mockClear();
  createAgentSessionRuntimeMock.mockResolvedValue({
    session: { model: { provider: "openai", id: "gpt-4o" } },
    diagnostics: [],
  } as never);
  runPrintModeMock.mockResolvedValue(0);
});
afterEach(() => {
  store.cleanup();
  vi.restoreAllMocks();
});

describe("runPiLhcLauncher", () => {
  it("returns 0 and prints help without launching runtime", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const code = await runPiLhcLauncher(["--help"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("--lhc-thread");
    expect(logs.join("\n")).toContain("--print");
    logSpy.mockRestore();
  });

  it("returns 0 and prints models for --list-models", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const code = await runPiLhcLauncher(["--list-models", "nova-lite"]);

    expect(code).toBe(0);
    expect(logs.some((line) => line.includes("/") && line.toLowerCase().includes("nova-lite"))).toBe(true);
    logSpy.mockRestore();
  });

  it("fails loud for blocked PI session-source flags", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    expect(await runPiLhcLauncher(["--session", "abc"])).toBe(1);
    expect(errors.join("\n")).toContain("--session");

    errors.length = 0;
    expect(await runPiLhcLauncher(["--resume"])).toBe(1);
    expect(errors.join("\n")).toContain("--resume");

    errorSpy.mockRestore();
  });

  it("fails loud for deferred unsupported PI options", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    expect(await runPiLhcLauncher(["--models", "sonnet"])).toBe(1);
    expect(errors.join("\n")).toContain("--models");

    errors.length = 0;
    expect(await runPiLhcLauncher(["--mode", "rpc"])).toBe(1);
    expect(errors.join("\n")).toContain("--mode rpc");

    errors.length = 0;
    expect(await runPiLhcLauncher(["--export", "out.html"])).toBe(1);
    expect(errors.join("\n")).toContain("--export");

    errors.length = 0;
    withInteractiveTty(() => {
      expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["hello"]))).toContain("positional prompt");
    });
    expect(
      await withInteractiveTty(async () =>
        runPiLhcLauncher(["hello"], { newThreadFilePath: () => store.threadPath() }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain("positional prompt");

    errors.length = 0;
    expect(await runPiLhcLauncher(["--print", "@prompt.md"])).toBe(1);
    expect(errors.join("\n")).toContain("@file");

    errors.length = 0;
    expect(await runPiLhcLauncher(["--no-session"])).toBe(1);
    expect(errors.join("\n")).toContain("--no-session");

    errorSpy.mockRestore();
  });

  it("runs text print mode through PI runPrintMode", async () => {
    const created = await makeTempThread(store);

    const code = await runPiLhcLauncher(["--lhc-thread", created.threadId, "--print", "summarize"], {
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => ({
        inferenceCallbacks: createDeterministicInferenceCallbacks(),
        mode: "background",
      }),
    });

    expect(code).toBe(0);
    expect(runPrintModeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "text",
        initialMessage: "summarize",
        messages: [],
      }),
    );
  });

  it("runs json print mode through PI runPrintMode", async () => {
    const created = await makeTempThread(store);

    const code = await runPiLhcLauncher(["--lhc-thread", created.threadId, "--mode", "json", "first", "second"], {
      registryPath: store.registryPath,
      newThreadFilePath: () => store.threadPath(),
      buildSdkConfig: () => ({
        inferenceCallbacks: createDeterministicInferenceCallbacks(),
        mode: "background",
      }),
    });

    expect(code).toBe(0);
    expect(runPrintModeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "json",
        initialMessage: "first",
        messages: ["second"],
      }),
    );
  });
});

describe("unsupportedLauncherFlagError", () => {
  it("detects each deferred flag independently", () => {
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["--models", "x"]))).toContain("--models");
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["--mode", "rpc"]))).toContain("--mode rpc");
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["--export", "x"]))).toContain("--export");
    withInteractiveTty(() => {
      expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["hi"]))).toContain("positional");
    });
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["@x"]))).toContain("@file");
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["--no-session"]))).toContain("--no-session");
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["--model", "x"]))).toBeNull();
  });

  it("allows print and json mode with positional prompts", () => {
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["--print", "hello"]))).toBeNull();
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["-p", "hello"]))).toBeNull();
    expect(unsupportedLauncherFlagError(piCodingAgent.parseArgs(["--mode", "json", "hello"]))).toBeNull();
  });
});

describe("launcher app mode", () => {
  it("resolves print and json modes like PI main", () => {
    const printParsed = piCodingAgent.parseArgs(["--print", "hello"]);
    expect(resolveAppMode(printParsed, true, true)).toBe("print");
    expect(toPrintOutputMode("print")).toBe("text");

    const jsonParsed = piCodingAgent.parseArgs(["--mode", "json", "hello"]);
    expect(resolveAppMode(jsonParsed, true, true)).toBe("json");
    expect(toPrintOutputMode("json")).toBe("json");
    expect(isPrintLikeMode(jsonParsed, true, true)).toBe(true);
  });

  it("preparePrintPrompt merges stdin and positional messages", () => {
    const parsed = piCodingAgent.parseArgs(["--print", "tail"]);
    expect(preparePrintPrompt(parsed, "stdin\n")).toEqual({
      initialMessage: "stdin\ntail",
      messages: [],
    });
    expect(preparePrintPrompt(piCodingAgent.parseArgs(["--print", "one", "two"]))).toEqual({
      initialMessage: "one",
      messages: ["two"],
    });
  });
});

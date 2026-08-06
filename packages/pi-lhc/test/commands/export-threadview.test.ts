import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpResult, ThreadRef } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleExportThreadview } from "../../src/commands/export-threadview.js";
import { createConnector, LHC_EXPORT_THREADVIEW_COMMAND } from "../../src/index.js";
import type { ExtensionAPI, ExtensionCommandContext } from "../../src/pi/types.js";
import type { LhcInstance } from "../../src/shared/instance.js";

function threadRef(): ThreadRef {
  return { threadId: "th_0000000000000001", registryPath: "/tmp/registry" };
}

function mockCtx(cwd: string): {
  ctx: ExtensionCommandContext;
  notifications: Array<{ message: string; type?: string }>;
} {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx: ExtensionCommandContext = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message, type) => {
        notifications.push({ message, ...(type === undefined ? {} : { type }) });
      },
    },
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    sessionManager: { getEntries: () => [] },
    waitForIdle: async () => {},
    newSession: vi.fn(),
  };
  return { ctx, notifications };
}

function mockInstance(
  messages: OpResult<{
    threadId: string;
    messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }>;
  }>,
) {
  const getLlmRequestContext = vi.fn(async () => messages);
  const instance = {
    sdk: {
      threadView: {
        getLlmRequestContext,
      },
    },
    threadRef: threadRef(),
    dispose: async () => ({ ok: true as const, value: undefined }),
  } as unknown as LhcInstance;
  return { instance, getLlmRequestContext };
}

describe("handleExportThreadview", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it("notifies error when no LHC thread is attached", async () => {
    workDir = mkdtempSync(join(tmpdir(), "pi-lhc-export-threadview-"));
    const { ctx, notifications } = mockCtx(workDir);
    const { instance } = mockInstance({ ok: true, value: { threadId: "t1", messages: [] } });

    await handleExportThreadview(ctx, null, instance);
    expect(notifications).toEqual([{ message: "pi-lhc: no active LHC thread", type: "error" }]);
    expect(readdirSync(workDir)).toEqual([]);

    notifications.length = 0;
    await handleExportThreadview(ctx, threadRef(), null);
    expect(notifications).toEqual([{ message: "pi-lhc: no active LHC thread", type: "error" }]);
  });

  it("writes lhc-threadview file with shared serializer output", async () => {
    workDir = mkdtempSync(join(tmpdir(), "pi-lhc-export-threadview-"));
    const { ctx, notifications } = mockCtx(workDir);
    const ref = threadRef();
    const { instance } = mockInstance({
      ok: true,
      value: {
        threadId: "t1",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "world" }] },
        ],
      },
    });

    await handleExportThreadview(ctx, ref, instance);

    const files = readdirSync(workDir).filter((name) => name.startsWith("lhc-threadview-"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(workDir, files[0] ?? ""), "utf8")).toBe("[user]\nhello\n\n[assistant]\nworld\n");
    expect(notifications[0]?.message).toMatch(/^pi-lhc: thread view written to lhc-threadview-/);
    expect(notifications[0]?.type).toBe("info");
  });
});

describe(`/${LHC_EXPORT_THREADVIEW_COMMAND} command`, () => {
  it("registers dispatch by name and fails without an attached thread", async () => {
    let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const connector = createConnector({
      readLaunchFlags: () => ({ ok: true, value: {} }),
      startupValidationReporter: () => {},
    });
    const pi = {
      on: () => {},
      registerCommand: (name: string, options: { handler: typeof commandHandler }) => {
        if (name === LHC_EXPORT_THREADVIEW_COMMAND) commandHandler = options.handler;
      },
      registerTool: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      appendEntry: () => {},
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => {},
      setModel: async () => true,
    } as ExtensionAPI;

    connector.register(pi);
    expect(commandHandler).toBeDefined();
    if (commandHandler === undefined) return;

    const notifications: Array<{ message: string; type?: string }> = [];
    await commandHandler("", {
      cwd: "/work/export-threadview",
      hasUI: true,
      ui: {
        notify: (message, type) => {
          notifications.push({ message, ...(type === undefined ? {} : { type }) });
        },
      },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
      sessionManager: { getEntries: () => [] },
      waitForIdle: async () => {},
      newSession: vi.fn(),
    });

    expect(notifications).toEqual([{ message: "pi-lhc: no active LHC thread", type: "error" }]);
  });
});

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleExportPiSession } from "../../src/commands/export-pi-session.js";
import { createConnector, LHC_EXPORT_PI_SESSION_COMMAND } from "../../src/index.js";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "../../src/pi/types.js";
import { makeAssistantMessage, makeUserMessage } from "../fixtures/synthetic.js";

function mockCtx(
  cwd: string,
  entries: SessionEntry[],
): {
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
    sessionManager: { getEntries: () => entries },
    waitForIdle: async () => {},
    newSession: vi.fn(),
  };
  return { ctx, notifications };
}

describe("handleExportPiSession", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it("writes lhc-pi-session file from live SessionManager entries", async () => {
    workDir = mkdtempSync(join(tmpdir(), "pi-lhc-export-pi-session-"));
    const entries: SessionEntry[] = [
      { type: "message", id: "m1", message: makeUserMessage("before resume") },
      { type: "thinking_level_change", id: "t1", thinkingLevel: "high" },
      { type: "message", id: "m2", message: makeAssistantMessage({ text: "after resume" }) },
    ];
    const { ctx, notifications } = mockCtx(workDir, entries);

    await handleExportPiSession(ctx);

    const files = readdirSync(workDir).filter((name) => name.startsWith("lhc-pi-session-"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(workDir, files[0] ?? ""), "utf8")).toBe(
      "[user]\nbefore resume\n\n[assistant]\nafter resume\n",
    );
    expect(notifications[0]?.message).toMatch(/^pi-lhc: PI session written to lhc-pi-session-/);
    expect(notifications[0]?.type).toBe("info");
  });

  it("writes an empty export when the session has no message entries", async () => {
    workDir = mkdtempSync(join(tmpdir(), "pi-lhc-export-pi-session-"));
    const { ctx } = mockCtx(workDir, [{ type: "custom", id: "c1", customType: "pi-lhc.thread", data: {} }]);

    await handleExportPiSession(ctx);

    const files = readdirSync(workDir).filter((name) => name.startsWith("lhc-pi-session-"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(workDir, files[0] ?? ""), "utf8")).toBe("");
  });
});

describe(`/${LHC_EXPORT_PI_SESSION_COMMAND} command`, () => {
  it("registers dispatch by name and writes from ctx.sessionManager without an LHC thread", async () => {
    let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const connector = createConnector({
      readLaunchFlags: () => ({ ok: true, value: {} }),
      startupValidationReporter: () => {},
    });
    const pi = {
      on: () => {},
      registerCommand: (name: string, options: { handler: typeof commandHandler }) => {
        if (name === LHC_EXPORT_PI_SESSION_COMMAND) commandHandler = options.handler;
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

    const workDir = mkdtempSync(join(tmpdir(), "pi-lhc-export-pi-session-cmd-"));
    try {
      const entries: SessionEntry[] = [{ type: "message", id: "m1", message: makeUserMessage("live") }];
      const notifications: Array<{ message: string; type?: string }> = [];
      await commandHandler("", {
        cwd: workDir,
        hasUI: true,
        ui: {
          notify: (message, type) => {
            notifications.push({ message, ...(type === undefined ? {} : { type }) });
          },
        },
        modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
        sessionManager: { getEntries: () => entries },
        waitForIdle: async () => {},
        newSession: vi.fn(),
      });

      const files = readdirSync(workDir).filter((name) => name.startsWith("lhc-pi-session-"));
      expect(files).toHaveLength(1);
      expect(readFileSync(join(workDir, files[0] ?? ""), "utf8")).toBe("[user]\nlive\n");
      expect(notifications[0]?.type).toBe("info");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

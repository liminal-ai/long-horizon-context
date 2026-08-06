import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSessionRuntimeDiagnostic,
  ModelRuntime,
  parseArgs,
  SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLauncherRuntimeFactory, type LauncherSessionCreateOptions } from "../../src/launcher/runtime-factory.js";

describe("launcher runtime factory CLI flags", () => {
  const cleanups: Array<() => void> = [];
  let tempDir: string;

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  async function createTestModelRuntime(): Promise<ModelRuntime> {
    return ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
  }

  async function runFactory(
    argv: string[],
    options: {
      modelRuntime?: ModelRuntime;
      observe?: (options: LauncherSessionCreateOptions) => void;
      observeSettingsManager?: (settingsManager: SettingsManager) => void;
    } = {},
  ) {
    tempDir = join(tmpdir(), `pi-lhc-factory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    cleanups.push(() => {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    });

    const observed: LauncherSessionCreateOptions[] = [];
    const modelRuntime = options.modelRuntime ?? (await createTestModelRuntime());
    const factory = createLauncherRuntimeFactory({
      modelRuntime,
      extensionFlagValues: new Map(),
      extensionFactories: [],
      parsed: parseArgs(argv),
      observeSessionOptions: (sessionOptions) => {
        observed.push(sessionOptions);
        options.observe?.(sessionOptions);
      },
      ...(options.observeSettingsManager === undefined
        ? {}
        : { observeSettingsManager: options.observeSettingsManager }),
    });

    const result = await factory({
      cwd: tempDir,
      agentDir: tempDir,
      sessionManager: SessionManager.inMemory(tempDir),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });

    return {
      sessionOptions: observed.at(-1),
      diagnostics: result.diagnostics,
      sessionManager: result.session,
      modelRuntime,
    };
  }

  function errorMessages(diagnostics: AgentSessionRuntimeDiagnostic[]): string {
    return diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => diagnostic.message)
      .join("\n");
  }

  it("forwards provider, model, thinking, tools, excludeTools, and noTools into session creation", async () => {
    const { sessionOptions } = await runFactory([
      "--provider",
      "amazon-bedrock",
      "--model",
      "amazon.nova-lite-v1:0",
      "--thinking",
      "high",
      "--tools",
      "read,bash",
      "--exclude-tools",
      "write",
      "--no-tools",
    ]);

    expect(sessionOptions).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          provider: "amazon-bedrock",
          id: "amazon.nova-lite-v1:0",
        }),
        thinkingLevel: "high",
        tools: ["read", "bash"],
        excludeTools: ["write"],
        noTools: "all",
      }),
    );
  });

  it("forwards noBuiltinTools as noTools builtin", async () => {
    const { sessionOptions } = await runFactory([
      "--provider",
      "amazon-bedrock",
      "--model",
      "amazon.nova-lite-v1:0",
      "--no-builtin-tools",
    ]);

    expect(sessionOptions).toEqual(
      expect.objectContaining({
        noTools: "builtin",
      }),
    );
  });

  it("sets runtime api key when model is resolved", async () => {
    const modelRuntime = await createTestModelRuntime();
    const setKey = vi.spyOn(modelRuntime, "setRuntimeApiKey");

    await runFactory(["--provider", "amazon-bedrock", "--model", "amazon.nova-lite-v1:0", "--api-key", "test-key"], {
      modelRuntime,
    });

    expect(setKey).toHaveBeenCalledWith("amazon-bedrock", "test-key");
    setKey.mockRestore();
  });

  it("errors when --api-key is provided without a model", async () => {
    const { diagnostics } = await runFactory(["--api-key", "test-key"]);

    expect(errorMessages(diagnostics)).toContain("--api-key requires a model");
  });

  it("appends session name once and rejects blank --name", async () => {
    const sessionManager = SessionManager.inMemory(join(tmpdir(), `pi-lhc-name-${Date.now()}`));
    const appendSpy = vi.spyOn(sessionManager, "appendSessionInfo");

    const factory = createLauncherRuntimeFactory({
      modelRuntime: await createTestModelRuntime(),
      extensionFlagValues: new Map(),
      extensionFactories: [],
      parsed: parseArgs(["--name", "my-thread"]),
    });
    await factory({
      cwd: sessionManager.getCwd(),
      agentDir: sessionManager.getCwd(),
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith("my-thread");
    appendSpy.mockRestore();

    const blank = await runFactory([
      "--provider",
      "amazon-bedrock",
      "--model",
      "amazon.nova-lite-v1:0",
      "--name",
      "  ",
    ]);
    expect(errorMessages(blank.diagnostics)).toContain("--name requires a non-empty value");
  });

  it("applies system prompt and project trust flags from argv", async () => {
    let trusted: boolean | undefined;
    const { sessionManager } = await runFactory(
      [
        "--provider",
        "amazon-bedrock",
        "--model",
        "amazon.nova-lite-v1:0",
        "--system-prompt",
        "custom prompt",
        "--append-system-prompt",
        "extra",
        "--no-extensions",
        "--approve",
      ],
      {
        observeSettingsManager: (settingsManager) => {
          trusted = settingsManager.isProjectTrusted();
        },
      },
    );

    expect(sessionManager.systemPrompt).toContain("custom prompt");
    expect(sessionManager.systemPrompt).toContain("extra");
    expect(trusted).toBe(true);
  });
});

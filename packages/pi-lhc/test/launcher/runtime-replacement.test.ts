import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, parseArgs, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createLauncherRuntimeFactory } from "../../src/launcher/runtime-factory.js";

describe("launcher runtime replacement", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("factory recreates cwd-bound services for each replacement session target", async () => {
    const tempDir = join(tmpdir(), `pi-lhc-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    cleanups.push(() => {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    });

    const factory = createLauncherRuntimeFactory({
      authStorage: AuthStorage.inMemory(),
      extensionFlagValues: new Map(),
      extensionFactories: [],
      parsed: parseArgs([]),
    });

    const startup = await factory({
      cwd: tempDir,
      agentDir: tempDir,
      sessionManager: SessionManager.inMemory(tempDir),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    const replacement = await factory({
      cwd: tempDir,
      agentDir: tempDir,
      sessionManager: SessionManager.inMemory(tempDir),
      sessionStartEvent: { type: "session_start", reason: "new" },
    });

    expect(startup.session).not.toBe(replacement.session);
    expect(startup.services).not.toBe(replacement.services);
    expect(replacement.session.sessionManager.getSessionFile()).toBeUndefined();
  });
});

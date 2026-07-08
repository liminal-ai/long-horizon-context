import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureThreadRef,
  codexLhcHome,
  defaultLineageDbPath,
  defaultRegistryPath,
  defaultThreadFilePath,
} from "../../src/intake/paths.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "codex-lhc-home-"));
}

describe("codex-lhc paths", () => {
  it("resolves home, registry, and lineage db under ~/.codex-lhc by default", () => {
    const home = tempHome();
    process.env.CODEX_LHC_HOME = home;
    expect(codexLhcHome()).toBe(home);
    expect(defaultRegistryPath()).toBe(join(home, "registry.sqlite"));
    expect(defaultLineageDbPath()).toBe(join(home, "codex-lhc.sqlite"));
  });

  it("creates threads under the home threads directory", () => {
    const home = tempHome();
    process.env.CODEX_LHC_HOME = home;
    mkdirSync(home, { recursive: true });
    const threadPath = defaultThreadFilePath();
    expect(threadPath.startsWith(join(home, "threads"))).toBe(true);
    expect(threadPath.endsWith(".sqlite")).toBe(true);
  });

  it("builds capture thread refs with registry path", () => {
    const home = tempHome();
    process.env.CODEX_LHC_HOME = home;
    const registry = defaultRegistryPath();
    expect(captureThreadRef("th_1")).toEqual({ threadId: "th_1", registryPath: registry });
    expect(captureThreadRef("th_2", "/custom/registry.sqlite")).toEqual({
      threadId: "th_2",
      registryPath: "/custom/registry.sqlite",
    });
  });
});

/**
 * LIM-117 TC-4.1a and AR-12: Default provenance and packaged bounded-core closure.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACCEPTED_BOUNDED_CORE_SOURCE_COMMIT,
  ADAPTATION_BASE_COMMIT,
  allocationById,
  compactConstruction,
  mutationCoreProfile,
} from "../../src/governor/band-allocation.js";
import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { captureSdkConfig } from "../../src/intake/session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CC_LHC_ROOT = join(HERE, "../..");
const REPO_ROOT = join(CC_LHC_ROOT, "../..");
const LHC_ROOT = join(REPO_ROOT, "packages", "lhc");
const ASSEMBLED = join(REPO_ROOT, "build", "cc-lhc-npm");
const LHC_SRC_SELECTOR_FILES = [
  "src/thread-view/internal/bounded-source.ts",
  "src/thread-view/internal/compact-algorithm.ts",
  "src/thread-view/internal/selection-structure.ts",
  "src/thread-view/internal/walk.ts",
];
const HOST_SELECTOR_BASENAMES = new Set([
  "bounded-source.ts",
  "compact-algorithm.ts",
  "selection-structure.ts",
]);
const HOST_SELECTOR_MARKERS = [
  "createBoundedSelection",
  "COMPACT_ALGORITHM_ENV_VAR",
  "resolveCompactAlgorithm(",
  "LHC_COMPACT_ALGORITHM",
];

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit(root);
  return out;
}

function sha256Dir(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(relative(root, path));
      hash.update("\0");
      if (entry.isDirectory()) visit(path);
      else {
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function assertNoHostSelector(root: string): void {
  for (const path of walkFiles(root)) {
    const base = path.split("/").pop() ?? "";
    expect(HOST_SELECTOR_BASENAMES.has(base), `host-local selector file ${relative(root, path)}`).toBe(false);
    if (!path.endsWith(".ts") && !path.endsWith(".js")) continue;
    const text = readFileSync(path, "utf8");
    for (const marker of HOST_SELECTOR_MARKERS) {
      expect(text.includes(marker), `${relative(root, path)} copies ${marker}`).toBe(false);
    }
  }
}

describe("TC-4.1a Default allocation and core provenance", () => {
  it("proves Default 20/20/30/30, exact 1cfce5d provenance, adaptation base, and no host selector", () => {
    const def = allocationById("default");
    expect(def.label).toBe("Default");
    expect(def.description).toBe("favors recent history");
    expect([def.low, def.medium, def.high, def.full]).toEqual([20, 20, 30, 30]);
    expect(BUILTIN_CONTEXT_POLICY.profile).toBe("default");
    expect(mutationCoreProfile("default")).toBe("continuation");
    // LIM-144: the conservative built-in is the 200k policy (70k target).
    expect(compactConstruction(BUILTIN_CONTEXT_POLICY)).toEqual({
      profile: "continuation",
      params: { lowerBound: 70_000 },
    });

    expect(ACCEPTED_BOUNDED_CORE_SOURCE_COMMIT).toBe("1cfce5d5b45258150278a5699657a2481de5a48e");
    expect(ADAPTATION_BASE_COMMIT).toBe("da5e9bbb6a66728e78ae57fce4c51268b40731a6");

    for (const relativePath of LHC_SRC_SELECTOR_FILES) {
      expect(existsSync(join(LHC_ROOT, relativePath)), relativePath).toBe(true);
    }
    const algorithm = readFileSync(join(LHC_ROOT, "src/thread-view/internal/compact-algorithm.ts"), "utf8");
    expect(algorithm).toContain('export type CompactAlgorithm = "bounded" | "legacy"');
    expect(algorithm).toContain("LHC_COMPACT_ALGORITHM");

    const distAlgorithm = join(LHC_ROOT, "dist/thread-view/internal/compact-algorithm.js");
    expect(existsSync(distAlgorithm), "lhc dist must contain the bounded selector").toBe(true);
    const distText = readFileSync(distAlgorithm, "utf8");
    expect(distText).toContain("bounded");
    expect(distText).toContain("LHC_COMPACT_ALGORITHM");

    assertNoHostSelector(join(CC_LHC_ROOT, "src"));
    const manual = captureSdkConfig({ noInference: true });
    const background = captureSdkConfig({ noInference: false });
    expect(manual.view).toEqual(background.view);
  });
});

describe("AR-12 assembled package bounded core", () => {
  it("assembled package matches source lhc/dist and contains no worktree or host selector", () => {
    expect(existsSync(ASSEMBLED), "assembled package missing at build/cc-lhc-npm").toBe(true);
    const bundledDist = join(ASSEMBLED, "node_modules/lhc/dist");
    const sourceDist = join(LHC_ROOT, "dist");
    expect(existsSync(bundledDist), "bundled lhc dist missing").toBe(true);
    expect(existsSync(sourceDist), "source lhc dist missing").toBe(true);
    expect(sha256Dir(bundledDist)).toBe(sha256Dir(sourceDist));

    const bundledAlgorithm = join(bundledDist, "thread-view/internal/compact-algorithm.js");
    expect(existsSync(bundledAlgorithm)).toBe(true);
    const bundled = readFileSync(bundledAlgorithm, "utf8");
    expect(bundled).toContain("bounded");
    expect(bundled).toContain("LHC_COMPACT_ALGORITHM");

    expect(existsSync(join(ASSEMBLED, ".git"))).toBe(false);
    expect(existsSync(join(ASSEMBLED, "node_modules/lhc/.git"))).toBe(false);
    expect(existsSync(join(ASSEMBLED, "src/thread-view/internal/bounded-source.ts"))).toBe(false);
    assertNoHostSelector(join(ASSEMBLED, "dist"));

    const manifest = JSON.parse(readFileSync(join(ASSEMBLED, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      bundledDependencies: string[];
    };
    expect(manifest.bundledDependencies).toEqual(expect.arrayContaining(["lhc"]));
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      expect(spec.startsWith("file:"), `${name} is a file: dependency`).toBe(false);
      expect(spec.startsWith("link:"), `${name} is a link: dependency`).toBe(false);
      expect(spec.startsWith("workspace:"), `${name} is a workspace: dependency`).toBe(false);
    }
    const bundledLhcManifest = JSON.parse(readFileSync(join(ASSEMBLED, "node_modules/lhc/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, spec] of Object.entries(bundledLhcManifest.dependencies ?? {})) {
      expect(spec.startsWith("file:"), `bundled lhc ${name} is a file: dependency`).toBe(false);
    }

    expect(ACCEPTED_BOUNDED_CORE_SOURCE_COMMIT).toBe("1cfce5d5b45258150278a5699657a2481de5a48e");
    expect(ADAPTATION_BASE_COMMIT).toBe("da5e9bbb6a66728e78ae57fce4c51268b40731a6");
  });
});

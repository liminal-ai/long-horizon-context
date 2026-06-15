// Epic 05 Story 1 (Flow 6): CLI retirement proof — TC-6.1, TC-6.2.
// The package publishes an SDK-only surface: no binary, no named-provider
// registry, no env/flag provider resolution. Deletion is proven three ways:
// an export-name snapshot of the package entry (catches both leftover
// CLI-only exports and accidental removals), a manifest check, and a
// source-level scan for the retired resolution vocabulary. Provider arrival
// is injection at createSdk only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import { createSdk, type SdkConfig } from "../src/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The checked-in SDK-only surface (AC-6.1). A diff here is an intentional
// public-API change: update the list in the same change that alters the
// exports, never to quiet the test.
const SDK_ONLY_EXPORTS = [
  "BUILT_IN_PROFILES",
  "DEFAULT_COMPACT_THRESHOLD",
  "DEFAULT_PROMPT_NAMES",
  "DEFAULT_VISIBILITY",
  "DERIVATION_TYPES",
  "PROMPT_NAMES",
  "TOKEN_ESTIMATOR_ID",
  "WORK_KIND_REGISTRY",
  "assembleWorkHandlerMap",
  "countLiveItems",
  "createDeterministicProvider",
  "createSdk",
  "deterministicOutcomesSuffix",
  "deterministicReceiptsSuffix",
  "deterministicText",
  "enqueue",
  "estimateTokens",
  "inspect",
  "intakeStream",
  "logging",
  "lookupWorkHandler",
  "messages",
  "queryLog",
  "queueDetail",
  "runInTransaction",
  "setSchedulerPoke",
  "setThreadTouch",
  "supersedeQueued",
  "threadView",
  "threads",
  "turns",
  "writeLog",
];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe("TC-6.1: deletion proof — SDK-only public API, no binary (AC-6.1, AC-6.2)", () => {
  it("the package entry's export-name set equals the checked-in SDK-only list", () => {
    expect(Object.keys(api).sort()).toEqual(SDK_ONLY_EXPORTS);
  });

  it("the CLI-only entries are gone from the surface", () => {
    const names = new Set(Object.keys(api));
    expect(names.has("resolveNamedProvider")).toBe(false);
    expect(names.has("registeredProviderNames")).toBe(false);
    expect(names.has("runCli")).toBe(false);
  });

  it("the package manifest publishes no binary and no CLI script", () => {
    const manifest = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
      bin?: unknown;
      scripts?: Record<string, string>;
    };
    expect(manifest.bin).toBeUndefined();
    expect(manifest.scripts?.["dev:cli"]).toBeUndefined();
    for (const command of Object.values(manifest.scripts ?? {})) {
      expect(command).not.toContain("LHC_PROCESS_SUITE");
    }
  });

  it("the CLI surface, registry module, and spawned-process suites are deleted", () => {
    expect(existsSync(path.join(pkgRoot, "src", "cli"))).toBe(false);
    expect(existsSync(path.join(pkgRoot, "src", "cli.ts"))).toBe(false);
    expect(existsSync(path.join(pkgRoot, "src", "providers", "registry.ts"))).toBe(false);
    const processSuites = readdirSync(path.join(pkgRoot, "test")).filter((name) =>
      name.startsWith("cli-process"),
    );
    expect(processSuites).toEqual([]);
  });
});

describe("TC-6.2: the env/flag provider-resolution path is gone (AC-6.3)", () => {
  const envKey = ["LHC", "PROVIDER"].join("_"); // composed so the scan below stays meaningful
  const flag = "--" + "provider";

  it("zero LHC_PROVIDER / --provider references under src/", () => {
    const hits: string[] = [];
    for (const file of collectSourceFiles(path.join(pkgRoot, "src"))) {
      const source = readFileSync(file, "utf8");
      if (source.includes(envKey) || source.includes(flag)) {
        hits.push(path.relative(pkgRoot, file));
      }
    }
    expect(hits).toEqual([]);
  });

  const priorEnv = process.env[envKey];
  afterEach(() => {
    if (priorEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = priorEnv;
  });

  it("neither provider nor inference is the XOR TypeError; no fallback resolution catches it", () => {
    // Even with the retired env variable set, construction must throw: the
    // only provider-arrival path is injection at createSdk.
    process.env[envKey] = "deterministic";
    expect(() => createSdk({ mode: "manual" } as unknown as SdkConfig)).toThrow(TypeError);
    expect(() => createSdk({ mode: "manual" } as unknown as SdkConfig)).toThrow(
      /exactly one of provider or inference/,
    );
  });
});

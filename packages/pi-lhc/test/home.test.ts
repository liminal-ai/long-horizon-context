import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultNewThreadFilePath,
  defaultRegistryPath,
  ensurePiAgentDirEnv,
  piLhcAgentDir,
  piLhcHome,
} from "../src/home.js";

const originalHome = process.env.PI_LHC_HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PI_LHC_HOME;
  else process.env.PI_LHC_HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-lhc-home-"));
}

describe("pi-lhc home paths", () => {
  it("defaults home to ~/.pi-lhc when PI_LHC_HOME is unset", () => {
    delete process.env.PI_LHC_HOME;
    expect(piLhcHome()).toBe(join(homedir(), ".pi-lhc"));
    expect(defaultRegistryPath()).toBe(join(homedir(), ".pi-lhc", "registry.sqlite"));
  });

  it("treats empty-string PI_LHC_HOME as unset", () => {
    process.env.PI_LHC_HOME = "";
    expect(piLhcHome()).toBe(join(homedir(), ".pi-lhc"));
    expect(defaultRegistryPath()).toBe(join(homedir(), ".pi-lhc", "registry.sqlite"));
  });

  it("respects PI_LHC_HOME override for home and registry", () => {
    const home = tempHome();
    process.env.PI_LHC_HOME = home;
    expect(piLhcHome()).toBe(home);
    expect(defaultRegistryPath()).toBe(join(home, "registry.sqlite"));
  });

  it("bootstraps threads dir idempotently and returns distinct file paths", () => {
    const home = tempHome();
    process.env.PI_LHC_HOME = home;

    const first = defaultNewThreadFilePath();
    const second = defaultNewThreadFilePath();

    const threadsDir = join(home, "threads");
    expect(existsSync(threadsDir)).toBe(true);
    expect(first.startsWith(threadsDir)).toBe(true);
    expect(second.startsWith(threadsDir)).toBe(true);
    expect(first.endsWith(".sqlite")).toBe(true);
    expect(second.endsWith(".sqlite")).toBe(true);
    expect(first).not.toBe(second);
    // Directory exists once; mkdirSync recursive is a no-op on the second call.
    expect(readdirSync(home)).toEqual(["threads"]);
  });
});

describe("piLhcAgentDir", () => {
  it("derives <home>/pi/agent under the default home", () => {
    delete process.env.PI_LHC_HOME;
    expect(piLhcAgentDir()).toBe(join(homedir(), ".pi-lhc", "pi", "agent"));
  });

  it("derives <home>/pi/agent under PI_LHC_HOME override", () => {
    const home = tempHome();
    process.env.PI_LHC_HOME = home;
    expect(piLhcAgentDir()).toBe(join(home, "pi", "agent"));
  });
});

describe("ensurePiAgentDirEnv", () => {
  it("sets PI_CODING_AGENT_DIR from the home when unset and creates the dir", () => {
    const home = tempHome();
    process.env.PI_LHC_HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;

    const expected = join(home, "pi", "agent");
    const resolved = ensurePiAgentDirEnv();

    expect(resolved).toBe(expected);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("treats empty-string PI_CODING_AGENT_DIR as unset", () => {
    const home = tempHome();
    process.env.PI_LHC_HOME = home;
    process.env.PI_CODING_AGENT_DIR = "";

    const expected = join(home, "pi", "agent");
    const resolved = ensurePiAgentDirEnv();

    expect(resolved).toBe(expected);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("respects an operator-preset PI_CODING_AGENT_DIR without overwriting or mkdir of home path", () => {
    const home = tempHome();
    const preset = mkdtempSync(join(tmpdir(), "pi-agent-preset-"));
    process.env.PI_LHC_HOME = home;
    process.env.PI_CODING_AGENT_DIR = preset;

    const resolved = ensurePiAgentDirEnv();

    expect(resolved).toBe(preset);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(preset);
    // Must not create <home>/pi/agent when a preset is present.
    expect(existsSync(join(home, "pi"))).toBe(false);
  });
});

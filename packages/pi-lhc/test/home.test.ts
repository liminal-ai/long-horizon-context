import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultNewThreadFilePath, defaultRegistryPath, piLhcHome } from "../src/home.js";

const originalHome = process.env.PI_LHC_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PI_LHC_HOME;
  else process.env.PI_LHC_HOME = originalHome;
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

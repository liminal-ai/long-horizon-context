/**
 * CC_LHC_HOME contract: the runtime descriptor under the cc-lhc home is a
 * retrieval capability. POSIX confidentiality is mode-enforced (0600/0700)
 * so overrides go anywhere (unchanged); Windows has no POSIX modes and no
 * bespoke DACL is installed, so an out-of-profile home fails closed. Pure
 * platform-parameterized helpers — assertions run on every host.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalizeForContainment, isWithinProfile, resolveCcLhcHome } from "../../src/intake/paths.js";

const WIN_HOME = "C:\\Users\\casey";

describe("isWithinProfile (win32 semantics)", () => {
  it("accepts the profile root itself and nested paths, case-insensitively", () => {
    expect(isWithinProfile(WIN_HOME, WIN_HOME, "win32")).toBe(true);
    expect(isWithinProfile("C:\\Users\\casey\\.cc-lhc", WIN_HOME, "win32")).toBe(true);
    expect(isWithinProfile("c:\\users\\CASEY\\.CC-LHC\\runtime", WIN_HOME, "win32")).toBe(true);
  });

  it("rejects sibling directories whose name merely extends the profile root", () => {
    expect(isWithinProfile("C:\\Users\\casey2\\.cc-lhc", WIN_HOME, "win32")).toBe(false);
    expect(isWithinProfile("C:\\Users\\caseyBackup", WIN_HOME, "win32")).toBe(false);
  });

  it("resolves .. segments before judging containment", () => {
    expect(isWithinProfile("C:\\Users\\casey\\.cc-lhc\\..\\..\\shared", WIN_HOME, "win32")).toBe(false);
    expect(isWithinProfile("C:\\Users\\casey\\x\\..\\.cc-lhc", WIN_HOME, "win32")).toBe(true);
  });

  it("rejects other drives and roots", () => {
    expect(isWithinProfile("D:\\Users\\casey\\.cc-lhc", WIN_HOME, "win32")).toBe(false);
    expect(isWithinProfile("C:\\ProgramData\\cc-lhc", WIN_HOME, "win32")).toBe(false);
  });
});

describe("resolveCcLhcHome", () => {
  it("defaults to <home>/.cc-lhc on every platform", () => {
    expect(resolveCcLhcHome(undefined, "/home/u", "linux")).toEqual({ ok: true, path: "/home/u/.cc-lhc" });
    expect(resolveCcLhcHome("", WIN_HOME, "win32")).toEqual({ ok: true, path: `${WIN_HOME}\\.cc-lhc` });
  });

  it("win32: accepts overrides inside the profile (any casing)", () => {
    expect(resolveCcLhcHome("C:\\Users\\CASEY\\lhc-home", WIN_HOME, "win32")).toEqual({
      ok: true,
      path: "C:\\Users\\CASEY\\lhc-home",
    });
  });

  it("win32: fails closed on out-of-profile overrides with the capability rationale, no escape hatch", () => {
    for (const override of [
      "C:\\shared\\lhc",
      "D:\\lhc",
      "C:\\Users\\casey\\..\\shared",
      "C:\\Users\\casey2\\lhc",
    ]) {
      const r = resolveCcLhcHome(override, WIN_HOME, "win32");
      expect(r.ok, override).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("outside the user profile");
        expect(r.reason).toContain("default ACLs");
        expect(r.reason).toContain("no bespoke DACL");
      }
    }
  });

  it("POSIX: overrides resolve anywhere, unchanged", () => {
    expect(resolveCcLhcHome("/tmp/anywhere", "/home/u", "linux")).toEqual({ ok: true, path: "/tmp/anywhere" });
    expect(resolveCcLhcHome("/home/u/../v/lhc", "/home/u", "darwin")).toEqual({ ok: true, path: "/home/v/lhc" });
  });

  it("win32: containment judges canonicalized spellings (8.3 short names cannot break or fake it)", () => {
    const canon = (p: string): string => p.replace(/RUNNER~1/i, "runneradmin");
    const inProfileShort = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cc-lhc-home";
    expect(resolveCcLhcHome(inProfileShort, "C:\\Users\\runneradmin", "win32", canon)).toEqual({
      ok: true,
      path: inProfileShort,
    });
    const outAlias = (p: string): string => p.replace(/LOOKSIN~1/i, "C:\\shared").replace(/^C:\\Users\\casey\\C:\\/, "C:\\");
    void outAlias;
    // An alias canonicalizing OUTSIDE the profile is rejected even though its
    // literal spelling sits inside it.
    const evilCanon = (p: string): string =>
      p.toLowerCase().startsWith("c:\\users\\casey\\link") ? p.replace(/^C:\\Users\\casey\\link/i, "C:\\shared") : p;
    const r = resolveCcLhcHome("C:\\Users\\casey\\link\\lhc", "C:\\Users\\casey", "win32", evilCanon);
    expect(r.ok).toBe(false);
  });
});

describe("canonicalizeForContainment", () => {
  it("realpaths the deepest existing ancestor and reattaches missing segments (symlink alias)", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-canon-"));
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "marker"), "");
    const alias = join(root, "alias");
    try {
      symlinkSync(real, alias, "dir");
    } catch {
      // Environments forbidding symlink creation cannot exercise this case.
      return;
    }
    const canonical = canonicalizeForContainment(join(alias, "not-yet", "created"));
    expect(canonical).toBe(join(canonicalizeForContainment(real), "not-yet", "created"));
    expect(canonical).not.toContain("alias");
  });
});

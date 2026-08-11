/**
 * Windows Claude-executable resolver: PATH/PATHEXT semantics restricted to
 * native executables, absolute-path validation, shim refusal with actionable
 * guidance, and unchanged POSIX pass-through. Pure seams — runs everywhere.
 */

import { describe, expect, it } from "vitest";

import { resolveClaudeBin, resolveWindowsClaudeBin } from "../../src/shared/claude-bin.js";

/** NTFS-like case-insensitive file probe over a fixed listing. */
function files(...paths: string[]): (path: string) => boolean {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
}

const PATHEXT = ".COM;.EXE;.BAT;.CMD";

describe("resolveWindowsClaudeBin: PATH search", () => {
  it("resolves the first PATH directory holding a native exe, in order", () => {
    const r = resolveWindowsClaudeBin("claude", {
      pathValue: "C:\\one;C:\\two",
      pathextValue: PATHEXT,
      isFile: files("C:\\one\\claude.exe", "C:\\two\\claude.exe"),
    });
    expect(r).toEqual({ ok: true, path: "C:\\one\\claude.exe" });
  });

  it("prefers a later native exe over an earlier cmd shim (never runs the shim)", () => {
    const r = resolveWindowsClaudeBin("claude", {
      pathValue: "C:\\npm;C:\\native",
      pathextValue: PATHEXT,
      isFile: files("C:\\npm\\claude.cmd", "C:\\native\\claude.exe"),
    });
    expect(r).toEqual({ ok: true, path: "C:\\native\\claude.exe" });
  });

  it("matches extensions case-insensitively (PATHEXT casing and on-disk casing)", () => {
    const r = resolveWindowsClaudeBin("claude", {
      pathValue: "C:\\bin",
      pathextValue: ".EXE",
      isFile: files("C:\\bin\\CLAUDE.EXE"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.toLowerCase()).toBe("c:\\bin\\claude.exe");
  });

  it("cmd-shim-only PATH fails closed with install/CC_LHC_CLAUDE_BIN guidance", () => {
    const r = resolveWindowsClaudeBin("claude", {
      pathValue: "C:\\npm",
      pathextValue: PATHEXT,
      isFile: files("C:\\npm\\claude.cmd"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("C:\\npm\\claude.cmd");
      expect(r.reason).toContain("cmd.exe");
      expect(r.reason).toContain("CC_LHC_CLAUDE_BIN");
      expect(r.reason).toContain("native Claude Code");
    }
  });

  it("missing everywhere fails with not-found guidance", () => {
    const r = resolveWindowsClaudeBin("claude", {
      pathValue: "C:\\one;C:\\two",
      pathextValue: PATHEXT,
      isFile: files(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("not found on PATH");
      expect(r.reason).toContain("CC_LHC_CLAUDE_BIN");
    }
  });

  it("hostile spaces and metacharacters in PATH directories survive verbatim (no shell quoting)", () => {
    const dir = "C:\\Program Files (x86)\\Claude & Co";
    const r = resolveWindowsClaudeBin("claude", {
      pathValue: `"${dir}";C:\\other`,
      pathextValue: PATHEXT,
      isFile: files(`${dir}\\claude.exe`),
    });
    expect(r).toEqual({ ok: true, path: `${dir}\\claude.exe` });
  });
});

describe("resolveWindowsClaudeBin: explicit paths (CC_LHC_CLAUDE_BIN contract)", () => {
  it("accepts an absolute native exe, case-insensitive extension", () => {
    const r = resolveWindowsClaudeBin("C:\\Tools\\Claude.EXE", {
      isFile: files("C:\\Tools\\Claude.EXE"),
    });
    expect(r).toEqual({ ok: true, path: "C:\\Tools\\Claude.EXE" });
  });

  it("an extension-less absolute path tries the native extensions", () => {
    const r = resolveWindowsClaudeBin("C:\\Tools\\claude", {
      isFile: files("C:\\Tools\\claude.exe"),
    });
    expect(r).toEqual({ ok: true, path: "C:\\Tools\\claude.exe" });
  });

  it("an absolute cmd shim is refused even when it exists", () => {
    const r = resolveWindowsClaudeBin("C:\\npm\\claude.cmd", {
      isFile: files("C:\\npm\\claude.cmd"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not a native executable");
  });

  it("a missing absolute exe fails with its exact path", () => {
    const r = resolveWindowsClaudeBin("C:\\Tools\\claude.exe", { isFile: files() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("C:\\Tools\\claude.exe");
  });
});

describe("resolveClaudeBin: POSIX pass-through unchanged", () => {
  it.skipIf(process.platform === "win32")("returns the env override or bare claude verbatim", () => {
    const prior = process.env.CC_LHC_CLAUDE_BIN;
    try {
      delete process.env.CC_LHC_CLAUDE_BIN;
      expect(resolveClaudeBin()).toBe("claude");
      process.env.CC_LHC_CLAUDE_BIN = "/opt/claude/bin/claude";
      expect(resolveClaudeBin()).toBe("/opt/claude/bin/claude");
    } finally {
      if (prior === undefined) delete process.env.CC_LHC_CLAUDE_BIN;
      else process.env.CC_LHC_CLAUDE_BIN = prior;
    }
  });
});

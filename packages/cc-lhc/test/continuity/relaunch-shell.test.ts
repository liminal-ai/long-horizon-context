/**
 * LIM-145: the shell a relaunched Monitor runs through, resolved exactly as
 * Claude Code 2.1.252 resolves its own bash on Windows.
 */
import { describe, expect, it } from "vitest";

import { resolveRelaunchShell } from "../../src/continuity/relaunch-shell.js";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const GIT_BASH_X86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";

describe("resolveRelaunchShell", () => {
  it("POSIX: /bin/sh -c <command>, no filesystem probing", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const resolved = resolveRelaunchShell(platform, {}, () => {
        throw new Error("must not probe");
      });
      expect(resolved.ok && resolved.shell.program).toBe("/bin/sh");
      expect(resolved.ok && resolved.shell.args("tail -f x")).toEqual(["-c", "tail -f x"]);
    }
  });

  it("win32: CLAUDE_CODE_GIT_BASH_PATH first, then the Git for Windows installs, then bash.exe on PATH — never PowerShell or cmd", () => {
    const at =
      (...present: string[]) =>
      (p: string) =>
        present.includes(p);
    const configured = "D:\\tools\\git\\bin\\bash.exe";
    expect(
      resolveRelaunchShell(
        "win32",
        { CLAUDE_CODE_GIT_BASH_PATH: configured, PATH: "C:\\other" },
        at(configured, GIT_BASH),
      ),
    ).toMatchObject({
      ok: true,
      shell: { program: configured },
    });
    // A configured path that does not exist falls through to auto-detection, as Claude Code does.
    expect(
      resolveRelaunchShell("win32", { CLAUDE_CODE_GIT_BASH_PATH: "D:\\missing\\bash.exe", PATH: "" }, at(GIT_BASH)),
    ).toMatchObject({
      ok: true,
      shell: { program: GIT_BASH },
    });
    expect(resolveRelaunchShell("win32", { PATH: "" }, at(GIT_BASH_X86))).toMatchObject({
      ok: true,
      shell: { program: GIT_BASH_X86 },
    });
    expect(
      resolveRelaunchShell("win32", { PATH: "C:\\Windows;C:\\Users\\me\\bin" }, at("C:\\Users\\me\\bin\\bash.exe")),
    ).toMatchObject({
      ok: true,
      shell: { program: "C:\\Users\\me\\bin\\bash.exe" },
    });
    const none = resolveRelaunchShell(
      "win32",
      { PATH: "C:\\Windows\\System32", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      () => false,
    );
    expect(none).toEqual({ ok: false, reason: "git_bash_not_found" });
    const found = resolveRelaunchShell("win32", { PATH: "" }, at(GIT_BASH));
    expect(found.ok && found.shell.args("tail -f x")).toEqual(["-c", "tail -f x"]);
  });
});

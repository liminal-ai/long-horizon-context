/**
 * LIM-145: Windows background-shell adoption through the real native addon —
 * the production adapter with no injected seams. Runs only on win32 with the
 * compiled addon; under CC_LHC_NATIVE_REQUIRE_ADDON=1 on a Windows lane the
 * addon must load, so the proof cannot skip silently there.
 */
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactFileIdentityReader, loadIdentityAddon } from "cc-lhc-native";
import { afterEach, describe, expect, it } from "vitest";

import { type AdapterContext, FAMILY_ADAPTERS } from "../../src/continuity/adapters.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { openContinuityStore } from "../../src/continuity/store.js";
import { LAUNCH_IDS, LAUNCHES, tempDbPath } from "./helpers.js";

const isWin32 = process.platform === "win32";
// env: {} bypasses the suite-wide CC_LHC_IDENTITY_ADDON stub — this proof is
// about the compiled artifact; the stub's Node-stat identity must never stand
// in for the Win32 file object (that is exactly the proxy the contract bans).
const addonLoads = ((): boolean => {
  try {
    loadIdentityAddon({ env: {} });
    return true;
  } catch {
    return false;
  }
})();
const readRealFileIdentity = createExactFileIdentityReader({ env: {} });

it("win32 lane contract: the addon loads when required", () => {
  if (isWin32 && process.env.CC_LHC_NATIVE_REQUIRE_ADDON === "1") expect(addonLoads).toBe(true);
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!isWin32 || !addonLoads)("win32: real Win32 file identity qualifies the shell adopt adapter", () => {
  it("verifies, re-verifies across appends, and refuses a replaced path", () => {
    const tasksDir = mkdtempSync(join(tmpdir(), "cc-lhc-win32-output-"));
    dirs.push(tasksDir);
    const outputPath = join(tasksDir, "shell-1.output");
    writeFileSync(outputPath, "line 1\r\n");
    const store = openContinuityStore(tempDbPath());
    const observer = createContinuityObserver({ store, threadId: "th_win" });
    for (const line of LAUNCHES.background_shell.lines({ tasksDir, sessionDir: join(tasksDir, "session") }))
      observer.observeLine(line);
    const context: AdapterContext = {
      platform: "win32",
      sourceRolloutPath: undefined,
      readFileIdentity: readRealFileIdentity,
    };
    const item = () => store.getItem("th_win", LAUNCH_IDS.background_shell)!;

    const first = FAMILY_ADAPTERS.background_shell.qualify(item(), context);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.verifiedIdentity).toMatchObject({ kind: "win32_output", path: outputPath });
    const identity = first.verifiedIdentity as { kind: "win32_output"; volumeId: string; fileId: string };
    expect(identity.volumeId).toMatch(/^\d+$/);
    expect(identity.fileId).toMatch(/^(id128:[0-9a-f]{32}|index64:\d+)$/);

    appendFileSync(outputPath, "line 2\r\n");
    const again = FAMILY_ADAPTERS.background_shell.qualify(item(), context);
    expect(again.ok && again.verifiedIdentity).toEqual(first.verifiedIdentity);

    renameSync(outputPath, `${outputPath}.held`);
    writeFileSync(outputPath, "replacement\r\n");
    const replaced = FAMILY_ADAPTERS.background_shell.qualify(item(), context);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.verifiedIdentity).not.toEqual(first.verifiedIdentity);

    rmSync(outputPath);
    expect(FAMILY_ADAPTERS.background_shell.qualify(item(), context)).toEqual({
      ok: false,
      reason: "output_file_missing",
    });
    store.close();
  });
});

/**
 * The Windows holder rule (jfv): Restart Manager holders other than this
 * process mean held; a refused share-none open with no listed holder (and
 * this process not listed, whose own handle would also refuse it) means
 * "cannot prove unheld"; otherwise unheld. The real native path runs on the
 * Windows CI targets through torn-tail.test.ts.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findFileHolders, type NativeFileHolders } from "../../src/runtime/file-holders.js";

function file(): string {
  const path = join(mkdtempSync(join(tmpdir(), "cc-lhc-holders-")), "t.jsonl");
  writeFileSync(path, "x\n");
  return path;
}

const SELF = 4242;
const listing =
  (holders: { pid: number; name: string }[], sharingViolation: boolean): NativeFileHolders =>
  () => ({ ok: true, holders, truncated: false, sharingViolation });

describe("findFileHolders on win32", () => {
  const run = (native: NativeFileHolders) =>
    findFileHolders(file(), { platform: "win32", selfPid: SELF, nativeHolders: native });

  it("another listed process holds it: held, named", () => {
    expect(run(listing([{ pid: 77, name: "claude.exe" }], true))).toEqual({
      ok: true,
      holders: [{ pid: 77, cmd: "claude.exe" }],
    });
  });

  it("nothing listed and the share-none open succeeds: unheld", () => {
    expect(run(listing([], false))).toEqual({ ok: true, holders: [] });
  });

  it("only this process listed: unheld, whatever the share-none open says", () => {
    expect(run(listing([{ pid: SELF, name: "node.exe" }], true))).toEqual({ ok: true, holders: [] });
  });

  it("nothing listed but the share-none open is refused: cannot prove unheld", () => {
    expect(run(listing([], true))).toMatchObject({ ok: false, reason: expect.stringContaining("share-none") });
  });

  it("a native failure is cannot-prove-unheld", () => {
    expect(run(() => ({ ok: false, code: "native_error", message: "RmGetList failed (error 234)" }))).toEqual({
      ok: false,
      reason: "holder list failed: native_error: RmGetList failed (error 234)",
    });
  });
});

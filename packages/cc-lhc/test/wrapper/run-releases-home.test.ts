/**
 * run() must let go of every file under the cc-lhc home before it returns,
 * on every way out: the orderly exit, a guidance exit, a refused launch.
 * A store left open is harmless when cli.ts exits right after run(), but it
 * holds the database for an in-process caller, and on Windows an open handle
 * stops the home from being removed (CI 35943449452: ~270 EPERM teardowns
 * from a store left open).
 *
 * Linux only: /proc/self/fd names every descriptor this process holds, so the
 * check needs no Windows runner to catch the class.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendThreadSignatures } from "../../src/intake/lineage-db.js";
import { defaultLineageDbPath } from "../../src/intake/paths.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import { run } from "../../src/wrapper/run.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const STANDIN = join(FIXTURES, "oneshot-claude.mjs");
const ORPHAN = "11111111-1111-4111-8111-111111111111";

function fakeStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

/** Every path this process holds open under `root`. */
function heldUnder(root: string): string[] {
  const held: string[] = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    let target: string;
    try {
      target = readlinkSync(join("/proc/self/fd", fd));
    } catch {
      continue; // closed between readdir and readlink (the readdir's own fd)
    }
    if (target.startsWith(`${root}/`)) held.push(target);
  }
  return held;
}

describe.skipIf(process.platform !== "linux")("run() releases the cc-lhc home on every exit", () => {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CC_LHC_HOME: process.env.CC_LHC_HOME,
  };
  let home = "";
  let lhcHome = "";
  let projectDir = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-lhc-releases-home-"));
    lhcHome = join(home, ".cc-lhc");
    mkdirSync(lhcHome);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CC_LHC_HOME = lhcHome;
    projectDir = join(home, ".claude", "projects", encodeProjectPath(process.cwd()));
    mkdirSync(projectDir, { recursive: true });
    chmodSync(STANDIN, 0o755);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const opts = () => ({
    stdin: fakeStream(),
    stdout: fakeStream() as never,
    stderr: fakeStream() as never,
    noInference: true,
  });

  it("orderly one-shot exit", async () => {
    const session = "22222222-2222-4222-8222-222222222222";
    expect(await run(["-p", "hello there", "--session-id", session], { ...opts(), claudeBin: STANDIN })).toBe(0);
    // The run really used the home: the lineage database is there.
    expect(readdirSync(lhcHome)).toContain("cc-lhc.sqlite");
    expect(heldUnder(home).map((p) => p.slice(home.length))).toEqual([]);
  });

  it("guidance exit (one-shot on an unlinked rebuilt transcript)", async () => {
    writeFileSync(
      join(projectDir, `${ORPHAN}.jsonl`),
      readFileSync(join(FIXTURES, "alder-043-short-tail-orphan.jsonl")),
    );
    appendThreadSignatures(defaultLineageDbPath(), "th_unrelated_B", [
      "7e3af9d1d0129ff782e097d54f659e50c830318997c669c8e72762a7f428a7c4",
      "ba1a1cc30c8df3501d24c76f710ecf0981164d92d8b3e38e7f1d90fd6178ed00",
    ]);
    expect(await run(["--resume", ORPHAN, "-p", "What is the codeword?"], { ...opts(), claudeBin: STANDIN })).toBe(2);
    expect(heldUnder(home).map((p) => p.slice(home.length))).toEqual([]);
  });

  it("refused launch (bad --session-id)", async () => {
    expect(await run(["-p", "hi", "--session-id", "not-a-uuid"], { ...opts(), claudeBin: STANDIN })).toBe(2);
    expect(heldUnder(home).map((p) => p.slice(home.length))).toEqual([]);
  });
});

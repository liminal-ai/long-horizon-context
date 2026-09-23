/**
 * A one-shot resuming a rebuilt transcript that no record links to its thread
 * (a pre-fix orphan of an interrupted compaction). Capture would be refused,
 * and a one-shot has no screen to show why, so run() prints the guidance to
 * stderr and exits non-zero before any Claude process exists.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendThreadSignatures } from "../../src/intake/lineage-db.js";
import { defaultLineageDbPath } from "../../src/intake/paths.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import { run } from "../../src/wrapper/run.js";

const ALDER_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/alder-043-short-tail-orphan.jsonl");
const ORPHAN = "11111111-1111-4111-8111-111111111111";

function fakeStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

describe("run: one-shot on an unlinked rebuilt transcript", () => {
  const saved = { HOME: process.env.HOME, CC_LHC_HOME: process.env.CC_LHC_HOME };
  const dirs: string[] = [];

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-unlinked-home-"));
    const lhcHome = mkdtempSync(join(tmpdir(), "cc-lhc-unlinked-lhc-"));
    dirs.push(home, lhcHome);
    process.env.HOME = home;
    process.env.CC_LHC_HOME = lhcHome;
    const projectDir = join(home, ".claude", "projects", encodeProjectPath(process.cwd()));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${ORPHAN}.jsonl`), readFileSync(ALDER_FIXTURE));
    // Alder's lineage: an unrelated thread holds both replayed lines.
    appendThreadSignatures(defaultLineageDbPath(), "th_unrelated_B", [
      "7e3af9d1d0129ff782e097d54f659e50c830318997c669c8e72762a7f428a7c4",
      "ba1a1cc30c8df3501d24c76f710ecf0981164d92d8b3e38e7f1d90fd6178ed00",
    ]);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("prints the guidance on stderr and exits non-zero without launching Claude", async () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const out: string[] = [];
    const err: string[] = [];
    stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
    stderr.on("data", (chunk: Buffer) => err.push(chunk.toString()));
    let spawned = 0;

    const code = await run(["--resume", ORPHAN, "-p", "What is the codeword?"], {
      claudeBin: "fake-claude",
      spawnPty: (() => {
        spawned += 1;
        throw new Error("a one-shot on an unlinked rebuild must not launch Claude");
      }) as never,
      stdin: fakeStream(),
      stdout: stdout as never,
      stderr: stderr as never,
      noInference: true,
    });

    expect(code).toBe(2);
    expect(spawned).toBe(0);
    expect(out.join("")).toBe("");
    const printed = err.join("");
    expect(printed).toContain(`session ${ORPHAN} is a Smart Compact rebuilt transcript`);
    expect(printed).toContain("cannot link to a thread");
    expect(printed).toContain("run cc-lhc --resume with no id and pick it");
  });
});

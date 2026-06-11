// Story 4 (Epic 02), process-boundary suite: CLI parity for the report and
// requeue mirrors — `lhc messages report|requeue` and `lhc turns
// report|requeue` through the spawned dist/cli.js produce the same result
// JSON the SDK surfaces return (tech design CLI parity rule; supplemental
// non-TC checks per the test plan). Report and requeue need no provider
// (DD-11) — only the drain legs set LHC_PROVIDER. Runs under verify-all only
// (LHC_PROCESS_SUITE=1). Lives in its own file because cli-process-work.test.ts
// is hash-locked by the Story 1 red manifest; green may add files, not edit.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSdk,
  intakeStream,
  messages,
  resolveNamedProvider,
  threads,
  turns,
  type FormReportEntry,
  type OpResult,
} from "../src/index.js";
import { validEvent } from "./fixtures/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pkgRoot, "dist", "cli.js");

function runBinary(
  args: string[],
  env?: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-report-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function newThreadFile(name: string): Promise<string> {
  const filePath = path.join(dir, `${name}.sqlite`);
  const created = await threads.newThread({
    filePath,
    registryPath: path.join(dir, "registry.sqlite"),
  });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

// One closed prompt+answer turn, identical on both twins (fixed idempotency
// keys; report rows for an undrained thread carry no timestamps, so the twin
// JSON compares byte-equal without clock control).
async function seedTwin(filePath: string): Promise<void> {
  const batch = [
    validEvent("user_prompt", { payload: { text: "twin report prompt" } }),
    validEvent("assistant_text", { payload: { text: "twin report answer" } }),
    validEvent("turn_end"),
  ].map((event, index) => ({ ...event, idempotencyKey: `twin-report-${index}` }));
  const seeded = await intakeStream.messageEvents({ filePath }, batch);
  if (!seeded.ok) throw new Error(`fixture batch failed: ${seeded.error.reason}`);
}

describe("CLI parity: report mirrors the SDK surfaces, no provider required", () => {
  it("messages and turns report JSON equals the SDK result on twin threads, including --not-ready", async () => {
    const cliThread = await newThreadFile("cli-report");
    const sdkThread = await newThreadFile("sdk-report");
    await seedTwin(cliThread);
    await seedTwin(sdkThread);

    const viaCli = runBinary(["messages", "report", "--file-path", cliThread], {
      LHC_PROVIDER: undefined,
    });
    expect(viaCli.status).toBe(0);
    const cliReport = JSON.parse(viaCli.stdout) as OpResult<FormReportEntry[]>;
    const viaSdk = await messages.report({ filePath: sdkThread });
    expect(cliReport).toEqual(viaSdk);

    const viaCliTurns = runBinary(
      ["turns", "report", "--file-path", cliThread, "--not-ready"],
      { LHC_PROVIDER: undefined },
    );
    expect(viaCliTurns.status).toBe(0);
    const cliTurnsReport = JSON.parse(viaCliTurns.stdout) as OpResult<FormReportEntry[]>;
    const viaSdkTurns = await turns.report({ filePath: sdkThread }, { notReady: true });
    expect(cliTurnsReport).toEqual(viaSdkTurns);
    expect(cliTurnsReport.ok).toBe(true);
    if (!cliTurnsReport.ok) return;
    // The undrained twin is all pending with live queue detail in the rows.
    expect(cliTurnsReport.value.map((entry) => [entry.form, entry.state])).toEqual([
      ["lower_band_projection", "pending"],
      ["turn_rendering", "pending"],
    ]);
    expect(cliTurnsReport.value[0]?.queue).toEqual({ status: "queued", attempts: 0 });
  });

  it("report on a missing thread exits 1 with thread_not_found", async () => {
    const missing = runBinary(
      ["messages", "report", "--file-path", path.join(dir, "nope.sqlite")],
      { LHC_PROVIDER: undefined },
    );
    expect(missing.status).toBe(1);
    const parsed = JSON.parse(missing.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("thread_not_found");
  });
});

describe("CLI parity: requeue mirrors the SDK surfaces", () => {
  it("requeue through both owners returns identical result JSON on drained twins; the no-op and refusal legs match too", async () => {
    const cliThread = await newThreadFile("cli-requeue");
    const sdkThread = await newThreadFile("sdk-requeue");
    await seedTwin(cliThread);
    await seedTwin(sdkThread);

    // Drain both twins through the production provider registry (DD-11):
    // the CLI twin via the spawned binary, the SDK twin via the same
    // resolution seam in-process.
    const drained = runBinary(["work", "drain", "--file-path", cliThread], {
      LHC_PROVIDER: "deterministic",
    });
    expect(drained.status).toBe(0);
    const provider = resolveNamedProvider("deterministic");
    if (provider === undefined) throw new Error("deterministic provider not registered");
    const sdk = createSdk({ provider, mode: "manual" });
    const sdkDrained = await sdk.work.drain({ filePath: sdkThread });
    expect(sdkDrained.ok).toBe(true);

    // listChunks parity (ruling 012): the drained twins hold one open chunk
    // with t1 placed; CLI JSON matches the SDK record shape exactly.
    const cliChunks = runBinary(["turns", "list-chunks", "--file-path", cliThread], {
      LHC_PROVIDER: undefined,
    });
    expect(cliChunks.status).toBe(0);
    const sdkChunks = await turns.listChunks({ filePath: sdkThread });
    expect(JSON.parse(cliChunks.stdout)).toEqual(sdkChunks);
    expect(sdkChunks.ok && sdkChunks.value).toMatchObject([
      { chunkId: "c1", status: "open", memberTurnIds: ["t1"] },
    ]);

    // messages.requeue parity: rebuild a ready smoothing at the next version.
    const cliRequeue = runBinary(
      [
        "messages",
        "requeue",
        "--file-path",
        cliThread,
        "--message-id",
        "m1",
        "--form",
        "smoothed_prompt",
      ],
      { LHC_PROVIDER: undefined },
    );
    expect(cliRequeue.status).toBe(0);
    const sdkRequeue = await messages.requeue(
      { filePath: sdkThread },
      { messageId: "m1", form: "smoothed_prompt" },
    );
    expect(JSON.parse(cliRequeue.stdout)).toEqual(sdkRequeue);
    expect(sdkRequeue.ok && sdkRequeue.value).toEqual({
      workItemId: "w-m1-prompt_smoothing-v2",
    });

    // Idempotency through the CLI: the second ask is the explicit no-op.
    const cliNoop = runBinary(
      [
        "messages",
        "requeue",
        "--file-path",
        cliThread,
        "--message-id",
        "m1",
        "--form",
        "smoothed_prompt",
      ],
      { LHC_PROVIDER: undefined },
    );
    expect(cliNoop.status).toBe(0);
    const sdkNoop = await messages.requeue(
      { filePath: sdkThread },
      { messageId: "m1", form: "smoothed_prompt" },
    );
    expect(JSON.parse(cliNoop.stdout)).toEqual(sdkNoop);
    expect(sdkNoop.ok && sdkNoop.value).toEqual({ noop: "already_queued" });

    // turns.requeue parity on the turn rebuild.
    const cliTurn = runBinary(
      [
        "turns",
        "requeue",
        "--file-path",
        cliThread,
        "--subject-kind",
        "turn",
        "--subject-id",
        "t1",
        "--form",
        "turn_rendering",
      ],
      { LHC_PROVIDER: undefined },
    );
    expect(cliTurn.status).toBe(0);
    const sdkTurn = await turns.requeue(
      { filePath: sdkThread },
      { subjectKind: "turn", subjectId: "t1", form: "turn_rendering" },
    );
    expect(JSON.parse(cliTurn.stdout)).toEqual(sdkTurn);
    expect(sdkTurn.ok && sdkTurn.value).toEqual({ workItemId: "w-t1-turn_derivation-v2" });

    // Refusal parity: a bogus target is the same caller error, exit 1.
    const cliMissing = runBinary(
      [
        "messages",
        "requeue",
        "--file-path",
        cliThread,
        "--message-id",
        "m99",
        "--form",
        "smoothed_prompt",
      ],
      { LHC_PROVIDER: undefined },
    );
    expect(cliMissing.status).toBe(1);
    const sdkMissing = await messages.requeue(
      { filePath: sdkThread },
      { messageId: "m99", form: "smoothed_prompt" },
    );
    expect(JSON.parse(cliMissing.stdout)).toEqual(sdkMissing);
    expect(!sdkMissing.ok && sdkMissing.error.code).toBe("message_not_found");
  });
});

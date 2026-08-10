/**
 * Operator label-backfill CLI (Slice 7): explicit selected thread, prefix
 * resolution through the cc-lhc registry, dry-run purity, and refusal shapes.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDeterministicInferenceCallbacks, initLhc, threads, type Lhc } from "lhc";
import { beforeEach, describe, expect, it } from "vitest";

import { isBackfillLabelsArgv, runBackfillLabelsCli } from "../../src/commands/backfill-labels.js";

let root: string;
let registryPath: string;
let filePath: string;
let threadId: string;
let sdk: Lhc;
let out: string[];
let errs: string[];

async function seedTurn(prompt: string, answer: string): Promise<void> {
  const send = await sdk.intakeStream.messageEvents({ filePath }, [
    {
      eventKind: "user_prompt",
      idempotencyKey: `u-${prompt}`,
      actor: "user",
      harness: "cc",
      payload: { text: prompt },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: `a-${answer}`,
      actor: "assistant",
      harness: "cc",
      payload: { text: answer },
    },
    { eventKind: "turn_end", idempotencyKey: `e-${prompt}`, actor: "system", harness: "cc", payload: {} },
  ]);
  if (!send.ok) throw new Error(send.error.reason);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
}

function stripLabels(turnId: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.prepare(
      `UPDATE derivation SET content = 'legacy untagged rendering'
       WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'`,
    ).run(turnId);
  } finally {
    db.close();
  }
}

function renderingContent(turnId: string): string | null {
  const db = new DatabaseSync(filePath);
  try {
    const row = db
      .prepare(
        `SELECT content FROM derivation
         WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'turn_rendering'`,
      )
      .get(turnId) as { content: string | null } | undefined;
    return row?.content ?? null;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cc-lhc-backfill-"));
  registryPath = join(root, "registry.sqlite");
  filePath = join(root, "thread.sqlite");
  const created = await threads.newThread({ filePath, registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  threadId = created.value.threadId;
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  out = [];
  errs = [];
});

function deps() {
  return {
    registryPath,
    initSdk: () => sdk,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => errs.push(line),
  };
}

describe("backfill-labels CLI", () => {
  it("claims only its own argv head", () => {
    expect(isBackfillLabelsArgv(["backfill-labels", "th_x"])).toBe(true);
    expect(isBackfillLabelsArgv(["get-turns", "t1"])).toBe(false);
    expect(isBackfillLabelsArgv([])).toBe(false);
  });

  it("refuses missing/extra arguments and unknown flags with usage", async () => {
    expect(await runBackfillLabelsCli(["backfill-labels"], deps())).toBe(2);
    expect(errs.some((line) => line.startsWith("usage:"))).toBe(true);
    errs = [];
    expect(await runBackfillLabelsCli(["backfill-labels", "a", "b"], deps())).toBe(2);
    errs = [];
    expect(await runBackfillLabelsCli(["backfill-labels", "th_x", "--force"], deps())).toBe(2);
    expect(errs[0]).toContain("unknown flag");
  });

  it("refuses an unknown thread cleanly", async () => {
    expect(await runBackfillLabelsCli(["backfill-labels", "th_nope"], deps())).toBe(2);
    expect(errs[0]).toContain("thread resolve failed");
  });

  it("relabels through a unique thread-id prefix and reports the receipt", async () => {
    await seedTurn("question one", "answer one");
    await seedTurn("question two", "answer two");
    stripLabels("t1");

    const prefix = threadId.slice(0, 8);
    expect(await runBackfillLabelsCli(["backfill-labels", prefix], deps())).toBe(0);
    expect(out.some((line) => line.includes(`thread ${threadId}`))).toBe(true);
    expect(out.some((line) => line.includes("relabeled 1"))).toBe(true);
    const rewritten = renderingContent("t1");
    expect(rewritten?.startsWith("<t1>\n")).toBe(true);
    expect(rewritten?.endsWith("\n</t1>")).toBe(true);
  });

  it("dry run mutates nothing and says so", async () => {
    await seedTurn("question one", "answer one");
    stripLabels("t1");
    const before = renderingContent("t1");
    expect(await runBackfillLabelsCli(["backfill-labels", threadId, "--dry-run"], deps())).toBe(0);
    expect(out.some((line) => line.includes("(dry run)"))).toBe(true);
    expect(renderingContent("t1")).toBe(before);
  });
});

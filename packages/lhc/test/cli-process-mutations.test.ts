// Story 5 (Epic 02), process-boundary suite: TC-5.6 — `lhc messages edit`
// through the spawned dist/cli.js has full parity with messages.edit on twin
// fixtures: identical result JSON, identical cascade (queue rows), identical
// read-back. Mutations need no provider (DD-11) — only the twin-building
// drains resolve one, in-process through the same registry the CLI uses.
// Runs under verify-all only (LHC_PROCESS_SUITE=1). Lives in its own file
// because cli-process-work.test.ts is hash-locked by the Story 1 red
// manifest; green may add files, not edit (the Story 4 precedent).
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
  queueDetail,
  resolveNamedProvider,
  threads,
  type MutationResult,
  type OpResult,
} from "../src/index.js";
import { openRaw, readDerivedForms, validEvent } from "./fixtures/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pkgRoot, "dist", "cli.js");

function runBinary(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, LHC_PROVIDER: undefined },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-mutations-"));
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

// One closed prompt+answer turn, identical on both twins: fixed idempotency
// keys make the records comparable; the drains run in-process under one
// injected clock so derived timestamps match byte-for-byte.
async function seedTwin(filePath: string): Promise<void> {
  const batch = [
    validEvent("user_prompt", { payload: { text: "twin edit prompt" } }),
    validEvent("assistant_text", { payload: { text: "twin edit answer" } }),
    validEvent("turn_end"),
  ].map((event, index) => ({ ...event, idempotencyKey: `twin-edit-${index}` }));
  const seeded = await intakeStream.messageEvents({ filePath }, batch);
  if (!seeded.ok) throw new Error(`fixture batch failed: ${seeded.error.reason}`);
}

function rawDetailStripped(
  filePath: string,
): Array<Omit<ReturnType<typeof queueDetail>[number], "queuedAt">> {
  const db = openRaw(filePath);
  try {
    return queueDetail(db).map(({ queuedAt: _queuedAt, ...rest }) => rest);
  } finally {
    db.close();
  }
}

describe("TC-5.6 / AC-5.6: messages.edit has SDK/CLI parity on twin fixtures", () => {
  it("the same edit via SDK and spawned CLI yields identical result JSON, cascade, and read-back", async () => {
    const cliThread = await newThreadFile("cli-edit");
    const sdkThread = await newThreadFile("sdk-edit");
    await seedTwin(cliThread);
    await seedTwin(sdkThread);

    // Build identical ready state on both twins through the production
    // assembly the CLI drain uses: registry provider, manual mode, one fixed
    // clock so derivedAt stamps match.
    const provider = resolveNamedProvider("deterministic");
    if (provider === undefined) throw new Error("deterministic provider not registered");
    const sdk = createSdk({
      provider,
      mode: "manual",
      clock: () => new Date("2026-06-11T00:00:00.000Z"),
    });
    for (const filePath of [cliThread, sdkThread]) {
      const drained = await sdk.work.drain({ filePath });
      if (!drained.ok) throw new Error(`twin drain failed: ${drained.error.reason}`);
    }
    expect(readDerivedForms(cliThread)).toEqual(readDerivedForms(sdkThread));

    const viaSdk = await messages.edit(
      { filePath: sdkThread },
      { messageId: "m1", content: "twin edited prompt" },
    );
    expect(viaSdk.ok).toBe(true);

    const viaCli = runBinary([
      "messages",
      "edit",
      "--file-path",
      cliThread,
      "--message",
      "m1",
      "--content",
      "twin edited prompt",
    ]);
    expect(viaCli.status).toBe(0);
    const parsed = JSON.parse(viaCli.stdout) as OpResult<MutationResult>;
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !viaSdk.ok) return;

    // Identical result JSON: same validation, same result shape, same
    // cascade report (the deterministic ids carry the source versions).
    expect(parsed.value).toEqual(viaSdk.value);

    // Identical cascade in the record: the live queue rows match minus the
    // wall-clock queuedAt stamp (the edits ran at different real times).
    expect(rawDetailStripped(cliThread)).toEqual(rawDetailStripped(sdkThread));

    // Identical read-back: messages (content, blocks, re-stamped estimate,
    // attached form states) and the full derived_form table.
    const cliMessages = await messages.listMessages({ filePath: cliThread });
    const sdkMessages = await messages.listMessages({ filePath: sdkThread });
    expect(cliMessages.ok && sdkMessages.ok).toBe(true);
    if (!cliMessages.ok || !sdkMessages.ok) return;
    expect(cliMessages.value).toEqual(sdkMessages.value);
    expect(readDerivedForms(cliThread)).toEqual(readDerivedForms(sdkThread));
  });

  it("refusals carry the same stable codes through the CLI, exit 1, and change nothing", async () => {
    const threadPath = await newThreadFile("cli-refusal");
    await seedTwin(threadPath);
    const before = readDerivedForms(threadPath);

    const missing = runBinary([
      "messages",
      "edit",
      "--file-path",
      threadPath,
      "--message",
      "m99",
      "--content",
      "nope",
    ]);
    expect(missing.status).toBe(1);
    const missingParsed = JSON.parse(missing.stdout) as { ok: boolean; error: { code: string } };
    expect(missingParsed.ok).toBe(false);
    expect(missingParsed.error.code).toBe("message_not_found");

    // SDK twin refusal is byte-identical in code and class.
    const viaSdk = await messages.edit({ filePath: threadPath }, { messageId: "m99", content: "nope" });
    expect(viaSdk.ok).toBe(false);
    if (viaSdk.ok) return;
    expect(viaSdk.error.code).toBe("message_not_found");
    expect(viaSdk.error.errorClass).toBe("caller_error");

    expect(readDerivedForms(threadPath)).toEqual(before);
  });
});

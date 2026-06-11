// Story 6 (Epic 02), process-boundary suite: TC-6.8 — `lhc messages delete`
// and `lhc turns delete` through the spawned dist/cli.js have full parity
// with messages.deleteMessage / turns.deleteTurn on twin fixtures: identical
// result JSON, identical cascade (queue rows), identical read-back —
// including the unfiltered event read-back, the audit surface every delete
// variant must leave byte-stable. Mutations need no provider (DD-11) — only
// the twin-building drains resolve one, in-process through the same registry
// the CLI uses. Runs under verify-all only (LHC_PROCESS_SUITE=1). New file
// by the red-manifest rule: cli-process-mutations.test.ts is hash-locked by
// Story 5 (the Story 4 precedent — green may add files, not edit).
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
  turns,
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
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-delete-"));
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

// One closed turn with a tool run, identical on both twins: fixed
// idempotency keys make the records comparable; the drains run in-process
// under one injected clock so derived timestamps match byte-for-byte.
async function seedTwin(filePath: string): Promise<void> {
  const batch = [
    validEvent("user_prompt", { payload: { text: "twin delete prompt" } }),
    validEvent("tool_call"),
    validEvent("tool_result"),
    validEvent("assistant_text", { payload: { text: "twin delete answer" } }),
    validEvent("turn_end"),
  ].map((event, index) => ({ ...event, idempotencyKey: `twin-delete-${index}` }));
  const seeded = await intakeStream.messageEvents({ filePath }, batch);
  if (!seeded.ok) throw new Error(`fixture batch failed: ${seeded.error.reason}`);
}

async function drainTwins(paths: string[]): Promise<void> {
  const provider = resolveNamedProvider("deterministic");
  if (provider === undefined) throw new Error("deterministic provider not registered");
  const sdk = createSdk({
    provider,
    mode: "manual",
    clock: () => new Date("2026-06-11T00:00:00.000Z"),
  });
  for (const filePath of paths) {
    const drained = await sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(`twin drain failed: ${drained.error.reason}`);
  }
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

// The twin comparison surface: every read path the delete touches plus the
// one it must not — message reads, turn reads with membership, chunk
// membership, derived forms, the live queue, and the unfiltered events.
async function readBack(filePath: string): Promise<unknown> {
  const messageRecords = await messages.listMessages({ filePath });
  const turnRecords = await turns.listTurns({ filePath });
  const chunkRecords = await turns.listChunks({ filePath });
  const events = await intakeStream.listEvents({ filePath });
  if (!messageRecords.ok || !turnRecords.ok || !chunkRecords.ok || !events.ok) {
    throw new Error("read-back failed");
  }
  return {
    messages: messageRecords.value,
    turns: turnRecords.value,
    chunks: chunkRecords.value,
    // Events carry recordedAt stamps from the twins' separate intake walls;
    // compare order, kind, and payload — the audit content.
    events: events.value.map((event) => ({
      eventOrder: event.eventOrder,
      eventKind: event.eventKind,
      payload: event.payload,
    })),
    forms: readDerivedForms(filePath),
    queue: rawDetailStripped(filePath),
  };
}

describe("TC-6.8 / AC-6.8: message delete and turn delete have SDK/CLI parity on twin fixtures", () => {
  it("the same message delete via SDK and spawned CLI yields identical result JSON, cascade, and read-back", async () => {
    const cliThread = await newThreadFile("cli-msg-delete");
    const sdkThread = await newThreadFile("sdk-msg-delete");
    await seedTwin(cliThread);
    await seedTwin(sdkThread);
    await drainTwins([cliThread, sdkThread]);
    expect(readDerivedForms(cliThread)).toEqual(readDerivedForms(sdkThread));

    const viaSdk = await messages.deleteMessage({ filePath: sdkThread }, { messageId: "m3" });
    expect(viaSdk.ok).toBe(true);

    const viaCli = runBinary(["messages", "delete", "--file-path", cliThread, "--message", "m3"]);
    expect(viaCli.status).toBe(0);
    const parsed = JSON.parse(viaCli.stdout) as OpResult<MutationResult>;
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !viaSdk.ok) return;

    expect(parsed.value).toEqual(viaSdk.value);
    expect(await readBack(cliThread)).toEqual(await readBack(sdkThread));
  });

  it("the same turn delete via SDK and spawned CLI yields identical result JSON, cascade, and read-back", async () => {
    const cliThread = await newThreadFile("cli-turn-delete");
    const sdkThread = await newThreadFile("sdk-turn-delete");
    await seedTwin(cliThread);
    await seedTwin(sdkThread);
    await drainTwins([cliThread, sdkThread]);

    const viaSdk = await turns.deleteTurn({ filePath: sdkThread }, { turnId: "t1" });
    expect(viaSdk.ok).toBe(true);

    const viaCli = runBinary(["turns", "delete", "--file-path", cliThread, "--turn", "t1"]);
    expect(viaCli.status).toBe(0);
    const parsed = JSON.parse(viaCli.stdout) as OpResult<MutationResult>;
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !viaSdk.ok) return;

    expect(parsed.value).toEqual(viaSdk.value);
    expect(await readBack(cliThread)).toEqual(await readBack(sdkThread));
  });

  it("refusals carry the same stable codes through the CLI, exit 1, and change nothing", async () => {
    const threadPath = await newThreadFile("cli-delete-refusal");
    await seedTwin(threadPath);
    await drainTwins([threadPath]);
    const before = await readBack(threadPath);

    // Prompt protection through the CLI: the refusal names the turn and the
    // turn-delete path, matching the SDK code and class exactly.
    const protectedPrompt = runBinary([
      "messages",
      "delete",
      "--file-path",
      threadPath,
      "--message",
      "m1",
    ]);
    expect(protectedPrompt.status).toBe(1);
    const promptParsed = JSON.parse(protectedPrompt.stdout) as {
      ok: boolean;
      error: { errorClass: string; code: string; reason: string };
    };
    expect(promptParsed.ok).toBe(false);
    expect(promptParsed.error.code).toBe("message_initiates_turn");
    expect(promptParsed.error.errorClass).toBe("caller_error");
    expect(promptParsed.error.reason).toContain("t1");
    expect(promptParsed.error.reason).toContain("turns delete");

    const viaSdk = await messages.deleteMessage({ filePath: threadPath }, { messageId: "m1" });
    expect(viaSdk.ok).toBe(false);
    if (viaSdk.ok) return;
    expect(viaSdk.error.code).toBe("message_initiates_turn");

    const missingTurn = runBinary(["turns", "delete", "--file-path", threadPath, "--turn", "t9"]);
    expect(missingTurn.status).toBe(1);
    const turnParsed = JSON.parse(missingTurn.stdout) as { ok: boolean; error: { code: string } };
    expect(turnParsed.ok).toBe(false);
    expect(turnParsed.error.code).toBe("turn_not_found");

    expect(await readBack(threadPath)).toEqual(before);
  });
});

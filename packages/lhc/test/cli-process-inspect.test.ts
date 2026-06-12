// Story 1 (Epic 04), process-boundary suite: TC-3.4 — `lhc messages list`
// and `lhc messages show` through the spawned dist/cli.js have full JSON
// parity with the in-process SDK operations: same options, same result JSON,
// refusals included. Reads are non-mutating, so one fixture thread serves
// both sides — the spawned output deep-equals the SDK result on the same
// file (the production-path proof: cli/messages-read.ts routes to the SDK,
// any divergence is a bypass). Reads need no provider; the binary runs with
// LHC_PROVIDER unset. Runs under verify-all only (LHC_PROCESS_SUITE=1).
// TC-5.4's checkpoint parity joins this file in Story 4.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSdk,
  messages,
  resolveNamedProvider,
  threads,
  type MessageListOptions,
} from "../src/index.js";
import { validEvent } from "./fixtures/index.js";

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
  dir = mkdtempSync(path.join(tmpdir(), "lhc-proc-inspect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Two closed turns (m1 prompt, m2 text, m3 call, m4 result; m6 prompt,
// m7 text), drained in-process against the registry's deterministic
// provider, then m2 deleted — so the parity sweep covers live, bounded,
// deleted-included, and deleted-shown reads on one record.
async function seedThread(): Promise<string> {
  const filePath = path.join(dir, "inspect-parity.sqlite");
  const created = await threads.newThread({
    filePath,
    registryPath: path.join(dir, "registry.sqlite"),
  });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  const provider = resolveNamedProvider("deterministic");
  if (provider === undefined) throw new Error("deterministic provider not registered");
  const sdk = createSdk({ provider, mode: "manual" });
  const batches = [
    [
      validEvent("user_prompt", { payload: { text: "please read notes.txt" } }),
      validEvent("assistant_text", { payload: { text: "reading it now" } }),
      validEvent("tool_call", {
        payload: {
          toolCallId: "call-parity-1",
          toolName: "read_file",
          arguments: { path: "notes.txt" },
        },
      }),
      validEvent("tool_result", {
        payload: {
          toolCallId: "call-parity-1",
          content: "contents of notes.txt: full parity-fixture tool output",
          isError: false,
        },
      }),
      validEvent("turn_end"),
    ],
    [
      validEvent("user_prompt", { payload: { text: "summarize what you read" } }),
      validEvent("assistant_text", { payload: { text: "here is the summary" } }),
      validEvent("turn_end"),
    ],
  ];
  for (const batch of batches) {
    const sent = await sdk.intakeStream.messageEvents({ filePath }, batch);
    if (!sent.ok) throw new Error(`fixture batch failed: ${sent.error.reason}`);
  }
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok || drained.value.remaining !== 0) {
    throw new Error("fixture drain did not settle");
  }
  const deleted = await messages.deleteMessage({ filePath }, { messageId: "m2" });
  if (!deleted.ok) throw new Error(`fixture delete failed: ${deleted.error.reason}`);
  return filePath;
}

describe("TC-3.4 / AC-3.4: spawned-CLI message list/show parity with the SDK", () => {
  it("messages list mirrors the SDK across default, bounded, include-deleted, and refused options", async () => {
    const filePath = await seedThread();
    const cases: Array<{ args: string[]; opts: MessageListOptions; ok: boolean }> = [
      { args: [], opts: {}, ok: true },
      { args: ["--from", "2", "--to", "4"], opts: { from: 2, to: 4 }, ok: true },
      { args: ["--limit", "2"], opts: { limit: 2 }, ok: true },
      { args: ["--include-deleted"], opts: { includeDeleted: true }, ok: true },
      {
        args: ["--from", "3", "--limit", "2", "--include-deleted"],
        opts: { from: 3, limit: 2, includeDeleted: true },
        ok: true,
      },
      // The refusal leg: bad bounds carry the same structured error through
      // the process boundary, exit 1.
      { args: ["--from", "5", "--to", "2"], opts: { from: 5, to: 2 }, ok: false },
    ];
    for (const parity of cases) {
      const viaSdk = await messages.listMessages({ filePath }, parity.opts);
      expect(viaSdk.ok).toBe(parity.ok);
      const viaCli = runBinary(["messages", "list", "--file-path", filePath, ...parity.args]);
      expect(viaCli.status).toBe(parity.ok ? 0 : 1);
      expect(JSON.parse(viaCli.stdout)).toEqual(viaSdk);
    }
    // Six serial dist/cli.js spawns push past Vitest's 5000ms default on a
    // loaded machine; the explicit budget keeps the configured verify-all gate
    // stable (SV-01-003), matching the other process-suite spawn tests.
  }, 30000);

  it("messages show mirrors the SDK for live, deleted, and missing targets", async () => {
    const filePath = await seedThread();
    for (const messageId of [
      "m4", // live drained tool result, forms attached
      "m2", // deleted: ok + flag — the audit read
      "m99", // missing: message_not_found, exit 1
    ]) {
      const viaSdk = await messages.show({ filePath }, messageId);
      const viaCli = runBinary([
        "messages",
        "show",
        "--file-path",
        filePath,
        "--message-id",
        messageId,
      ]);
      expect(viaCli.status).toBe(viaSdk.ok ? 0 : 1);
      expect(JSON.parse(viaCli.stdout)).toEqual(viaSdk);
    }
    // The deleted target succeeds with the flag; the missing one refuses —
    // pinned here so the loop's parity can't both-sides-drift.
    const deletedShown = await messages.show({ filePath }, "m2");
    expect(deletedShown.ok).toBe(true);
    if (deletedShown.ok) expect(deletedShown.value.deleted).toBe(true);
    const missing = await messages.show({ filePath }, "m99");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("message_not_found");
    // Same spawn-cost budget as the list leg, for the same gate-stability
    // reason (SV-01-003).
  }, 30000);
});

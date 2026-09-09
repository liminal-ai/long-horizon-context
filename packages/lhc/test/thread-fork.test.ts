// Fork operations (threads domain): copy with rekey and idle refusal, host
// binding table, identity note, neutral history export, derivation repair,
// and the thin `lhc thread` CLI over them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { initLhc, intakeStream, threads } from "../src/index.js";
import {
  createInferenceCallbacksDouble,
  openRaw,
  setFormState,
  type TempStore,
  tempStore,
  threadWithClosedTurns,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const RECORD_TABLES = ["event", "turns", "message", "message_block", "derivation", "chunk", "chunk_member"] as const;

function dumpTables(path: string): Record<string, unknown[]> {
  const db = openRaw(path);
  try {
    const out: Record<string, unknown[]> = {};
    for (const table of RECORD_TABLES) out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return out;
  } finally {
    db.close();
  }
}

function metadataThreadId(path: string): string {
  const db = openRaw(path);
  try {
    return (db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as { thread_id: string }).thread_id;
  } finally {
    db.close();
  }
}

async function send(filePath: string, batch: Parameters<typeof intakeStream.messageEvents>[1]): Promise<void> {
  const result = await intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
}

// Two closed turns with a tool run and thinking, then an empty open turn: idle.
async function idleSource(): Promise<{ filePath: string; threadId: string }> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath, title: "src", cwd: "/w" });
  if (!created.ok) throw new Error(created.error.reason);
  await send(filePath, [
    validEvent("user_prompt", { payload: { text: "first prompt" } }),
    validEvent("assistant_thinking", { payload: { text: "private" } }),
    validEvent("tool_call", { payload: { toolCallId: "c1", toolName: "read_file", arguments: { path: "a" } } }),
    validEvent("tool_result", { payload: { toolCallId: "c1", content: "file body" } }),
    validEvent("assistant_text", { payload: { text: "first answer" } }),
    validEvent("turn_end", { payload: { outcome: "completed" } }),
    validEvent("user_prompt", { payload: { text: "second prompt" } }),
    validEvent("assistant_text", { payload: { text: "second answer" } }),
    validEvent("turn_end"),
  ]);
  return { filePath, threadId: created.value.threadId };
}

function targetHome(name = "target"): { home: string; registry: string; threadsDir: string } {
  const home = join(store.dir, name);
  return { home, registry: join(home, "registry.sqlite"), threadsDir: join(home, "threads") };
}

describe("threads.copyThread", () => {
  it("copies under a new id: metadata rekeyed, registry row, every record table byte-equal, source untouched", async () => {
    const source = await idleSource();
    const before = sha256(source.filePath);
    const target = targetHome();
    const filePath = join(target.threadsDir, "fork.sqlite");

    const copied = await threads.copyThread({
      source: { threadId: source.threadId, registryPath: store.registryPath },
      filePath,
      registryPath: target.registry,
      title: "forked",
      cwd: "/w2",
    });
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    expect(copied.value.sourceThreadId).toBe(source.threadId);
    expect(copied.value.threadId).not.toBe(source.threadId);
    expect(copied.value.threadId).toMatch(/^th_[0-9a-f]{16}$/);
    expect(copied.value.rekeyed).toBe(true);
    expect(copied.value.schema.copy).toBeGreaterThanOrEqual(copied.value.schema.source);

    expect(sha256(source.filePath)).toBe(before);
    expect(metadataThreadId(filePath)).toBe(copied.value.threadId);
    expect(dumpTables(filePath)).toEqual(dumpTables(source.filePath));

    const listed = await threads.listThreads({ registryPath: target.registry });
    expect(listed.ok && listed.value.map((t) => [t.threadId, t.filePath, t.title, t.cwd])).toEqual([
      [copied.value.threadId, filePath, "forked", "/w2"],
    ]);
    const resolved = await threads.resolve({ threadId: source.threadId, registryPath: target.registry });
    expect(resolved.ok).toBe(false);

    // Without overrides, a registry-sourced copy inherits the source row's title and cwd.
    const inherited = await threads.copyThread({
      source: { threadId: source.threadId, registryPath: store.registryPath },
      filePath: join(target.threadsDir, "inherited.sqlite"),
      registryPath: target.registry,
    });
    if (!inherited.ok) throw new Error(inherited.error.reason);
    const row = await threads.resolve({ threadId: inherited.value.threadId, registryPath: target.registry });
    expect(row.ok && [row.value.title, row.value.cwd]).toEqual(["src", "/w"]);
  });

  it("honours an explicit new id and keepThreadId; refuses an id already in the target registry", async () => {
    const source = await idleSource();
    const target = targetHome();
    const explicit = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "explicit.sqlite"),
      registryPath: target.registry,
      newThreadId: "th_explicit",
    });
    expect(explicit.ok && explicit.value.threadId).toBe("th_explicit");

    const kept = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "kept.sqlite"),
      registryPath: target.registry,
      keepThreadId: true,
    });
    expect(kept.ok && [kept.value.threadId, kept.value.rekeyed]).toEqual([source.threadId, false]);

    const again = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "kept-again.sqlite"),
      registryPath: target.registry,
      keepThreadId: true,
    });
    expect(!again.ok && again.error.code).toBe("thread_exists");
    expect(existsSync(join(target.threadsDir, "kept-again.sqlite"))).toBe(false);

    const exists = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "explicit.sqlite"),
      registryPath: target.registry,
    });
    expect(!exists.ok && exists.error.code).toBe("path_exists");
  });

  it("refuses a mid-turn source and leaves no file; allowed explicitly; runtime notes do not count", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    await send(filePath, [
      validEvent("user_prompt", { payload: { text: "still running" } }),
      validEvent("tool_call", { payload: { toolCallId: "c9", toolName: "bash", arguments: {} } }),
    ]);
    const target = targetHome();
    const refused = await threads.copyThread({
      source: { filePath },
      filePath: join(target.threadsDir, "mid.sqlite"),
      registryPath: target.registry,
    });
    expect(!refused.ok && refused.error.code).toBe("mid_turn");
    expect(!refused.ok && refused.error.reason).toContain("2 member(s)");
    expect(existsSync(join(target.threadsDir, "mid.sqlite"))).toBe(false);
    expect(existsSync(target.registry)).toBe(false);

    const allowed = await threads.copyThread({
      source: { filePath },
      filePath: join(target.threadsDir, "mid.sqlite"),
      registryPath: target.registry,
      requireIdle: false,
    });
    expect(allowed.ok).toBe(true);

    // An idle record carrying only a runtime note in its open turn is still idle.
    const source = await idleSource();
    await send(source.filePath, [validEvent("runtime_note", { payload: { text: "[lhc compact:auto] ..." } })]);
    const idle = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "noted.sqlite"),
      registryPath: target.registry,
    });
    expect(idle.ok).toBe(true);
  });
});

describe("threads.hostBinding / bindHost", () => {
  it("fixed host table", () => {
    expect(threads.hostBinding("cc-lhc", "abc-1")).toEqual({
      ok: true,
      value: { kind: "alias", alias: "claude-code:abc-1" },
    });
    expect(threads.hostBinding("claude-lhc", "s1")).toEqual({
      ok: true,
      value: { kind: "alias", alias: "t3code-lhc:s1" },
    });
    expect(threads.hostBinding("pi-lhc")).toEqual({ ok: true, value: { kind: "none" } });
    expect(threads.hostBinding("codex-lhc", "019f-uuid")).toEqual({
      ok: true,
      value: { kind: "file", fileName: "019f-uuid.sqlite" },
    });
    expect(threads.hostBinding("codex-lhc", "a.b_c/d")).toEqual({
      ok: true,
      value: { kind: "file", fileName: "a%2Eb%5Fc%2Fd.sqlite" },
    });
    expect(threads.hostBinding("grok", "g1")).toEqual({
      ok: true,
      value: { kind: "file", fileName: "grok-g1.sqlite" },
    });
    // grok's encoder keeps `_`; codex's does not (each mirrors its Rust host).
    expect(threads.hostBinding("grok", "a.b_c/d")).toEqual({
      ok: true,
      value: { kind: "file", fileName: "grok-a%2Eb_c%2Fd.sqlite" },
    });
    const missing = threads.hostBinding("cc-lhc");
    expect(!missing.ok && missing.error.code).toBe("invalid_thread_alias");
    // hermes: file named after the session verbatim, no encoder, unsafe names refused.
    expect(threads.hostBinding("hermes", "20260810_130535_bc6de9dc")).toEqual({
      ok: true,
      value: { kind: "file", fileName: "20260810_130535_bc6de9dc.sqlite" },
    });
    const unsafe = threads.hostBinding("hermes", "a.b/c");
    expect(!unsafe.ok && unsafe.error.code).toBe("invalid_thread_alias");
    const noSession = threads.hostBinding("hermes");
    expect(!noSession.ok && noSession.error.code).toBe("invalid_thread_alias");
    expect(threads.SOURCE_ONLY_HOSTS).toEqual(["hermes"]);
    expect(threads.isSourceOnlyHost("hermes")).toBe(true);
    expect(threads.isSourceOnlyHost("cc-lhc")).toBe(false);
  });

  it("alias hosts register the current alias; file hosts are refused; pi binds nothing", async () => {
    const source = await idleSource();
    const target = targetHome();
    const copied = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "b.sqlite"),
      registryPath: target.registry,
    });
    if (!copied.ok) throw new Error(copied.error.reason);
    const threadId = copied.value.threadId;

    const bound = await threads.bindHost({
      threadId,
      registryPath: target.registry,
      host: "cc-lhc",
      sessionId: "sess-1",
    });
    expect(bound).toEqual({ ok: true, value: { kind: "alias", alias: "claude-code:sess-1" } });
    const current = await threads.currentAlias({ threadId, registryPath: target.registry });
    expect(current.ok && current.value.currentAlias).toBe("claude-code:sess-1");
    const resolved = await threads.resolveAlias({ alias: "claude-code:sess-1", registryPath: target.registry });
    expect(resolved.ok && resolved.value.threadId).toBe(threadId);

    const file = await threads.bindHost({ threadId, registryPath: target.registry, host: "grok", sessionId: "g" });
    expect(!file.ok && file.error.code).toBe("file_bound_host");
    const none = await threads.bindHost({ threadId, registryPath: target.registry, host: "pi-lhc" });
    expect(none).toEqual({ ok: true, value: { kind: "none" } });
    const hermes = await threads.bindHost({ threadId, registryPath: target.registry, host: "hermes", sessionId: "h" });
    expect(!hermes.ok && hermes.error.code).toBe("file_bound_host");
  });
});

describe("threads.writeIdentityNote", () => {
  it("records one runtime note in the open turn with the provenance text", async () => {
    const source = await idleSource();
    const target = targetHome();
    const copied = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "n.sqlite"),
      registryPath: target.registry,
    });
    if (!copied.ok) throw new Error(copied.error.reason);
    const ref = { threadId: copied.value.threadId, registryPath: target.registry };
    const noted = await threads.writeIdentityNote({
      ref,
      sourceThreadId: source.threadId,
      sourceHome: "/home/x/.cc-lhc",
      seat: "wren",
      at: "2026-09-09T13:00:00.000Z",
    });
    expect(noted.ok && noted.value.text).toBe(
      `[lhc fork] copied from ${source.threadId} (/home/x/.cc-lhc) on 2026-09-09T13:00:00.000Z, seat wren`,
    );
    const db = openRaw(copied.value.filePath);
    try {
      const rows = db
        .prepare(
          `SELECT m.kind, t.status, b.content FROM message m JOIN turns t ON t.turn_id = m.turn_id
           JOIN message_block b ON b.message_id = m.message_id WHERE m.kind = 'runtime_note'`,
        )
        .all() as Array<{ kind: string; status: string; content: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("open");
      expect(rows[0]?.content).toContain("[lhc fork] copied from");
    } finally {
      db.close();
    }
  });
});

describe("threads.exportHistory", () => {
  it("groups exported kinds per turn in record order; thinking is omitted and counted", async () => {
    const source = await idleSource();
    const exported = await threads.exportHistory({ filePath: source.filePath });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const history = exported.value;
    expect(history.threadId).toBe(source.threadId);
    expect(history.omitted).toEqual({ assistant_thinking: 1 });
    expect(history.turns.map((t) => [t.order, t.status, t.outcome, t.messages.map((m) => m.kind)])).toEqual([
      [1, "closed", "completed", ["user_prompt", "tool_call", "tool_result", "assistant_text"]],
      [2, "closed", null, ["user_prompt", "assistant_text"]],
      [3, "open", null, []],
    ]);
    const first = history.turns[0]?.messages[0];
    expect(first?.blocks).toEqual([{ blockType: "text", content: { text: "first prompt" } }]);
    expect(first?.actor).toBe("fixture-actor");
    expect(first?.recordedAt).toMatch(/^\d{4}-/);
    const orders = history.turns.flatMap((t) => t.messages.map((m) => m.eventOrder));
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    const toolCall = history.turns[0]?.messages[1];
    expect(toolCall?.blocks[0]?.blockType).toBe("tool_call");
    expect(toolCall?.blocks[0]?.content).toMatchObject({ toolCallId: "c1", toolName: "read_file" });
  });
});

describe("threads.repairDerivations", () => {
  it("re-derives failed turn compressions through the instance; the bare call reports missing inference", async () => {
    const { filePath, turnIds } = await threadWithClosedTurns(store, 2);
    const sdk = initLhc({
      inferenceCallbacks: createInferenceCallbacksDouble(),
      mode: "manual",
      guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    });
    // Intake queued the turns' derivation work. Repair drains it before its
    // first pass, so nothing is failed or deferred and the turns come out ready.
    const carried = await sdk.threads.repairDerivations({ ref: { filePath } });
    expect(carried.ok && carried.value.turns).toEqual({ attempted: 0, repaired: 0, failed: 0, deferred: 0 });
    const idle = await sdk.work.drain({ filePath }, { maxItems: 25 });
    expect(idle.ok && idle.value.ran).toEqual([]);
    for (const turnId of turnIds) {
      const derived = await sdk.turns.deriveTurn({ filePath }, turnId);
      expect(derived.ok && derived.value.outcome).toBe("derived");
    }
    for (const turnId of turnIds) {
      setFormState(
        filePath,
        { subjectKind: "turn", subjectId: turnId, derivationType: "detailed_turn_compression" },
        { state: "failed", reason: "rate_limit: scripted" },
      );
    }
    const before = await sdk.inspect.health({ filePath });
    expect(before.ok && before.value.failures.map((f) => f.subjectId)).toEqual(turnIds);

    const bare = await threads.repairDerivations({ ref: { filePath } });
    expect(!bare.ok && bare.error.code).toBe("inference_unavailable");

    const limited = await sdk.threads.repairDerivations({ ref: { filePath }, limit: 1 });
    expect(limited.ok && limited.value.turns).toEqual({ attempted: 1, repaired: 1, failed: 0, deferred: 0 });
    expect(limited.ok && limited.value.remainingFailures).toBe(1);

    const repaired = await sdk.threads.repairDerivations({ ref: { filePath } });
    if (!repaired.ok) throw new Error(`repair failed: ${JSON.stringify(repaired.error)}`);
    expect(repaired.value.turns).toEqual({ attempted: 1, repaired: 1, failed: 0, deferred: 0 });
    expect(repaired.value.remainingFailures).toBe(0);
    expect(repaired.value.errors).toEqual([]);
    const after = await sdk.inspect.health({ filePath });
    expect(after.ok && after.value.failures).toEqual([]);
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function userVersion(path: string): number {
  const db = openRaw(path);
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

// The registry exactly as lhc-rs creates it: one `threads` table, no
// user_version, no alias tables.
function rustRegistry(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "registry.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL
    );`);
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
      "0f0e0d0c-0b0a-4908-8706-050403020100",
      join(dir, "threads", "0f0e0d0c-0b0a-4908-8706-050403020100.sqlite"),
      "rust row",
      "/r",
      "2026-09-01T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
  return path;
}

describe("fork across hosts: compact rule, id policy, Rust ceilings", () => {
  it("provider table and compact plan: providers differ or the caller decides", () => {
    expect(threads.HOST_PROVIDERS).toEqual({
      "cc-lhc": "anthropic",
      "claude-lhc": "anthropic",
      "pi-lhc": "pi",
      "codex-lhc": "openai",
      grok: "xai",
      hermes: "hermes",
    });
    expect(threads.forkCompactPlan("hermes", "cc-lhc")).toEqual({ compact: true, reason: "hermes -> anthropic" });
    expect(threads.forkCompactPlan("hermes", "claude-lhc")).toEqual({ compact: true, reason: "hermes -> anthropic" });
    expect(threads.forkCompactPlan("hermes", "codex-lhc")).toEqual({ compact: true, reason: "hermes -> openai" });
    expect(threads.forkCompactPlan("cc-lhc", "claude-lhc")).toEqual({
      compact: false,
      reason: "same provider anthropic",
    });
    expect(threads.forkCompactPlan("codex-lhc", "cc-lhc")).toEqual({ compact: true, reason: "openai -> anthropic" });
    expect(threads.forkCompactPlan("cc-lhc", "grok")).toEqual({ compact: true, reason: "anthropic -> xai" });
    expect(threads.forkCompactPlan("pi-lhc", "pi-lhc")).toEqual({ compact: false, reason: "same provider pi" });
    expect(threads.forkCompactPlan("cc-lhc", "pi-lhc")).toEqual({ compact: true, reason: "anthropic -> pi" });
    expect(threads.forkCompactPlan("cc-lhc", "cc-lhc", "always")).toEqual({ compact: true, reason: "forced" });
    expect(threads.forkCompactPlan("cc-lhc", "grok", "never")).toEqual({ compact: false, reason: "suppressed" });
    expect(threads.handoffCompactOptions()).toEqual({ profile: "handoff" });
    expect(threads.handoffCompactOptions(5000)).toEqual({ profile: "handoff", params: { lowerBound: 5000 } });
  });

  it("codex ids are the rollout uuid; grok mints a uuid; registry hosts keep SDK ids", () => {
    const minted = threads.forkThreadId("codex-lhc", {});
    expect(minted.ok && UUID.test(minted.value)).toBe(true);
    const fromSession = threads.forkThreadId("codex-lhc", { sessionId: "0f0e0d0c-0b0a-4908-8706-050403020100" });
    expect(fromSession.ok && fromSession.value).toBe("0f0e0d0c-0b0a-4908-8706-050403020100");
    const agree = threads.forkThreadId("codex-lhc", {
      newId: "0f0e0d0c-0b0a-4908-8706-050403020100",
      sessionId: "0f0e0d0c-0b0a-4908-8706-050403020100",
    });
    expect(agree.ok).toBe(true);
    const disagree = threads.forkThreadId("codex-lhc", {
      newId: "0f0e0d0c-0b0a-4908-8706-050403020100",
      sessionId: "other",
    });
    expect(!disagree.ok && disagree.error.code).toBe("invalid_thread_alias");
    const notUuid = threads.forkThreadId("codex-lhc", { newId: "th_abc" });
    expect(!notUuid.ok && notUuid.error.code).toBe("invalid_thread_alias");
    const grok = threads.forkThreadId("grok", { sessionId: "grok_session" });
    expect(grok.ok && UUID.test(grok.value)).toBe(true);
    const grokGiven = threads.forkThreadId("grok", { newId: "th_g" });
    expect(grokGiven.ok && grokGiven.value).toBe("th_g");
    const cc = threads.forkThreadId("cc-lhc", { sessionId: "uuid-1" });
    expect(cc.ok && cc.value.startsWith("th_")).toBe(true);
  });

  it("a copy lands at the thread schema the Rust hosts accept (P3)", async () => {
    // The vendored lhc-rs pins 13. The day the SDK moves ahead, this fails
    // here instead of at a codex or grok host's open.
    expect(threads.FILE_HOST_THREAD_SCHEMA_VERSION).toBe(threads.RUST_HOST_THREAD_SCHEMA_VERSION);
    const source = await idleSource();
    const target = targetHome();
    const copied = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "0f0e0d0c-0b0a-4908-8706-050403020101.sqlite"),
      registryPath: target.registry,
      newThreadId: "0f0e0d0c-0b0a-4908-8706-050403020101",
    });
    if (!copied.ok) throw new Error(copied.error.reason);
    expect(userVersion(copied.value.filePath)).toBe(threads.RUST_HOST_THREAD_SCHEMA_VERSION);
  });

  it("a Rust-created registry takes a copy and an alias, keeps its rows, gains the alias tables (P2)", async () => {
    const dir = join(store.dir, "rust-home");
    const registryPath = rustRegistry(dir);
    expect(userVersion(registryPath)).toBe(0);
    const source = await idleSource();
    const copied = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(dir, "threads", "th_into_rust.sqlite"),
      registryPath,
      newThreadId: "th_into_rust",
    });
    if (!copied.ok) throw new Error(copied.error.reason);
    const bound = await threads.registerCurrentAlias({
      alias: "claude-code:s9",
      threadId: "th_into_rust",
      registryPath,
    });
    expect(bound.ok).toBe(true);

    const db = openRaw(registryPath);
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toEqual(["thread_alias", "thread_current_alias", "threads"]);
      const rows = db
        .prepare("SELECT thread_id, file_path, title, cwd, created_at FROM threads ORDER BY created_at")
        .all();
      expect(rows[0]).toEqual({
        thread_id: "0f0e0d0c-0b0a-4908-8706-050403020100",
        file_path: join(dir, "threads", "0f0e0d0c-0b0a-4908-8706-050403020100.sqlite"),
        title: "rust row",
        cwd: "/r",
        created_at: "2026-09-01T00:00:00.000Z",
      });
      expect(rows.length).toBe(2);
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    } finally {
      db.close();
    }
    const listed = await threads.listThreads({ registryPath });
    expect(listed.ok && listed.value.map((t) => t.threadId)).toEqual([
      "0f0e0d0c-0b0a-4908-8706-050403020100",
      "th_into_rust",
    ]);
  });

  it("handoff compact leaves no closed turn raw and keeps the identity note in the tail", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const source = await idleSource();
    const drainedSource = await sdk.work.drain({ filePath: source.filePath });
    if (!drainedSource.ok) throw new Error(drainedSource.error.reason);
    const target = targetHome();
    const copied = await threads.copyThread({
      source: { filePath: source.filePath },
      filePath: join(target.threadsDir, "h.sqlite"),
      registryPath: target.registry,
      newThreadId: "th_handoff",
    });
    if (!copied.ok) throw new Error(copied.error.reason);
    const ref = { threadId: "th_handoff", registryPath: target.registry };
    const noted = await threads.writeIdentityNote({ ref, sourceThreadId: source.threadId, seat: "wren" });
    if (!noted.ok) throw new Error(noted.error.reason);

    const before = await sdk.threadView.getSessionThreadView(ref);
    if (!before.ok) throw new Error(before.error.reason);
    expect(before.value.entries.some((e) => "role" in e && e.role === "toolResult")).toBe(true);

    const opts = threads.handoffCompactOptions();
    const preview = await sdk.threadView.previewCompact(ref, opts);
    expect(preview.ok && preview.value.kind).toBe("ok");
    const compacted = await sdk.threadView.compact(ref, opts);
    if (!compacted.ok) throw new Error(compacted.error.reason);
    expect(compacted.value.profile).toBe("handoff");
    expect(compacted.value.config.full).toBe(0);
    expect(compacted.value.config.newestClosedProtection).toBe(0);
    // "full" is the verbatim share, not a band: with it at zero every closed
    // turn lands in a text band and only the open turn (the note) is tail.
    expect(
      compacted.value.bands.smooth.entries +
        compacted.value.bands.detailed.entries +
        compacted.value.bands.brief.entries,
    ).toBeGreaterThan(0);
    expect(compacted.value.tailTokens).toBeGreaterThan(0);

    const after = await sdk.threadView.getSessionThreadView(ref);
    if (!after.ok) throw new Error(after.error.reason);
    const entries = after.value.entries;
    expect(entries.some((e) => "role" in e && e.role === "toolResult")).toBe(false);
    const parts = entries.flatMap((e) => ("role" in e && e.role === "assistant" ? e.content : []));
    expect(parts.some((p) => p.type === "toolCall" || p.type === "thinking")).toBe(false);
    expect(JSON.stringify(entries)).toContain(noted.value.text);
  });
});

describe("lhc thread CLI", () => {
  function capture(): { out: string[]; err: string[]; restore: () => void } {
    const out: string[] = [];
    const err: string[] = [];
    const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return {
      out,
      err,
      restore: () => {
        o.mockRestore();
        e.mockRestore();
      },
    };
  }

  it("copy, note, bind, export, health print one line each and exit 0; refusals exit 2; usage exits 1", async () => {
    const source = await idleSource();
    const target = targetHome();
    const sourceHome = store.dir;
    const c = capture();
    try {
      const sourceArgs = ["--source-file", source.filePath];
      expect(await main(["thread", "copy", ...sourceArgs, "--home", target.home, "--new-id", "th_cli"])).toBe(0);
      expect(c.out.at(-1)).toBe(`th_cli ${join(target.threadsDir, "th_cli.sqlite")}\n`);

      const common = ["--home", target.home, "--thread-id", "th_cli"];
      expect(await main(["thread", "note", ...common, "--from", source.threadId, "--seat", "wren"])).toBe(0);
      expect(c.out.at(-1)).toMatch(/^\S+ \[lhc fork\] copied from th_[0-9a-f]+ on .*, seat wren\n$/);

      expect(await main(["thread", "bind", ...common, "--host", "claude-lhc", "--session-id", "S"])).toBe(0);
      expect(c.out.at(-1)).toBe("t3code-lhc:S\n");

      expect(await main(["thread", "health", ...common])).toBe(0);
      expect(c.out.at(-1)).toMatch(/^ready=\d+ pending=\d+ failed=\d+ blocked=\d+ repairable=\d+\n$/);

      const outFile = join(store.dir, "history.json");
      expect(await main(["thread", "export", ...common, "--out", outFile])).toBe(0);
      expect(c.out.at(-1)).toBe(`${outFile} turns=3\n`);
      const parsed = JSON.parse(readFileSync(outFile, "utf8")) as { threadId: string; turns: unknown[] };
      expect(parsed.threadId).toBe("th_cli");

      expect(await main(["thread", "copy", ...sourceArgs, "--home", target.home, "--new-id", "th_cli"])).toBe(2);
      expect(c.err.at(-1)).toMatch(/^path_exists: /);

      expect(await main(["thread", "bind", ...common, "--host", "grok", "--session-id", "g"])).toBe(2);
      expect(c.err.at(-1)).toMatch(/^file_bound_host: /);

      expect(await main(["thread", "copy", "--home", target.home])).toBe(1);
      expect(c.err.at(-1)).toMatch(/^usage: /);
      // hermes is a source only: refused as a bind or fork target before any work.
      expect(await main(["thread", "bind", ...common, "--host", "hermes", "--session-id", "h"])).toBe(1);
      expect(c.err.at(-1)).toMatch(/^usage: host hermes is a source only/);
      expect(await main(["thread", "nope"])).toBe(1);
      expect(await main([])).toBe(0);
      expect(c.out.at(-1)).toContain("usage: lhc thread");
      expect(sourceHome).toBe(store.dir);
    } finally {
      c.restore();
    }
  });

  it("fork composes copy, note, bind with --no-repair and prints the one line", async () => {
    const source = await idleSource();
    const target = targetHome();
    const c = capture();
    try {
      const rc = await main([
        "thread",
        "fork",
        "--source-home",
        store.dir,
        "--source-thread-id",
        source.threadId,
        "--home",
        target.home,
        "--source-host",
        "claude-lhc",
        "--host",
        "cc-lhc",
        "--session-id",
        "uuid-1",
        "--new-id",
        "th_forked",
        "--seat",
        "wren",
        "--no-repair",
      ]);
      expect(c.err).toEqual([]);
      expect(rc).toBe(0);
      expect(c.out.at(-1)).toBe(
        `th_forked ${join(target.threadsDir, "th_forked.sqlite")} claude-code:uuid-1 repaired=0 failed=0 deferred=0 remaining=skipped compact=skipped (same provider anthropic)\n`,
      );
      const current = await threads.currentAlias({ threadId: "th_forked", registryPath: target.registry });
      expect(current.ok && current.value.currentAlias).toBe("claude-code:uuid-1");
      const history = await threads.exportHistory({ threadId: "th_forked", registryPath: target.registry });
      expect(history.ok && history.value.turns.at(-1)?.messages.map((m) => m.kind)).toEqual(["runtime_note"]);

      // A mid-turn source refuses the whole fork with exit 2 and no file.
      const midPath = store.threadPath();
      const created = await threads.newThread({ filePath: midPath, registryPath: store.registryPath });
      if (!created.ok) throw new Error(created.error.reason);
      await send(midPath, [validEvent("user_prompt", { payload: { text: "open" } })]);
      const refused = await main([
        "thread",
        "fork",
        "--source-file",
        midPath,
        "--source-host",
        "pi-lhc",
        "--home",
        target.home,
        "--host",
        "pi-lhc",
        "--new-id",
        "th_mid",
        "--no-repair",
      ]);
      expect(refused).toBe(2);
      expect(c.err.at(-1)).toMatch(/^mid_turn: /);
      expect(existsSync(join(target.threadsDir, "th_mid.sqlite"))).toBe(false);
    } finally {
      c.restore();
    }
  });

  it("fork compacts across providers under handoff, honours --no-compact, and mints codex ids", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const source = await idleSource();
    const drained = await sdk.work.drain({ filePath: source.filePath });
    if (!drained.ok) throw new Error(drained.error.reason);
    const target = targetHome();
    const c = capture();
    try {
      // The claude binary must never be reached: derivations are ready and
      // repair is off, so the compact runs on stored material alone.
      const common = [
        "thread",
        "fork",
        "--source-file",
        source.filePath,
        "--home",
        target.home,
        "--no-repair",
        "--claude-bin",
        "/bin/false",
      ];
      const rc = await main([
        ...common,
        "--source-host",
        "codex-lhc",
        "--host",
        "cc-lhc",
        "--session-id",
        "u-1",
        "--new-id",
        "th_x",
      ]);
      expect(c.err).toEqual([]);
      expect(rc).toBe(0);
      expect(c.out.at(-1)).toMatch(
        /^th_x \S+ claude-code:u-1 repaired=0 failed=0 deferred=0 remaining=skipped compact=[1-9]\d* \(openai -> anthropic\)\n$/,
      );
      const view = await sdk.threadView.getSessionThreadView({ threadId: "th_x", registryPath: target.registry });
      if (!view.ok) throw new Error(view.error.reason);
      expect(view.value.entries.some((e) => "role" in e && e.role === "toolResult")).toBe(false);
      expect(JSON.stringify(view.value.entries)).toContain("[lhc fork] copied from");
      const stored = await sdk.threadView.describe({ threadId: "th_x", registryPath: target.registry });
      expect(stored.ok && stored.value?.profileName).toBe("handoff");

      const suppressed = await main([
        ...common,
        "--source-host",
        "codex-lhc",
        "--host",
        "cc-lhc",
        "--session-id",
        "u-2",
        "--new-id",
        "th_y",
        "--no-compact",
      ]);
      expect(suppressed).toBe(0);
      expect(c.out.at(-1)).toMatch(/ compact=skipped \(suppressed\)\n$/);
      const none = await sdk.threadView.describe({ threadId: "th_y", registryPath: target.registry });
      expect(none.ok && none.value).toBeNull();

      const forced = await main([
        ...common,
        "--source-host",
        "cc-lhc",
        "--host",
        "cc-lhc",
        "--session-id",
        "u-3",
        "--new-id",
        "th_z",
        "--compact",
      ]);
      expect(forced).toBe(0);
      expect(c.out.at(-1)).toMatch(/ compact=[1-9]\d* \(forced\)\n$/);

      // hermes as a source: its own provider, so the fork compacts under handoff; as a target it is refused.
      const hermes = await main([
        ...common,
        "--source-host",
        "hermes",
        "--host",
        "cc-lhc",
        "--session-id",
        "u-4",
        "--new-id",
        "th_h",
      ]);
      expect(hermes).toBe(0);
      expect(c.out.at(-1)).toMatch(/^th_h \S+ claude-code:u-4 .* compact=[1-9]\d* \(hermes -> anthropic\)\n$/);
      expect(await main([...common, "--source-host", "cc-lhc", "--host", "hermes", "--session-id", "h"])).toBe(1);
      expect(c.err.at(-1)).toMatch(/^usage: host hermes is a source only/);

      // codex: no ids given, one uuid names the thread, the session, and the file.
      const codex = await main([...common, "--source-host", "cc-lhc", "--host", "codex-lhc"]);
      expect(codex).toBe(0);
      const line = c.out.at(-1) as string;
      const [id, filePath, fileName] = line.split(" ");
      expect(UUID.test(id as string)).toBe(true);
      expect(fileName).toBe(`${id}.sqlite`);
      expect(filePath).toBe(join(target.threadsDir, `${id}.sqlite`));
      expect(line).toContain("compact=");
      expect(line).toContain("(anthropic -> openai)");

      const disagree = await main([
        ...common,
        "--source-host",
        "cc-lhc",
        "--host",
        "codex-lhc",
        "--new-id",
        "0f0e0d0c-0b0a-4908-8706-050403020100",
        "--session-id",
        "other",
      ]);
      expect(disagree).toBe(2);
      expect(c.err.at(-1)).toMatch(/^invalid_thread_alias: /);

      const both = await main([
        ...common,
        "--source-host",
        "cc-lhc",
        "--host",
        "cc-lhc",
        "--session-id",
        "u-4",
        "--compact",
        "--no-compact",
      ]);
      expect(both).toBe(1);
      const missingSource = await main([...common, "--host", "cc-lhc", "--session-id", "u-5"]);
      expect(missingSource).toBe(1);
      expect(c.err.at(-1)).toMatch(/--source-host is required/);
    } finally {
      c.restore();
    }
  });
});

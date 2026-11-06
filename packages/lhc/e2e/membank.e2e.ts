import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  MembaseHandshakeError,
  type SdkConfig,
  type ThreadRef,
} from "../src/index.js";

const run = promisify(execFile);
const membaseRepo = process.env.MEMBASE_REPO ?? join(homedir(), "lim-v2/code/membase");
const laneScript = join(membaseRepo, ".agents/skills/verify-membase/scripts/lane.sh");
const bun = join(membaseRepo, "node_modules/.bin/bun");
const base: SdkConfig = {
  inferenceCallbacks: createDeterministicInferenceCallbacks(),
  tokenFamily: "o200k",
  mode: "manual",
};

const dir = mkdtempSync(join(tmpdir(), "lhc-membank-"));
const lane = join(dir, "lane");
const home = join(lane, "home");
const registryPath = join(dir, "registry.sqlite");
const started: ChildProcess[] = [];
const servers: Server[] = [];
let socketPath = "";
let laneUp = false;
let beforeEnroll: unknown;

const membase = async (...args: string[]) =>
  (
    await run(bun, ["packages/cli/src/main.ts", ...args], {
      cwd: membaseRepo,
      env: { ...process.env, MEMBASE_HOME: home },
    })
  ).stdout;

const handshakeFailure = async (socketPath: string) => {
  const startedAt = performance.now();
  const error = await initLhc({ ...base, membase: { socketPath } }).then(
    () => null,
    (cause: unknown) => cause,
  );
  return { error, ms: performance.now() - startedAt };
};

const newThread = async (sdk: Lhc, name: string): Promise<{ threadId: string; filePath: string; ref: ThreadRef }> => {
  const created = await sdk.threads.newThread({ filePath: join(dir, `${name}.sqlite`), registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  return { ...created.value, ref: { threadId: created.value.threadId, registryPath } };
};

const waitForSocket = async (path: string, child: ChildProcess) => {
  const deadline = performance.now() + 15_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null) throw new Error(`membase exited ${child.exitCode}`);
    if (performance.now() > deadline) throw new Error(`membase did not open ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

beforeAll(async () => {
  if (!existsSync(bun)) {
    throw new Error(
      `no installed membase checkout at ${membaseRepo}; run scripts/offline-install.sh there or set MEMBASE_REPO`,
    );
  }
  const up = (await run(laneScript, ["up", lane], { cwd: membaseRepo })).stdout;
  laneUp = true;
  socketPath = /socket (\S+)/.exec(up)?.[1] ?? "";
  beforeEnroll = (await handshakeFailure(socketPath)).error;
  const line = (await membase("enroll", "--name", "lhc-e2e")).trim();
  await membase("machine", "approve", "--yes", "--admin-key-file", join(lane, "convex/admin.key"), line);
  await membase("bank", "create", "books", "--description", "Fiction craft");
  await membase("bank", "create", "poems", "--description", "Verse");
  const items: [string, string, string, string][] = [
    ["lesson", "Present tense in scenes", "Scene prose stays in present tense", "Write every scene in present tense."],
    ["lesson", "Name the feeling late", "Show the cause before naming the feeling", "Let the reader feel it first."],
    ["skill", "Outline a chapter", "Beats first, then prose", "1. List the beats.\n2. Draft each beat."],
  ];
  for (const [kind, title, description, body] of items) {
    await membase(kind, "add", "--bank", "books", "--title", title, "--description", description, "--body", body);
  }
});

afterAll(async () => {
  for (const child of started) child.kill();
  for (const server of servers) server.close();
  if (laneUp) await run(laneScript, ["down", lane], { cwd: membaseRepo });
  rmSync(dir, { recursive: true, force: true });
});

describe("membank against a real membase", () => {
  it("refuses construction with membase_unavailable before the machine is enrolled", () => {
    expect(beforeEnroll).toBeInstanceOf(MembaseHandshakeError);
    expect(beforeEnroll).toMatchObject({ code: "membase_unavailable", name: "MembaseHandshakeError" });
    expect(String((beforeEnroll as Error).message)).toContain("NotEnrolled");
  });

  it("answers membank_not_configured on every operation of an SDK built without membase", async () => {
    const sdk = initLhc(base);
    const { ref } = await newThread(sdk, "plain");
    const results = await Promise.all([
      sdk.membank.attach(ref, "books"),
      sdk.membank.detach(ref),
      sdk.membank.attachment(ref),
      sdk.membank.list(ref),
      sdk.membank.get(ref, "L1"),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "membank_not_configured" } });
    }
  });

  it("attaches a thread, lists and gets every item, and detaches", async () => {
    const sdk = await initLhc({ ...base, membase: { socketPath } });
    const thread = await newThread(sdk, "attached");
    const { ref } = thread;

    expect(await sdk.membank.attachment(ref)).toMatchObject({ ok: false, error: { code: "not_attached" } });
    expect(await sdk.membank.list(ref)).toMatchObject({ ok: false, error: { code: "not_attached" } });
    expect(await sdk.membank.get(ref, "L1")).toMatchObject({ ok: false, error: { code: "not_attached" } });
    expect(await sdk.membank.detach(ref)).toMatchObject({ ok: false, error: { code: "not_attached" } });
    expect(await sdk.membank.attach(ref, "nope")).toMatchObject({ ok: false, error: { code: "bank_not_found" } });

    const attached = await sdk.membank.attach(ref, "books");
    expect(attached).toMatchObject({
      ok: true,
      value: { threadId: thread.threadId, bank: "books", machine: "lhc-e2e" },
    });
    expect(await sdk.membank.attach(ref, "books")).toMatchObject({ ok: true, value: { bank: "books" } });
    expect(await sdk.membank.attach(ref, "poems")).toMatchObject({
      ok: false,
      error: { code: "already_attached", reason: `AlreadyAttached threadId=${thread.threadId} bank=books` },
    });
    expect(await sdk.membank.attachment({ filePath: thread.filePath })).toEqual(attached);

    expect(await sdk.membank.list(ref, "lesson")).toEqual({
      ok: true,
      value: [
        {
          id: "L1",
          kind: "lesson",
          title: "Present tense in scenes",
          description: "Scene prose stays in present tense",
          status: "active",
        },
        {
          id: "L2",
          kind: "lesson",
          title: "Name the feeling late",
          description: "Show the cause before naming the feeling",
          status: "active",
        },
      ],
    });
    expect(await sdk.membank.list(ref, "skill")).toMatchObject({ ok: true, value: [{ id: "S1" }] });
    const all = await sdk.membank.list(ref);
    expect(all.ok && all.value.map((item) => item.id)).toEqual(["L1", "L2", "S1"]);

    const bodies: Record<string, string> = {
      L1: "Write every scene in present tense.",
      L2: "Let the reader feel it first.",
      S1: "1. List the beats.\n2. Draft each beat.",
    };
    for (const [id, body] of Object.entries(bodies)) {
      expect(await sdk.membank.get(ref, id)).toMatchObject({ ok: true, value: { id, body, citations: [] } });
    }
    expect(await sdk.membank.get(ref, "L9")).toMatchObject({
      ok: false,
      error: { code: "item_not_found", reason: "ItemNotFound bank=books id=L9" },
    });

    expect(await sdk.membank.detach(ref)).toEqual({ ok: true, value: { threadId: thread.threadId, bank: "books" } });
    expect(await sdk.membank.get(ref, "L1")).toMatchObject({ ok: false, error: { code: "not_attached" } });
  });

  it("refuses malformed input and unknown threads before calling membase", async () => {
    const sdk = await initLhc({ ...base, membase: { socketPath } });
    const { ref } = await newThread(sdk, "inputs");
    expect(await sdk.membank.get(ref, "X1")).toMatchObject({ ok: false, error: { code: "invalid_membank_input" } });
    expect(await sdk.membank.attach(ref, "my bank")).toMatchObject({
      ok: false,
      error: { code: "invalid_membank_input" },
    });
    expect(await sdk.membank.list(ref, "note" as "lesson")).toMatchObject({
      ok: false,
      error: { code: "invalid_membank_input" },
    });
    expect(await sdk.membank.list({ threadId: "th_0000000000000000", registryPath })).toMatchObject({
      ok: false,
      error: { code: "thread_not_found" },
    });
    const copied = await sdk.threads.copyThread({
      source: ref,
      filePath: join(dir, "copied.sqlite"),
      registryPath,
      newThreadId: "session/42",
    });
    expect(copied).toMatchObject({ ok: true, value: { threadId: "session/42" } });
    expect(await sdk.membank.attach({ threadId: "session/42", registryPath }, "books")).toMatchObject({
      ok: false,
      error: { code: "invalid_membank_input" },
    });
  });

  it("refuses construction with membase_version_mismatch when membase speaks another API version", async () => {
    const versionHome = join(dir, "v2");
    const versionSocket = join(dir, "v2.sock");
    mkdirSync(join(versionHome, "config"), { recursive: true });
    const convexUrl = readFileSync(join(lane, "convex/convex.url"), "utf8").trim();
    const secretFile = join(home, "config/machine.secret");
    writeFileSync(
      join(versionHome, "config/membase.json"),
      JSON.stringify({ socketPath: versionSocket, convexUrl, secretFile }),
    );
    const child = spawn(
      bun,
      ["--preload", join(import.meta.dirname, "membase-api-version.mjs"), "packages/service/src/main.ts"],
      {
        cwd: membaseRepo,
        env: { ...process.env, MEMBASE_HOME: versionHome, MEMBASE_FAKE_API_VERSION: "2" },
        stdio: "ignore",
      },
    );
    started.push(child);
    await waitForSocket(versionSocket, child);

    const { error } = await handshakeFailure(versionSocket);
    expect(error).toMatchObject({ name: "MembaseHandshakeError", code: "membase_version_mismatch" });
    expect(String((error as Error).message)).toContain("VersionMismatch server=2 client=1");
  });

  it("refuses construction with membase_unreachable when nothing answers on the socket", async () => {
    const missing = await handshakeFailure(join(dir, "missing.sock"));
    expect(missing.error).toMatchObject({ name: "MembaseHandshakeError", code: "membase_unreachable" });
    expect(String((missing.error as Error).message)).toContain("ENOENT");
    expect(missing.ms).toBeLessThan(5_000);

    const silentSocket = join(dir, "silent.sock");
    const silent = createServer(() => {});
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(silentSocket, resolve));
    const hung = await handshakeFailure(silentSocket);
    expect(hung.error).toMatchObject({ name: "MembaseHandshakeError", code: "membase_unreachable" });
    expect(String((hung.error as Error).message)).toContain("within 5000 ms");
  });

  it("refuses construction with membase_unavailable when the socket answers outside the contract", async () => {
    const crashingSocket = join(dir, "crashing.sock");
    const crashing = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { id } = JSON.parse(Buffer.concat(chunks).toString()) as { id: string };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            { _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "boom" }] } },
          ]),
        );
      });
    });
    servers.push(crashing);
    await new Promise<void>((resolve) => crashing.listen(crashingSocket, resolve));
    const { error } = await handshakeFailure(crashingSocket);
    expect(error).toMatchObject({ name: "MembaseHandshakeError", code: "membase_unavailable" });
    expect(String((error as Error).message)).toContain("answered outside its contract");
  });

  it("answers membase_unreachable from an SDK whose membase stopped after construction", async () => {
    const sdk = await initLhc({ ...base, membase: { socketPath } });
    const { ref } = await newThread(sdk, "stopped");
    await run(laneScript, ["down", lane], { cwd: membaseRepo });
    laneUp = false;
    expect(await sdk.membank.list(ref)).toMatchObject({ ok: false, error: { code: "membase_unreachable" } });
  });
});

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AttachmentHarvester,
  type AttachmentSource,
  attachmentStorePath,
  readAttachments,
} from "../src/capture/attachments.ts";
import { messageKeyPrefix } from "../src/capture/mapper.ts";
import { nativeSessionPath } from "../src/nativeSessionFile.ts";
import { type NativeEntry, PROJECTED_SOURCE_FIELD } from "../src/projection/project.ts";
import { ClaudeLhcSession } from "../src/session.ts";
import { fixtureGenerations, jsonl, withoutRestampedFields } from "./support/nativeFixture.ts";

const generations: { options: Options; input: AsyncIterator<SDKUserMessage>; emit(message: SDKMessage): void }[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  renameSession: async () => {},
  query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const out: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    const emit = (message: SDKMessage): void => {
      out.push(message);
      wake?.();
    };
    generations.push({ options, input: prompt[Symbol.asyncIterator](), emit });
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SDKMessage>> => {
          while (out.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          return { value: out.shift() as SDKMessage, done: false };
        },
      }),
      getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
      close: () => {},
    };
  },
}));

let dir = "";
let source: (sessionId: string) => AttachmentSource;
const { first: gen1, resumed: gen2 } = fixtureGenerations();

function writeTranscript(sessionId: string, body: string): string {
  const path = nativeSessionPath(source(sessionId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-attachments-"));
  mkdirSync(join(dir, "cwd"));
  const env = { CLAUDE_CONFIG_DIR: join(dir, "claude") };
  source = (sessionId) => ({ home: join(dir, "lhc"), threadId: "thread-1", sessionId, cwd: join(dir, "cwd"), env });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("harvestAttachments", () => {
  test("anchors each attachment after the first prompt to that prompt in file order, and the snapshot after the reply to the reply", async () => {
    writeTranscript(gen1.sessionId, jsonl(gen1.lines));
    const { found } = new AttachmentHarvester().harvest(source(gen1.sessionId));

    const prompt = gen1.lines.find((line) => line["type"] === "user");
    const reply = gen1.lines.find((line) => line["type"] === "assistant");
    const between = (from: NativeEntry | undefined, to: NativeEntry | undefined): NativeEntry[] =>
      gen1.lines
        .slice(gen1.lines.indexOf(from ?? {}), to === undefined ? undefined : gen1.lines.indexOf(to))
        .filter((line) => line["type"] === "attachment");
    const stored = await readAttachments(join(dir, "lhc"), "thread-1");
    expect([...stored.keys()]).toEqual([
      messageKeyPrefix(String(prompt?.["uuid"])),
      messageKeyPrefix(String(reply?.["uuid"])),
    ]);
    const promptAttachments = between(prompt, reply);
    expect(promptAttachments.map((line) => (line["attachment"] as NativeEntry)["type"])).toEqual(
      expect.arrayContaining(["environment", "model", "date"]),
    );
    expect(stored.get(messageKeyPrefix(String(prompt?.["uuid"])))).toEqual(
      promptAttachments.map((line) => ({
        uuid: line["uuid"],
        anchor: messageKeyPrefix(String(prompt?.["uuid"])),
        line: withoutRestampedFields(line),
      })),
    );
    const snapshots = stored.get(messageKeyPrefix(String(reply?.["uuid"]))) ?? [];
    expect(snapshots.map(({ line }) => (line["attachment"] as NativeEntry)["type"])).toEqual(["prompt_snapshot"]);
    expect(stored.get(messageKeyPrefix(String(prompt?.["uuid"])))?.[0]?.line["rendered"]).toEqual(
      promptAttachments[0]?.["rendered"],
    );
    expect(found).toBe(promptAttachments.length + snapshots.length);
  });

  test("skips every projected line and anchors the resumed generation's own attachments to its new prompt", async () => {
    writeTranscript(gen2.sessionId, jsonl(gen2.lines));
    new AttachmentHarvester().harvest(source(gen2.sessionId));

    const projected = new Set(
      gen2.lines.filter((line) => PROJECTED_SOURCE_FIELD in line).map((line) => String(line["uuid"])),
    );
    const prompt = gen2.lines.find((line) => line["type"] === "user" && !(PROJECTED_SOURCE_FIELD in line));
    const stored = [...(await readAttachments(join(dir, "lhc"), "thread-1")).values()].flat();
    expect(projected.size).toBeGreaterThan(0);
    expect(stored.some(({ uuid }) => projected.has(uuid))).toBe(false);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]?.anchor).toBe(messageKeyPrefix(String(prompt?.["uuid"])));
  });

  test("an unchanged transcript reads no bytes, and an appended turn reads only its own bytes", () => {
    const harvester = new AttachmentHarvester();
    const prefix = jsonl(gen2.lines.slice(0, 10));
    const path = writeTranscript(gen2.sessionId, prefix);
    const first = harvester.harvest(source(gen2.sessionId));

    expect(first.bytesRead).toBe(Buffer.byteLength(prefix));
    expect(harvester.harvest(source(gen2.sessionId))).toEqual({ found: 0, bytesRead: 0 });
    const appended = jsonl(gen2.lines.slice(10));
    appendFileSync(path, appended);
    const second = harvester.harvest(source(gen2.sessionId));
    expect(second.bytesRead).toBe(Buffer.byteLength(appended));
    const own = gen2.lines.filter((line) => line["type"] === "attachment" && !(PROJECTED_SOURCE_FIELD in line));
    expect(first.found + second.found).toBe(own.length);
    expect(second.found).toBeGreaterThan(0);
  });

  test("a later process harvesting the same transcript appends nothing", () => {
    writeTranscript(gen1.sessionId, jsonl(gen1.lines));
    const first = new AttachmentHarvester().harvest(source(gen1.sessionId));
    const size = statSync(attachmentStorePath(join(dir, "lhc"), "thread-1")).size;

    expect(first.found).toBeGreaterThan(0);
    expect(new AttachmentHarvester().harvest(source(gen1.sessionId)).found).toBe(0);
    expect(statSync(attachmentStorePath(join(dir, "lhc"), "thread-1")).size).toBe(size);
  });

  test("a store write that fails is retried by the next harvest in the same process", () => {
    const harvester = new AttachmentHarvester();
    writeTranscript(gen1.sessionId, jsonl(gen1.lines));
    mkdirSync(join(dir, "lhc"), { recursive: true });
    writeFileSync(join(dir, "lhc", "attachments"), "a file where the store's directory goes");

    expect(() => harvester.harvest(source(gen1.sessionId))).toThrow();
    rmSync(join(dir, "lhc", "attachments"));
    const retried = harvester.harvest(source(gen1.sessionId));
    expect(retried.found).toBe(gen1.lines.filter((line) => line["type"] === "attachment").length);
  });

  test("a torn transcript tail is read once it is whole", async () => {
    const harvester = new AttachmentHarvester();
    const body = jsonl(gen1.lines);
    const last = gen1.lines.filter((line) => line["type"] === "attachment").at(-1);
    const cut = body.indexOf(JSON.stringify(last)) + 40;
    const path = writeTranscript(gen1.sessionId, body.slice(0, cut));
    const torn = harvester.harvest(source(gen1.sessionId));

    writeFileSync(path, body);
    const whole = harvester.harvest(source(gen1.sessionId));
    expect(whole.found).toBe(1);
    expect(torn.bytesRead + whole.bytesRead).toBe(Buffer.byteLength(body) + (cut - body.lastIndexOf("\n", cut) - 1));
    const stored = [...(await readAttachments(join(dir, "lhc"), "thread-1")).values()].flat();
    expect(stored.at(-1)?.uuid).toBe(last?.["uuid"]);
  });

  test("a torn store tail left by a crashed process is skipped, and the next process appends after it", async () => {
    const body = jsonl(gen1.lines);
    const last = gen1.lines.filter((line) => line["type"] === "attachment").at(-1);
    const path = writeTranscript(gen1.sessionId, body.slice(0, body.indexOf(JSON.stringify(last))));
    const before = new AttachmentHarvester().harvest(source(gen1.sessionId)).found;
    appendFileSync(attachmentStorePath(join(dir, "lhc"), "thread-1"), '{"uuid":"torn","anch');

    writeFileSync(path, body);
    expect(new AttachmentHarvester().harvest(source(gen1.sessionId)).found).toBe(1);
    const stored = [...(await readAttachments(join(dir, "lhc"), "thread-1")).values()].flat();
    expect(stored).toHaveLength(before + 1);
    expect(stored.at(-1)?.uuid).toBe(last?.["uuid"]);
  });

  test("a generation with no transcript yet harvests nothing", async () => {
    expect(new AttachmentHarvester().harvest(source("no-such-session"))).toEqual({ found: 0, bytesRead: 0 });
    expect((await readAttachments(join(dir, "lhc"), "thread-1")).size).toBe(0);
  });
});

test("a store that cannot be written or read is logged, and the turn and the next resume go on", async () => {
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
  generations.length = 0;
  const frames: SDKMessage[] = [];
  const logs: string[] = [];
  const io = {
    emit: (message: SDKMessage) => void frames.push(message),
    request: async () => ({}),
    end(): void {},
    fail(message: string): void {
      throw new Error(message);
    },
    log: (line: string) => void logs.push(line),
  };
  const session = new ClaudeLhcSession(io);
  const { cwd, env } = source(gen1.sessionId);
  await session.start({
    cwd,
    model: "claude-sonnet-5",
    sessionId: gen1.sessionId,
    env,
    lhc: { home: join(dir, "lhc"), compact: { trigger: 500_000, target: 180_000 } },
  });
  writeTranscript(gen1.sessionId, jsonl(gen1.lines));
  writeFileSync(join(dir, "lhc", "attachments"), "a file where the store's directory goes");

  await session.pushUser({ type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null });
  const live = generations[0];
  await live?.input.next();
  live?.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    uuid: randomUUID(),
    session_id: "",
  } as unknown as SDKMessage);
  await vi.waitFor(() => expect(frames.some((frame) => frame.type === "result")).toBe(true));

  expect(logs).toContainEqual(
    expect.stringMatching(new RegExp(`^attachments: harvest from ${gen1.sessionId} failed: `)),
  );
  await session.close();

  const resumed = new ClaudeLhcSession(io);
  await resumed.start({ cwd, model: "claude-sonnet-5", resume: gen1.sessionId, env, lhc: { home: join(dir, "lhc") } });
  expect(generations).toHaveLength(2);
  expect(logs).toContainEqual(
    expect.stringMatching(/^attachments: read for thread \S+ failed: .*; projecting without them$/),
  );
  await resumed.close();
});

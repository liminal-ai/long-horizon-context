import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AttachmentSource,
  attachmentStorePath,
  harvestAttachments,
  readAttachments,
} from "../src/capture/attachments.ts";
import { messageKeyPrefix } from "../src/capture/mapper.ts";
import { nativeSessionPath } from "../src/nativeSessionFile.ts";
import { type NativeEntry, PROJECTED_SOURCE_FIELD } from "../src/projection/project.ts";
import { fixtureGenerations, jsonl, withoutEnvelope } from "./support/nativeFixture.ts";

let dir = "";
let source: (sessionId: string) => AttachmentSource;
const logs: string[] = [];
const log = (line: string): void => void logs.push(line);
const [gen1, gen2] = fixtureGenerations();

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
  logs.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("harvestAttachments", () => {
  test("anchors each attachment after the first prompt to that prompt in file order, and the snapshot after the reply to the reply", async () => {
    writeTranscript(gen1.sessionId, jsonl(gen1.lines));
    await harvestAttachments(source(gen1.sessionId), log);

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
        line: withoutEnvelope(line),
      })),
    );
    const snapshots = stored.get(messageKeyPrefix(String(reply?.["uuid"]))) ?? [];
    expect(snapshots.map(({ line }) => (line["attachment"] as NativeEntry)["type"])).toEqual(["prompt_snapshot"]);
    expect(stored.get(messageKeyPrefix(String(prompt?.["uuid"])))?.[0]?.line["rendered"]).toEqual(
      promptAttachments[0]?.["rendered"],
    );
    expect(logs).toEqual([
      expect.stringMatching(
        new RegExp(
          `^attachments: ${promptAttachments.length + snapshots.length} new from ${gen1.sessionId} in \\d+ ms$`,
        ),
      ),
    ]);
  });

  test("skips every projected line and anchors the resumed generation's own attachments to its new prompt", async () => {
    writeTranscript(gen2.sessionId, jsonl(gen2.lines));
    await harvestAttachments(source(gen2.sessionId), log);

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

  test("a second harvest of the same transcript appends nothing", async () => {
    writeTranscript(gen1.sessionId, jsonl(gen1.lines));
    const first = await harvestAttachments(source(gen1.sessionId), log);
    const size = statSync(attachmentStorePath(join(dir, "lhc"), "thread-1")).size;

    expect(first).toBeGreaterThan(0);
    expect(await harvestAttachments(source(gen1.sessionId), log)).toBe(0);
    expect(statSync(attachmentStorePath(join(dir, "lhc"), "thread-1")).size).toBe(size);
    expect(logs[1]).toMatch(new RegExp(`^attachments: 0 new from ${gen1.sessionId} in \\d+ ms$`));
  });

  test("a torn last line is skipped in the transcript and in the store, and the next harvest takes the line once it is whole", async () => {
    const body = jsonl(gen1.lines);
    const last = gen1.lines.filter((line) => line["type"] === "attachment").at(-1);
    const cut = body.indexOf(JSON.stringify(last)) + 40;
    const path = writeTranscript(gen1.sessionId, body.slice(0, cut));
    const torn = await harvestAttachments(source(gen1.sessionId), log);
    appendFileSync(attachmentStorePath(join(dir, "lhc"), "thread-1"), '{"uuid":"torn","anch');

    writeFileSync(path, body);
    expect(await harvestAttachments(source(gen1.sessionId), log)).toBe(1);
    const stored = [...(await readAttachments(join(dir, "lhc"), "thread-1")).values()].flat();
    expect(stored).toHaveLength(torn + 1);
    expect(stored.at(-1)?.uuid).toBe(last?.["uuid"]);
  });

  test("a generation with no transcript yet harvests nothing", async () => {
    expect(await harvestAttachments(source("no-such-session"), log)).toBe(0);
    expect((await readAttachments(join(dir, "lhc"), "thread-1")).size).toBe(0);
    expect(logs).toEqual([expect.stringMatching(/^attachments: 0 new from no-such-session in \d+ ms$/)]);
  });
});

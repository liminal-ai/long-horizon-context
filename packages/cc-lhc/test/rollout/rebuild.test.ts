import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionThreadView, SessionThreadViewEntry } from "lhc";
import { describe, expect, it } from "vitest";

import {
  buildRolloutLines,
  envelopeFromRolloutLine,
  firstUserPrompt,
  parseRolloutEnvelopeFromContent,
  serializeRolloutLines,
} from "../../src/rollout/rebuild.js";
import {
  appendSessionsIndexEntry,
  loadSessionsIndexForAppend,
  readSessionsIndex,
  SESSIONS_INDEX_UNREADABLE_MESSAGE,
  sessionsIndexTempPath,
} from "../../src/rollout/sessions-index.js";
import { writeRebuiltRollout } from "../../src/rollout/write-rebuilt.js";

const sampleEntries: SessionThreadViewEntry[] = [
  { role: "user", content: "hello", sourceMessages: [] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi there" },
    ],
    sourceMessages: [],
  },
  {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "Bash",
    content: "output",
    sourceMessages: [],
  },
];

describe("buildRolloutLines", () => {
  it("maps view entries to uuid-linked rollout lines with envelope fields", () => {
    const sessionId = "new-session-id";
    const lines = buildRolloutLines({
      entries: sampleEntries,
      newSessionId: sessionId,
      envelope: {
        cwd: "/work/project",
        version: "2.1.201",
        gitBranch: "main",
        assistantModel: "claude-opus-4-6",
        dualSessionIdFields: true,
      },
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]?.line.parentUuid).toBeNull();
    expect(lines[1]?.line.parentUuid).toBe(lines[0]?.line.uuid);
    expect(lines[2]?.line.parentUuid).toBe(lines[1]?.line.uuid);
    for (const entry of lines) {
      expect(entry.line.sessionId).toBe(sessionId);
      expect(entry.line.session_id).toBe(sessionId);
      expect(entry.line.cwd).toBe("/work/project");
      expect(entry.line.version).toBe("2.1.201");
      expect(entry.line.isSidechain).toBe(false);
    }
    expect(lines[0]?.line.type).toBe("user");
    expect(lines[0]?.line.message?.content).toBe("hello");
    expect(lines[1]?.line.type).toBe("assistant");
    expect(lines[1]?.line.message).toMatchObject({
      role: "assistant",
      type: "message",
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "[thinking]\nhmm\n\nhi there" }],
    });
    expect(typeof lines[1]?.line.message?.id).toBe("string");
    expect(String(lines[1]?.line.message?.id)).toMatch(/^msg_/);
    expect(lines[2]?.line.type).toBe("user");
    expect(lines[2]?.line.message?.content).toBe("output");
  });

  it("serializes one JSON object per line", () => {
    const lines = buildRolloutLines({
      entries: [{ role: "user", content: "one", sourceMessages: [] }],
      newSessionId: "sid",
      envelope: { cwd: "/w" },
    });
    const serialized = serializeRolloutLines(lines);
    const parsed = serialized.trim().split("\n").map((line) => JSON.parse(line) as { type?: string });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("user");
  });
});

describe("parseRolloutEnvelopeFromContent", () => {
  it("copies envelope scalars and assistant model from source rollout", () => {
    const content = [
      '{"type":"mode","mode":"normal"}',
      '{"type":"user","version":"2.1.201","gitBranch":"main","session_id":"old","cwd":"/work/project","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","version":"2.1.201","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"ok"}]}}',
    ].join("\n");
    const envelope = parseRolloutEnvelopeFromContent(content, "/work/project");
    expect(envelope.version).toBe("2.1.201");
    expect(envelope.gitBranch).toBe("main");
    expect(envelope.dualSessionIdFields).toBe(true);
    expect(envelope.assistantModel).toBe("claude-sonnet-4-6");
  });

  it("detects dual session id fields from a rollout line", () => {
    const envelope = envelopeFromRolloutLine(
      { type: "user", session_id: "abc", cwd: "/w" },
      "/w",
    );
    expect(envelope.dualSessionIdFields).toBe(true);
  });
});

describe("loadSessionsIndexForAppend", () => {
  it("aborts when an existing index file is unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-index-abort-"));
    const projectDir = join(root, "proj");
    mkdirSync(projectDir, { recursive: true });
    const indexPath = join(projectDir, "sessions-index.json");
    await writeFile(indexPath, "{not json");

    await expect(loadSessionsIndexForAppend(projectDir)).rejects.toThrow(SESSIONS_INDEX_UNREADABLE_MESSAGE);
    expect(readFileSync(indexPath, "utf8")).toBe("{not json");
    expect(existsSync(`${indexPath}.bak`)).toBe(false);
  });

  it("uses unique temp filenames for index writes", () => {
    const a = sessionsIndexTempPath("/tmp/sessions-index.json");
    const b = sessionsIndexTempPath("/tmp/sessions-index.json");
    expect(a).not.toBe(b);
    expect(a).toContain(String(process.pid));
  });
});

describe("writeRebuiltRollout", () => {
  it("writes rollout file, appends index entry, and creates .bak", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rebuild-"));
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, "-work-project");
    mkdirSync(projectDir, { recursive: true });
    const indexPath = join(projectDir, "sessions-index.json");
    await writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: "old",
            fullPath: join(projectDir, "old.jsonl"),
            fileMtime: 1,
            firstPrompt: "old",
            summary: "old",
            messageCount: 1,
            created: "2026-01-01T00:00:00.000Z",
            modified: "2026-01-01T00:00:00.000Z",
            projectPath: "/work/project",
            isSidechain: false,
          },
        ],
      }),
    );

    const sourcePath = join(projectDir, "source.jsonl");
    await writeFile(
      sourcePath,
      `${JSON.stringify({
        type: "assistant",
        version: "2.1.201",
        gitBranch: "dev",
        sessionId: "source",
        cwd: "/work/project",
        message: { role: "assistant", model: "claude-opus-4-6", content: [{ type: "text", text: "seed" }] },
      })}\n`,
    );

    const view: SessionThreadView = {
      threadId: "th_1",
      entries: sampleEntries,
    };

    const result = await writeRebuiltRollout({
      view,
      cwd: "/work/project",
      newSessionId: "rebuilt-session",
      projectsRoot,
      sourceRolloutPath: sourcePath,
      deps: {
        copyFileFn: copyFile,
      },
    });

    expect(existsSync(result.rolloutPath)).toBe(true);
    expect(result.lineCount).toBe(3);

    const index = await readSessionsIndex(projectDir);
    const entry = index.entries.find((item) => item.sessionId === "rebuilt-session");
    expect(entry).toMatchObject({
      sessionId: "rebuilt-session",
      fullPath: result.rolloutPath,
      messageCount: 3,
      projectPath: "/work/project",
      isSidechain: false,
    });
    expect(existsSync(`${indexPath}.bak`)).toBe(true);

    const rolloutContent = readFileSync(result.rolloutPath, "utf8");
    const firstLine = JSON.parse(rolloutContent.split("\n")[0]!) as {
      version?: string;
      message?: { content?: string };
    };
    expect(firstLine.version).toBe("2.1.201");
    expect(firstLine.message?.content).toBe("hello");
  });

  it("does not write rollout when sessions-index is unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rebuild-abort-"));
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, "-work-project");
    mkdirSync(projectDir, { recursive: true });
    await writeFile(join(projectDir, "sessions-index.json"), "broken");

    await expect(
      writeRebuiltRollout({
        view: { threadId: "th", entries: sampleEntries },
        cwd: "/work/project",
        newSessionId: "should-not-exist",
        projectsRoot,
      }),
    ).rejects.toThrow(SESSIONS_INDEX_UNREADABLE_MESSAGE);

    expect(existsSync(join(projectDir, "should-not-exist.jsonl"))).toBe(false);
  });
});

describe("appendSessionsIndexEntry", () => {
  it("creates a backup before modifying an existing index", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-index-"));
    const projectDir = join(root, "proj");
    mkdirSync(projectDir, { recursive: true });
    const indexPath = join(projectDir, "sessions-index.json");
    await writeFile(indexPath, JSON.stringify({ version: 1, entries: [] }));

    const rolloutPath = join(projectDir, "new.jsonl");
    await writeFile(rolloutPath, "line\n");

    await appendSessionsIndexEntry({
      projectDir,
      sessionId: "new",
      sessionFilePath: rolloutPath,
      firstPrompt: "prompt",
      messageCount: 1,
      projectPath: "/work",
    });

    expect(existsSync(`${indexPath}.bak`)).toBe(true);
    const index = await readSessionsIndex(projectDir);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.sessionId).toBe("new");
  });
});

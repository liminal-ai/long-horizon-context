import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionThreadView, SessionThreadViewEntry } from "lhc";
import { describe, expect, it } from "vitest";

import {
  buildRolloutLines,
  envelopeFromRolloutLine,
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
  it("maps view entries to uuid-linked NATIVE rollout lines (one block per line, shared message id)", () => {
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

    // Selected thinking rebuild arm is omit: [user, text, toolResult] — no thinking line,
    // and never invent signature:"".
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

    // native per-block assistant lines: text only under omit arm
    expect(lines[1]?.line.type).toBe("assistant");
    expect(lines[1]?.line.message).toMatchObject({
      role: "assistant",
      type: "message",
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hi there" }],
    });
    expect(JSON.stringify(lines)).not.toContain('"type":"thinking"');
    expect(JSON.stringify(lines)).not.toContain('signature":""');
    expect(String(lines[1]?.line.message?.id)).toMatch(/^msg_/);

    // tool result is a native tool_result block paired by tool_use_id
    expect(lines[2]?.line.type).toBe("user");
    expect(lines[2]?.line.message?.content).toEqual([
      { type: "tool_result", tool_use_id: "tool-1", content: "output", is_error: false },
    ]);
  });

  it("signed_verbatim arm emits captured signature and never invents empty signature", () => {
    const lines = buildRolloutLines({
      entries: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", thinkingSignature: "OPAQUE_SIG" },
            { type: "text", text: "hi" },
          ],
          sourceMessages: [],
        },
      ],
      newSessionId: "sid",
      envelope: { cwd: "/w", assistantModel: "claude-opus-4-6" },
      thinkingRebuildArm: "signed_verbatim",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.line.message?.content).toEqual([
      { type: "thinking", thinking: "", signature: "OPAQUE_SIG" },
    ]);
  });

  it("production omit projection: signed-empty and non-empty thinking omitted; text/tools/parent chain exact", () => {
    const entries: SessionThreadViewEntry[] = [
      { role: "user", content: "list files", sourceMessages: [] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "OPAQUE_EMPTY_SIGNED" },
          { type: "thinking", thinking: "I should run ls", thinkingSignature: "OPAQUE_NONEMPTY" },
          { type: "text", text: "Listing." },
          { type: "toolCall", toolCallId: "toolu_01XX", toolName: "Bash", arguments: { command: "ls" } },
        ],
        sourceMessages: [],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_01XX",
        toolName: "Bash",
        content: "a.txt",
        sourceMessages: [],
      },
    ];
    const lines = buildRolloutLines({
      entries,
      newSessionId: "omit-sid",
      envelope: { cwd: "/w", assistantModel: "claude-sonnet-5", dualSessionIdFields: true },
      // production selected arm
    });
    // user + text + tool_use + tool_result (both thinking blocks omitted)
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.rolloutType)).toEqual(["user", "assistant", "assistant", "user"]);
    expect(lines[0]?.line.message?.content).toBe("list files");
    expect(lines[1]?.line.message?.content).toEqual([{ type: "text", text: "Listing." }]);
    expect(lines[2]?.line.message?.content).toEqual([
      { type: "tool_use", id: "toolu_01XX", name: "Bash", input: { command: "ls" } },
    ]);
    expect(lines[3]?.line.message?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01XX", content: "a.txt", is_error: false },
    ]);
    // parent chain
    expect(lines[0]?.line.parentUuid).toBeNull();
    expect(lines[1]?.line.parentUuid).toBe(lines[0]?.line.uuid);
    expect(lines[2]?.line.parentUuid).toBe(lines[1]?.line.uuid);
    expect(lines[3]?.line.parentUuid).toBe(lines[2]?.line.uuid);
    // shared message id across assistant parts
    expect(lines[1]?.line.message?.id).toBe(lines[2]?.line.message?.id);
    const raw = JSON.stringify(lines);
    expect(raw).not.toMatch(/"type":"thinking"/);
    expect(raw).not.toMatch(/"signature":""/);
    expect(raw).not.toContain("OPAQUE_EMPTY_SIGNED");
    expect(raw).not.toContain("OPAQUE_NONEMPTY");
  });

  it("unsigned_visible arm retains non-empty thinking without inventing signature (uncertified alternate)", () => {
    const lines = buildRolloutLines({
      entries: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "visible", thinkingSignature: "SHOULD_NOT_EMIT_WHEN_UNSIGNED_ARM" },
            { type: "text", text: "ok" },
          ],
          sourceMessages: [],
        },
      ],
      newSessionId: "sid",
      envelope: { cwd: "/w", assistantModel: "m" },
      thinkingRebuildArm: "unsigned_visible",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.line.message?.content).toEqual([{ type: "thinking", thinking: "visible" }]);
    expect(JSON.stringify(lines[0]?.line.message?.content)).not.toContain("signature");
    // empty thinking omitted under unsigned_visible
    const emptyOnly = buildRolloutLines({
      entries: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", thinkingSignature: "SIG" }],
          sourceMessages: [],
        },
      ],
      newSessionId: "sid",
      envelope: { cwd: "/w" },
      thinkingRebuildArm: "unsigned_visible",
    });
    expect(emptyOnly).toHaveLength(0);
  });

  it("emits native tool_use blocks with verbatim id/name/input and stop_reason tool_use", () => {
    const lines = buildRolloutLines({
      entries: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "running it" },
            { type: "toolCall", toolCallId: "toolu_01AB", toolName: "Bash", arguments: { command: "ls" } },
          ],
          sourceMessages: [],
        },
      ],
      newSessionId: "sid",
      envelope: { cwd: "/w", assistantModel: "claude-opus-4-6" },
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]?.line.message?.stop_reason).toBe("tool_use");
    expect(lines[1]?.line.message).toMatchObject({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_01AB", name: "Bash", input: { command: "ls" } }],
    });
    expect(lines[1]?.line.message?.id).toBe(lines[0]?.line.message?.id);
    // no bracket-label text anywhere in a native rebuild
    expect(JSON.stringify(lines)).not.toContain("[tool ");
    expect(JSON.stringify(lines)).not.toContain("[thinking]");
  });

  it("stamps model_change onto subsequent assistant lines and skips thinking_level_change", () => {
    const lines = buildRolloutLines({
      entries: [
        {
          role: "assistant",
          content: [{ type: "text", text: "before" }],
          sourceMessages: [],
        },
        { kind: "model_change", provider: "anthropic", modelId: "claude-fable-5", sourceMessages: [] },
        { kind: "thinking_level_change", level: "high", sourceMessages: [] },
        {
          role: "assistant",
          content: [{ type: "text", text: "after" }],
          sourceMessages: [],
        },
      ],
      newSessionId: "sid",
      envelope: { cwd: "/w", assistantModel: "claude-opus-4-6" },
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]?.line.message?.model).toBe("claude-opus-4-6");
    expect(lines[1]?.line.message?.model).toBe("claude-fable-5");
  });

  it("marks tool_result errors with is_error", () => {
    const lines = buildRolloutLines({
      entries: [{ role: "toolResult", toolCallId: "tool-9", content: "boom", isError: true, sourceMessages: [] }],
      newSessionId: "sid",
      envelope: { cwd: "/w" },
    });
    expect(lines[0]?.line.message?.content).toEqual([
      { type: "tool_result", tool_use_id: "tool-9", content: "boom", is_error: true },
    ]);
    expect(JSON.stringify(lines)).not.toContain("[tool error]");
  });

  it("serializes one JSON object per line", () => {
    const lines = buildRolloutLines({
      entries: [{ role: "user", content: "one", sourceMessages: [] }],
      newSessionId: "sid",
      envelope: { cwd: "/w" },
    });
    const serialized = serializeRolloutLines(lines);
    const parsed = serialized
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string });
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
    const envelope = envelopeFromRolloutLine({ type: "user", session_id: "abc", cwd: "/w" }, "/w");
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
    // omit arm: [user, text, toolResult]
    expect(result.lineCount).toBe(3);

    const index = await readSessionsIndex(projectDir);
    const entry = index.entries.find((item) => item.sessionId === "rebuilt-session");
    expect(entry).toMatchObject({
      sessionId: "rebuilt-session",
      messageCount: 3,
      fullPath: result.rolloutPath,
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

  it("appends the swap receipt as a trailing runtime-note user line when requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-rebuild-receipt-"));
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, "-work-project");
    mkdirSync(projectDir, { recursive: true });

    const result = await writeRebuiltRollout({
      view: { threadId: "th_1", entries: sampleEntries },
      cwd: "/work/project",
      newSessionId: "rebuilt-session",
      projectsRoot,
      swapReceipt: { oldSessionId: "old-session" },
    });

    // omit arm: 3 content lines + receipt = 4. Receipt is NEW history (not prefix).
    expect(result.lineCount).toBe(4);
    expect(result.expectedReintakeLines).toBe(4);
    // ...but it is NEW history, not served-view replay: the handoff capture
    // must map it (as runtime_note) instead of hard-skipping it as prefix.
    expect(result.replayedPrefixLines).toBe(3);

    const lines = readFileSync(result.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            uuid?: string;
            parentUuid?: string | null;
            message?: { content?: unknown };
          },
      );
    expect(lines).toHaveLength(4);
    const receipt = lines[3]!;
    expect(receipt.type).toBe("user");
    expect(receipt.parentUuid).toBe(lines[2]!.uuid);
    expect(receipt.message?.content).toBe(
      "[runtime note] session old-session preserved; LHC view rebuilt as rebuilt-session (expect ~4 lines); relaunch with cc-lhc --resume rebuilt-session",
    );

    // First prompt shown in the sessions index stays the conversation opener, not the receipt.
    const index = await readSessionsIndex(projectDir);
    const entry = index.entries.find((item) => item.sessionId === "rebuilt-session");
    expect(entry).toMatchObject({ messageCount: 4, firstPrompt: "hello" });
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

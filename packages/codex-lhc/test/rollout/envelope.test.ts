import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSessionMetaLine, readRolloutEnvelope } from "../../src/rollout/envelope.js";

describe("parseSessionMetaLine", () => {
  it("parses current session_meta with session_id", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-07T11:09:02.776Z",
      type: "session_meta",
      payload: {
        session_id: "019f3c44-62fa-7161-975a-3f456e028ff4",
        id: "019f3c44-62fa-7161-975a-3f456e028ff4",
        cwd: "/work/project",
        originator: "codex_exec",
        cli_version: "0.142.5",
      },
    });

    expect(parseSessionMetaLine(line)).toEqual({
      sessionId: "019f3c44-62fa-7161-975a-3f456e028ff4",
      cwd: "/work/project",
      originator: "codex_exec",
      cliVersion: "0.142.5",
    });
  });

  it("falls back to payload.id when session_id is absent", () => {
    const line = JSON.stringify({
      timestamp: "2026-04-11T18:40:05.000Z",
      type: "session_meta",
      payload: {
        id: "019d7eb3-c9c9-7be0-9edf-9920bff15b94",
        cwd: "/legacy/project",
        originator: "codex-tui",
        cli_version: "0.115.0",
      },
    });

    expect(parseSessionMetaLine(line)).toEqual({
      sessionId: "019d7eb3-c9c9-7be0-9edf-9920bff15b94",
      cwd: "/legacy/project",
      originator: "codex-tui",
      cliVersion: "0.115.0",
    });
  });

  it("returns null for garbled or non-session_meta first lines", () => {
    expect(parseSessionMetaLine("")).toBeNull();
    expect(parseSessionMetaLine("{not json")).toBeNull();
    expect(parseSessionMetaLine(JSON.stringify({ type: "event_msg", payload: {} }))).toBeNull();
    expect(
      parseSessionMetaLine(
        JSON.stringify({
          type: "session_meta",
          payload: { id: "019d7eb3-c9c9-7be0-9edf-9920bff15b94" },
        }),
      ),
    ).toBeNull();
  });
});

describe("readRolloutEnvelope", () => {
  it("reads the first line from a rollout file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-lhc-envelope-"));
    const filePath = join(dir, "rollout.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            session_id: "019f3c44-62fa-7161-975a-3f456e028ff4",
            cwd: "/work/project",
            originator: "codex_exec",
            cli_version: "0.142.5",
          },
        }),
        JSON.stringify({ type: "event_msg", payload: {} }),
      ].join("\n"),
    );

    expect(await readRolloutEnvelope(filePath)).toEqual({
      sessionId: "019f3c44-62fa-7161-975a-3f456e028ff4",
      cwd: "/work/project",
      originator: "codex_exec",
      cliVersion: "0.142.5",
    });
  });

  it("returns null when the first line is garbled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-lhc-envelope-"));
    const filePath = join(dir, "broken.jsonl");
    writeFileSync(filePath, "not-json\n");

    expect(await readRolloutEnvelope(filePath)).toBeNull();
  });
});

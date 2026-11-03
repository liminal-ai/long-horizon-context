import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { TranscriptLine } from "../sidecar/src/capture/transcript.ts";
import { events, type Harness, harness, record, recorder, SESSION, writeTranscript } from "./fixture.ts";

// A stop mid-Bash, then `claude -p --resume`: live capture recorded the call's result, which never reached the
// transcript, and Claude Code wrote a replacement result for the same call on resume.
const lines = readFileSync(join(import.meta.dirname, "fixtures", "interrupted-resume-duplicate-result.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as TranscriptLine);
const CALL = "toolu_01KJvbP5LprZbWtXykT1Wm81";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

it("keeps the first recorded result when a resumed transcript replaces an interrupted call's result", async () => {
  writeTranscript(h, lines.slice(0, 2));
  const live = await recorder(h);
  const content = [{ type: "tool_result", tool_use_id: CALL, content: "Exit code 137", is_error: true }];
  await live.capture([
    {
      kind: "row",
      sessionId: SESSION,
      uuid: "de89522d-1a15-4865-9b06-cc551044b4d6",
      door: "tool-result",
      origin: "composer",
      message: { type: "user", role: "user", content },
      at: 0,
    },
  ]);
  live.release();

  writeTranscript(h, lines);
  const resumed = await record(h, "resume");
  if (resumed.kind !== "recording") throw new Error(JSON.stringify(resumed));
  const results = [...(await events(resumed.recorder))].filter(([key]) => key.endsWith(":tool_result"));

  expect(results.map(([, payload]) => [payload.toolCallId, payload.content])).toEqual([[CALL, "Exit code 137"]]);
});

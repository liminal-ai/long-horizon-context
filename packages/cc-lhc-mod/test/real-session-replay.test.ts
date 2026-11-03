import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CaptureEntry } from "../src/capture.ts";
import { harness, messages, recorder, writeTranscript } from "./fixture.ts";

const lines = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

it("a real session's engine-id end, from before a reload, cannot split a later recovered turn", async () => {
  const rows = lines("reload-later-turn-transcript.jsonl");
  const markers = lines("reload-later-turn-markers.jsonl") as CaptureEntry[];
  const end = markers.find((marker) => marker.kind === "turn-end");
  const answer = markers.find((marker) => marker.kind === "row");
  if (end === undefined || answer === undefined || answer.kind !== "row") throw new Error("fixture lacks its markers");
  const h = harness();
  try {
    writeTranscript(
      h,
      rows.slice(
        0,
        rows.findIndex((row) => row.uuid === answer.uuid),
      ),
    );
    const r = await recorder(h);
    expect(r.isTurnOpen).toBe(true);
    await r.capture([end]);
    const wasOpen = r.isTurnOpen;
    writeTranscript(h, rows);
    await r.capture([answer]);

    const got = await messages(r);
    const prompt = got.find((m) => m.includes("user_prompt") && m.includes("RELOAD_TOOL_OK"))?.split(" ")[0];
    expect(got).toContain(`${prompt} assistant_text RELOAD_DONE`);
    expect(wasOpen).toBe(true);
    r.release();
  } finally {
    h.cleanup();
  }
});

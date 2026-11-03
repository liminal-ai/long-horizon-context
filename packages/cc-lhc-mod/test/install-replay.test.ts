import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { answerCompact } from "../sidecar/src/compact.ts";
import { type Harness, harness, messages, recorder, SESSION, writeTranscript } from "./fixture.ts";

const homes: Harness[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});
it("replays a real interactive manual install as projection: no reopened turn, no second /compact note", async () => {
  const h = harness();
  homes.push(h);
  const lines = readFileSync(join(import.meta.dirname, "fixtures", "lhc-manual-compact-transcript.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s))
    .filter((r) => typeof r.uuid === "string");
  const first = lines.findIndex((r) => r.subtype === "compact_boundary");
  const next = lines.findIndex((r, i) => i > first && r.type === "user" && r.message?.content === "/compact");
  writeTranscript(h, lines.slice(0, first));
  const r = await recorder(h);
  const before = await messages(r);
  expect(before.filter((x) => x.includes("runtime_note /compact"))).toHaveLength(1);
  const answer = await answerCompact(r, { sessionId: SESSION, trigger: "manual", target: 140000 }, () => {});
  if (answer.kind !== "view") throw new Error(answer.reason);
  writeTranscript(h, lines.slice(0, next));
  await r.recover();
  await r.recover();
  const after = await messages(r);
  expect.soft(after).toEqual(before);
  expect(r.isTurnOpen).toBe(false);
});

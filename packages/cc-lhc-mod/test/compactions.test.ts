import { expect, it } from "vitest";
import { NATIVE_SUMMARY_LABEL } from "../sidecar/src/capture/map.ts";
import type { Recorder } from "../sidecar/src/capture/recorder.ts";
import { events, harness, messages, recorder, Script, writeTranscript } from "./fixture.ts";

/** Live hooks never see a native compaction's summary; recovery records it as one labeled note. */
const summaries = (recorded: string[]): number => recorded.filter((x) => x.includes(NATIVE_SUMMARY_LABEL)).length;
const withoutSummaries = (recorded: string[]): string[] => recorded.filter((x) => !x.includes(NATIVE_SUMMARY_LABEL));

const prompts = async (r: Recorder) =>
  (await messages(r)).filter((x) => x.includes("user_prompt")).map((x) => x.split("user_prompt ")[1] ?? "");
for (const compactCount of [1, 2])
  for (const depth of [0, 1, 2, 4])
    it(`round3: ${compactCount} compactions, rewind after ${depth} postcompact turns`, async () => {
      const h = harness();
      try {
        const s = new Script();
        const r = await recorder(h);
        const commit = async () => {
          writeTranscript(h, s.lines);
          await r.capture(s.entries);
        };
        const want: string[] = [];
        for (let c = 0; c < compactCount; c++) {
          const p = `before compact ${c}`;
          want.push(p);
          s.toolTurn(`pre-${c}`, p, `tool-${c}`);
          await commit();
          s.nativeCompaction();
          await commit();
        }
        let anchor = s.lines.at(-1)!.uuid;
        for (let d = 0; d < depth; d++) {
          const p = `kept ${d}`;
          want.push(p);
          s.toolTurn(`keep-${d}`, p, `k-${d}`);
          await commit();
          anchor = s.lines.at(-1)!.uuid;
        }
        s.toolTurn("discard-a", "discard A", "da");
        await commit();
        s.toolTurn("discard-b", "discard B", "db");
        await commit();
        const n = s.entries.length;
        s.rewindTo(anchor);
        s.toolTurn("replace", "replacement", "ra", "rb");
        writeTranscript(h, s.lines);
        await r.capture(s.entries.slice(n));
        expect(await prompts(r)).toEqual([...want, "replacement"]);
        const before = await messages(r);
        expect(before.some((x) => x.includes("discard"))).toBe(false);
        r.release();
        const next = await recorder(h);
        const recovered = await messages(next);
        expect(withoutSummaries(recovered)).toEqual(before);
        expect(summaries(recovered)).toBe(compactCount);
        await next.capture(s.entries.slice(n));
        expect(await messages(next)).toEqual(recovered);
        next.release();
      } finally {
        h.cleanup();
      }
    });
it("round3: parallel tool siblings after compaction survive ordinary next prompt and recovery", async () => {
  const h = harness();
  try {
    const s = new Script();
    const r = await recorder(h);
    s.toolTurn("pre", "before", "p");
    writeTranscript(h, s.lines);
    await r.capture(s.entries);
    s.nativeCompaction();
    writeTranscript(h, s.lines);
    await r.capture(s.entries);
    const n = s.entries.length;
    s.prompt("parallel");
    s.turnStart("parallel");
    const parent = s.lines.at(-1)!.uuid;
    for (const id of ["p1", "p2", "p3"]) {
      s.rewindTo(parent);
      s.answer({ type: "tool_use", id, name: "Bash", input: { command: id } });
      s.results(id);
    }
    s.answer({ type: "text", text: "all done" });
    s.turnEnd("parallel");
    s.toolTurn("next", "next", "n");
    writeTranscript(h, s.lines);
    await r.capture(s.entries.slice(n));
    expect(await prompts(r)).toEqual(["before", "parallel", "next"]);
    expect([...(await events(r)).keys()].filter((k) => k.endsWith(":rollback"))).toEqual([]);
    const before = await messages(r);
    for (const id of ["p1", "p2", "p3"]) expect(before.filter((x) => x.endsWith(id))).toHaveLength(2);
    r.release();
    const next = await recorder(h);
    const recovered = await messages(next);
    expect(withoutSummaries(recovered)).toEqual(before);
    expect(summaries(recovered)).toBe(1);
    next.release();
  } finally {
    h.cleanup();
  }
});
for (const secondCompact of [false, true])
  it(`round3: first bind recovers a complete transcript containing rewind before compact (${secondCompact})`, async () => {
    const h = harness();
    try {
      const s = new Script();
      s.toolTurn("kept", "kept before rewind", "k");
      const anchor = s.lines.at(-1)!.uuid;
      s.toolTurn("discard", "discarded before compact", "d");
      s.rewindTo(anchor);
      s.toolTurn("replacement", "replacement before compact", "r");
      s.nativeCompaction();
      s.toolTurn("post", "post compact", "p");
      if (secondCompact) {
        s.nativeCompaction();
        s.toolTurn("post2", "post second compact", "p2");
      }
      writeTranscript(h, s.lines);
      const r = await recorder(h);
      const actual = await prompts(r);
      expect(actual.filter((x) => !x.startsWith("/compact"))).toEqual([
        "kept before rewind",
        "replacement before compact",
        "post compact",
        ...(secondCompact ? ["post second compact"] : []),
      ]);
      r.release();
    } finally {
      h.cleanup();
    }
  });

it("keeps a legacy origin-less prompt typed right after a native compaction", async () => {
  const h = harness();
  try {
    const s = new Script();
    s.toolTurn("a", "legacy before", "a");
    s.nativeCompaction();
    s.toolTurn("b", "LEGACY_AFTER_COMPACT", "b");
    for (const line of s.lines) delete line.origin;
    writeTranscript(h, s.lines);
    const r = await recorder(h);

    expect((await messages(r)).some((m) => m.includes("user_prompt LEGACY_AFTER_COMPACT"))).toBe(true);
    r.release();
  } finally {
    h.cleanup();
  }
});

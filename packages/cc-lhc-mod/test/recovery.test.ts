import { afterEach, beforeEach, expect, it } from "vitest";
import { type Harness, harness, messages, recorder, Script, writeTranscript } from "./fixture.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const ALL = [
  "t1 user_prompt first",
  "t1 tool_call toolu_a",
  "t1 tool_result toolu_a",
  "t1 assistant_text done turn-1",
  "t2 user_prompt second",
  "t2 tool_call toolu_b",
  "t2 tool_result toolu_b",
  "t2 assistant_text done turn-2",
  "t3 user_prompt third",
  "t3 tool_call toolu_c",
  "t3 tool_result toolu_c",
  "t3 assistant_text done turn-3",
];

function session(): Script {
  const script = new Script();
  script.toolTurn("turn-1", "first", "toolu_a");
  script.toolTurn("turn-2", "second", "toolu_b");
  script.toolTurn("turn-3", "third", "toolu_c");
  return script;
}

const rowsOf = (script: Script) =>
  script.entries.filter((entry) => entry.kind === "row" && entry.door !== "attachment");

it.each([
  ["start", (_rows: number) => [0, 1]],
  ["middle", (rows: number) => [Math.floor(rows / 2), Math.floor(rows / 2) + 1]],
  ["end", (rows: number) => [rows - 2, rows - 1]],
])("records rows live capture missed at the %s exactly once", async (_where, missing) => {
  const script = session();
  const rows = rowsOf(script);
  const lost = new Set(missing(rows.length).map((index) => rows[index]));
  const live = await recorder(h);
  writeTranscript(h, script.lines);
  await live.capture(script.entries.filter((entry) => !lost.has(entry)));
  live.release();

  const reopened = await recorder(h);
  await reopened.capture(script.entries);

  const withoutTurn = (items: string[]) => items.map((item) => item.slice(item.indexOf(" ") + 1)).sort();
  expect(withoutTurn(await messages(reopened))).toEqual(withoutTurn(ALL));
});

it("reads only past the committed cursor on the next bind", async () => {
  const script = session();
  writeTranscript(h, script.lines);
  (await recorder(h)).release();

  await recorder(h);

  expect(h.log.at(-1)).toMatch(/recovered 0 of 0 transcript rows/);
});

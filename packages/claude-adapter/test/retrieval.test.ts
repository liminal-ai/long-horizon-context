import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  formatRetrieval,
  MESSAGES_DESCRIPTION,
  RETRIEVAL_BYTE_BUDGET,
  RETRIEVAL_MAX_IDS,
  RETRIEVAL_TOKEN_BUDGET,
  recallClose,
  recallOpen,
  runRetrieval,
  TURNS_DESCRIPTION,
} from "../src/index.js";

let dir = "";
let lhc: Lhc;
let seq = 0;

const event = (eventKind: string, payload: Record<string, unknown>) => {
  seq += 1;
  return { eventKind, idempotencyKey: `k-${seq}`, actor: "test", harness: "claude-adapter-test", payload };
};

async function thread(turns: Array<[string, string]>): Promise<ThreadRef> {
  seq += 1;
  const ref = { filePath: join(dir, `thread-${seq}.sqlite`) };
  const created = await lhc.threads.newThread({ filePath: ref.filePath, registryPath: join(dir, "registry.sqlite") });
  if (!created.ok) throw new Error(created.error.reason);
  const events = turns.flatMap(([prompt, answer]) => [
    event("user_prompt", { text: prompt }),
    event("assistant_text", { text: answer }),
    event("turn_end", {}),
  ]);
  const sent = await lhc.intakeStream.messageEvents(ref, events as never);
  if (!sent.ok) throw new Error(sent.error.reason);
  return ref;
}

const turns = async (ref: ThreadRef, ids: string[], fromToken?: number) =>
  (await runRetrieval("claude-code", lhc, ref, "get_turns", ids, fromToken)).text;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-adapter-retrieval-"));
  lhc = initLhc({
    mode: "manual",
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
    tokenFamily: "claude-2026",
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("retrieval", () => {
  test("budgets and descriptions", () => {
    expect([RETRIEVAL_TOKEN_BUDGET, RETRIEVAL_BYTE_BUDGET, RETRIEVAL_MAX_IDS]).toEqual([8_000, 48_000, 32]);
    expect(TURNS_DESCRIPTION).toContain("(the <tNNN> tags in compressed history)");
    expect(TURNS_DESCRIPTION).toContain("Use it whenever the context says `[turns tA–tB not in view; use get-turns]`");
    expect(TURNS_DESCRIPTION).not.toContain("verbatim");
    expect(MESSAGES_DESCRIPTION).toContain("Returns the verbatim record as it existed then");
  });

  test("get_turns returns the turn as its history renders it, inside the historical envelope; receipts outside it", async () => {
    const ref = await thread([
      ["the tide gauge read 7.31 m", "noted: 7.31 m"],
      ["second question", "second answer"],
    ]);
    const text = await turns(ref, ["t1", "t99", "x1"]);
    const open = recallOpen("get_turns");
    const close = recallClose("get_turns");
    expect(text.startsWith(open)).toBe(true);
    const inside = text.slice(open.length, text.indexOf(close));
    expect(inside).toContain("<t1>");
    expect(inside).toContain("the tide gauge read 7.31 m");
    expect(inside).not.toContain("second question");
    const after = text.slice(text.indexOf(close) + close.length);
    expect(after).toContain("not served: t99 (no such id in this conversation)");
    expect(after).toContain("not served: x1 (not a valid id");
  });

  test("get_messages returns each message verbatim, wrapped in its <mN> tag", async () => {
    const ref = await thread([["remember BLUE-HERON-4", "remembered"]]);
    const id = /<(m\d+)>[^<]*BLUE-HERON-4/.exec(await turns(ref, ["t1"]))?.[1];
    expect(id).toBeDefined();
    const { text } = await runRetrieval("claude-code", lhc, ref, "get_messages", [id!]);
    expect(text).toContain(recallOpen("get_messages"));
    expect(text).toContain(`<${id}>\nremember BLUE-HERON-4\n</${id}>`);
  });

  test("a long turn is served as a head slice with the exact next call; fromToken continues it", async () => {
    const long = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ");
    const ref = await thread([["write a lot", `${long} THE-END-MARK`]]);
    const first = await turns(ref, ["t1"]);
    const next = /Next slice: get_turns\(\{"ids":\["t1"\],"fromToken":(\d+)\}\)/.exec(first);
    expect(next).not.toBeNull();
    expect(first.indexOf("Next slice")).toBeGreaterThan(first.indexOf(recallClose("get_turns")));
    expect(first).not.toContain("THE-END-MARK");
    let from = Number(next![1]);
    let rest = "";
    for (let i = 0; i < 10 && from > 0; i++) {
      const more = await turns(ref, ["t1"], from);
      rest += more;
      const again = /"fromToken":(\d+)\}\)/.exec(more);
      from = again === null ? 0 : Number(again[1]);
    }
    expect(rest).toContain("THE-END-MARK");
    expect(rest).toContain("end of content");
  });

  test("deleted and budget-spent ids are reported with the recovery", () => {
    const text = formatRetrieval(
      "get_turns",
      [{ id: "t1", text: "<t1>x</t1>" }],
      [
        { id: "t2", reason: "deleted" },
        { id: "t3", reason: "budget", tokens: 9000 },
      ],
    );
    expect(text).toContain("not served: t2 (deleted from the record)");
    expect(text).toContain(
      'not served: t3 (9000 tok — call budget spent). Pull it separately: get_turns({"ids":["t3"]})',
    );
    expect(text.indexOf("not served")).toBeGreaterThan(text.indexOf(recallClose("get_turns")));
  });

  test("a failed store read is an error result, not an exception", async () => {
    const result = await runRetrieval(
      "claude-code",
      lhc,
      { filePath: join(dir, "missing", "nope.sqlite") },
      "get_turns",
      ["t1"],
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^get_turns failed: /);
  });
});

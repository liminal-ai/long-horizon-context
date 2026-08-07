// Board model: post/budget/ttl semantics, size→ttl policy, kill switches.
// Pure state machine — every behavior fixture-testable without PI.
import { describe, expect, it } from "vitest";
import {
  BOARD_DISABLE_ENV,
  BOARD_TOKEN_BUDGET,
  boardTokens,
  clearEntries,
  createBoardState,
  DEFAULT_MESSAGE_TTL,
  onRunEnd,
  postEntry,
  pullTtl,
  statusLine,
  TTL1_SIZE_THRESHOLD_TOKENS,
} from "../../src/board/index.js";

function freshBoard() {
  return createBoardState({});
}

describe("posting", () => {
  it("posts entries with sequential ids and counts tokens", () => {
    const board = freshBoard();
    const first = postEntry(board, { kind: "note", ids: [], text: "hello there", ttl: 2, src: "dev" });
    const second = postEntry(board, { kind: "turns", ids: ["t4"], text: "<t4>\nbody\n</t4>", ttl: 1, src: "pull" });
    expect(first.ok && first.entry.entryId).toBe("b1");
    expect(second.ok && second.entry.entryId).toBe("b2");
    expect(boardTokens(board)).toBeGreaterThan(0);
  });

  it("rejects empty text and non-positive ttl", () => {
    const board = freshBoard();
    expect(postEntry(board, { kind: "note", ids: [], text: "", ttl: 1, src: "dev" }).ok).toBe(false);
    expect(postEntry(board, { kind: "note", ids: [], text: "x", ttl: 0, src: "dev" }).ok).toBe(false);
  });

  it("rejects a post that would exceed the board budget, loudly", () => {
    const board = freshBoard();
    const huge = "word ".repeat(BOARD_TOKEN_BUDGET * 4);
    const outcome = postEntry(board, { kind: "note", ids: [], text: huge, ttl: 1, src: "dev" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("board full");
    expect(board.entries).toHaveLength(0);
  });

  it("refuses posts while off and while hard-disabled", () => {
    const board = freshBoard();
    board.enabled = false;
    expect(postEntry(board, { kind: "note", ids: [], text: "x", ttl: 1, src: "dev" }).ok).toBe(false);

    const hard = createBoardState({ [BOARD_DISABLE_ENV]: "1" });
    expect(hard.enabled).toBe(false);
    expect(hard.hardDisabled).toBe(true);
    const outcome = postEntry(hard, { kind: "note", ids: [], text: "x", ttl: 1, src: "dev" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain(BOARD_DISABLE_ENV);
  });
});

describe("ttl", () => {
  it("ages entries at run end and drops the expired", () => {
    const board = freshBoard();
    postEntry(board, { kind: "note", ids: [], text: "short-lived", ttl: 1, src: "dev" });
    postEntry(board, { kind: "note", ids: [], text: "longer-lived", ttl: 2, src: "dev" });
    onRunEnd(board);
    expect(board.runCounter).toBe(1);
    expect(board.entries.map((entry) => entry.text)).toEqual(["longer-lived"]);
    expect(board.entries[0]!.ttl).toBe(1);
    onRunEnd(board);
    expect(board.entries).toHaveLength(0);
  });

  it("pullTtl: turns always 1; messages 1 only above the size threshold", () => {
    expect(pullTtl("turns", 10)).toBe(1);
    expect(pullTtl("turns", TTL1_SIZE_THRESHOLD_TOKENS * 2)).toBe(1);
    expect(pullTtl("messages", TTL1_SIZE_THRESHOLD_TOKENS)).toBe(DEFAULT_MESSAGE_TTL);
    expect(pullTtl("messages", TTL1_SIZE_THRESHOLD_TOKENS + 1)).toBe(1);
  });
});

describe("controls", () => {
  it("clear drops everything and reports the count", () => {
    const board = freshBoard();
    postEntry(board, { kind: "note", ids: [], text: "a", ttl: 5, src: "dev" });
    postEntry(board, { kind: "note", ids: [], text: "b", ttl: 5, src: "dev" });
    expect(clearEntries(board)).toBe(2);
    expect(board.entries).toHaveLength(0);
  });

  it("statusLine names mode, entries, tokens, and run", () => {
    const board = freshBoard();
    postEntry(board, { kind: "turns", ids: ["t7"], text: "body", ttl: 1, src: "pull" });
    const line = statusLine(board);
    expect(line).toContain("board: on");
    expect(line).toContain("1 entries");
    expect(line).toContain("t7");
    board.enabled = false;
    expect(statusLine(board)).toContain("board: off");
  });
});

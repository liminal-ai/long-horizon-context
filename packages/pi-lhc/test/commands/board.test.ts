// /board command: the user-operated kill switch and dev rig. Never depends on
// model behavior — every verb works against the state machine directly.
import { describe, expect, it } from "vitest";
import { BOARD_DISABLE_ENV, createBoardState, postEntry } from "../../src/board/index.js";
import { handleBoardCommand } from "../../src/commands/board.js";
import type { ExtensionCommandContext } from "../../src/pi/types.js";

function fakeCtx(): { ctx: ExtensionCommandContext; notices: Array<{ text: string; level: string }> } {
  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    ui: {
      notify: (text: string, level: string) => {
        notices.push({ text, level });
      },
    },
    cwd: "/tmp",
  } as unknown as ExtensionCommandContext;
  return { ctx, notices };
}

describe("/board", () => {
  it("bare command shows status", () => {
    const { ctx, notices } = fakeCtx();
    handleBoardCommand(ctx, "", createBoardState({}));
    expect(notices[0]!.text).toContain("board: on");
  });

  it("off stops injection and on restores it", () => {
    const board = createBoardState({});
    const { ctx } = fakeCtx();
    handleBoardCommand(ctx, "off", board);
    expect(board.enabled).toBe(false);
    handleBoardCommand(ctx, "on", board);
    expect(board.enabled).toBe(true);
  });

  it("on refuses while hard-disabled", () => {
    const board = createBoardState({ [BOARD_DISABLE_ENV]: "1" });
    const { ctx, notices } = fakeCtx();
    handleBoardCommand(ctx, "on", board);
    expect(board.enabled).toBe(false);
    expect(notices[0]!.level).toBe("error");
    expect(notices[0]!.text).toContain(BOARD_DISABLE_ENV);
  });

  it("clear drops all entries", () => {
    const board = createBoardState({});
    postEntry(board, { kind: "note", ids: [], text: "x", ttl: 5, src: "dev" });
    const { ctx, notices } = fakeCtx();
    handleBoardCommand(ctx, "clear", board);
    expect(board.entries).toHaveLength(0);
    expect(notices[0]!.text).toContain("1 entries dropped");
  });

  it("post plants an unanchored entry, with optional leading ttl", () => {
    const board = createBoardState({});
    const { ctx } = fakeCtx();
    handleBoardCommand(ctx, "post 5 remember the milk", board);
    expect(board.entries[0]).toMatchObject({ text: "remember the milk", ttl: 5, src: "dev" });
    expect(board.entries[0]!.anchorToolCallId).toBeUndefined();

    handleBoardCommand(ctx, "post 42 is the answer", board);
    // Leading integer is consumed as ttl by design; document via behavior.
    expect(board.entries[1]).toMatchObject({ text: "is the answer", ttl: 42 });
  });

  it("unknown verb prints usage", () => {
    const { ctx, notices } = fakeCtx();
    handleBoardCommand(ctx, "bogus", createBoardState({}));
    expect(notices[0]!.text).toContain("usage:");
  });
});

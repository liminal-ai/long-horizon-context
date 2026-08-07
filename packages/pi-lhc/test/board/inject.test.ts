// Serve-time injection: prompt wrap + board block on the latest user message,
// anchored entries inside their own tool result during the posting run, then
// migration to the prompt block, and strict non-mutation of the input array.
import { describe, expect, it } from "vitest";
import { BOARD_HEADER, createBoardState, onRunEnd, postEntry } from "../../src/board/index.js";
import { injectBoard } from "../../src/board/inject.js";
import type { AgentMessage } from "../../src/pi/types.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function toolResult(toolCallId: string, text: string): AgentMessage {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text }], timestamp: 2 };
}

function freshBoard() {
  return createBoardState({});
}

function textOf(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");
}

describe("prompt block", () => {
  it("wraps the live prompt and appends the board block on the last user message only", () => {
    const board = freshBoard();
    postEntry(board, { kind: "note", ids: [], text: "remember the milk", ttl: 2, src: "dev" });

    const messages = [user("old prompt"), user("live prompt")];
    const injected = injectBoard(board, messages);
    expect(injected).toBeDefined();
    const [old, live] = injected!;
    expect(textOf(old!)).toBe("old prompt");
    const liveText = textOf(live!);
    expect(liveText).toContain("<user-prompt>\nlive prompt\n</user-prompt>");
    expect(liveText).toContain(BOARD_HEADER);
    expect(liveText).toContain('<board-note id="b1" ttl="2" src="dev">');
    expect(liveText).toContain("remember the milk");
    expect(liveText).toContain("</notification-board>");
  });

  it("wraps array-valued user content, including images, before the board block", () => {
    const board = freshBoard();
    postEntry(board, { kind: "note", ids: [], text: "recalled text", ttl: 2, src: "dev" });
    const live: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "inspect this" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      timestamp: 1,
    };

    const injected = injectBoard(board, [live])!;
    const content = injected[0]!.content as Array<{ type: string; text?: string }>;
    expect(content.map((part) => part.type)).toEqual(["text", "text", "image", "text", "text"]);
    expect(content[0]!.text).toBe("<user-prompt>\n");
    expect(content[1]!.text).toBe("inspect this");
    expect(content[3]!.text).toBe("\n</user-prompt>\n\n");
    expect(content[4]!.text).toContain(BOARD_HEADER);
  });

  it("returns undefined when the board is empty or off", () => {
    const board = freshBoard();
    expect(injectBoard(board, [user("hi")])).toBeUndefined();
    postEntry(board, { kind: "note", ids: [], text: "x", ttl: 1, src: "dev" });
    board.enabled = false;
    expect(injectBoard(board, [user("hi")])).toBeUndefined();
  });

  it("never mutates the input messages", () => {
    const board = freshBoard();
    postEntry(board, { kind: "note", ids: [], text: "x", ttl: 1, src: "dev" });
    const original = user("live prompt");
    const snapshot = structuredClone(original);
    injectBoard(board, [original]);
    expect(original).toEqual(snapshot);
  });
});

describe("anchored entries", () => {
  it("renders pull content inside its own tool result during the posting run", () => {
    const board = freshBoard();
    postEntry(board, {
      kind: "turns",
      ids: ["t4"],
      text: "<t4>\npulled body\n</t4>",
      ttl: 1,
      src: "pull",
      anchorToolCallId: "call-9",
    });

    const messages = [user("live prompt"), toolResult("call-9", "posted: t4"), toolResult("call-x", "other")];
    const injected = injectBoard(board, messages)!;
    const [live, receipt, other] = injected;
    // Anchored content does not ride the prompt while its run is live.
    expect(textOf(live!)).toBe("live prompt");
    const receiptText = textOf(receipt!);
    expect(receiptText).toContain("posted: t4");
    expect(receiptText).toContain('<recalled-turns ids="t4" ttl="1" src="pull">');
    expect(receiptText).toContain("pulled body");
    expect(textOf(other!)).toBe("other");
  });

  it("migrates surviving anchored entries to the prompt block after the run ends", () => {
    const board = freshBoard();
    postEntry(board, {
      kind: "messages",
      ids: ["m12"],
      text: "small verbatim message",
      ttl: 3,
      src: "pull",
      anchorToolCallId: "call-9",
    });
    onRunEnd(board);

    const messages = [user("next prompt"), toolResult("call-9", "posted: m12")];
    const injected = injectBoard(board, messages)!;
    const [live, receipt] = injected;
    const liveText = textOf(live!);
    expect(liveText).toContain('<recalled-messages ids="m12" ttl="2" src="pull">');
    expect(liveText).toContain("small verbatim message");
    // The stale anchor gets nothing.
    expect(textOf(receipt!)).toBe("posted: m12");
  });
});

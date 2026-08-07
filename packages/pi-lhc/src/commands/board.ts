// /board — user-operated board control. This is the kill switch: it must work
// even when the model is confused by board content, so it never depends on
// model behavior. `/board off` stops all injection at the next serve.
import {
  BOARD_DISABLE_ENV,
  type BoardState,
  clearEntries,
  DEFAULT_NOTE_TTL,
  postEntry,
  statusLine,
} from "../board/index.js";
import type { ExtensionCommandContext } from "../pi/types.js";

export const LHC_BOARD_COMMAND = "board";

export function handleBoardCommand(ctx: ExtensionCommandContext, args: string, board: BoardState): void {
  const trimmed = args.trim();
  const [verb, ...rest] = trimmed === "" ? [""] : trimmed.split(/\s+/);

  switch (verb) {
    case "": {
      ctx.ui.notify(statusLine(board), "info");
      return;
    }
    case "on": {
      if (board.hardDisabled) {
        ctx.ui.notify(`board is hard-disabled (${BOARD_DISABLE_ENV}=1); unset the env and restart`, "error");
        return;
      }
      board.enabled = true;
      ctx.ui.notify("board on", "info");
      return;
    }
    case "off": {
      board.enabled = false;
      ctx.ui.notify("board off — nothing will be injected", "info");
      return;
    }
    case "clear": {
      const dropped = clearEntries(board);
      ctx.ui.notify(`board cleared (${dropped} entries dropped)`, "info");
      return;
    }
    case "post": {
      // /board post [ttl] <text> — user-planted entry, visible from the next
      // serve (unanchored entries ride the prompt block immediately).
      let ttl = DEFAULT_NOTE_TTL;
      let textParts = rest;
      const maybeTtl = Number.parseInt(rest[0] ?? "", 10);
      if (rest.length > 1 && Number.isInteger(maybeTtl) && String(maybeTtl) === rest[0]) {
        ttl = maybeTtl;
        textParts = rest.slice(1);
      }
      const text = textParts.join(" ");
      const outcome = postEntry(board, { kind: "note", ids: [], text, ttl, src: "dev" });
      if (!outcome.ok) {
        ctx.ui.notify(`board post failed: ${outcome.reason}`, "error");
        return;
      }
      ctx.ui.notify(`posted ${outcome.entry.entryId} (${outcome.entry.tokens} tok, ttl ${outcome.entry.ttl})`, "info");
      return;
    }
    default: {
      ctx.ui.notify("usage: /board [on|off|clear|post [ttl] <text>]", "warning");
      return;
    }
  }
}

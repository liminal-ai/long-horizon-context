import { describe, expect, it } from "vitest";

import {
  createInputState,
  DEFAULT_LEADER_BYTE,
  finishExecuting,
  forceResetInput,
  type InputAction,
  type InputState,
  MODAL_ASCII_NOTE,
  MODAL_HELP_LINE,
  MODAL_UNKNOWN_PREFIX,
  mapModalCommand,
  processInputChunk,
  resolveBareEsc,
  resolveLeaderByte,
  showReceipts,
} from "../../src/wrapper/modal.js";
import { OutputHold } from "../../src/wrapper/output-hold.js";

const LEADER = Buffer.from([DEFAULT_LEADER_BYTE]);

interface FeedResult {
  state: InputState;
  pty: string;
  actions: InputAction[];
}

function feed(state: InputState, ...chunks: Array<string | Buffer>): FeedResult {
  let current = state;
  let pty = "";
  const actions: InputAction[] = [];
  for (const chunk of chunks) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    const result = processInputChunk(buffer, current);
    current = result.state;
    pty += result.toPty.toString("latin1");
    actions.push(...result.actions);
  }
  return { state: current, pty, actions };
}

function executed(actions: InputAction[]): string[] {
  return actions.filter((action) => action.kind === "execute").map((action) => action.commandLine);
}

describe("passthrough", () => {
  it("forwards ordinary bytes verbatim with no echo and no actions", () => {
    const result = feed(createInputState(), "hello world\r", "\x7f\x03\x15");
    expect(result.pty).toBe("hello world\r\x7f\x03\x15");
    expect(result.actions).toEqual([]);
    expect(result.state.mode).toBe("passthrough");
  });

  it("forwards escape sequences verbatim (CSI, OSC, DCS, legacy mouse)", () => {
    const chunks = ["\x1b[1;5A", "\x1b]11;rgb:11/22/33\x07", "\x1bP>|term\x1b\\", "\x1bM abc".slice(0, 5)];
    const result = feed(createInputState(), ...chunks);
    expect(result.pty).toBe(chunks.join(""));
    expect(result.actions).toEqual([]);
  });

  it("enters modal on the leader byte: byte withheld, fresh panel state", () => {
    const result = feed(createInputState(), "ab", LEADER);
    expect(result.pty).toBe("ab");
    expect(result.actions).toEqual([{ kind: "enter_modal" }]);
    expect(result.state.mode).toBe("modal");
    expect(result.state.line).toBe("");
    expect(result.state.panelRows).toEqual([]);
  });

  it("keeps the leader literal inside a bracketed paste", () => {
    const pasted = `\x1b[200~before\x1dafter\x1b[201~`;
    const result = feed(createInputState(), pasted);
    expect(result.pty).toBe(pasted);
    expect(result.actions).toEqual([]);
    expect(result.state.mode).toBe("passthrough");
    // Paste closed: the next leader press is a real keypress again.
    const after = feed(result.state, LEADER);
    expect(after.actions).toEqual([{ kind: "enter_modal" }]);
  });

  it("keeps the leader literal inside a paste split across chunks", () => {
    const result = feed(createInputState(), "\x1b[200~pa", "st\x1de", "\x1b[201~");
    expect(result.pty).toBe("\x1b[200~pa" + "st\x1de" + "\x1b[201~");
    expect(result.actions).toEqual([]);
  });

  it("never opens modal on a leader byte inside an in-flight OSC response", () => {
    const result = feed(createInputState(), "\x1b]11;fo", "\x1dob\x07");
    expect(result.pty).toBe("\x1b]11;fo\x1dob\x07");
    expect(result.actions).toEqual([]);
    expect(result.state.escape).toBeNull();
  });

  it("never opens modal on a leader byte inside an in-flight CSI or DCS", () => {
    const csi = feed(createInputState(), "\x1b[", "\x1d", "m");
    expect(csi.pty).toBe("\x1b[\x1dm");
    expect(csi.actions).toEqual([]);

    const dcs = feed(createInputState(), "\x1bP1$r", "\x1d", "\x1b\\");
    expect(dcs.pty).toBe("\x1bP1$r\x1d\x1b\\");
    expect(dcs.actions).toEqual([]);
  });

  it("never opens modal on a leader byte inside a legacy mouse report", () => {
    const result = feed(createInputState(), Buffer.from([0x1b, 0x4d, 0x20, 0x1d, 0x21]));
    expect(result.pty).toBe("\x1bM \x1d!");
    expect(result.actions).toEqual([]);
  });

  it("holds a pending ESC across the chunk boundary; the next byte resolves it", () => {
    // The ESC is HELD, not forwarded — it may head the kitty-encoded leader.
    const result = feed(createInputState(), Buffer.from([0x1b]));
    expect(result.pty).toBe("");
    expect(result.state.escape).toEqual({ kind: "pending_esc" });
    expect(result.state.heldSeq).toEqual([0x1b]);
    // The byte after a bare Esc resolves it: both flush; a raw leader here is
    // suppressed once (forwarded literally) — the accepted trade for never
    // misreading a split sequence; leader-again recovers.
    const suppressed = feed(result.state, LEADER);
    expect(suppressed.pty).toBe("\x1b\x1d");
    expect(suppressed.actions).toEqual([]);
    expect(suppressed.state.escape).toBeNull();
    const recovered = feed(suppressed.state, LEADER);
    expect(recovered.actions).toEqual([{ kind: "enter_modal" }]);
  });

  it("flushes a truly bare held ESC via resolveBareEsc but RESUMES tracking", () => {
    const held = feed(createInputState(), Buffer.from([0x1b]));
    const resolved = resolveBareEsc(held.state);
    expect(resolved).not.toBeNull();
    expect(resolved!.toPty!.toString("latin1")).toBe("\x1b");
    expect(resolved!.actions).toEqual([]);
    // tracking survives the flush, exactly as if the ESC had streamed unheld
    expect(resolved!.state.escape).toEqual({ kind: "pending_esc" });
    expect(resolved!.state.heldSeq).toEqual([]);
    // nothing left to flush → a second fire is a no-op
    expect(resolveBareEsc(resolved!.state)).toBeNull();
    // a sequence arriving after the flush still tracks: paste opens, a raw
    // leader inside it stays literal, and no byte is double-sent
    const after = feed(resolved!.state, "[200~a\x1db\x1b[201~");
    expect(after.pty).toBe("[200~a\x1db\x1b[201~");
    expect(after.actions).toEqual([]);
    // and a second bare ESC right after the flush is not double-forwarded
    const doubleEsc = feed(resolved!.state, Buffer.from([0x1b]));
    expect(doubleEsc.pty).toBe("");
    expect(doubleEsc.state.heldSeq).toEqual([0x1b]);
  });

  it("a stalled paste-opener candidate flushes but keeps CSI tracking (reviewer probe)", () => {
    // ESC[200 held; the timer fires before the ~ arrives
    const stalled = feed(createInputState(), "\x1b[200");
    const flushed = resolveBareEsc(stalled.state);
    expect(flushed).not.toBeNull();
    expect(flushed!.toPty!.toString("latin1")).toBe("\x1b[200");
    expect(flushed!.state.escape).toEqual({ kind: "csi", params: "200" });
    // the late ~ completes the paste marker; a literal raw leader inside the
    // pasted body stays literal — no modal, every byte reaches the child
    const after = feed(flushed!.state, "~x\x1dy");
    expect(after.actions).toEqual([]);
    expect(after.state.mode).toBe("passthrough");
    expect(after.state.inPaste).toBe(true);
    expect(after.pty).toBe("~x\x1dy");
    const closed = feed(after.state, "\x1b[201~");
    expect(closed.state.inPaste).toBe(false);

    // a stalled kitty-shaped candidate also resumes as plain CSI: its late
    // final is forwarded, never claimed as the leader
    const kittyStall = feed(createInputState(), "\x1b[93;5");
    const kittyFlushed = resolveBareEsc(kittyStall.state);
    expect(kittyFlushed!.toPty!.toString("latin1")).toBe("\x1b[93;5");
    const lateFinal = feed(kittyFlushed!.state, "u");
    expect(lateFinal.pty).toBe("u");
    expect(lateFinal.actions).toEqual([]);
  });

  it("never opens modal on a leader inside a sequence split after its ESC", () => {
    // OSC with a leader (and BEL terminator) in the payload
    const osc = feed(createInputState(), "\x1b", "]11;fo\x1dob\x07");
    expect(osc.pty).toBe("\x1b]11;fo\x1dob\x07");
    expect(osc.actions).toEqual([]);

    // bracketed-paste open split after ESC, leader in the pasted content
    const paste = feed(createInputState(), "\x1b", "[200~ab\x1dcd", "\x1b[201~");
    expect(paste.pty).toBe("\x1b[200~ab\x1dcd\x1b[201~");
    expect(paste.actions).toEqual([]);
    expect(paste.state.inPaste).toBe(false);

    // CSI with the leader byte among its params
    const csi = feed(createInputState(), "\x1b", "[38;5;\x1dm");
    expect(csi.pty).toBe("\x1b[38;5;\x1dm");
    expect(csi.actions).toEqual([]);

    // legacy mouse report with a leader among its three payload bytes
    const mouse = feed(createInputState(), Buffer.from([0x1b]), Buffer.from([0x4d, 0x20, 0x1d, 0x21]));
    expect(mouse.pty).toBe("\x1bM \x1d!");
    expect(mouse.actions).toEqual([]);

    // double-ESC then a split sequence keeps tracking
    const doubleEsc = feed(createInputState(), "\x1b", "\x1b", "[200~x\x1dy\x1b[201~");
    expect(doubleEsc.pty).toBe("\x1b\x1b[200~x\x1dy\x1b[201~");
    expect(doubleEsc.actions).toEqual([]);
  });

  it("opens modal on a leader in its own chunk right after a completed sequence", () => {
    const result = feed(createInputState(), "\x1b[A", LEADER);
    expect(result.actions).toEqual([{ kind: "enter_modal" }]);
  });

  it("honors a custom leader byte", () => {
    const state = createInputState(0x1f);
    const ignored = feed(state, LEADER);
    expect(ignored.pty).toBe("\x1d");
    expect(ignored.actions).toEqual([]);
    const entered = feed(ignored.state, Buffer.from([0x1f]));
    expect(entered.actions).toEqual([{ kind: "enter_modal" }]);
  });

  describe("kitty-encoded leader (CSI ...u)", () => {
    it("CSI 93;5u press enters modal and is NOT forwarded to the child", () => {
      const result = feed(createInputState(), "\x1b[93;5u");
      expect(result.pty).toBe("");
      expect(result.actions).toEqual([{ kind: "enter_modal" }]);
      expect(result.state.mode).toBe("modal");
    });

    it("repeat (event 2) also enters modal; press with explicit :1 too", () => {
      const repeat = feed(createInputState(), "\x1b[93;5:2u");
      expect(repeat.actions).toEqual([{ kind: "enter_modal" }]);
      expect(repeat.pty).toBe("");
      const press = feed(createInputState(), "\x1b[93;5:1u");
      expect(press.actions).toEqual([{ kind: "enter_modal" }]);
    });

    it("release (93;5:3u) is ignored and forwarded untouched", () => {
      const result = feed(createInputState(), "\x1b[93;5:3u");
      expect(result.actions).toEqual([]);
      expect(result.pty).toBe("\x1b[93;5:3u");
      expect(result.state.mode).toBe("passthrough");
    });

    it("split-chunk delivery (ESC alone, then [93;5u) still enters modal, nothing forwarded", () => {
      const result = feed(createInputState(), "\x1b", "[93;5u");
      expect(result.pty).toBe("");
      expect(result.actions).toEqual([{ kind: "enter_modal" }]);
      // even byte-at-a-time
      const oneByOne = feed(createInputState(), ..."\x1b[93;5u".split(""));
      expect(oneByOne.pty).toBe("");
      expect(oneByOne.actions).toEqual([{ kind: "enter_modal" }]);
    });

    it("non-leader CSI-u keys are forwarded untouched", () => {
      const other = feed(createInputState(), "\x1b[94;5u");
      expect(other.pty).toBe("\x1b[94;5u");
      expect(other.actions).toEqual([]);
      const noCtrl = feed(createInputState(), "\x1b[93u");
      expect(noCtrl.pty).toBe("\x1b[93u");
      expect(noCtrl.actions).toEqual([]);
    });

    it("ctrl+alt (93;7u) and other modifier chords are NOT claimed", () => {
      const result = feed(createInputState(), "\x1b[93;7u");
      expect(result.pty).toBe("\x1b[93;7u");
      expect(result.actions).toEqual([]);
    });

    it("a custom leader is recognized in its kitty form (0x1f -> 95;5u; ctrl+letter maps to +96)", () => {
      const punct = feed(createInputState(0x1f), "\x1b[95;5u");
      expect(punct.actions).toEqual([{ kind: "enter_modal" }]);
      expect(punct.pty).toBe("");
      // ctrl-A (0x01) -> keycode 97
      const letter = feed(createInputState(0x01), "\x1b[97;5u");
      expect(letter.actions).toEqual([{ kind: "enter_modal" }]);
      // and the default leader's encoding is NOT claimed for that config
      const wrong = feed(createInputState(0x1f), "\x1b[93;5u");
      expect(wrong.pty).toBe("\x1b[93;5u");
      expect(wrong.actions).toEqual([]);
    });

    it("kitty leader inside a bracketed paste stays literal", () => {
      const result = feed(createInputState(), "\x1b[200~text \x1b[93;5u more\x1b[201~");
      expect(result.actions).toEqual([]);
      expect(result.pty).toBe("\x1b[200~text \x1b[93;5u more\x1b[201~");
    });

    it("xterm modifyOtherKeys encoding (27;5;93~) enters modal and is NOT forwarded", () => {
      // Observed live from tmux extended-keys: ctrl-] arrives as CSI 27;5;93~.
      const result = feed(createInputState(), "\x1b[27;5;93~");
      expect(result.pty).toBe("");
      expect(result.actions).toEqual([{ kind: "enter_modal" }]);
      // colon-suffixed third field is a different key event: forwarded byte-identical
      const suffixed = feed(createInputState(), "\x1b[27;5;93:3~");
      expect(suffixed.pty).toBe("\x1b[27;5;93:3~");
      expect(suffixed.actions).toEqual([]);
      // other modifier or other key: forwarded untouched
      const alt = feed(createInputState(), "\x1b[27;7;93~");
      expect(alt.pty).toBe("\x1b[27;7;93~");
      expect(alt.actions).toEqual([]);
      const other = feed(createInputState(), "\x1b[27;5;94~");
      expect(other.pty).toBe("\x1b[27;5;94~");
      expect(other.actions).toEqual([]);
    });

    it("modifyOtherKeys leader-again cancels the modal", () => {
      const opened = feed(createInputState(), LEADER);
      const cancelled = feed(opened.state, "\x1b[27;5;93~");
      expect(cancelled.actions).toEqual([{ kind: "exit_modal" }]);
      expect(cancelled.pty).toBe("");
    });

    it("kitty leader-again cancels the modal (and is dropped while executing)", () => {
      const opened = feed(createInputState(), LEADER);
      const cancelled = feed(opened.state, "\x1b[93;5u");
      expect(cancelled.actions).toEqual([{ kind: "exit_modal" }]);
      expect(cancelled.state.mode).toBe("passthrough");
      expect(cancelled.pty).toBe("");

      const executing = feed(createInputState(), LEADER, "status\r");
      const dropped = feed(executing.state, "\x1b[93;5u");
      expect(dropped.actions).toEqual([]);
      expect(dropped.state.mode).toBe("executing");
      expect(dropped.pty).toBe("");
    });
  });
});

describe("modal line editor", () => {
  function openModal(): InputState {
    return feed(createInputState(), LEADER).state;
  }

  it("builds the line from typed printables, executes a known command on Enter", () => {
    const typed = feed(openModal(), "status");
    expect(typed.state.line).toBe("status");
    const result = feed(typed.state, "\r");
    expect(result.pty).toBe("");
    expect(executed(result.actions)).toEqual(["/lhc-status"]);
    expect(result.state.mode).toBe("executing");
    // the submitted text stays visible on the panel's prompt line while running
    expect(result.state.line).toBe("status");
  });

  it("passes the prune target through", () => {
    const result = feed(openModal(), "prune 50000\r");
    expect(executed(result.actions)).toEqual(["/lhc-prune 50000"]);
  });

  it("treats a malformed prune argument as unknown and stays modal", () => {
    const result = feed(openModal(), "prune lots\r");
    expect(executed(result.actions)).toEqual([]);
    expect(result.state.panelRows).toEqual([`${MODAL_UNKNOWN_PREFIX}prune lots`, MODAL_HELP_LINE]);
    expect(result.state.mode).toBe("modal");
  });

  it("shows help (with the ASCII-only note) as panel rows on help/? and stays modal", () => {
    const result = feed(openModal(), "?\r");
    expect(result.state.panelRows).toEqual([MODAL_HELP_LINE, MODAL_ASCII_NOTE]);
    expect(result.state.mode).toBe("modal");
    const then = feed(result.state, "stats\r");
    expect(executed(then.actions)).toEqual(["/lhc-stats"]);
    // stale help rows are cleared when a command starts
    expect(then.state.panelRows).toEqual([]);
  });

  it("shows help for an unknown command, stays modal, and still executes next", () => {
    const unknown = feed(openModal(), "bogus\r");
    expect(unknown.state.panelRows[0]).toBe(`${MODAL_UNKNOWN_PREFIX}bogus`);
    const result = feed(unknown.state, "status\r");
    expect(executed(result.actions)).toEqual(["/lhc-status"]);
  });

  it("cancels on Enter with an empty line", () => {
    const result = feed(openModal(), "\r");
    expect(result.actions).toEqual([{ kind: "exit_modal" }]);
    expect(result.state.mode).toBe("passthrough");
  });

  it("backspace edits the line", () => {
    const edited = feed(openModal(), "stx\x7f");
    expect(edited.state.line).toBe("st");
    const result = feed(edited.state, "atus\r");
    expect(executed(result.actions)).toEqual(["/lhc-status"]);
  });

  it("backspace on an empty line does nothing", () => {
    const result = feed(openModal(), "\x7f");
    expect(result.state.mode).toBe("modal");
    expect(result.state.line).toBe("");
  });

  it("ctrl-U kills the whole line", () => {
    const result = feed(openModal(), "garbage\x15stats\r");
    expect(executed(result.actions)).toEqual(["/lhc-stats"]);
  });

  it("a bare Esc followed by a byte cancels; the byte belongs to passthrough", () => {
    const opened = feed(openModal(), "sta");
    const result = feed(opened.state, Buffer.from([0x1b]), "x");
    expect(result.actions).toEqual([{ kind: "exit_modal" }]);
    expect(result.pty).toBe("x");
    expect(result.state.mode).toBe("passthrough");
  });

  it("a truly bare Esc resolves to cancel via resolveBareEsc (run.ts timer)", () => {
    const opened = feed(openModal(), "sta", Buffer.from([0x1b]));
    expect(opened.state.mode).toBe("modal");
    expect(opened.state.escape).toEqual({ kind: "pending_esc" });
    const resolved = resolveBareEsc(opened.state);
    expect(resolved).not.toBeNull();
    expect(resolved!.actions).toEqual([{ kind: "exit_modal" }]);
    expect(resolved!.state.mode).toBe("passthrough");
    // nothing pending → null
    expect(resolveBareEsc(resolved!.state)).toBeNull();
  });

  it("a split escape sequence while modal is never misread as cancel", () => {
    // split arrow key: dropped, stays modal
    const arrow = feed(openModal(), "\x1b", "[A");
    expect(arrow.state.mode).toBe("modal");
    expect(arrow.pty).toBe("");
    expect(arrow.actions).toEqual([]);
    // split kitty Enter still submits
    const kitty = feed(openModal(), "status", "\x1b", "[13;1u");
    expect(executed(kitty.actions)).toEqual(["/lhc-status"]);
    // split OSC response forwards and stays modal
    const osc = feed(openModal(), "\x1b", "]11;rgb:aa\x07");
    expect(osc.pty).toBe("\x1b]11;rgb:aa\x07");
    expect(osc.state.mode).toBe("modal");
  });

  it("cancels on ctrl-C and on leader-again", () => {
    const viaCtrlC = feed(openModal(), "\x03");
    expect(viaCtrlC.actions).toEqual([{ kind: "exit_modal" }]);
    expect(viaCtrlC.state.mode).toBe("passthrough");

    const viaLeader = feed(openModal(), LEADER);
    expect(viaLeader.actions).toEqual([{ kind: "exit_modal" }]);
    expect(viaLeader.state.mode).toBe("passthrough");
  });

  it("dismissal resets the panel state entirely (rows and line)", () => {
    const result = feed(openModal(), "bogus\r", "\x03");
    expect(result.actions).toEqual([{ kind: "exit_modal" }]);
    expect(result.state.mode).toBe("passthrough");
    expect(result.state.panelRows).toEqual([]);
    expect(result.state.line).toBe("");
  });

  it("handles kitty CSI-u Enter/Esc/Backspace; ignores releases", () => {
    const enter = feed(openModal(), "status", "\x1b[13;1u");
    expect(executed(enter.actions)).toEqual(["/lhc-status"]);

    const esc = feed(openModal(), "sta", "\x1b[27;1u");
    expect(esc.actions).toEqual([{ kind: "exit_modal" }]);

    const backspace = feed(openModal(), "stx", "\x1b[127;1u", "atus", "\x1b[13;1u");
    expect(executed(backspace.actions)).toEqual(["/lhc-status"]);

    const release = feed(openModal(), "status", "\x1b[13;1:3u");
    expect(executed(release.actions)).toEqual([]);
    expect(release.state.mode).toBe("modal");
  });

  it("drops navigation keys and mouse reports while modal", () => {
    const result = feed(openModal(), "\x1b[A", "\x1b[3~", "\x1b[<35;10;5M", "status\r");
    expect(result.pty).toBe("");
    expect(executed(result.actions)).toEqual(["/lhc-status"]);
  });

  it("forwards protocol CSI and string responses to the pty while modal", () => {
    const result = feed(openModal(), "\x1b[24;80R", "\x1b]11;rgb:aa/bb/cc\x07");
    expect(result.pty).toBe("\x1b[24;80R\x1b]11;rgb:aa/bb/cc\x07");
    expect(result.state.mode).toBe("modal");
  });

  it("appends pasted printables, ignores pasted newlines and control bytes", () => {
    const result = feed(openModal(), "\x1b[200~sta\rtus\x1d\x1b[201~", "\r");
    expect(result.pty).toBe("");
    expect(executed(result.actions)).toEqual(["/lhc-status"]);
  });

  it("ignores non-ASCII bytes in the editor (line stays ASCII)", () => {
    const chunk = Buffer.concat([Buffer.from("sta"), Buffer.from([0xc3, 0xa9]), Buffer.from("tus\r")]);
    const result = feed(openModal(), chunk);
    expect(executed(result.actions)).toEqual(["/lhc-status"]);
  });
});

describe("executing mode", () => {
  function startExecuting(): InputState {
    const opened = feed(createInputState(), LEADER, "status\r");
    expect(opened.state.mode).toBe("executing");
    return opened.state;
  }

  it("drops user input while a command runs (Esc and leader included)", () => {
    const result = feed(startExecuting(), "abc\r", LEADER, Buffer.from([0x1b]), "q");
    expect(result.pty).toBe("");
    expect(result.actions).toEqual([]);
    expect(result.state.mode).toBe("executing");
    // the running command stays visible on the panel's prompt line
    expect(result.state.line).toBe("status");
  });

  it("ctrl-C while executing DETACHES: modal leaves, output resumes, command unaffected", () => {
    const detached = feed(startExecuting(), "\x03");
    expect(detached.actions).toEqual([{ kind: "exit_modal" }]);
    expect(detached.state.mode).toBe("passthrough");
    // subsequent input flows to claude; the late receipt path (settleCommand
    // with mode !== executing) prints raw without touching input state
    const after = feed(detached.state, "hello");
    expect(after.pty).toBe("hello");
    expect(forceResetInput(after.state)).toBe(after.state);
  });

  it("resolveBareEsc while executing clears the pending ESC without detaching", () => {
    const pending = feed(startExecuting(), Buffer.from([0x1b]));
    expect(pending.state.escape).toEqual({ kind: "pending_esc" });
    const resolved = resolveBareEsc(pending.state);
    expect(resolved).not.toBeNull();
    expect(resolved!.actions).toEqual([]);
    expect(resolved!.state.mode).toBe("executing");
    expect(resolved!.state.escape).toBeNull();
  });

  it("still forwards protocol responses while executing", () => {
    const result = feed(startExecuting(), "\x1b[24;80R");
    expect(result.pty).toBe("\x1b[24;80R");
  });

  it("finishExecuting restores a fresh passthrough state", () => {
    const finished = finishExecuting(startExecuting());
    expect(finished.mode).toBe("passthrough");
    expect(finished.line).toBe("");
    expect(finished.panelRows).toEqual([]);
    const after = feed(finished, "x");
    expect(after.pty).toBe("x");
  });

  it("showReceipts returns to modal with receipt rows; one keypress dismisses", () => {
    const shown = showReceipts(startExecuting(), ["line one\nline two", "three"]);
    expect(shown.mode).toBe("modal");
    expect(shown.line).toBe("");
    expect(shown.panelRows).toEqual(["line one", "line two", "three"]);
    const dismissed = feed(shown, "\x03");
    expect(dismissed.actions).toEqual([{ kind: "exit_modal" }]);
    expect(dismissed.state.mode).toBe("passthrough");
    expect(dismissed.state.panelRows).toEqual([]);
  });

  it("forceResetInput is a no-op in passthrough and a reset elsewhere", () => {
    const passthrough = createInputState();
    expect(forceResetInput(passthrough)).toBe(passthrough);
    const executing = forceResetInput(startExecuting());
    expect(executing.mode).toBe("passthrough");
  });
});

describe("mapModalCommand", () => {
  it("maps the surface", () => {
    expect(mapModalCommand("status")).toBe("/lhc-status");
    expect(mapModalCommand("stats")).toBe("/lhc-stats");
    expect(mapModalCommand("compact")).toBe("/lhc-compact");
    expect(mapModalCommand("prune")).toBe("/lhc-prune");
    expect(mapModalCommand("prune 1234")).toBe("/lhc-prune 1234");
    expect(mapModalCommand("status extra")).toBeNull();
    expect(mapModalCommand("prune 12 34")).toBeNull();
    expect(mapModalCommand("lhc-status")).toBeNull();
    expect(mapModalCommand("")).toBeNull();
  });
});

describe("resolveLeaderByte", () => {
  it("defaults to ctrl-]", () => {
    expect(resolveLeaderByte(undefined)).toBe(0x1d);
    expect(resolveLeaderByte("")).toBe(0x1d);
  });

  it("accepts hex, caret notation, and a literal control char", () => {
    expect(resolveLeaderByte("0x1f")).toBe(0x1f);
    expect(resolveLeaderByte("^_")).toBe(0x1f);
    expect(resolveLeaderByte("\x1f")).toBe(0x1f);
  });

  it("rejects printables and forbidden control bytes, warns, and falls back", () => {
    for (const raw of ["g", "^G", "0x1b", "^M", "^C", "0x00", "leader"]) {
      const warnings: string[] = [];
      expect(resolveLeaderByte(raw, (message) => warnings.push(message))).toBe(0x1d);
      expect(warnings).toHaveLength(1);
    }
  });
});

describe("OutputHold", () => {
  it("writes through when not holding, holds and flushes in order", () => {
    const written: string[] = [];
    const hold = new OutputHold(
      1024,
      (data) => written.push(data),
      () => {},
    );
    hold.feed("a");
    hold.hold();
    hold.feed("b");
    hold.feed("c");
    expect(written).toEqual(["a"]);
    hold.flush();
    expect(written).toEqual(["a", "bc"]);
    hold.feed("d");
    expect(written).toEqual(["a", "bc", "d"]);
  });

  it("fires onOverflow past the cap; flush releases everything", () => {
    const written: string[] = [];
    let overflows = 0;
    const hold: OutputHold = new OutputHold(
      5,
      (data) => written.push(data),
      () => {
        overflows += 1;
        hold.flush();
      },
    );
    hold.hold();
    hold.feed("123");
    hold.feed("456");
    expect(overflows).toBe(1);
    expect(written).toEqual(["123456"]);
    expect(hold.holding).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { createInputState, processInputChunk, showReceipts } from "../../src/wrapper/modal.js";

const LEADER_KITTY = Buffer.from("\x1b[93;5u");
const ESC_KITTY = Buffer.from("\x1b[27u");
const ENTER_KITTY = Buffer.from("\x1b[13u");
const CTRL_C_KITTY = Buffer.from("\x1b[99;5u");

describe("modal freeze regressions (kitty encodings)", () => {
  it("kitty ctrl-C detaches an executing command, same as raw 0x03", () => {
    let r = processInputChunk(LEADER_KITTY, createInputState());
    expect(r.actions).toEqual([{ kind: "enter_modal" }]);
    r = processInputChunk(Buffer.from("/status"), r.state);
    r = processInputChunk(ENTER_KITTY, r.state);
    expect(r.actions).toEqual([{ kind: "execute", commandLine: "/lhc-status" }]);
    expect(r.state.mode).toBe("executing");

    const raw = processInputChunk(Buffer.from([0x03]), r.state);
    expect(raw.actions).toEqual([{ kind: "exit_modal" }]);

    const kitty = processInputChunk(CTRL_C_KITTY, r.state);
    expect(kitty.actions).toEqual([{ kind: "exit_modal" }]);
    expect(kitty.state.mode).toBe("passthrough");
  });

  it("post-receipts state: kitty Esc and kitty leader both dismiss", () => {
    let r = processInputChunk(LEADER_KITTY, createInputState());
    r = processInputChunk(Buffer.from("/status"), r.state);
    r = processInputChunk(ENTER_KITTY, r.state);
    const settled = showReceipts(r.state, ["tail=100"]);
    expect(settled.mode).toBe("modal");

    const viaEsc = processInputChunk(ESC_KITTY, settled);
    expect(viaEsc.actions).toEqual([{ kind: "exit_modal" }]);

    const viaLeader = processInputChunk(LEADER_KITTY, settled);
    expect(viaLeader.actions).toEqual([{ kind: "exit_modal" }]);

    const viaEnter = processInputChunk(ENTER_KITTY, settled);
    expect(viaEnter.actions).toEqual([{ kind: "exit_modal" }]);
  });

  it("a stray string-terminator introducer (ESC ]) no longer wedges the modal", () => {
    const r = processInputChunk(LEADER_KITTY, createInputState());
    const settled = showReceipts(r.state, ["tail=100"]);

    let s = processInputChunk(Buffer.from([0x1b, 0x5d]), settled);
    expect(s.state.escape).toEqual({ kind: "string_term" });

    s = processInputChunk(Buffer.from([0x0d]), s.state);
    expect(s.state.escape).not.toBeNull();

    const escaped = processInputChunk(Buffer.from([0x03]), s.state);
    expect(escaped.actions).toEqual([{ kind: "exit_modal" }]);
    expect(escaped.state.mode).toBe("passthrough");
    expect(escaped.state.escape).toBeNull();
    expect(escaped.toPty.toString("latin1")).toBe("\x1b\\");
  });
});

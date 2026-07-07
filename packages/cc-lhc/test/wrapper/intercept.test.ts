import { describe, expect, it } from "vitest";

import {
  createInterceptState,
  isWithholdBuffer,
  processInputChunk,
  type InterceptState,
} from "../../src/wrapper/intercept.js";

const BS = "\x08 \x08";

function feed(input: string, initial: InterceptState = createInterceptState()) {
  let state = initial;
  let toPty = Buffer.alloc(0);
  let toStdout = "";
  let dispatch: string | undefined;

  for (const chunk of input) {
    const result = processInputChunk(Buffer.from(chunk), state);
    state = result.state;
    toPty = Buffer.concat([toPty, result.toPty]);
    toStdout += result.toStdout;
    if (result.dispatch !== undefined) dispatch = result.dispatch;
  }

  return { state, toPty: toPty.toString("utf8"), toStdout, dispatch };
}

function feedChunks(chunks: string[], initial: InterceptState = createInterceptState()) {
  let state = initial;
  let toPty = Buffer.alloc(0);
  let toStdout = "";
  let dispatch: string | undefined;

  for (const chunk of chunks) {
    const result = processInputChunk(Buffer.from(chunk), state);
    state = result.state;
    toPty = Buffer.concat([toPty, result.toPty]);
    toStdout += result.toStdout;
    if (result.dispatch !== undefined) dispatch = result.dispatch;
  }

  return { state, toPty: toPty.toString("utf8"), toStdout, dispatch };
}

describe("isWithholdBuffer", () => {
  it("accepts /lhc prefixes and commands", () => {
    expect(isWithholdBuffer("/")).toBe(true);
    expect(isWithholdBuffer("/l")).toBe(true);
    expect(isWithholdBuffer("/lh")).toBe(true);
    expect(isWithholdBuffer("/lhc")).toBe(true);
    expect(isWithholdBuffer("/lhc-status")).toBe(true);
    expect(isWithholdBuffer("/help")).toBe(false);
    expect(isWithholdBuffer("/c")).toBe(false);
  });
});

describe("processInputChunk", () => {
  it("passes plain typing through on a fresh line", () => {
    const result = feed("hello");
    expect(result.toPty).toBe("hello");
    expect(result.toStdout).toBe("");
    expect(result.dispatch).toBeUndefined();
    expect(result.state.shadowLen).toBe(5);
  });

  it("flushes /help to the pty in byte order on divergence", () => {
    const result = feed("/help");
    expect(result.toPty).toBe("/help");
    expect(result.toStdout).toBe(`/${BS}`);
    expect(result.state.withholding).toBe(false);
  });

  it("withholds /lhc-status and dispatches on Enter", () => {
    const result = feed("/lhc-status\r");
    expect(result.toPty).toBe("");
    expect(result.toStdout).toBe("/lhc-status\r\n");
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.state).toEqual({ ...createInterceptState(), swallowLfAfterDispatch: true });
  });

  it("supports backspace editing while withholding", () => {
    const result = feed("/lhc-stat\x7fts\r");
    expect(result.toPty).toBe("");
    expect(result.dispatch).toBe("/lhc-stats");
    expect(result.toStdout).toContain("/lhc-stat");
    expect(result.toStdout).toContain(BS);
    expect(result.toStdout).toContain("\r\n");
  });

  it("dispatches a pasted /lhc-stats line from one chunk", () => {
    const result = feedChunks(["/lhc-stats\r"]);
    expect(result.toPty).toBe("");
    expect(result.dispatch).toBe("/lhc-stats");
    expect(result.toStdout).toBe("/lhc-stats\r\n");
  });

  it("resets on Ctrl-C without flushing withheld bytes", () => {
    const result = feed("/lhc\x03");
    expect(result.toPty).toBe("\x03");
    expect(result.toStdout).toBe("/lhc");
    expect(result.state).toEqual(createInterceptState());
  });

  it("cancels withheld bytes on bare Escape at chunk end, leaving the line fresh", () => {
    const first = feed("/lhc");
    expect(first.state.withholding).toBe(true);
    const second = feedChunks(["\x1b"], first.state);
    expect(second.toPty).toBe("\x1b");
    expect(second.toStdout).toBe(BS.repeat(4));
    expect(second.state.shadowLen).toBe(0);
    expect(second.state.withholding).toBe(false);
  });

  it("flushes withheld bytes on bare Escape followed by a non-sequence byte", () => {
    const result = feedChunks(["/lhc", "\x1bY"]);
    expect(result.toPty).toBe("\x1bY");
    expect(result.toStdout).toBe(`/lhc${BS.repeat(4)}`);
    expect(result.state.shadowLen).toBe(1);
  });

  it("passes CSI sequences through mid-withhold without flushing the buffer", () => {
    const result = feedChunks(["/lhc", "\x1b[A"]);
    expect(result.toPty).toBe("\x1b[A");
    expect(result.toStdout).toBe("/lhc");
    expect(result.state.withholding).toBe(true);
    expect(result.state.buffer).toBe("/lhc");
  });

  it("does not intercept after non-slash content on the line", () => {
    const first = feed("echo hi");
    expect(first.toPty).toBe("echo hi");
    expect(first.state.shadowLen).toBe(7);
    const second = feed("/lhc-status\r", first.state);
    expect(second.toPty).toBe("/lhc-status\r");
    expect(second.dispatch).toBeUndefined();
  });

  it("preserves byte order when divergence happens mid-chunk", () => {
    const result = processInputChunk(Buffer.from("/help"), createInterceptState());
    expect(result.toPty.toString("utf8")).toBe("/help");
    expect(result.toStdout).toBe(`/${BS}`);
  });

  it("preserves byte order when divergence chunk mixes withheld and passthrough", () => {
    const result = processInputChunk(Buffer.from("/lhxmore"), createInterceptState());
    expect(result.toPty.toString("utf8")).toBe("/lhxmore");
    expect(result.toStdout).toBe(`/lh${BS.repeat(3)}`);
  });

  it("flushes incomplete /lhc prefix to the pty on Enter", () => {
    const result = feed("/lh\r");
    expect(result.toPty).toBe("/lh\r");
    expect(result.toStdout).toBe("/lh");
    expect(result.dispatch).toBeUndefined();
  });

  it("swallows CRLF \\n in the same chunk after dispatch on \\r", () => {
    const result = feed("/lhc-status\r\n");
    expect(result.toPty).toBe("");
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.state.swallowLfAfterDispatch).toBe(false);
  });

  it("swallows CRLF \\n in the next chunk after dispatch on \\r", () => {
    const first = feed("/lhc-status\r");
    expect(first.state.swallowLfAfterDispatch).toBe(true);
    const second = feedChunks(["\n"], first.state);
    expect(second.toPty).toBe("");
    expect(second.state.swallowLfAfterDispatch).toBe(false);
  });

  it("forwards trailing bytes after dispatch on \\r in the same chunk", () => {
    const result = feed("/lhc-status\rmore text");
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.toPty).toBe("more text");
    expect(result.state.shadowLen).toBe(9);
  });

  it("ignores backspace beyond the withheld buffer start", () => {
    const result = feed("/\x7f\x7f");
    expect(result.toPty).toBe("\x7f");
    expect(result.toStdout).toBe(`/${BS}`);
    expect(result.state.withholding).toBe(false);
    expect(result.state.buffer).toBe("");
  });

  it("forwards Ctrl-C and trailing same-chunk bytes without flushing withheld text", () => {
    const result = feedChunks(["/lhc\x03more"]);
    expect(result.toPty).toBe("\x03more");
    expect(result.toStdout).toBe("/lhc");
    expect(result.state).toEqual({ ...createInterceptState(), shadowLen: 4 });
  });

  it("passes through text before /lhc-status on the same line", () => {
    const result = feed("text before /lhc-status\r");
    expect(result.toPty).toBe("text before /lhc-status\r");
    expect(result.dispatch).toBeUndefined();
    expect(result.toStdout).toBe("");
  });

  it("intercepts /lhc-status after mouse SGR noise on a fresh line", () => {
    const mouse = "\x1b[<0;10;20M";
    const result = feedChunks([mouse, "/lhc-status\r"]);
    expect(result.toPty).toBe(mouse);
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.toStdout).toBe("/lhc-status\r\n");
    expect(result.state.shadowLen).toBe(0);
  });

  it("intercepts /lhc-prune after focus-reporting noise before typing", () => {
    const result = feedChunks(["\x1b[I", "\x1b[O", "/lhc-prune\r"]);
    expect(result.toPty).toBe("\x1b[I\x1b[O");
    expect(result.dispatch).toBe("/lhc-prune");
    expect(result.toStdout).toBe("/lhc-prune\r\n");
  });

  it("intercepts after a CSI sequence split across chunks", () => {
    const first = feedChunks(["\x1b[", "100"]);
    expect(first.state.shadowLen).toBe(0);
    expect(first.state.escapePassthrough).toEqual({ kind: "csi", params: "100" });
    const second = feedChunks([";20M", "/lhc-stats\r"], first.state);
    expect(second.toPty).toBe(";20M");
    expect(second.dispatch).toBe("/lhc-stats");
  });

  it("passes OSC sequences through without disarming fresh line interception", () => {
    const osc = "\x1b]0;title\x07";
    const result = feedChunks([osc, "/lhc-help\r"]);
    expect(result.toPty).toBe(osc);
    expect(result.dispatch).toBe("/lhc-help");
  });

  it("passes legacy mouse and bare ESC pairs through without disarming interception", () => {
    const legacy = "\x1bM!!!";
    const bare = "\x1bY";
    const result = feedChunks([legacy, bare, "/lhc-stats\r"]);
    expect(result.toPty).toBe(`${legacy}${bare}`);
    expect(result.dispatch).toBe("/lhc-stats");
  });

  it("passes tab and other C0 controls on a fresh line without disarming interception", () => {
    const result = feedChunks(["\t", "/lhc-status\r"]);
    expect(result.toPty).toBe("\t");
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.state.shadowLen).toBe(0);
  });

  it("intercepts after mouse SGR noise mid-withhold", () => {
    const mouse = "\x1b[<35;10;5M";
    const result = feedChunks(["/lh", mouse, "c-status\r"]);
    expect(result.toPty).toBe(mouse);
    expect(result.toStdout).toBe("/lhc-status\r\n");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("intercepts after focus events mid-withhold", () => {
    const result = feedChunks(["/lhc", "\x1b[I", "-prune\r"]);
    expect(result.toPty).toBe("\x1b[I");
    expect(result.dispatch).toBe("/lhc-prune");
    expect(result.state.withholding).toBe(false);
  });

  it("dispatches on kitty Enter \\x1b[13u while withholding", () => {
    const result = feedChunks(["/lhc-stats", "\x1b[13u"]);
    expect(result.toPty).toBe("\x1b[13");
    expect(result.dispatch).toBe("/lhc-stats");
    expect(result.toStdout).toBe("/lhc-stats\r\n");
  });

  it("dispatches on kitty Enter with modifier params while withholding", () => {
    const result = feedChunks(["/lhc-help", "\x1b[13;1u"]);
    expect(result.dispatch).toBe("/lhc-help");
    expect(result.toPty).toBe("\x1b[13;1");
    expect(result.toStdout).toBe("/lhc-help\r\n");
  });

  it("intercepts after a CSI sequence split across chunks mid-withhold", () => {
    const first = feed("/lh");
    expect(first.state.withholding).toBe(true);
    const mid = feedChunks(["\x1b[", "35;10;5M"], first.state);
    expect(mid.toPty).toBe("\x1b[35;10;5M");
    expect(mid.state.withholding).toBe(true);
    expect(mid.state.buffer).toBe("/lh");
    const last = feedChunks(["c-status\r"], mid.state);
    expect(last.dispatch).toBe("/lhc-status");
    expect(last.toPty).toBe("");
  });

  const WARP_HANDSHAKE =
    "\x1bP>|Warp(v0.2026.07.01)\x1b\\\x1b[?2026;2$y\x1b[?62c";

  it("intercepts after Warp terminal handshake on startup", () => {
    const result = feedChunks([WARP_HANDSHAKE, "/lhc-status\r"]);
    expect(result.toPty).toBe(WARP_HANDSHAKE);
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.toStdout).toBe("/lhc-status\r\n");
    expect(result.state.shadowLen).toBe(0);
  });

  it("passes Warp DCS split across chunks without disarming interception", () => {
    const dcs = "\x1bP>|Warp(v0.2026.07.01)\x1b\\";
    const first = feedChunks(["\x1bP>|W", "arp(v0.2026.07.01)\x1b\\"]);
    expect(first.state.shadowLen).toBe(0);
    expect(first.state.escapePassthrough).toBeNull();
    expect(first.toPty).toBe(dcs);
    const second = feedChunks(["/lhc-help\r"], first.state);
    expect(second.dispatch).toBe("/lhc-help");
  });

  it("passes DCS through mid-withhold without flushing the buffer", () => {
    const dcs = "\x1bP>|Warp(v0.2026.07.01)\x1b\\";
    const result = feedChunks(["/lh", dcs, "c-prune\r"]);
    expect(result.toPty).toBe(dcs);
    expect(result.dispatch).toBe("/lhc-prune");
    expect(result.toStdout).toBe("/lhc-prune\r\n");
  });

  it("passes DECRPM and DA CSI responses at a fresh line without disarming interception", () => {
    const responses = "\x1b[?2026;2$y\x1b[?62c";
    const result = feedChunks([responses, "/lhc-stats\r"]);
    expect(result.toPty).toBe(responses);
    expect(result.dispatch).toBe("/lhc-stats");
    expect(result.state.shadowLen).toBe(0);
  });
});

describe("shadow line-length freshness", () => {
  it("intercepts a command after type-then-erase with backspace (user-reported repro)", () => {
    const result = feedChunks(["hey", "\x7f\x7f\x7f", "/lhc-status\r"]);
    expect(result.toPty).toBe("hey\x7f\x7f\x7f");
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.toStdout).toBe("/lhc-status\r\n");
  });

  it("floors the count at zero on extra backspaces before a command", () => {
    const result = feedChunks(["hi", "\x7f\x7f\x7f\x7f", "/lhc-stats\r"]);
    expect(result.dispatch).toBe("/lhc-stats");
  });

  it("intercepts a command after ctrl-U clears the line", () => {
    const result = feedChunks(["draft text", "\x15", "/lhc-status\r"]);
    expect(result.toPty).toBe("draft text\x15");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("intercepts a command after ctrl-H (0x08) erases typed chars", () => {
    const result = feedChunks(["ab", "\x08\x08", "/lhc-status\r"]);
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("intercepts a command after a bare Esc keypress zeroes a dirty line", () => {
    const result = feedChunks(["some draft", "\x1b", "/lhc-status\r"]);
    expect(result.toPty).toBe("some draft\x1b");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("Esc recovery works even when the count has drifted past reality", () => {
    // Arrow-key noise miscounted or box cleared behind our back: Esc must
    // always restore arming.
    const drifted = feedChunks(["overcounted line", "\x1b"]);
    expect(drifted.state.shadowLen).toBe(0);
    const result = feedChunks(["/lhc-help\r"], drifted.state);
    expect(result.dispatch).toBe("/lhc-help");
  });

  it("re-arms after Esc cancels a withheld command", () => {
    const result = feedChunks(["/lhc", "\x1b", "/lhc-status\r"]);
    expect(result.toPty).toBe("\x1b");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("counts a bare-Esc-then-typed byte in separate chunks as box content", () => {
    const result = feedChunks(["\x1b", "Y"]);
    expect(result.toPty).toBe("\x1bY");
    expect(result.state.shadowLen).toBe(1);
  });

  it("recovers via backspace after a divergence flush", () => {
    const result = feedChunks(["/lho", "\x7f\x7f\x7f\x7f", "/lhc-status\r"]);
    expect(result.toPty).toBe("/lho\x7f\x7f\x7f\x7f");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("counts UTF-8 characters once (lead byte only) and recovers on backspace", () => {
    const twoByteChar = "é"; // 0xc3 0xa9 in utf8: lead byte counts, continuation does not
    const typed = feedChunks([twoByteChar]);
    expect(typed.state.shadowLen).toBe(1);
    const result = feedChunks(["\x7f", "/lhc-status\r"], typed.state);
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("does not count bracketed-paste markers, does count paste content", () => {
    const paste = "\x1b[200~abc\x1b[201~";
    const pasted = feedChunks([paste]);
    expect(pasted.toPty).toBe(paste);
    expect(pasted.state.shadowLen).toBe(3);
    expect(pasted.state.inPaste).toBe(false);
    const result = feedChunks(["\x7f\x7f\x7f", "/lhc-status\r"], pasted.state);
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("treats pasted newlines as literal box content, not submits", () => {
    const pasted = feedChunks(["\x1b[200~ab\rcd\x1b[201~"]);
    expect(pasted.state.shadowLen).toBe(5);
    expect(pasted.state.inPaste).toBe(false);
    const blocked = feedChunks(["/lhc-status\r"], pasted.state);
    expect(blocked.dispatch).toBeUndefined();
    expect(blocked.toPty).toBe("/lhc-status\r");
  });

  it("still arms for a bracketed paste of the command itself", () => {
    const result = feedChunks(["\x1b[200~/lhc-status\x1b[201~", "\r"]);
    expect(result.dispatch).toBe("/lhc-status");
  });
});

describe("kitty CSI-u functional keys", () => {
  it("kitty backspace decrements the count and interception recovers", () => {
    const result = feedChunks(["ab", "\x1b[127u\x1b[127u", "/lhc-status\r"]);
    expect(result.toPty).toBe("ab\x1b[127u\x1b[127u");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("ignores kitty backspace release events", () => {
    const result = feedChunks(["a", "\x1b[127;1:3u"]);
    expect(result.state.shadowLen).toBe(1);
  });

  it("kitty Esc zeroes a dirty line so a command arms", () => {
    const result = feedChunks(["draft", "\x1b[27u", "/lhc-status\r"]);
    expect(result.toPty).toBe("draft\x1b[27u");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("kitty Enter outside withholding marks the line fresh", () => {
    const result = feedChunks(["hello", "\x1b[13u", "/lhc-status\r"]);
    expect(result.toPty).toBe("hello\x1b[13u");
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("kitty Esc cancels a withheld command and re-arms", () => {
    const result = feedChunks(["/lhc", "\x1b[27u", "/lhc-status\r"]);
    expect(result.toPty).toBe("\x1b[27u");
    expect(result.toStdout).toContain(BS.repeat(4));
    expect(result.dispatch).toBe("/lhc-status");
  });

  it("kitty backspace edits a withheld command", () => {
    const result = feedChunks(["/lhc-stat", "\x1b[127u", "ts\r"]);
    expect(result.toPty).toBe("\x1b[127u");
    expect(result.dispatch).toBe("/lhc-stats");
  });
});

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
    expect(result.state.freshLine).toBe(false);
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

  it("flushes withheld bytes on Escape then passes the sequence through", () => {
    const result = feedChunks(["/lhc", "\x1b[A"]);
    expect(result.toPty).toBe("/lhc\x1b[A");
    expect(result.toStdout).toBe(`/lhc${BS.repeat(4)}`);
    expect(result.state.freshLine).toBe(false);
  });

  it("does not intercept after non-slash content on the line", () => {
    const first = feed("echo hi");
    expect(first.toPty).toBe("echo hi");
    expect(first.state.freshLine).toBe(false);
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
    expect(result.state.freshLine).toBe(false);
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
    expect(result.state).toEqual(createInterceptState());
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
    expect(result.state.freshLine).toBe(true);
  });

  it("intercepts /lhc-prune after focus-reporting noise before typing", () => {
    const result = feedChunks(["\x1b[I", "\x1b[O", "/lhc-prune\r"]);
    expect(result.toPty).toBe("\x1b[I\x1b[O");
    expect(result.dispatch).toBe("/lhc-prune");
    expect(result.toStdout).toBe("/lhc-prune\r\n");
  });

  it("intercepts after a CSI sequence split across chunks", () => {
    const first = feedChunks(["\x1b[", "100"]);
    expect(first.state.freshLine).toBe(true);
    expect(first.state.escapePassthrough).toEqual({ kind: "csi" });
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
    const bare = "\x1bX";
    const result = feedChunks([legacy, bare, "/lhc-stats\r"]);
    expect(result.toPty).toBe(`${legacy}${bare}`);
    expect(result.dispatch).toBe("/lhc-stats");
  });

  it("passes tab and other C0 controls on a fresh line without disarming interception", () => {
    const result = feedChunks(["\t", "/lhc-status\r"]);
    expect(result.toPty).toBe("\t");
    expect(result.dispatch).toBe("/lhc-status");
    expect(result.state.freshLine).toBe(true);
  });
});

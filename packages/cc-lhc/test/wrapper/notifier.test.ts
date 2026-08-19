import { describe, expect, it } from "vitest";

import {
  createInputState,
  type InputAction,
  type InputState,
  matchHazardousCommand,
  processInputChunk,
  resolveBareEsc,
} from "../../src/wrapper/modal.js";
import { NOTIFIER_HINT, renderPanel } from "../../src/wrapper/panel.js";

function feed(
  state: InputState,
  bytes: string | Buffer,
): { state: InputState; toPty: Buffer; actions: InputAction[] } {
  const chunk = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : bytes;
  return processInputChunk(chunk, state);
}

function feedAll(
  state: InputState,
  chunks: Array<string | Buffer>,
): { state: InputState; toPty: Buffer; actions: InputAction[] } {
  let current = state;
  let toPty = Buffer.alloc(0);
  const actions: InputAction[] = [];
  for (const chunk of chunks) {
    const result = feed(current, chunk);
    current = result.state;
    toPty = Buffer.concat([toPty, result.toPty]);
    actions.push(...result.actions);
  }
  return { state: current, toPty, actions };
}

function win32Key(virtualKey: number, unicodeChar: number, keyDown = 1, controlKeyState = 0): string {
  return `\x1b[${virtualKey};0;${unicodeChar};${keyDown};${controlKeyState};1_`;
}

function win32Text(text: string): string[] {
  return [...text].map((char) => win32Key(char.toUpperCase().charCodeAt(0), char.charCodeAt(0)));
}

describe("hazardous-command matcher", () => {
  it("matches only the verified straight-line commands", () => {
    expect(matchHazardousCommand("/resume")).toBe("/resume");
    expect(matchHazardousCommand("/resume abc-123")).toBe("/resume");
    expect(matchHazardousCommand("/clear")).toBe("/clear");
    expect(matchHazardousCommand("/compact")).toBe("/compact");
    expect(matchHazardousCommand("  /clear  ")).toBe("/clear");
    expect(matchHazardousCommand("/clearx")).toBeNull();
    expect(matchHazardousCommand("/compactor")).toBeNull();
    expect(matchHazardousCommand("/help")).toBeNull();
    expect(matchHazardousCommand("say /clear please")).toBeNull();
    // Candidates rejected pending a live fixture:
    expect(matchHazardousCommand("/rewind")).toBeNull();
    expect(matchHazardousCommand("/branch")).toBeNull();
  });
});

describe("hazard notifier: straight-line interception", () => {
  it("holds ONLY the final Enter of a straight-line /clear; continue forwards it exactly once", () => {
    const typed = feed(createInputState(), "/clear");
    expect(typed.toPty.toString()).toBe("/clear"); // command text forwarded untouched
    const submitted = feed(typed.state, "\r");
    expect(submitted.toPty.length).toBe(0); // the Enter is held
    expect(submitted.actions).toEqual([{ kind: "notifier_open", command: "/clear" }]);
    expect(submitted.state.mode).toBe("notifier");

    const continued = feed(submitted.state, "\r");
    expect(continued.actions).toEqual([{ kind: "notifier_continue", enterBytes: [0x0d] }]);
    expect(continued.state.mode).toBe("passthrough");
    // Nothing duplicated: the command text was never re-sent.
    expect(continued.toPty.length).toBe(0);
  });

  it("return via 'n' forwards nothing and a bare re-Enter re-notifies (line stays typed in Claude)", () => {
    const open = feedAll(createInputState(), ["/resume abc", "\r"]);
    expect(open.state.mode).toBe("notifier");
    const returned = feed(open.state, "n");
    expect(returned.actions).toEqual([{ kind: "notifier_return" }]);
    expect(returned.state.mode).toBe("passthrough");
    expect(returned.toPty.length).toBe(0);
    // The typed command still sits in Claude's input line: bare Enter re-notifies.
    const again = feed(returned.state, "\r");
    expect(again.actions).toEqual([{ kind: "notifier_open", command: "/resume" }]);
    // Editing after return poisons: Enter then passes through.
    const edited = feedAll(feed(open.state, "n").state, [Buffer.from([0x7f]), "\r"]);
    expect(edited.actions).toEqual([]);
    expect(edited.toPty.toString("latin1")).toBe("\x7f\r");
  });

  it("ctrl-C and Esc return from the overlay without forwarding", () => {
    const open = feedAll(createInputState(), ["/compact", "\r"]);
    const viaCtrlC = feed(open.state, Buffer.from([0x03]));
    expect(viaCtrlC.actions).toEqual([{ kind: "notifier_return" }]);
    expect(viaCtrlC.toPty.length).toBe(0);

    // Bare Esc: pending, resolved by run.ts's timer.
    const pending = feed(open.state, Buffer.from([0x1b]));
    const resolved = resolveBareEsc(pending.state);
    expect(resolved?.actions).toEqual([{ kind: "notifier_return" }]);
  });

  it("non-hazardous lines pass through with the Enter", () => {
    const result = feedAll(createInputState(), ["/help", "\r"]);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString()).toBe("/help\r");
  });

  it("pasted content never triggers: bracketed paste poisons the line", () => {
    const paste = feedAll(createInputState(), [
      "\x1b[200~", // paste open (forwarded)
      "/clear",
      "\x1b[201~", // paste close
      "\r",
    ]);
    expect(paste.actions).toEqual([]);
    expect(paste.toPty.toString("latin1")).toBe("\x1b[200~/clear\x1b[201~\r");
  });

  it("cursor/history sequences poison the line: no false interception after arrow keys", () => {
    const result = feedAll(createInputState(), ["/clear", "\x1b[A", "\r"]);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString("latin1")).toBe("/clear\x1b[A\r");
  });

  it("backspace editing poisons: '/clearx' + backspace never claims '/clear'", () => {
    const result = feedAll(createInputState(), ["/clearx", Buffer.from([0x7f]), "\r"]);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString("latin1")).toBe("/clearx\x7f\r");
  });

  it("TAB (completion) and non-ASCII poison", () => {
    const tab = feedAll(createInputState(), ["/cle", "\t", "ar", "\r"]);
    expect(tab.actions).toEqual([]);
    const utf8 = feedAll(createInputState(), ["/clear", Buffer.from([0xc3, 0xa9]), "\r"]);
    expect(utf8.actions).toEqual([]);
  });

  it("ctrl-C mid-line is a clean boundary: text typed after it is a fresh line", () => {
    const result = feedAll(createInputState(), ["garbage", Buffer.from([0x03]), "/clear", "\r"]);
    // After ctrl-C cleared Claude's input, "/clear" IS a straight line.
    expect(result.actions).toEqual([{ kind: "notifier_open", command: "/clear" }]);
    expect(result.toPty.toString("latin1")).toBe("garbage\x03/clear");
  });

  it("kitty CSI-u plain Enter is intercepted and replayed byte-exact on continue", () => {
    const typed = feed(createInputState(), "/compact");
    const kittyEnter = Buffer.from("\x1b[13u", "latin1");
    const submitted = feed(typed.state, kittyEnter);
    expect(submitted.toPty.length).toBe(0);
    expect(submitted.actions).toEqual([{ kind: "notifier_open", command: "/compact" }]);
    const continued = feed(submitted.state, "\r");
    expect(continued.actions).toEqual([
      { kind: "notifier_continue", enterBytes: [...kittyEnter] },
    ]);
  });

  it("kitty plain Enter on a non-hazard line forwards intact (clean boundary)", () => {
    const result = feedAll(createInputState(), ["hello", Buffer.from("\x1b[13u", "latin1")]);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString("latin1")).toBe("hello\x1b[13u");
    // Next line is fresh: a straight /clear notifies.
    const next = feedAll(result.state, ["/clear", "\r"]);
    expect(next.actions).toEqual([{ kind: "notifier_open", command: "/clear" }]);
  });

  it("kitty modified Enter (ctrl-Enter) is NOT claimed", () => {
    const result = feedAll(createInputState(), ["/clear", Buffer.from("\x1b[13;5u", "latin1")]);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString("latin1")).toBe("/clear\x1b[13;5u");
  });

  it("tracks win32-mode text and holds the exact encoded Enter", () => {
    const encodedEnter = win32Key(13, 13);
    const submitted = feedAll(createInputState(), [...win32Text("/clear"), encodedEnter]);
    expect(submitted.toPty.toString("latin1")).toBe(win32Text("/clear").join(""));
    expect(submitted.actions).toEqual([{ kind: "notifier_open", command: "/clear" }]);

    const continued = feed(submitted.state, encodedEnter);
    expect(continued.actions).toEqual([
      { kind: "notifier_continue", enterBytes: [...Buffer.from(encodedEnter, "latin1")] },
    ]);
  });

  it("accepts encoded n as return and keeps the hazardous line available for re-Enter", () => {
    const encodedEnter = win32Key(13, 13);
    const open = feedAll(createInputState(), [...win32Text("/resume abc"), encodedEnter]);
    const returned = feed(open.state, win32Key(78, 110));
    expect(returned.actions).toEqual([{ kind: "notifier_return" }]);
    const again = feed(returned.state, encodedEnter);
    expect(again.actions).toEqual([{ kind: "notifier_open", command: "/resume" }]);
  });

  it("keeps win32 key-up and modifier events neutral but poisons navigation", () => {
    const prefix = feedAll(createInputState(), [
      ...win32Text("/cle"),
      win32Key(17, 0, 1, 40), // control down: no edit
      win32Key(17, 0, 0, 40), // control up
      win32Key(69, 101, 0), // printable key release
      ...win32Text("ar"),
      win32Key(13, 13),
    ]);
    expect(prefix.actions).toEqual([{ kind: "notifier_open", command: "/clear" }]);

    const navigated = feedAll(createInputState(), [
      ...win32Text("/clear"),
      win32Key(37, 0), // left arrow key-down
      win32Key(13, 13),
    ]);
    expect(navigated.actions).toEqual([]);
    expect(navigated.toPty.toString("latin1")).toContain(win32Key(37, 0));
  });

  it("forwards a non-hazardous win32-mode line byte-exact", () => {
    const events = [...win32Text("/help"), win32Key(13, 13)];
    const result = feedAll(createInputState(), events);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString("latin1")).toBe(events.join(""));
  });

  it("rapid input in one chunk: earlier lines forward, the hazardous line still intercepts", () => {
    const result = feed(createInputState(), "hello world\r/clear\r");
    expect(result.toPty.toString("latin1")).toBe("hello world\r/clear");
    expect(result.actions).toEqual([{ kind: "notifier_open", command: "/clear" }]);
  });

  it("bytes 'typed' while the overlay is up are dropped, never forwarded out of order", () => {
    const open = feedAll(createInputState(), ["/clear", "\r"]);
    const stray = feed(open.state, "abc");
    expect(stray.toPty.length).toBe(0);
    expect(stray.state.mode).toBe("notifier");
    const continued = feed(stray.state, "\r");
    expect(continued.actions).toEqual([{ kind: "notifier_continue", enterBytes: [0x0d] }]);
  });

  it("disabled notifier is pure passthrough", () => {
    const state = createInputState(undefined, { notifierEnabled: false });
    const result = feedAll(state, ["/clear", "\r", "/resume abc", "\r"]);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString("latin1")).toBe("/clear\r/resume abc\r");
  });


  it("terminal protocol traffic (focus events, DA/DSR/kitty responses, OSC) does NOT poison — the tmux case", () => {
    const result = feedAll(createInputState(), [
      "\x1b[I", // focus in
      "/cl",
      "\x1b[?62;1c", // DA1 response
      "ea",
      "\x1b[24;80R", // cursor position report
      "r",
      "\x1b]11;rgb:1e/1e/1e\x07", // OSC background response
      "\x1b[O", // focus out
      "\r",
    ]);
    // Everything forwarded verbatim, and the straight line still notifies.
    expect(result.actions).toEqual([{ kind: "notifier_open", command: "/clear" }]);
    expect(result.toPty.toString("latin1")).toBe(
      "\x1b[I/cl\x1b[?62;1cea\x1b[24;80Rr\x1b]11;rgb:1e/1e/1e\x07\x1b[O",
    );
  });

  it("navigation keys still poison even between protocol traffic", () => {
    const result = feedAll(createInputState(), ["\x1b[I", "/clear", "\x1b[D", "\r"]);
    expect(result.actions).toEqual([]);
    expect(result.toPty.toString("latin1")).toBe("\x1b[I/clear\x1b[D\r");
  });

  it("the leader still opens the modal from a partially typed hazard line (no interference)", () => {
    const typed = feed(createInputState(), "/cle");
    const opened = feed(typed.state, Buffer.from([0x1d]));
    expect(opened.actions).toEqual([{ kind: "enter_modal" }]);
    expect(opened.state.mode).toBe("modal");
  });
});

describe("notifier overlay rendering", () => {
  it("renders the warning and hint within terminal height at small sizes", () => {
    const open = feedAll(createInputState(), ["/clear", "\r"]);
    for (const [cols, rows] of [
      [120, 40],
      [40, 10],
      [80, 5],
    ] as const) {
      const out = renderPanel(open.state, cols, rows);
      expect(out).toContain("/clear");
      const cursorRows = [...out.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number.parseInt(m[1]!, 10));
      for (const row of cursorRows) expect(row).toBeLessThanOrEqual(Math.max(5, rows));
    }
    const out = renderPanel(open.state, 120, 40);
    expect(out).toContain(NOTIFIER_HINT);
  });
});

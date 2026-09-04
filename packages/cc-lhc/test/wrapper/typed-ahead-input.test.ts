/**
 * Typed-ahead accounting during compaction: only bytes a person could have
 * typed raise the resend notice. The terminal's answers to the replacement
 * child's startup queries arrive on stdin in the same window and are control
 * sequences, not input.
 */
import { describe, expect, it } from "vitest";

import { countTypedBytes } from "../../src/wrapper/typed-ahead-input.js";

const ESC = "\x1b";
const DA1 = `${ESC}[?62;4;6;22c`;
const DA2 = `${ESC}[>1;4000;22c`;
const CURSOR_POSITION = `${ESC}[24;1R`;
const KITTY_FLAGS = `${ESC}[?0u`;
const BACKGROUND_COLOUR = `${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`;
const FOREGROUND_COLOUR_BEL = `${ESC}]10;rgb:ffff/ffff/ffff\x07`;
const DCS_REPLY = `${ESC}P1$r0 q${ESC}\\`;

describe("countTypedBytes", () => {
  it("counts nothing for the terminal's startup replies, alone or run together", () => {
    for (const reply of [DA1, DA2, CURSOR_POSITION, KITTY_FLAGS, BACKGROUND_COLOUR, FOREGROUND_COLOUR_BEL, DCS_REPLY]) {
      expect(countTypedBytes(Buffer.from(reply, "latin1")), JSON.stringify(reply)).toBe(0);
    }
    expect(countTypedBytes(Buffer.from(DA1 + KITTY_FLAGS + BACKGROUND_COLOUR + CURSOR_POSITION, "latin1"))).toBe(0);
  });

  it("counts every byte a person typed, before, between and after replies", () => {
    expect(countTypedBytes(Buffer.from("hello\r"))).toBe(6);
    expect(countTypedBytes(Buffer.from(`ab${DA1}c\r${KITTY_FLAGS}`, "latin1"))).toBe(4);
    expect(countTypedBytes(Buffer.from("\x03"))).toBe(1);
  });

  it("counts an alt-modified key as typed but not navigation keys", () => {
    expect(countTypedBytes(Buffer.from(`${ESC}x`))).toBe(2);
    expect(countTypedBytes(Buffer.from(`${ESC}[A${ESC}OB`))).toBe(0);
  });

  it("treats a sequence cut off by the chunk boundary as a reply, not typing", () => {
    expect(countTypedBytes(Buffer.from(`x${ESC}[?62;4`))).toBe(1);
    expect(countTypedBytes(Buffer.from(`x${ESC}]11;rgb:1e1e`))).toBe(1);
    expect(countTypedBytes(Buffer.from(`x${ESC}`))).toBe(1);
  });
});

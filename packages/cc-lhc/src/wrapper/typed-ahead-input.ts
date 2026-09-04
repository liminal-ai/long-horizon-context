/**
 * Typed-ahead input during compaction.
 *
 * Once compact owns the settled session, input stops being forwarded. Bytes
 * typed from that moment are dropped — not buffered, not journalled, never
 * replayed. Replaying them into a replacement is a real duplicate-send hazard,
 * and holding them is what turned input delivery into a veto over a swap that
 * had already succeeded. The operator gets one line and resends.
 *
 * Input that started BEFORE ownership is not typed-ahead at all: it opens a
 * normal turn, and compact re-evaluates at that turn's settle.
 */

/** The one line. Nothing else about dropped input reaches the terminal. */
export const TYPED_AHEAD_RESEND_NOTICE = "input typed during compaction was not delivered — please resend";

/**
 * How many of the bytes dropped during compaction a person could have typed.
 *
 * The replacement child interrogates the terminal as it starts (device
 * attributes, cursor position, keyboard-protocol flags, colours), and the
 * terminal answers on stdin while compact still owns input. Those answers are
 * ESC-led control sequences (CSI, OSC, DCS, SS3, APC/PM/SOS), never text. They
 * are dropped like everything else in the window, but they are not typed-ahead
 * and must not raise the resend notice: counting them told the operator to
 * resend input that never existed, on every Smart Compact. Every byte outside
 * a control sequence counts, including keys (arrows, Enter) that arrive as
 * their own sequences — those are handled below as ESC + final only when they
 * are not one of the reply shapes. A sequence cut off by the chunk boundary
 * counts as a reply.
 */
export function countTypedBytes(chunk: Buffer): number {
  let typed = 0;
  let i = 0;
  while (i < chunk.length) {
    const byte = chunk[i]!;
    if (byte !== 0x1b) {
      typed += 1;
      i += 1;
      continue;
    }
    const next = chunk[i + 1];
    if (next === undefined) break; // ESC at the boundary: head of a split reply
    if (next === 0x5b) {
      // CSI: parameters 0x30–0x3f, intermediates 0x20–0x2f, one final 0x40–0x7e.
      let j = i + 2;
      while (j < chunk.length && chunk[j]! >= 0x20 && chunk[j]! <= 0x3f) j += 1;
      if (j >= chunk.length) break;
      i = j + 1;
      continue;
    }
    if (next === 0x5d || next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
      // OSC / DCS / APC / PM / SOS: runs to BEL or ST (ESC \).
      let j = i + 2;
      for (;;) {
        if (j >= chunk.length) return typed;
        if (chunk[j] === 0x07) break;
        if (chunk[j] === 0x1b && chunk[j + 1] === 0x5c) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (next === 0x4f) {
      // SS3: one final byte (cursor keys in application mode).
      i += 3;
      continue;
    }
    // ESC + other: an alt-modified key — typed.
    typed += 2;
    i += 2;
  }
  return typed;
}

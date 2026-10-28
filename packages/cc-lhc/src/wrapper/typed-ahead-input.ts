export const TYPED_AHEAD_RESEND_NOTICE = "input typed during compaction was not delivered — please resend";

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
    if (next === undefined) break;
    if (next === 0x5b) {
      let j = i + 2;
      while (j < chunk.length && chunk[j]! >= 0x20 && chunk[j]! <= 0x3f) j += 1;
      if (j >= chunk.length) break;
      i = j + 1;
      continue;
    }
    if (next === 0x5d || next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
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
      i += 3;
      continue;
    }
    typed += 2;
    i += 2;
  }
  return typed;
}

// Deterministic prompt floor for smoothing recovery. Pure by construction:
// no DB, no clock, no provider.
function cleanProse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\bi\b/g, "I");
}

function readLine(text: string, start: number): { raw: string; body: string; next: number } {
  let end = start;
  while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
  let next = end;
  if (end < text.length) {
    if (text[end] === "\r" && text[end + 1] === "\n") next = end + 2;
    else next = end + 1;
  }
  return { raw: text.slice(start, next), body: text.slice(start, end), next };
}

function fenceMarker(body: string): "`" | "~" | null {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("```")) return "`";
  if (trimmed.startsWith("~~~")) return "~";
  return null;
}

export function cleanPrompt(text: string): string {
  const parts: string[] = [];
  let proseStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const line = readLine(text, cursor);
    const marker = fenceMarker(line.body);
    if (marker === null) {
      cursor = line.next;
      continue;
    }

    const prose = cleanProse(text.slice(proseStart, cursor));
    if (prose !== "") parts.push(`${prose}\n`);

    let fenceEnd = line.next;
    while (fenceEnd < text.length) {
      const fenceLine = readLine(text, fenceEnd);
      fenceEnd = fenceLine.next;
      if (fenceMarker(fenceLine.body) === marker) break;
    }
    parts.push(text.slice(cursor, fenceEnd));
    cursor = fenceEnd;
    proseStart = fenceEnd;
  }
  const tail = cleanProse(text.slice(proseStart));
  if (tail !== "") parts.push(tail);
  return parts.join("");
}

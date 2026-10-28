export const MAX_LISTED_TOOL_CALLS = 12;
const MAX_TOOL_SUMMARY_CHARS = 90;

export const REJECTED_AGAIN_NOTICE_LINES = [
  "Claude rejected the request as too long again after Smart Compact; cc-lhc did not continue it a second time.",
  "The task is too large for one turn: split it (for example read fewer pages or a smaller range at once) and resend.",
];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocksOf(message: unknown): unknown[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function isRealPrompt(line: Json): boolean {
  if (line.type !== "user" || line.isMeta === true || line.isSidechain === true) return false;
  const blocks = blocksOf(line.message);
  if (blocks.length === 0) return false;
  if (blocks.some((block) => isRecord(block) && block.type === "tool_result")) return false;
  const text = blocks
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trimStart();
  if (text.length === 0) return false;
  return !text.startsWith("[runtime note]") && !text.startsWith("<task-notification>");
}

function summarizeInput(input: unknown): string {
  if (!isRecord(input)) return "";
  const parts: string[] = [];
  for (const key of ["file_path", "command", "pattern", "url", "path", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
      break;
    }
  }
  for (const key of ["pages", "offset", "limit"]) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number") parts.push(`${key} ${value}`);
  }
  const flat = parts.join(", ").replace(/\s+/g, " ").trim();
  return flat.length <= MAX_TOOL_SUMMARY_CHARS ? flat : `${flat.slice(0, MAX_TOOL_SUMMARY_CHARS - 1)}~`;
}

export function completedToolCallsInLastTurn(rolloutText: string): string[] {
  const lines: Json[] = [];
  for (const raw of rolloutText.split("\n")) {
    if (raw.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) lines.push(parsed);
    } catch {}
  }
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isRealPrompt(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  const calls: { id: string; label: string }[] = [];
  const finished = new Set<string>();
  for (const line of lines.slice(start)) {
    if (line.isSidechain === true) continue;
    for (const block of blocksOf(line.message)) {
      if (!isRecord(block)) continue;
      if (line.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
        const name = typeof block.name === "string" ? block.name : "tool";
        const summary = summarizeInput(block.input);
        calls.push({ id: block.id, label: summary.length > 0 ? `${name}(${summary})` : name });
      }
      if (line.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        finished.add(block.tool_use_id);
      }
    }
  }
  return calls.filter((call) => finished.has(call.id)).map((call) => call.label);
}

export function rejectionContinueNote(completedToolCalls: readonly string[]): string {
  const listed = completedToolCalls.slice(0, MAX_LISTED_TOOL_CALLS);
  const more = completedToolCalls.length - listed.length;
  const tools =
    listed.length === 0
      ? "No tool calls had completed in that turn."
      : `Tool calls that had already completed in that turn: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
  return (
    "[runtime note] cc-lhc: your previous turn was rejected by the API as too long (Prompt is too long), " +
    "so cc-lhc ran Smart Compact and is continuing that turn once. " +
    `${tools} Continue where you left off; do not repeat completed work unless you need its output again, ` +
    "and keep each step small enough to fit."
  );
}

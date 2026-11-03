/**
 * Claude Code 2.1.317's own token estimate for message content (its `i3` and
 * `uYe`): a quarter token per character, rounded per block, half for JSON
 * documents, 2000 for an image or a non-text document.
 */
const IMAGE_TOKENS = 2000;

const quarter = (text: unknown, perToken = 4): number =>
  typeof text === "string" ? Math.round(text.length / perToken) : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function perTokenFor(title: unknown): number {
  const extension = typeof title === "string" ? title.split(".").pop()?.toLowerCase() : undefined;
  return extension === "json" || extension === "jsonl" || extension === "jsonc" ? 2 : 4;
}

function blockTokens(block: unknown): number {
  if (typeof block === "string") return quarter(block);
  if (!isRecord(block)) return 0;
  const { type } = block;
  if (type === "text") return quarter(block.text);
  if (type === "document" && isRecord(block.source)) {
    const { source } = block;
    if (source.type === "text") return quarter(source.data, perTokenFor(block.title));
    if (source.type === "content") {
      if (typeof source.content === "string") return quarter(source.content);
      if (Array.isArray(source.content)) return estimateContent(source.content.filter(isRecord));
    }
  }
  if (type === "image" || type === "document") return IMAGE_TOKENS;
  if (type === "tool_result") return estimateContent(block.content);
  if (type === "tool_use") return quarter(`${String(block.name)}${JSON.stringify(block.input ?? {})}`);
  if (type === "thinking") return quarter(block.thinking);
  if (type === "redacted_thinking") return quarter(block.data);
  return quarter(JSON.stringify(block));
}

export function estimateContent(content: unknown): number {
  if (typeof content === "string") return quarter(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, block) => sum + blockTokens(block), 0);
}

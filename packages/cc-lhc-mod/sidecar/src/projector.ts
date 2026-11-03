import type { ApiBlock, SessionThreadView, SessionThreadViewEntrySource } from "lhc";
import type { BuiltMessage, BuiltToolUse } from "../../src/compact.ts";

export const DANGLING_RESULT = "[tool result unavailable: the session was interrupted before this call completed]";

const idOf = (sources: readonly SessionThreadViewEntrySource[]): string => sources[0]?.messageId ?? "unknown";

function omitted(blocks: readonly ApiBlock[] | undefined, messageId: string): string[] {
  const kinds = [...new Set((blocks ?? []).map((block) => block.type).filter((type) => type !== "text"))];
  return kinds.map((kind) => `[${kind} omitted by LHC: ${messageId}]`);
}

function withPlaceholders(text: string, blocks: readonly ApiBlock[] | undefined, messageId: string): string {
  const notes = omitted(blocks, messageId);
  if (notes.length === 0) return text;
  return [text, ...notes].filter((part) => part !== "").join("\n");
}

export function projectView(view: SessionThreadView): BuiltMessage[] {
  const built: BuiltMessage[] = [];
  let open: BuiltToolUse[] = [];
  let openMessage: BuiltMessage | undefined;
  let held: BuiltMessage[] = [];
  const answered = new Set(view.entries.flatMap((entry) => ("role" in entry && entry.role === "toolResult" ? [entry.toolCallId] : [])));
  // Only a call whose result the view holds further on is still running; any other was interrupted.
  const isAwaiting = (): boolean => open.some((use) => use.text === undefined && answered.has(use.tool_use_id));
  const release = (): void => {
    built.push(...held);
    held = [];
  };

  const settleOpen = (): void => {
    for (const use of open) {
      if (use.text !== undefined) continue;
      use.text = DANGLING_RESULT;
      use.isError = true;
      built.push({
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [{ tool_use_id: use.tool_use_id, text: DANGLING_RESULT, isError: true }],
      });
    }
    open = [];
    release();
  };

  for (const entry of view.entries) {
    if (!("role" in entry)) continue;
    if (entry.role === "toolResult") {
      const text = withPlaceholders(entry.content, entry.blocks, idOf(entry.sourceMessages));
      const result = text === "" ? `[empty tool result: ${idOf(entry.sourceMessages)}]` : text;
      const isError = entry.isError === true;
      const use = open.find((candidate) => candidate.tool_use_id === entry.toolCallId);
      if (use !== undefined) {
        use.text = result;
        if (isError) use.isError = true;
      }
      built.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: entry.toolCallId, text: result, isError }] });
      if (!isAwaiting()) release();
      continue;
    }
    if (entry.role === "user") {
      const text = withPlaceholders(entry.content, entry.blocks, idOf(entry.sourceMessages));
      if (text === "") continue;
      // Claude Code needs a call's result right after it; a note recorded while the call ran follows the results.
      if (isAwaiting()) {
        held.push({ role: "user", text, toolUses: [] });
        continue;
      }
      settleOpen();
      built.push({ role: "user", text, toolUses: [] });
      continue;
    }
    const text = entry.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
    const toolUses = entry.content.flatMap((part): BuiltToolUse[] =>
      part.type === "toolCall"
        ? [{ tool_use_id: part.toolCallId ?? "", tool: part.toolName ?? "unknown_tool", input: part.arguments ?? {} }]
        : [],
    );
    if (text === "" && toolUses.length === 0) continue;
    // A note recorded mid-response splits it; until any of its calls has a result, the next part is the same response.
    if (openMessage !== undefined && isAwaiting() && open.every((use) => use.text === undefined)) {
      openMessage.text = [openMessage.text, text].filter((part) => part !== "").join("\n");
      openMessage.toolUses.push(...toolUses);
      continue;
    }
    settleOpen();
    openMessage = { role: "assistant", text, toolUses };
    built.push(openMessage);
    open = toolUses;
  }
  settleOpen();
  return built;
}

import type {
  Band,
  SessionAssistantPart,
  SessionThreadView,
  SessionThreadViewEntry,
  SessionThreadViewEntrySource,
} from "../../shared-tech/index.js";
import { readBoundaryPosition } from "./boundary.js";
import { type TailRenderContext, toolNamesByCallId, toolResultSessionContent } from "./render.js";
import type { TailMessageRow } from "./snapshot.js";
import { readTailMessages, readThreadMetadata, readViewSnapshot } from "./snapshot.js";

function blockContent(message: TailMessageRow): Record<string, unknown> {
  return message.blocks[0]?.content ?? {};
}

function textOf(message: TailMessageRow): string {
  const text = blockContent(message)["text"];
  return typeof text === "string" ? text : "";
}

function entrySource(message: TailMessageRow): SessionThreadViewEntrySource {
  return { messageId: message.messageId, idempotencyKey: message.idempotencyKey };
}

function parseModelRef(model: string): { provider: string; modelId: string } | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function bandUserMessage(band: Band, renderedText: string): SessionThreadViewEntry {
  return { role: "user", content: `[context · ${band}]\n${renderedText}`, sourceMessages: [] };
}

function assistantPartOf(message: TailMessageRow): SessionAssistantPart {
  switch (message.kind) {
    case "assistant_thinking":
      return { type: "thinking", thinking: textOf(message) };
    case "assistant_text":
      return { type: "text", text: textOf(message) };
    case "tool_call": {
      const block = blockContent(message);
      return {
        type: "toolCall",
        toolCallId: typeof block["toolCallId"] === "string" ? block["toolCallId"] : "",
        toolName: typeof block["toolName"] === "string" ? block["toolName"] : "unknown_tool",
        arguments:
          typeof block["arguments"] === "object" && block["arguments"] !== null && !Array.isArray(block["arguments"])
            ? (block["arguments"] as Record<string, unknown>)
            : {},
      };
    }
    default:
      return { type: "text", text: "" };
  }
}

function toolResultOf(message: TailMessageRow, ctx: TailRenderContext): SessionThreadViewEntry {
  const block = blockContent(message);
  const toolCallId = typeof block["toolCallId"] === "string" ? block["toolCallId"] : "";
  const result: SessionThreadViewEntry = {
    role: "toolResult",
    toolCallId,
    toolName: ctx.toolNameByCallId.get(toolCallId) ?? "unknown_tool",
    content: toolResultSessionContent(message, ctx),
    sourceMessages: [entrySource(message)],
  };
  if (block["isError"] === true) {
    return { ...result, isError: true };
  }
  return result;
}

function modelChangeOf(message: TailMessageRow): SessionThreadViewEntry | null {
  const block = blockContent(message);
  const newModel = typeof block["newModel"] === "string" ? block["newModel"] : "";
  const parsed = parseModelRef(newModel);
  if (parsed === null) return null;
  return {
    kind: "model_change",
    provider: parsed.provider,
    modelId: parsed.modelId,
    sourceMessages: [entrySource(message)],
  };
}

function thinkingLevelChangeOf(message: TailMessageRow): SessionThreadViewEntry {
  const block = blockContent(message);
  const level = typeof block["newLevel"] === "string" ? block["newLevel"] : "";
  return { kind: "thinking_level_change", level, sourceMessages: [entrySource(message)] };
}

function tailEntriesOf(rows: readonly TailMessageRow[], boundaryPosition: number): SessionThreadViewEntry[] {
  const renderCtx: TailRenderContext = {
    boundaryPosition,
    toolNameByCallId: toolNamesByCallId(rows),
  };
  const entries: SessionThreadViewEntry[] = [];
  let assistantParts: SessionAssistantPart[] = [];
  let assistantSources: SessionThreadViewEntrySource[] = [];

  const flushAssistant = (): void => {
    if (assistantParts.length === 0) return;
    entries.push({ role: "assistant", content: assistantParts, sourceMessages: assistantSources });
    assistantParts = [];
    assistantSources = [];
  };

  for (const row of rows) {
    switch (row.kind) {
      case "user_prompt":
        flushAssistant();
        entries.push({ role: "user", content: textOf(row), sourceMessages: [entrySource(row)] });
        break;
      case "assistant_thinking":
      case "assistant_text":
      case "tool_call":
        assistantParts.push(assistantPartOf(row));
        assistantSources.push(entrySource(row));
        break;
      case "tool_result":
        flushAssistant();
        entries.push(toolResultOf(row, renderCtx));
        break;
      case "model_change": {
        const modelChange = modelChangeOf(row);
        if (modelChange !== null) entries.push(modelChange);
        break;
      }
      case "thinking_level_change":
        entries.push(thinkingLevelChangeOf(row));
        break;
      case "runtime_note":
        break;
    }
  }
  flushAssistant();
  return entries;
}

export function buildSessionThreadView(db: Parameters<typeof readViewSnapshot>[0]): SessionThreadView {
  const { threadId } = readThreadMetadata(db);
  const snapshot = readViewSnapshot(db);
  const compactPoint = snapshot?.compactPoint ?? 0;
  const boundaryPosition = readBoundaryPosition(db);
  const tailRows = readTailMessages(db, compactPoint);

  const entries: SessionThreadViewEntry[] = [];
  if (snapshot !== null) {
    for (const band of snapshot.bands) {
      entries.push(bandUserMessage(band.band, band.renderedText));
    }
  }
  entries.push(...tailEntriesOf(tailRows, boundaryPosition));
  return { threadId, entries };
}

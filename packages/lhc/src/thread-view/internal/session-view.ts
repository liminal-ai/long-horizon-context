import type {
  Band,
  SessionAssistantPart,
  SessionThreadView,
  SessionThreadViewEntry,
  SessionThreadViewEntrySource,
} from "../../shared-tech/index.js";
import { readBoundaryPosition } from "./boundary.js";
import { isEmptyThinkingHusk, type TailRenderContext, toolNamesByCallId, toolResultSessionContent } from "./render.js";
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

function thinkingSignatureOf(message: TailMessageRow): string | undefined {
  const content = blockContent(message);
  const signature = content["signature"] ?? content["thinkingSignature"];
  return typeof signature === "string" && signature !== "" ? signature : undefined;
}

function stringField(content: Record<string, unknown>, key: string): string | undefined {
  const value = content[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

interface RowProvenance {
  provider?: string;
  model?: string;
  api?: string;
}

/** Provider/model/api carried by one assistant row (thinking or text only). */
function rowProvenanceOf(row: TailMessageRow): RowProvenance {
  if (row.kind !== "assistant_thinking" && row.kind !== "assistant_text") return {};
  const content = blockContent(row);
  const provider = stringField(content, "provider");
  const model = stringField(content, "model");
  const api = stringField(content, "api");
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(api !== undefined ? { api } : {}),
  };
}

/** True when both sides state a field and disagree — rows with no provenance
 *  never conflict (they inherit the group's). */
function provenanceConflicts(a: RowProvenance, b: RowProvenance): boolean {
  return (
    (a.provider !== undefined && b.provider !== undefined && a.provider !== b.provider) ||
    (a.model !== undefined && b.model !== undefined && a.model !== b.model) ||
    (a.api !== undefined && b.api !== undefined && a.api !== b.api)
  );
}

/** First non-empty provider/model/api from grouped assistant rows (thinking or text). */
function modelProvenanceOf(rows: readonly TailMessageRow[]): {
  provider?: string;
  model?: string;
  api?: string;
} {
  let provider: string | undefined;
  let model: string | undefined;
  let api: string | undefined;
  for (const row of rows) {
    if (row.kind !== "assistant_thinking" && row.kind !== "assistant_text") continue;
    const content = blockContent(row);
    provider ??= stringField(content, "provider");
    model ??= stringField(content, "model");
    api ??= stringField(content, "api");
    if (provider !== undefined && model !== undefined && api !== undefined) break;
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(api !== undefined ? { api } : {}),
  };
}

function assistantPartOf(message: TailMessageRow): SessionAssistantPart {
  switch (message.kind) {
    case "assistant_thinking": {
      const part: SessionAssistantPart = { type: "thinking", thinking: textOf(message) };
      const signature = thinkingSignatureOf(message);
      if (signature !== undefined) part.thinkingSignature = signature;
      return part;
    }
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
  let assistantRows: TailMessageRow[] = [];
  let assistantProvenance: RowProvenance = {};

  const flushAssistant = (): void => {
    if (assistantParts.length === 0) return;
    const provenance = modelProvenanceOf(assistantRows);
    entries.push({
      role: "assistant",
      content: assistantParts,
      sourceMessages: assistantSources,
      ...provenance,
    });
    assistantParts = [];
    assistantSources = [];
    assistantRows = [];
    assistantProvenance = {};
  };

  for (const row of rows) {
    if (isEmptyThinkingHusk(row)) continue;
    switch (row.kind) {
      case "user_prompt":
        flushAssistant();
        entries.push({ role: "user", content: textOf(row), sourceMessages: [entrySource(row)] });
        break;
      case "assistant_thinking":
      case "assistant_text":
      case "tool_call": {
        // Identity boundary: message-level provenance covers every signature
        // in the group, so rows captured under a different model/provider
        // must start a new assistant entry — otherwise the identity gate
        // would re-emit (or suppress) the wrong ciphertext on resume.
        const rp = rowProvenanceOf(row);
        if (provenanceConflicts(assistantProvenance, rp)) flushAssistant();
        const merged = {
          provider: assistantProvenance.provider ?? rp.provider,
          model: assistantProvenance.model ?? rp.model,
          api: assistantProvenance.api ?? rp.api,
        };
        assistantProvenance = {
          ...(merged.provider !== undefined ? { provider: merged.provider } : {}),
          ...(merged.model !== undefined ? { model: merged.model } : {}),
          ...(merged.api !== undefined ? { api: merged.api } : {}),
        };
        assistantParts.push(assistantPartOf(row));
        assistantSources.push(entrySource(row));
        assistantRows.push(row);
        break;
      }
      case "tool_result":
        flushAssistant();
        entries.push(toolResultOf(row, renderCtx));
        break;
      case "model_change": {
        // Flush first: the change marks a boundary in time, so it must not
        // appear BEFORE assistant output that preceded it.
        flushAssistant();
        const modelChange = modelChangeOf(row);
        if (modelChange !== null) entries.push(modelChange);
        break;
      }
      case "thinking_level_change":
        flushAssistant();
        entries.push(thinkingLevelChangeOf(row));
        break;
      case "runtime_note":
        // Same rendering as getLlmRequestContext: a labeled user line. Hosts
        // rebuilding a session file from this view keep the note in place, so
        // the assistant turn that responded to it stays coherent.
        flushAssistant();
        entries.push({ role: "user", content: `[runtime note] ${textOf(row)}`, sourceMessages: [entrySource(row)] });
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

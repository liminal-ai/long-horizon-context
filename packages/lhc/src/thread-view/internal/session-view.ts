import {
  type ApiBlock,
  type ApiBlockType,
  type Band,
  type BlobLoader,
  inlineBlobs,
  type SessionAssistantPart,
  type SessionThreadView,
  type SessionThreadViewEntry,
  type SessionThreadViewEntrySource,
} from "../../shared-tech/index.js";
import { readTurnSteps } from "../../turns/index.js";
import { readBoundaryPosition } from "./boundary.js";
import { isEmptyThinkingHusk, type TailRenderContext, toolNamesByCallId, toolResultSessionContent } from "./render.js";
import type { TailMessageRow } from "./snapshot.js";
import { readBlob, readTailMessages, readThreadMetadata, readViewSnapshot } from "./snapshot.js";

const SERVER_RESULT_TYPES: ReadonlySet<string> = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
]);

function apiBlocksOf(message: TailMessageRow, load: BlobLoader): ApiBlock[] {
  return message.blocks.slice(1).map((block) => inlineBlobs(block.content, load) as ApiBlock);
}

function serverResultPart(blocks: readonly ApiBlock[]): SessionAssistantPart | null {
  const [only] = blocks;
  if (blocks.length !== 1 || only === undefined || !SERVER_RESULT_TYPES.has(only.type)) return null;
  return { type: only.type as ApiBlockType, block: only };
}

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

function bandUserMessage(
  band: Band,
  renderedText: string,
  sourceMessages: SessionThreadViewEntrySource[],
): SessionThreadViewEntry {
  return { role: "user", content: `[context · ${band}]\n${renderedText}`, sourceMessages };
}

interface ArrangedSubject {
  band: Band;
  subjectKind: "chunk" | "turn";
  subjectId: string;
  derivationUsed?: string;
  part?: { fromStep: number; toStep: number };
}

type DatabaseHandle = Parameters<typeof readViewSnapshot>[0];

const GAP_RUN_SEPARATOR = "–";

function coveredScope(db: DatabaseHandle, subject: ArrangedSubject): { where: string; params: Array<string | number> } {
  if (subject.subjectKind === "chunk") {
    return { where: "m.turn_id IN (SELECT turn_id FROM chunk_member WHERE chunk_id = ?)", params: [subject.subjectId] };
  }
  const [first, last] = subject.subjectId.split(GAP_RUN_SEPARATOR);
  if (subject.derivationUsed === "gap" && first !== undefined && last !== undefined) {
    return {
      where: `m.turn_id IN (SELECT turn_id FROM turns WHERE turn_order BETWEEN
        (SELECT turn_order FROM turns WHERE turn_id = ?) AND (SELECT turn_order FROM turns WHERE turn_id = ?))`,
      params: [first, last],
    };
  }
  const partEnd =
    subject.part === undefined
      ? undefined
      : readTurnSteps(db, subject.subjectId).steps.find((step) => step.index === subject.part?.toStep)?.lastOrder;
  if (partEnd !== undefined) {
    return { where: "m.turn_id = ? AND m.source_event_order <= ?", params: [subject.subjectId, partEnd] };
  }
  return { where: "m.turn_id = ?", params: [subject.subjectId] };
}

function bandLastSource(
  db: DatabaseHandle,
  subjects: readonly ArrangedSubject[],
  compactPoint: number,
): SessionThreadViewEntrySource[] {
  let last: { message_id: string; source_event_order: number | bigint; idempotency_key: string | null } | undefined;
  for (const subject of subjects) {
    const { where, params } = coveredScope(db, subject);
    const row = db
      .prepare(
        `SELECT m.message_id, m.source_event_order, e.idempotency_key FROM message m
         JOIN event e ON e.event_order = m.source_event_order
         WHERE m.deleted_at IS NULL AND m.source_event_order <= ? AND ${where}
         ORDER BY m.source_event_order DESC LIMIT 1`,
      )
      .get(compactPoint, ...params) as typeof last;
    if (row !== undefined && (last === undefined || Number(row.source_event_order) > Number(last.source_event_order)))
      last = row;
  }
  return last === undefined ? [] : [{ messageId: last.message_id, idempotencyKey: last.idempotency_key }];
}

function arrangedSubjects(db: DatabaseHandle, viewId: string): ArrangedSubject[] {
  const row = db.prepare("SELECT arrangement_json FROM thread_view WHERE view_id = ?").get(viewId) as
    | { arrangement_json: string }
    | undefined;
  return row === undefined ? [] : (JSON.parse(row.arrangement_json) as ArrangedSubject[]);
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

function provenanceConflicts(a: RowProvenance, b: RowProvenance): boolean {
  return (
    (a.provider !== undefined && b.provider !== undefined && a.provider !== b.provider) ||
    (a.model !== undefined && b.model !== undefined && a.model !== b.model) ||
    (a.api !== undefined && b.api !== undefined && a.api !== b.api)
  );
}

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

function assistantPartOf(message: TailMessageRow, load: BlobLoader): SessionAssistantPart {
  const [apiBlock] = apiBlocksOf(message, load);
  if (apiBlock !== undefined && (apiBlock.type === "redacted_thinking" || apiBlock.type === "server_tool_use")) {
    return { type: apiBlock.type, block: apiBlock };
  }
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

function toolResultOf(message: TailMessageRow, ctx: TailRenderContext, load: BlobLoader): SessionThreadViewEntry {
  const block = blockContent(message);
  const toolCallId = typeof block["toolCallId"] === "string" ? block["toolCallId"] : "";
  const blocks = message.sourceEventOrder > ctx.boundaryPosition ? apiBlocksOf(message, load) : [];
  const result: SessionThreadViewEntry = {
    role: "toolResult",
    toolCallId,
    toolName: ctx.toolNameByCallId.get(toolCallId) ?? "unknown_tool",
    content: toolResultSessionContent(message, ctx),
    ...(blocks.length > 0 ? { blocks } : {}),
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

function tailEntriesOf(
  rows: readonly TailMessageRow[],
  boundaryPosition: number,
  load: BlobLoader,
): SessionThreadViewEntry[] {
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
      case "user_prompt": {
        flushAssistant();
        const blocks = apiBlocksOf(row, load);
        entries.push({
          role: "user",
          content: textOf(row),
          ...(blocks.length > 0 ? { blocks } : {}),
          sourceMessages: [entrySource(row)],
        });
        break;
      }
      case "assistant_thinking":
      case "assistant_text":
      case "tool_call": {
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
        assistantParts.push(assistantPartOf(row, load));
        assistantSources.push(entrySource(row));
        assistantRows.push(row);
        break;
      }
      case "tool_result": {
        const serverPart = serverResultPart(apiBlocksOf(row, load));
        if (serverPart !== null) {
          assistantParts.push(serverPart);
          assistantSources.push(entrySource(row));
          assistantRows.push(row);
          break;
        }
        flushAssistant();
        entries.push(toolResultOf(row, renderCtx, load));
        break;
      }
      case "model_change": {
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
        flushAssistant();
        entries.push({ role: "user", content: `[runtime note] ${textOf(row)}`, sourceMessages: [entrySource(row)] });
        break;
      case "compact_continuation_marker": {
        flushAssistant();
        const block = blockContent(row);
        const cause = typeof block["cause"] === "string" ? block["cause"] : "context_compacted_task_in_progress";
        const action = typeof block["action"] === "string" ? block["action"] : "continue_existing_task";
        const turnId = typeof block["continuationTurnId"] === "string" ? block["continuationTurnId"] : "";
        entries.push({
          role: "user",
          content: [
            "[compact continuation]",
            `cause=${cause}`,
            `action=${action}`,
            "newUserRequest=false",
            "waitForUser=false",
            `continuationTurnId=${turnId}`,
          ].join(" "),
          sourceMessages: [entrySource(row)],
        });
        break;
      }
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
  const blobCache = new Map<string, Uint8Array | undefined>();
  const load: BlobLoader = (sha256) => {
    if (!blobCache.has(sha256)) blobCache.set(sha256, readBlob(db, sha256));
    return blobCache.get(sha256);
  };

  const entries: SessionThreadViewEntry[] = [];
  if (snapshot !== null) {
    const subjects = arrangedSubjects(db, snapshot.viewId);
    for (const band of snapshot.bands) {
      const covered = subjects.filter((subject) => subject.band === band.band);
      entries.push(bandUserMessage(band.band, band.renderedText, bandLastSource(db, covered, compactPoint)));
    }
  }
  entries.push(...tailEntriesOf(tailRows, boundaryPosition, load));
  return { threadId, entries };
}

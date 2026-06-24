import type { InspectOverview, LlmRequestContextMessage, ThreadRef } from "lhc";
import type { AgentMessage } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";

/** One bounded message line in the last-serve diagnostic preview. */
export interface ContextServeMessagePreview {
  role: "user" | "assistant";
  textPreview: string;
}

/** Plain-data record of the last context-serving attempt (connector snapshot seam). */
export interface ContextServeDiagnostic {
  served: boolean;
  reason: string;
  threadId?: string;
  fileRef?: string;
  messageCount: number;
  preview: ContextServeMessagePreview[];
  /** Set when `messageCount` exceeds the preview cap and the tail window is shown. */
  previewWindow?: "first" | "last";
}

export const CONTEXT_SERVE_PREVIEW_MAX_MESSAGES = 8;
export const CONTEXT_SERVE_PREVIEW_MAX_TEXT = 120;

function truncatePreviewText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

/** Build a bounded, deterministic preview of served LHC messages for diagnostics. */
export function buildContextServePreview(messages: readonly LlmRequestContextMessage[]): {
  preview: ContextServeMessagePreview[];
  previewWindow?: "first" | "last";
} {
  const max = CONTEXT_SERVE_PREVIEW_MAX_MESSAGES;
  const useLast = messages.length > max;
  const selected = useLast ? messages.slice(-max) : messages;
  const preview = selected.map((message) => ({
    role: message.role,
    textPreview: truncatePreviewText(llmMessageText(message), CONTEXT_SERVE_PREVIEW_MAX_TEXT),
  }));
  return useLast ? { preview, previewWindow: "last" } : { preview };
}

function fileRefOf(ref: ThreadRef): string | undefined {
  return "filePath" in ref ? ref.filePath : undefined;
}

function threadIdOf(ref: ThreadRef): string | undefined {
  return "threadId" in ref ? ref.threadId : undefined;
}

function llmMessageText(message: LlmRequestContextMessage): string {
  return message.content.map((part) => part.text).join("");
}

/** Map LHC `LlmRequestContext` messages to PI's `AgentMessage` shape (text-only smoke slice). */
export function mapLlmMessagesToPi(messages: readonly LlmRequestContextMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const text = llmMessageText(message);
    if (message.role === "user") {
      return { role: "user", content: text };
    }
    return { role: "assistant", content: [{ type: "text", text }] };
  });
}

function overviewPreview(threadId: string, overview: InspectOverview): string {
  const visibleMessages = overview.messages.visible;
  const eventCount = overview.events.count;
  const turnCount = overview.turns.open + overview.turns.closed;
  return `[pi-lhc context · thread=${threadId} · events=${eventCount} · messages=${visibleMessages} · turns=${turnCount}]`;
}

export type ServeContextResult =
  | { ok: true; messages: AgentMessage[]; diagnostic: ContextServeDiagnostic }
  | { ok: false; diagnostic: ContextServeDiagnostic };

type DiagnosticCore = Pick<ContextServeDiagnostic, "served" | "reason" | "messageCount" | "preview" | "previewWindow">;

function withOptionalRefs(
  base: DiagnosticCore,
  refs: { threadId?: string | undefined; fileRef?: string | undefined },
): ContextServeDiagnostic {
  const diagnostic: ContextServeDiagnostic = { ...base };
  if (refs.threadId !== undefined) diagnostic.threadId = refs.threadId;
  if (refs.fileRef !== undefined) diagnostic.fileRef = refs.fileRef;
  return diagnostic;
}

function previewFromLlmMessages(messages: readonly LlmRequestContextMessage[]): {
  preview: ContextServeMessagePreview[];
  previewWindow?: "first" | "last";
} {
  return buildContextServePreview(messages);
}

function piMessageText(message: AgentMessage): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function previewFromPiMessages(messages: readonly AgentMessage[]): ContextServeMessagePreview[] {
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    textPreview: truncatePreviewText(piMessageText(message), CONTEXT_SERVE_PREVIEW_MAX_TEXT),
  }));
}

/** Pull model context from the active LHC thread-view when possible; fall back to
 *  inspect overview preview when the view read fails or is empty. */
export async function serveContextFromLhc(
  instance: LhcInstance,
  threadRef: ThreadRef,
  originalMessageCount: number,
): Promise<ServeContextResult> {
  const fileRef = fileRefOf(threadRef);
  const refThreadId = threadIdOf(threadRef);

  const contextRead = await instance.sdk.threadView.getLlmRequestContext(threadRef);
  if (contextRead.ok && contextRead.value.messages.length > 0) {
    const servedPreview = previewFromLlmMessages(contextRead.value.messages);
    return {
      ok: true,
      messages: mapLlmMessagesToPi(contextRead.value.messages),
      diagnostic: withOptionalRefs(
        {
          served: true,
          reason: "thread_view",
          messageCount: contextRead.value.messages.length,
          preview: servedPreview.preview,
          ...(servedPreview.previewWindow === undefined ? {} : { previewWindow: servedPreview.previewWindow }),
        },
        { threadId: contextRead.value.threadId, fileRef },
      ),
    };
  }

  const overview = await instance.sdk.inspect.overview(threadRef);
  if (overview.ok && overview.value.events.count > 0) {
    const threadId = overview.value.thread.id;
    const fallbackMessages: AgentMessage[] = [{ role: "user", content: overviewPreview(threadId, overview.value) }];
    return {
      ok: true,
      messages: fallbackMessages,
      diagnostic: withOptionalRefs(
        {
          served: true,
          reason: contextRead.ok ? "overview_preview_empty_view" : `overview_preview:${contextRead.error.reason}`,
          messageCount: 1,
          preview: previewFromPiMessages(fallbackMessages),
        },
        { threadId, fileRef },
      ),
    };
  }

  const reason = !contextRead.ok ? contextRead.error.reason : overview.ok ? "empty_thread" : overview.error.reason;

  return {
    ok: false,
    diagnostic: withOptionalRefs(
      {
        served: false,
        reason,
        messageCount: originalMessageCount,
        preview: [],
      },
      { threadId: refThreadId, fileRef },
    ),
  };
}

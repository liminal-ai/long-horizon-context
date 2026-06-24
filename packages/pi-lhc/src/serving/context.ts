import type { InspectOverview, LlmRequestContextMessage, ThreadRef } from "lhc";
import type { AgentMessage } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";

/** Plain-data record of the last context-serving attempt (connector snapshot seam). */
export interface ContextServeDiagnostic {
  served: boolean;
  reason: string;
  threadId?: string;
  fileRef?: string;
  messageCount: number;
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

function withOptionalRefs(
  base: Pick<ContextServeDiagnostic, "served" | "reason" | "messageCount">,
  refs: { threadId?: string | undefined; fileRef?: string | undefined },
): ContextServeDiagnostic {
  const diagnostic: ContextServeDiagnostic = { ...base };
  if (refs.threadId !== undefined) diagnostic.threadId = refs.threadId;
  if (refs.fileRef !== undefined) diagnostic.fileRef = refs.fileRef;
  return diagnostic;
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
    return {
      ok: true,
      messages: mapLlmMessagesToPi(contextRead.value.messages),
      diagnostic: withOptionalRefs(
        {
          served: true,
          reason: "thread_view",
          messageCount: contextRead.value.messages.length,
        },
        { threadId: contextRead.value.threadId, fileRef },
      ),
    };
  }

  const overview = await instance.sdk.inspect.overview(threadRef);
  if (overview.ok && overview.value.events.count > 0) {
    const threadId = overview.value.thread.id;
    return {
      ok: true,
      messages: [{ role: "user", content: overviewPreview(threadId, overview.value) }],
      diagnostic: withOptionalRefs(
        {
          served: true,
          reason: contextRead.ok ? "overview_preview_empty_view" : `overview_preview:${contextRead.error.reason}`,
          messageCount: 1,
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
      },
      { threadId: refThreadId, fileRef },
    ),
  };
}

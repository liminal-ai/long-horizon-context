import type { MessageEventInput } from "lhc";
import type { AgentMessage } from "../pi/types.js";
import { NotImplementedError } from "../shared/not-implemented.js";

// AC-2.1, AC-2.3, AC-2.4, AC-2.5.

export interface MapCtx {
  piSessionId: string;
  entryId?: string;
}

/** Pure: one PI `AgentMessage` → the ordered LHC events for it. A user message
 *  → one `user_prompt`; an assistant message fans out `assistant_thinking` (if
 *  present) → `assistant_text` (if present) → one `tool_call` per call, in that
 *  order; a tool result → one `tool_result` correlated by `toolCallId`, carrying
 *  `isError`; unsupported parts → `runtime_note` (never a silent drop). Story 2. */
export function mapMessage(msg: AgentMessage, ctx: MapCtx): MessageEventInput[] {
  throw new NotImplementedError("capture.mapMessage");
}

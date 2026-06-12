// `lhc messages list` and `lhc messages show` (Epic 04 Story 1) per tech
// design §Placement: the message read command surface, mirroring the SDK
// operations one-for-one (AC-3.4). Thin argv-to-SDK wrappers — semantic
// option validation (from > to, limit < 1) stays in the SDK so the CLI's
// result JSON deep-equals the in-process result, refusals included.
import * as messages from "../domains/messages/index.js";
import type { MessageListOptions } from "../domains/messages/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import { renderResult, type CliResult } from "./render.js";

export async function runMessagesList(
  threadRef: ThreadRef,
  opts: MessageListOptions,
): Promise<CliResult> {
  return renderResult(await messages.listMessages(threadRef, opts));
}

export async function runMessagesShow(
  threadRef: ThreadRef,
  flags: { messageId: string },
): Promise<CliResult> {
  return renderResult(await messages.show(threadRef, flags.messageId));
}

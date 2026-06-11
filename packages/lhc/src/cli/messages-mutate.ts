// `lhc messages edit` (Story 5) — and Story 6's `lhc messages delete` when
// it lands — per tech design §Placement: the mutation command surface,
// mirroring the SDK operation one-for-one (AC-5.6). Mutations need no
// provider (DD-11): the cascade queues replacement work; only a drain
// dispatches handlers.
import * as messages from "../domains/messages/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import { renderResult, type CliResult } from "./render.js";

export async function runMessagesEdit(
  threadRef: ThreadRef,
  flags: { messageId: string; content: string },
): Promise<CliResult> {
  return renderResult(
    await messages.edit(threadRef, {
      messageId: flags.messageId,
      content: flags.content,
    }),
  );
}

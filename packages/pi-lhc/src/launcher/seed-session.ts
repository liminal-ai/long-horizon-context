import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OpResult, ThreadRef } from "lhc";
import { applySessionThreadViewToSessionManager } from "../serving/context.js";
import type { LhcInstance } from "../shared/instance.js";

/** Load initial model context from LHC and append it to an in-memory PI session. */
export async function seedPiSessionFromLhc(
  instance: LhcInstance,
  threadRef: ThreadRef,
  sessionManager: SessionManager,
): Promise<OpResult<{ messageCount: number }>> {
  const sessionView = await instance.sdk.threadView.getSessionThreadView(threadRef);
  if (!sessionView.ok) return sessionView;

  const seeded = applySessionThreadViewToSessionManager(
    sessionManager,
    sessionView.value.entries,
    sessionView.value.threadId,
  );
  return { ok: true, value: { messageCount: seeded.messageCount } };
}

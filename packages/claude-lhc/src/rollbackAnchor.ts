import type { Lhc, ThreadRef } from "lhc";
import { messageKeyPrefix } from "./capture/mapper.js";
import { nativeMessageAncestors } from "./nativeSessionFile.js";

export interface RollbackAnchor {
  readonly anchor: string;
  readonly keepThroughEventOrder: number;
  readonly via: string;
}

type AnchorLookup = {
  readonly lhc: Lhc;
  readonly thread: ThreadRef;
  readonly anchor: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
};

export async function resolveRollbackAnchor(input: AnchorLookup): Promise<RollbackAnchor | null> {
  const direct = await capturedThrough(input.lhc, input.thread, input.anchor);
  if (direct !== null) return { anchor: input.anchor, keepThroughEventOrder: direct, via: input.anchor };
  return nearestCapturedAncestor(input);
}

async function nearestCapturedAncestor(input: AnchorLookup): Promise<RollbackAnchor | null> {
  const ancestors = await nativeMessageAncestors({
    uuid: input.anchor,
    sessionId: input.sessionId,
    cwd: input.cwd,
    env: input.env,
  });
  for (const uuid of ancestors) {
    const order = await capturedThrough(input.lhc, input.thread, uuid);
    if (order !== null) return { anchor: input.anchor, keepThroughEventOrder: order, via: uuid };
  }
  return null;
}

async function capturedThrough(lhc: Lhc, thread: ThreadRef, uuid: string): Promise<number | null> {
  let last: number | null = null;
  let cursor: string | null = null;
  do {
    const page = await lhc.intakeStream.listEventKeysByPrefix(thread, {
      prefix: messageKeyPrefix(uuid),
      ...(cursor === null ? {} : { cursor }),
    });
    if (!page.ok) throw new Error(`LHC anchor lookup failed: ${page.error.reason}`);
    if (page.value.capExhausted) throw new Error(`LHC anchor lookup for ${uuid} passed the capture key cap`);
    for (const key of page.value.keys) last = Math.max(last ?? key.eventOrder, key.eventOrder);
    cursor = page.value.cursor;
  } while (cursor !== null);
  return last;
}

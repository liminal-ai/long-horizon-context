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
  const keys = await lhc.intakeStream.listEventKeysByPrefix(thread, { prefix: messageKeyPrefix(uuid) });
  if (!keys.ok) throw new Error(`LHC anchor lookup failed: ${keys.error.reason}`);
  return keys.value.keys.length === 0 ? null : Math.max(...keys.value.keys.map((key) => key.eventOrder));
}

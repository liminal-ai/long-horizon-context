import { randomUUID } from "node:crypto";
import type { Lhc, ThreadRef } from "lhc";
import { HARNESS, messageKeyPrefix } from "./capture/mapper.js";
import { nativeMessageChain } from "./nativeSessionFile.js";

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

const CURSOR_PREFIX = "claude-lhc-cursor:";

/** A rollback anchor that names a core event by its intake key, so it outlives every native projection. */
export function eventCursor(threadId: string, idempotencyKey: string): string {
  return `${CURSOR_PREFIX}${threadId}:${idempotencyKey}`;
}

export async function resolveRollbackAnchor(input: AnchorLookup): Promise<RollbackAnchor | null> {
  if (input.anchor.startsWith(CURSOR_PREFIX)) return resolveCursor(input);
  const direct = await capturedThrough(input.lhc, input.thread, input.anchor);
  if (direct !== null) return { anchor: input.anchor, keepThroughEventOrder: direct, via: input.anchor };
  const chain = await nativeMessageChain({
    uuid: input.anchor,
    sessionId: input.sessionId,
    cwd: input.cwd,
    env: input.env,
  });
  for (const line of chain) {
    const order =
      (line.uuid === input.anchor ? null : await capturedThrough(input.lhc, input.thread, line.uuid)) ??
      (line.source === null ? null : await recordedOrder(input.lhc, input.thread, line.source));
    if (order !== null) return { anchor: input.anchor, keepThroughEventOrder: order, via: line.uuid };
  }
  return null;
}

async function resolveCursor({ lhc, thread, anchor }: AnchorLookup): Promise<RollbackAnchor | null> {
  const body = anchor.slice(CURSOR_PREFIX.length);
  const split = body.indexOf(":");
  const threadId = split > 0 ? body.slice(0, split) : "";
  const own = "threadId" in thread ? thread.threadId : null;
  if (threadId !== own) throw new Error(`rollback cursor ${anchor} names LHC thread ${threadId}, not ${own}`);
  const order = await recordedOrder(lhc, thread, body.slice(split + 1));
  return order === null ? null : { anchor, keepThroughEventOrder: order, via: anchor };
}

async function recordedOrder(lhc: Lhc, thread: ThreadRef, key: string): Promise<number | null> {
  const page = await lhc.intakeStream.listEventKeysByPrefix(thread, { prefix: key });
  if (!page.ok) throw new Error(`LHC anchor lookup failed: ${page.error.reason}`);
  return page.value.keys.find((recorded) => recorded.idempotencyKey === key)?.eventOrder ?? null;
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

export async function appendRollback(
  lhc: Lhc,
  thread: ThreadRef,
  { keepThroughEventOrder }: RollbackAnchor,
  reason: string,
): Promise<boolean> {
  const later = await lhc.messages.list(thread, { from: keepThroughEventOrder + 1, limit: 1 });
  if (!later.ok) throw new Error(`LHC message read failed: ${later.error.reason}`);
  if (later.value.length === 0) return false;
  const sent = await lhc.intakeStream.messageEvents(thread, [
    {
      eventKind: "rollback",
      idempotencyKey: `claude-lhc:rollback:${randomUUID()}`,
      actor: "system",
      harness: HARNESS,
      payload: { keepThroughEventOrder, reason },
    },
  ]);
  if (!sent.ok) throw new Error(`LHC intake refused: ${sent.error.code}: ${sent.error.reason}`);
  return true;
}

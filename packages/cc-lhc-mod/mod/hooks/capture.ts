import type { EngineInterface, On } from "claude-code";
import type { CaptureEntry, CapturedMessage } from "../../src/capture.ts";
import { boundSession, log, post, runInBackground } from "./sidecar.ts";

type Captured = { [K in CaptureEntry["kind"]]: Omit<Extract<CaptureEntry, { kind: K }>, "sessionId" | "at"> }[CaptureEntry["kind"]];

const MAX_BATCH = 200;
const RETRY_MS = 2000;

const outbox: CaptureEntry[] = [];
let isFlushQueued = false;
let isRetryArmed = false;
let hookMs: number[] = [];

function flush($: EngineInterface): void {
  if (isFlushQueued) return;
  isFlushQueued = true;
  runInBackground($, "capture", async () => {
    isFlushQueued = false;
    try {
      const sessionId = outbox[0]?.sessionId;
      while (outbox[0] !== undefined && outbox[0].sessionId === sessionId) {
        const end = outbox.findIndex((entry) => entry.sessionId !== sessionId);
        const batch = outbox.slice(0, Math.min(MAX_BATCH, end === -1 ? outbox.length : end));
        await post($, "/capture", { entries: batch });
        outbox.splice(0, batch.length);
      }
      // A later session's entries wait for its bind, which is already queued behind this flush.
      if (outbox.length > 0) flush($);
    } catch (error) {
      if (!isRetryArmed) {
        isRetryArmed = true;
        void $.clock.sleep(RETRY_MS).then(() => {
          isRetryArmed = false;
          flush($);
        });
      }
      throw error;
    }
  });
}

function push($: EngineInterface, entry: Captured): void {
  const sessionId = boundSession();
  if (sessionId === undefined) return;
  outbox.push({ ...entry, sessionId, at: Date.now() } as CaptureEntry);
  flush($);
}

export function captureTurnStart($: EngineInterface, turnId: string): void {
  push($, { kind: "turn-start", turnId });
}

export function registerCapture(on: On): void {
  on("session.append", async ($, e, next) => {
    const stored = await next(e);
    const started = performance.now();
    if (e.agentId === undefined && stored.deny === undefined) {
      push($, {
        kind: "row",
        uuid: stored.uuid,
        door: e.door,
        origin: e.origin.kind,
        message: stored.message as CapturedMessage,
        ...(e.origin.kind === "model" ? { model: e.origin.model } : {}),
      });
      hookMs.push(performance.now() - started);
    }
    return stored;
  });

  on("turn.step", async function* ($, e, next) {
    if (e.agentId === undefined) push($, { kind: "step", turnId: e.turnId, index: e.index });
    return yield* next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      push($, { kind: "turn-end", turnId: e.turnId, isAborted: e.isAborted, reason: e.reason });
      const sorted = hookMs.sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      log($, `capture hook rows ${sorted.length} p95 ${p95.toFixed(3)}ms max ${(sorted.at(-1) ?? 0).toFixed(3)}ms`);
      hookMs = [];
    }
    return next(e);
  });
}

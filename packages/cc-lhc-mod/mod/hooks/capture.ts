import type { EngineInterface, On } from "claude-code";
import type { CaptureEntry, CapturedMessage } from "../../src/capture.ts";
import { boundSession, enqueue, log } from "./sidecar.ts";

type Captured = { [K in CaptureEntry["kind"]]: Omit<Extract<CaptureEntry, { kind: K }>, "sessionId" | "at"> }[CaptureEntry["kind"]];

let hookMs: number[] = [];

/**
 * A turn is named by the uuid of the prompt or command row that opened it,
 * the name recovery derives from the transcript, so the sidecar can tell a
 * replayed marker of an older turn from one of the turn still open. Without
 * that row (a reload mid-turn) the engine's turn id stands in.
 */
let opener: string | undefined;
const turnNames = new Map<string, string>();
const turnName = (turnId: string): string => turnNames.get(turnId) ?? turnId;

function push($: EngineInterface, entry: Captured): void {
  const sessionId = boundSession();
  if (sessionId === undefined) return;
  enqueue($, { ...entry, sessionId, at: Date.now() } as CaptureEntry);
}

export function captureTurnStart($: EngineInterface, turnId: string): void {
  turnNames.set(turnId, opener ?? turnId);
  opener = undefined;
  push($, { kind: "turn-start", turnId: turnName(turnId) });
}

export function registerCapture(on: On): void {
  on("session.append", async ($, e, next) => {
    const stored = await next(e);
    const started = performance.now();
    if (e.agentId === undefined && stored.deny === undefined) {
      if (e.door === "prompt" || e.door === "command") opener = stored.uuid;
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
    if (e.agentId === undefined) push($, { kind: "step", turnId: turnName(e.turnId), index: e.index });
    return yield* next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      push($, { kind: "turn-end", turnId: turnName(e.turnId), isAborted: e.isAborted, reason: e.reason });
      turnNames.delete(e.turnId);
      const sorted = hookMs.sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      log($, `capture hook rows ${sorted.length} p95 ${p95.toFixed(3)}ms max ${(sorted.at(-1) ?? 0).toFixed(3)}ms`);
      hookMs = [];
    }
    return next(e);
  });
}

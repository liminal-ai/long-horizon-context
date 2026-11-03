import type { EngineInterface, On } from "claude-code";
import type { CaptureEntry, CapturedMessage } from "../../src/capture.ts";
import type { TurnNames } from "../types";
import { measureAppend } from "./measure.ts";
import { boundSession, enqueue, log } from "./sidecar.ts";
import { endTurn } from "./state.ts";

type Captured = { [K in CaptureEntry["kind"]]: Omit<Extract<CaptureEntry, { kind: K }>, "sessionId" | "at"> }[CaptureEntry["kind"]];

let hookMs: number[] = [];

/**
 * A turn is named by the uuid of the row that opened it (a prompt, a command,
 * or a delivered notification), the name recovery derives from the
 * transcript, so the sidecar can tell a replayed marker of an older turn from
 * one of the turn still open. The names live in $.state, which survives a
 * reload; a turn with no opener row sends no markers, as recovery opens none.
 */
let turns: TurnNames = { names: {} };
let restored: Promise<void> | undefined;

function restoreTurns($: EngineInterface): Promise<void> {
  restored ??= $.state.get({ plugin: "lhc", key: "turns" }).then(({ value }) => {
    if (value !== undefined) turns = { pending: turns.pending ?? value.pending, names: { ...value.names, ...turns.names } };
  });
  return restored;
}

function saveTurns($: EngineInterface): void {
  void $.state.set({ plugin: "lhc", key: "turns" }, turns).catch(() => {});
}

function push($: EngineInterface, entry: Captured): void {
  const sessionId = boundSession();
  if (sessionId === undefined) return;
  enqueue($, { ...entry, sessionId, at: Date.now() } as CaptureEntry);
}

export async function captureTurnStart($: EngineInterface, turnId: string): Promise<void> {
  await restoreTurns($);
  const name = turns.pending;
  if (name === undefined) return;
  turns = { names: { ...turns.names, [turnId]: name } };
  saveTurns($);
  push($, { kind: "turn-start", turnId: name });
}

async function turnName($: EngineInterface, turnId: string): Promise<string | undefined> {
  await restoreTurns($);
  return turns.names[turnId];
}

export async function captureStep($: EngineInterface, turnId: string, index: number): Promise<void> {
  const name = await turnName($, turnId);
  if (name !== undefined) push($, { kind: "step", turnId: name, index });
}

export function registerCapture(on: On): void {
  on("session.append", async ($, e, next) => {
    const stored = await next(e);
    const started = performance.now();
    if (e.agentId === undefined && stored.deny === undefined) {
      // A plugin's command (the LHC panel's /compact) is never the person's: it opens no turn, live or recovered.
      const isOpener = e.door === "prompt" || e.door === "command" || e.door === "delivery";
      if (isOpener && e.origin.kind !== "plugin") {
        turns = { ...turns, pending: stored.uuid };
        saveTurns($);
      }
      if (e.door !== "queue") measureAppend(stored.message.content);
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

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      const name = await turnName($, e.turnId);
      if (name !== undefined) push($, { kind: "turn-end", turnId: name, isAborted: e.isAborted, reason: e.reason });
      const { [e.turnId]: _ended, ...names } = turns.names;
      turns = { ...turns, names };
      saveTurns($);
      const sorted = hookMs.sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      log($, `capture hook rows ${sorted.length} p95 ${p95.toFixed(3)}ms max ${(sorted.at(-1) ?? 0).toFixed(3)}ms`);
      hookMs = [];
      await endTurn($, e.durationMs);
    }
    return next(e);
  });
}

// Thread state over the websocket stream plus the HTTP snapshot: busy/idle,
// turn dispatch, waiting for the turn that adopted a message, and the reply.
// Derived from the smoke client's ThreadTracker/waitForTurn/settledThread.
import { randomUUID } from "node:crypto";
import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import type { RpcSession } from "./rpc.ts";

const RUNNING = new Set(["running", "starting"]);
/** Mirrors the server's queued-turn-start grace: a user message this fresh with no turn is pending work. */
const QUEUED_TURN_START_GRACE_MS = 30_000;

export const now = (): string => new Date().toISOString();

export class ThreadTracker {
  session: OrchestrationSession | null = null;
  readonly messages = new Map<string, { role: string; turnId: string | null; streaming: boolean; createdAt: string }>();
  lastError: string | null = null;
  streamEnded: string | null = null;
  #snapshotSeen = false;
  #waiters: Array<() => void> = [];

  onItem = (item: OrchestrationThreadStreamItem): void => {
    if (item.kind === "snapshot") {
      const thread = item.snapshot.thread;
      this.session = thread.session;
      for (const m of thread.messages)
        this.messages.set(m.id, { role: m.role, turnId: m.turnId, streaming: m.streaming, createdAt: m.createdAt });
      this.#snapshotSeen = true;
    } else if (item.kind === "event") this.#onEvent(item.event);
    this.#notify();
  };

  onEnd = (error: string | null): void => {
    this.streamEnded = error ?? "thread subscription ended";
    this.#notify();
  };

  #onEvent(event: OrchestrationEvent): void {
    switch (event.type) {
      case "thread.session-set":
        this.session = event.payload.session;
        if (event.payload.session.lastError) this.lastError = event.payload.session.lastError;
        break;
      case "thread.activity-appended":
        if (event.payload.activity.kind === "runtime.error")
          this.lastError = `${event.payload.activity.summary}: ${JSON.stringify(event.payload.activity.payload).slice(0, 300)}`;
        break;
      case "thread.message-sent":
        this.messages.set(event.payload.messageId, {
          role: event.payload.role,
          turnId: event.payload.turnId,
          streaming: event.payload.streaming,
          createdAt: event.payload.createdAt,
        });
        break;
      default:
        break;
    }
  }

  #notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  waitChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.#waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async ready(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#snapshotSeen) {
      if (this.streamEnded) throw new Error(`thread stream ended: ${this.streamEnded}`);
      if (Date.now() >= deadline) throw new Error("no thread snapshot within the timeout");
      await this.waitChange(deadline - Date.now());
    }
  }

  /** A turn is running (or starting) right now: a new turn.start becomes a steer. */
  get busy(): boolean {
    return this.session !== null && RUNNING.has(this.session.status);
  }

  /** Resolve with the turn id once the turn that adopted `messageId` has finished. */
  async waitForTurn(messageId: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let turnId: string | null = null;
    let sawRunning = false;
    while (Date.now() < deadline) {
      if (this.streamEnded) throw new Error(`thread stream ended: ${this.streamEnded}`);
      if (this.lastError) throw new Error(`provider error: ${this.lastError}`);
      turnId ??= this.messages.get(messageId)?.turnId ?? null;
      const session = this.session;
      if (session && RUNNING.has(session.status)) {
        if (turnId === null && session.activeTurnId) turnId = session.activeTurnId;
        if (session.status === "running" && (turnId === null || session.activeTurnId === turnId)) sawRunning = true;
      }
      if (session?.status === "error") throw new Error(`session error: ${session.lastError ?? "unknown"}`);
      const assistantDone =
        turnId !== null &&
        [...this.messages.values()].some((m) => m.role === "assistant" && m.turnId === turnId && !m.streaming);
      const idle = session !== null && !RUNNING.has(session.status);
      if (turnId !== null && idle && (sawRunning || assistantDone)) return turnId;
      await this.waitChange(Math.min(2000, Math.max(50, deadline - Date.now())));
    }
    throw new Error(
      `turn did not complete within ${timeoutMs}ms (turnId=${turnId ?? "?"}, session=${this.session?.status ?? "none"})`,
    );
  }
}

export async function fetchThread(baseUrl: string, bearer: string, threadId: string): Promise<OrchestrationThread> {
  const response = await fetch(`${baseUrl}/api/orchestration/threads/${encodeURIComponent(threadId)}`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`thread snapshot HTTP ${response.status}`);
  return ((await response.json()) as { thread: OrchestrationThread }).thread;
}

/** Turn idle: latest turn finished (or none), session not running, no fresh unadopted user message. */
export function threadIsIdle(thread: OrchestrationThread, at: string): boolean {
  if (thread.session && RUNNING.has(thread.session.status)) return false;
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null && turn.state === "running") return false;
  let latestUserAt = Number.NEGATIVE_INFINITY;
  for (const m of thread.messages) if (m.role === "user") latestUserAt = Math.max(latestUserAt, Date.parse(m.createdAt));
  if (!Number.isFinite(latestUserAt) || thread.session?.status === "error") return true;
  if (Math.abs(Date.parse(at) - latestUserAt) > QUEUED_TURN_START_GRACE_MS) return true;
  if (turn === null) return false;
  const adopted = [turn.requestedAt, turn.startedAt, turn.completedAt].some((v) => v != null && Date.parse(v) >= latestUserAt);
  return adopted;
}

export async function waitIdle(input: {
  tracker: ThreadTracker;
  baseUrl: string;
  bearer: string;
  threadId: string;
  deadline: number;
}): Promise<void> {
  while (Date.now() < input.deadline) {
    if (input.tracker.streamEnded) throw new Error(`thread stream ended: ${input.tracker.streamEnded}`);
    if (input.tracker.busy) {
      await input.tracker.waitChange(Math.min(2000, input.deadline - Date.now()));
      continue;
    }
    if (threadIsIdle(await fetchThread(input.baseUrl, input.bearer, input.threadId), now())) return;
    await input.tracker.waitChange(1000);
  }
  throw new Error("thread did not become idle before the deadline");
}

export async function sendTurn(rpc: RpcSession, threadId: string, text: string): Promise<{ messageId: string; createdAt: string }> {
  const messageId = randomUUID();
  const createdAt = now();
  await rpc.dispatch({
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId, role: "user", text, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt,
  } as never);
  return { messageId, createdAt };
}

export interface TurnReply {
  readonly text: string;
  /** "after-steer": assistant text created after the steer landed; "whole-turn": the fallback. */
  readonly mode: "whole-turn" | "after-steer";
  readonly turnState: string | null;
}

/** The assistant text of `turnId`; for a steer, only what was produced after it (best effort). */
export async function turnReply(input: {
  baseUrl: string;
  bearer: string;
  threadId: string;
  turnId: string;
  afterIso: string | null;
}): Promise<TurnReply> {
  const deadline = Date.now() + 20_000;
  let thread = await fetchThread(input.baseUrl, input.bearer, input.threadId);
  while (Date.now() < deadline && thread.latestTurn?.turnId === input.turnId && thread.latestTurn.state === "running") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    thread = await fetchThread(input.baseUrl, input.bearer, input.threadId);
  }
  const turnState = thread.latestTurn?.turnId === input.turnId ? thread.latestTurn.state : null;
  const assistant = thread.messages.filter((m) => m.role === "assistant" && m.turnId === input.turnId);
  const join = (ms: typeof assistant) => ms.map((m) => m.text).join("\n").trim();
  if (input.afterIso !== null) {
    const after = join(assistant.filter((m) => Date.parse(m.createdAt) > Date.parse(input.afterIso!)));
    if (after !== "") return { text: after, mode: "after-steer", turnState };
  }
  return { text: join(assistant), mode: "whole-turn", turnState };
}

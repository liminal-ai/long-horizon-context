import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageKeyPrefix } from "claude-adapter";
import type { Lhc, MessageEventInput, ThreadRef } from "lhc";
import type { CaptureEntry } from "../../../src/capture.ts";
import { acquireLease } from "../lease.ts";
import { type Recovered, recoverTranscript } from "../recovery.ts";
import { type Entry, HARNESS, isRecorded, mapEntries, opensTurn, SETTLED, type TurnState } from "./map.ts";
import { TranscriptTail } from "./transcript.ts";

export type Binding = { sessionId: string; transcriptPath: string; source: string };

type Deps = { lhc: Lhc; home: string; ownerPid: number; log: (line: string) => void };

export type Recording = { kind: "recording"; recorder: Recorder } | { kind: "refused"; notice: string };

const PARENT_POLLS = 40;
const PARENT_POLL_MS = 50;

export const aliasOf = (sessionId: string): string => `${HARNESS}:${sessionId}`;

type Thread = ThreadRef & { threadId: string; registryPath: string };

async function threadFor(lhc: Lhc, home: string, sessionId: string): Promise<Thread> {
  mkdirSync(join(home, "threads"), { recursive: true });
  const registryPath = join(home, "registry.sqlite");
  const alias = aliasOf(sessionId);
  const found = await lhc.threads.resolveAlias({ alias, registryPath });
  if (found.ok) return { threadId: found.value.threadId, registryPath };
  if (found.error.code !== "alias_not_found") throw new Error(`alias lookup failed: ${found.error.reason}`);
  const created = await lhc.threads.newThread({
    filePath: join(home, "threads", `${randomUUID()}.sqlite`),
    title: `Claude Code ${sessionId}`,
    registryPath,
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  const bound = await lhc.threads.registerCurrentAlias({ alias, threadId: created.value.threadId, registryPath });
  if (bound.ok) return { threadId: created.value.threadId, registryPath };
  const winner = await lhc.threads.resolveAlias({ alias, registryPath });
  if (!winner.ok) throw new Error(`alias registration failed: ${bound.error.reason}`);
  return { threadId: winner.value.threadId, registryPath };
}

/** A fork stays refused for the session's life, whatever reason a later bind gives. */
const forkMark = (home: string, sessionId: string): string => join(home, "forks", sessionId);

export async function openRecording(deps: Deps, binding: Binding): Promise<Recording> {
  if (binding.source === "fork") {
    mkdirSync(join(deps.home, "forks"), { recursive: true });
    writeFileSync(forkMark(deps.home, binding.sessionId), "");
  }
  if (existsSync(forkMark(deps.home, binding.sessionId))) {
    return { kind: "refused", notice: "LHC does not record forked sessions yet. This session is not recorded." };
  }
  const thread = await threadFor(deps.lhc, deps.home, binding.sessionId);
  const lease = acquireLease(deps.home, thread.threadId, deps.ownerPid);
  if (!lease.held) {
    return {
      kind: "refused",
      notice: `LHC thread ${thread.threadId} is already recorded by Claude Code process ${lease.ownerPid}. This session is not recorded.`,
    };
  }
  const recorder = new Recorder(deps, binding, thread, lease.release);
  const recovered = await recorder.recover();
  deps.log(
    `recording session ${binding.sessionId} thread ${thread.threadId} recovered ${recovered.recorded} of ${recovered.scanned} transcript rows`,
  );
  return { kind: "recording", recorder };
}

export class Recorder {
  #state: TurnState = SETTLED;
  readonly #parents: TranscriptTail;

  readonly deps: Deps;
  readonly binding: Binding;
  readonly thread: Thread;
  readonly release: () => void;

  constructor(deps: Deps, binding: Binding, thread: Thread, release: () => void) {
    this.deps = deps;
    this.binding = binding;
    this.thread = thread;
    this.release = release;
    this.#parents = new TranscriptTail(binding.transcriptPath);
  }

  recover(): Promise<Recovered> {
    return recoverTranscript({
      home: this.deps.home,
      sessionId: this.binding.sessionId,
      transcriptPath: this.binding.transcriptPath,
      capture: (entries) => this.#capture(entries, true),
    });
  }

  get isTurnOpen(): boolean {
    return this.#state.isOpen;
  }

  capture(entries: readonly Entry[]): Promise<number> {
    return this.#capture(entries, false);
  }

  async #capture(all: readonly Entry[], isTranscript: boolean): Promise<number> {
    // Rows on a branch a rewind left are never recorded, whether live, replayed from the mod's outbox, or recovered.
    this.#parents.read();
    const abandoned = new Set([...this.#parents.abandoned().values()].flat());
    const before = this.#state;
    let recorded = 0;
    let pending: MessageEventInput[] = [];
    try {
      for (const entry of all) {
        if (entry.kind === "row" && abandoned.has(entry.uuid)) continue;
        if (!isTranscript && !this.#applies(entry)) continue;
        if (entry.kind === "row" && isRecorded(entry) && opensTurn(entry, this.#state)) {
          recorded += await this.#write(pending);
          pending = await this.#rewind(entry.uuid);
        }
        const { events, state } = mapEntries([entry], this.#state);
        this.#state = state;
        pending.push(...events);
      }
      return recorded + (await this.#write(pending));
    } catch (error) {
      this.#state = before;
      throw error;
    }
  }


  /**
   * The transcript is the authority for every turn recovery has read, so a
   * turn marker from the mod applies only to the turn still open. A turn start
   * applies unless an open turn was opened later in the transcript; a step or
   * an end applies to the open turn. An engine turn id, which no transcript
   * row carries, comes from a mod reloaded mid-turn and names the open turn.
   */
  #applies(entry: Entry): boolean {
    if (entry.kind === "row" || entry.kind === "settle") return true;
    const { order } = this.#parents;
    const position = order.get(entry.turnId);
    if (entry.kind === "turn-start") {
      const open = this.#state.isOpen ? order.get(this.#state.turnId ?? "") : undefined;
      return position === undefined || open === undefined || position >= open;
    }
    if (entry.turnId === this.#state.turnId) return true;
    if (position !== undefined || !this.#state.isOpen) return false;
    this.#state = { ...this.#state, turnId: entry.turnId };
    return true;
  }



  async #write(events: MessageEventInput[]): Promise<number> {
    if (events.length === 0) return 0;
    const written = await this.deps.lhc.intakeStream.messageEvents(this.thread, events);
    if (!written.ok) throw new Error(`intake refused: ${written.error.code}: ${written.error.reason}`);
    return written.value.events.filter((event) => event.outcome === "recorded").length;
  }

  /**
   * A rewind writes nothing Claude Code tells a hook about. The new prompt's
   * transcript parent shows it: when the nearest recorded ancestor is not the
   * end of the live record, everything after that ancestor is rolled back.
   */
  async #rewind(promptUuid: string): Promise<MessageEventInput[]> {
    if ((await this.#capturedThrough(promptUuid)) !== undefined) return [];
    const parent = await this.#parentOf(promptUuid);
    if (parent === undefined) {
      this.deps.log(`rewind check skipped: prompt ${promptUuid} not in the transcript`);
      return [];
    }
    const transcript = this.#parents;
    if (!transcript.activeChain().has(promptUuid)) return [];
    const abandoned = transcript.abandoned();
    const branches: string[] = [];
    let keep: number | undefined;
    for (let id: string | null = parent; ; id = transcript.parents.get(id) ?? null) {
      branches.push(...(abandoned.get(id) ?? []));
      // A rewind reaches back to a compaction but not past it.
      if (id === null || transcript.compactBoundaries.has(id)) break;
      keep = await this.#capturedThrough(id);
      if (keep !== undefined) break;
    }
    const orders = await Promise.all(branches.map((id) => this.#capturedFrom(id)));
    const firstAbandoned = Math.min(...orders.filter((order) => order !== undefined));
    if (firstAbandoned === Number.POSITIVE_INFINITY) return [];
    keep = Math.min(keep ?? Number.POSITIVE_INFINITY, firstAbandoned - 1);
    this.deps.log(`rewind before prompt ${promptUuid}: rollback keeps through event ${keep}`);
    return [
      {
        eventKind: "rollback",
        idempotencyKey: `${messageKeyPrefix(HARNESS, promptUuid)}rollback`,
        actor: "system",
        harness: HARNESS,
        payload: { keepThroughEventOrder: keep, reason: "rewind" },
      },
    ];
  }

  async #parentOf(uuid: string): Promise<string | null | undefined> {
    for (let poll = 0; poll < PARENT_POLLS; poll++) {
      this.#parents.read();
      if (this.#parents.parents.has(uuid)) return this.#parents.parents.get(uuid);
      await new Promise((resolve) => setTimeout(resolve, PARENT_POLL_MS));
    }
    return undefined;
  }

  async #capturedFrom(uuid: string): Promise<number | undefined> {
    const page = await this.deps.lhc.intakeStream.listEventKeysByPrefix(this.thread, {
      prefix: messageKeyPrefix(HARNESS, uuid),
    });
    if (!page.ok) throw new Error(`key lookup failed: ${page.error.reason}`);
    const orders = page.value.keys.map((key) => key.eventOrder);
    return orders.length === 0 ? undefined : Math.min(...orders);
  }

  async #capturedThrough(uuid: string): Promise<number | undefined> {
    let last: number | undefined;
    let cursor: string | null = null;
    do {
      const page = await this.deps.lhc.intakeStream.listEventKeysByPrefix(this.thread, {
        prefix: messageKeyPrefix(HARNESS, uuid),
        ...(cursor === null ? {} : { cursor }),
      });
      if (!page.ok) throw new Error(`key lookup failed: ${page.error.reason}`);
      for (const key of page.value.keys) last = Math.max(last ?? 0, key.eventOrder);
      cursor = page.value.cursor;
    } while (cursor !== null);
    return last;
  }
}

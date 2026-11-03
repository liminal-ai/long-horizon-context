import { messageKeyPrefix, textEvent } from "claude-adapter";
import type { Lhc, MessageEventInput } from "lhc";
import type { CaptureEntry, How } from "../../../src/capture.ts";
import { type Binding, openThread, type Thread } from "../bind.ts";
import { acquireLease } from "../lease.ts";
import { Receipts } from "../receipts.ts";
import { type Recovered, recoverTranscript } from "../recovery.ts";
import { type Entry, HARNESS, isRecorded, mapEntries, opensTurn, SETTLED, type TurnState } from "./map.ts";
import { TranscriptTail } from "./transcript.ts";

type Deps = { lhc: Lhc; home: string; ownerPid: number; log: (line: string) => void };

export type { Binding };

/** A fork records nothing until its first row shows where it left its source. */
export type Recording =
  | { kind: "recording"; recorder: Recorder; how: How; notice?: string }
  | { kind: "refused"; notice: string }
  | { kind: "awaiting-fork" };

const PARENT_POLLS = 40;
const PARENT_POLL_MS = 50;

export async function openRecording(deps: Deps, binding: Binding, firstRow?: string): Promise<Recording> {
  const opened = await openThread(deps, binding, firstRow);
  if (opened === undefined) return { kind: "awaiting-fork" };
  const { thread, how, notice } = opened;
  const lease = acquireLease(deps.home, thread.threadId, deps.ownerPid);
  if (!lease.held) {
    return {
      kind: "refused",
      notice: `LHC thread ${thread.threadId} is already recorded by Claude Code process ${lease.ownerPid}. This session is not recorded.`,
    };
  }
  const recorder = new Recorder(deps, binding, thread, lease.release);
  await recorder.readAnswered();
  // A fork's transcript already holds its own first rows; live capture brings those.
  const recovered = await recorder.recover(opened.recoverThrough);
  // A turn cannot outlive its Claude Code process: a new one (startup, resume, a fork over its source's rows)
  // ends the old process's open turn.
  if (binding.source === "startup" || binding.source === "resume" || opened.recoverThrough !== undefined) {
    await recorder.endInterruptedTurn();
  }
  deps.log(
    `recording session ${binding.sessionId} thread ${thread.threadId} (${how}) recovered ${recovered.recorded} of ${recovered.scanned} transcript rows`,
  );
  if (notice !== undefined) deps.log(notice);
  return { kind: "recording", recorder, how, ...(notice === undefined ? {} : { notice }) };
}

export class Recorder {
  #state: TurnState = SETTLED;
  /** Turns live capture ended: a transcript that has not caught up yet never reopens one. */
  readonly #ended = new Set<string>();
  #answered = new Set<string>();
  readonly #parents: TranscriptTail;
  readonly receipts: Receipts;

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
    this.receipts = new Receipts(deps.home, binding.sessionId);
  }

  /** The tool calls the record already has a result for, which a later result row must not answer again. */
  async readAnswered(): Promise<void> {
    const listed = await this.deps.lhc.messages.list(this.thread);
    if (!listed.ok) throw new Error(`message read failed: ${listed.error.reason}`);
    for (const message of listed.value) {
      if (message.kind !== "tool_result") continue;
      for (const block of message.blocks) {
        if (typeof block.content.toolCallId === "string") this.#answered.add(block.content.toolCallId);
      }
    }
  }

  recover(through?: string): Promise<Recovered> {
    return recoverTranscript({
      ...(through === undefined ? {} : { through }),
      home: this.deps.home,
      sessionId: this.binding.sessionId,
      transcriptPath: this.binding.transcriptPath,
      capture: (entries) => this.#capture(entries, true),
      isInstalled: (uuid) => this.receipts.isInstalled(uuid),
      claimInstalled: (rows) => {
        for (const row of rows) this.receipts.isProjection(row);
      },
    });
  }

  get isTurnOpen(): boolean {
    return this.#state.isOpen;
  }

  async endInterruptedTurn(): Promise<void> {
    const { isOpen, turnId } = this.#state;
    if (!isOpen || turnId === undefined) return;
    await this.#capture([{ kind: "turn-end", sessionId: "", turnId, isAborted: true, reason: "interrupted", at: 0 }], true);
    this.deps.log(`ended turn ${turnId} its process left open`);
  }

  capture(entries: readonly Entry[]): Promise<number> {
    return this.#capture(entries, false);
  }

  async #capture(all: readonly Entry[], isTranscript: boolean): Promise<number> {
    // Rows on a branch a rewind left are never recorded, whether live, replayed from the mod's outbox, or recovered.
    this.#parents.read();
    const abandoned = new Set([...this.#parents.abandoned().values()].flat());
    const before = this.#state;
    const answered = new Set(this.#answered);
    let recorded = 0;
    let pending: MessageEventInput[] = [];
    try {
      let installed: string | undefined;
      for (const entry of all) {
        if (entry.kind === "row" && abandoned.has(entry.uuid)) continue;
        if (!isTranscript && !this.#applies(entry)) continue;
        if (entry.kind === "row" && this.receipts.isProjection(entry)) {
          installed = entry.uuid;
          continue;
        }
        // Recovery opens a turn after each prompt-looking row; an installed row opens none.
        if (entry.kind === "turn-start" && entry.turnId === installed) continue;
        if (isTranscript && entry.kind === "turn-start" && this.#ended.has(entry.turnId)) continue;
        if (entry.kind === "row" && isRecorded(entry) && opensTurn(entry, this.#state)) {
          recorded += await this.#write(pending);
          pending = await this.#rewind(entry.uuid);
        }
        const { events, state } = mapEntries([entry], this.#state, answered);
        this.#state = state;
        if (!isTranscript && entry.kind === "turn-end") this.#ended.add(entry.turnId);
        pending.push(...events);
      }
      recorded += await this.#write(pending);
      this.#answered = answered;
      return recorded;
    } catch (error) {
      this.#state = before;
      throw error;
    }
  }


  /**
   * The transcript is the authority for every turn recovery has read, so a
   * turn marker from the mod applies only to the turn still open. A turn start
   * applies unless an open turn was opened later in the transcript; a step or
   * an end applies only to the open turn.
   */
  #applies(entry: Entry): boolean {
    if (entry.kind === "row" || entry.kind === "settle") return true;
    const { order } = this.#parents;
    const position = order.get(entry.turnId);
    if (entry.kind === "turn-start") {
      const open = this.#state.isOpen ? order.get(this.#state.turnId ?? "") : undefined;
      return position === undefined || open === undefined || position >= open;
    }
    return entry.turnId === this.#state.turnId;
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

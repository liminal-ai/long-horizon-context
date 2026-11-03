import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import type { How } from "../../src/capture.ts";
import { HARNESS } from "./capture/map.ts";
import { TranscriptTail } from "./capture/transcript.ts";
import { Receipts } from "./receipts.ts";
import { writeCursor } from "./recovery.ts";

export type Binding = { sessionId: string; transcriptPath: string; source: string };

export type Thread = ThreadRef & { threadId: string; registryPath: string };

/** `recoverThrough`: for a fork, the row before its first captured one; recovery stops there. */
export type Opened = { thread: Thread; how: How; notice?: string; recoverThrough?: string };

type Deps = { lhc: Lhc; home: string; log: (line: string) => void };

const PARENT_POLLS = 40;
const PARENT_POLL_MS = 50;
const TAIL_BYTES = 1 << 20;

const sessionAlias = (sessionId: string): string => `${HARNESS}:${sessionId}`;
/** Aliases never move, so a session whose shared alias names a thread this host refused gets one of its own. */
const ownAlias = (sessionId: string): string => `cc-lhc-mod:${sessionId}`;

const registryOf = (home: string): string => join(home, "registry.sqlite");

async function lookup(lhc: Lhc, registryPath: string, alias: string): Promise<Thread | undefined> {
  const found = await lhc.threads.resolveAlias({ alias, registryPath });
  if (found.ok) return { threadId: found.value.threadId, registryPath };
  if (found.error.code !== "alias_not_found") throw new Error(`alias lookup failed: ${found.error.reason}`);
  return undefined;
}

async function threadOf(lhc: Lhc, registryPath: string, sessionId: string): Promise<Thread | undefined> {
  return (await lookup(lhc, registryPath, ownAlias(sessionId))) ?? lookup(lhc, registryPath, sessionAlias(sessionId));
}

async function bindAlias(lhc: Lhc, alias: string, thread: Thread): Promise<Thread> {
  const { registryPath } = thread;
  const bound = await lhc.threads.registerCurrentAlias({ alias, threadId: thread.threadId, registryPath });
  if (bound.ok) return thread;
  const winner = await lookup(lhc, registryPath, alias);
  if (winner === undefined) throw new Error(`alias registration failed: ${bound.error.reason}`);
  return winner;
}

async function newThread(deps: Deps, sessionId: string, alias = sessionAlias(sessionId)): Promise<Thread> {
  mkdirSync(join(deps.home, "threads"), { recursive: true });
  const created = await deps.lhc.threads.newThread({
    filePath: join(deps.home, "threads", `${randomUUID()}.sqlite`),
    title: `Claude Code ${sessionId}`,
    registryPath: registryOf(deps.home),
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  return bindAlias(deps.lhc, alias, { threadId: created.value.threadId, registryPath: registryOf(deps.home) });
}

/** Older hosts force turn boundaries this host does not keep, so their threads are left as they are. */
async function refusalOf(lhc: Lhc, thread: Thread): Promise<string | undefined> {
  const boundaries = await lhc.compactContinuation.listCompactContinuationBoundaries(thread);
  if (!boundaries.ok) throw new Error(`thread inspection failed: ${boundaries.error.reason}`);
  if (boundaries.value.length === 0) return undefined;
  return `LHC thread ${thread.threadId} has ${boundaries.value.length} forced compact boundaries from an older host and is not adopted.`;
}

async function replace(deps: Deps, sessionId: string, notice: string): Promise<Opened> {
  const thread = await newThread(deps, sessionId, ownAlias(sessionId));
  writeCursor(deps.home, sessionId, 0);
  return { thread, how: "replaced", notice: `${notice} This session records to new thread ${thread.threadId}.` };
}

/**
 * The fork's first row and its ancestors, nearest first, once its transcript
 * holds that row. Claude Code can write rows of its own between the copied
 * prefix and the first captured row (a synthetic reply to an interrupted turn,
 * a task notification), so the fork point is the nearest ancestor its source holds.
 */
async function ancestorsOf(transcriptPath: string, firstRow: string): Promise<string[] | undefined> {
  const tail = new TranscriptTail(transcriptPath);
  for (let poll = 0; poll < PARENT_POLLS; poll++) {
    tail.read();
    if (tail.parents.has(firstRow)) {
      const chain = new Set<string>();
      for (let id = tail.parents.get(firstRow) ?? null; id !== null && !chain.has(id); id = tail.parents.get(id) ?? null) {
        chain.add(id);
      }
      return [...chain];
    }
    await new Promise((resolve) => setTimeout(resolve, PARENT_POLL_MS));
  }
  return undefined;
}

function uuidOf(line: string): string | undefined {
  try {
    const { uuid } = JSON.parse(line) as { uuid?: unknown };
    return typeof uuid === "string" ? uuid : undefined;
  } catch {
    return undefined;
  }
}

function lastUuid(text: string): string | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const uuid = uuidOf(lines[index] ?? "");
    if (uuid !== undefined) return uuid;
  }
  return undefined;
}

/** A source ends at the fork point, so a transcript whose tail holds none of the fork's rows is passed over unread. */
function tailOf(path: string, size: number): string {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

type Source = { sessionId: string; point: string; isAtTip: boolean };

const uuidsIn = (text: string): Set<string> => new Set([...text.matchAll(/"uuid":"([^"]+)"/g)].map((match) => match[1] ?? ""));

/**
 * The session a fork copied. Claude Code copies the source's rows with their
 * uuids, so the source is the sibling transcript holding the fork's nearest
 * ancestor: one that still ends at it (read from its tail first), or a recorded
 * session that went on past it, whose install receipt the fork still needs. An
 * older session a fork of a fork also descends from holds only a farther ancestor.
 */
function sourceOf(home: string, transcriptPath: string, ancestors: readonly string[]): Source | undefined {
  const dir = dirname(transcriptPath);
  const self = basename(transcriptPath);
  const siblings = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl") && name !== self)
    .map((name) => {
      const { size } = statSync(join(dir, name));
      return { sessionId: name.slice(0, -".jsonl".length), path: join(dir, name), size };
    });
  const rank = new Map(ancestors.map((uuid, index) => [uuid, index]));
  const nearest = (found: Source[]): Source | undefined =>
    found.sort((a, b) => (rank.get(a.point) ?? 0) - (rank.get(b.point) ?? 0) || Number(b.isAtTip) - Number(a.isAtTip))[0];
  const atTip = siblings.flatMap(({ sessionId, path, size }): Source[] => {
    if (![...uuidsIn(tailOf(path, size))].some((uuid) => rank.has(uuid))) return [];
    const point = lastUuid(readFileSync(path, "utf8"));
    return point !== undefined && rank.has(point) ? [{ sessionId, point, isAtTip: true }] : [];
  });
  const moved = siblings
    .filter(({ sessionId }) => new Receipts(home, sessionId).current !== undefined)
    .flatMap(({ sessionId, path }): Source[] => {
      const held = uuidsIn(readFileSync(path, "utf8"));
      const point = ancestors.find((uuid) => held.has(uuid));
      return point === undefined ? [] : [{ sessionId, point, isAtTip: false }];
    });
  return nearest([...atTip, ...moved]);
}

/**
 * A fork records its whole transcript, into a copy of its source's thread when
 * one is safe to copy. The copy keeps the source's idempotency keys, so rows the
 * source recorded are not recorded again and rows it missed are; the source's
 * install receipt keeps its installed view out either way.
 */
async function fork(deps: Deps, binding: Binding, firstRow: string): Promise<Opened> {
  const fresh = async (why: string, recoverThrough?: string): Promise<Opened> => {
    deps.log(`fork ${binding.sessionId} not copied: ${why}`);
    const thread = await newThread(deps, binding.sessionId);
    const notice = `LHC could not copy the forked thread: ${why}.`;
    return { thread, how: "new", notice, ...(recoverThrough === undefined ? {} : { recoverThrough }) };
  };
  const ancestors = await ancestorsOf(binding.transcriptPath, firstRow);
  const before = ancestors?.[0];
  if (ancestors === undefined || before === undefined) return fresh("the fork transcript names no fork point");
  const found = sourceOf(deps.home, binding.transcriptPath, ancestors);
  if (found === undefined) return fresh(`no transcript holds the rows before row ${firstRow}`, before);
  const receipt = new Receipts(deps.home, found.sessionId).current;
  if (receipt !== undefined) new Receipts(deps.home, binding.sessionId).persist(receipt);
  if (!found.isAtTip) return fresh(`source session ${found.sessionId} went on past the fork point`, before);
  const registryPath = registryOf(deps.home);
  const source = await threadOf(deps.lhc, registryPath, found.sessionId);
  if (source === undefined) return fresh(`source session ${found.sessionId} has no LHC thread`, before);
  const refusal = await refusalOf(deps.lhc, source);
  if (refusal !== undefined) return { ...(await replace(deps, binding.sessionId, refusal)), recoverThrough: before };
  const copied = await deps.lhc.threads.copyThread({
    source,
    filePath: join(deps.home, "threads", `${randomUUID()}.sqlite`),
    registryPath,
    title: `Claude Code ${binding.sessionId}`,
    // A turn the source's process left open is settled by recovery before the fork's own first prompt.
    requireIdle: false,
  });
  if (!copied.ok) return fresh(copied.error.reason, before);
  const thread = await bindAlias(deps.lhc, sessionAlias(binding.sessionId), { threadId: copied.value.threadId, registryPath });
  deps.log(`forked thread ${source.threadId} of session ${found.sessionId} to ${thread.threadId} at ${found.point}`);
  return { thread, how: "forked", recoverThrough: before };
}

/**
 * The thread a binding records to. A known session keeps its thread unless an
 * older host left it with forced boundaries. A fork is copied from its source
 * once its first row shows where it left the source, so until then it waits.
 */
export async function openThread(deps: Deps, binding: Binding, firstRow?: string): Promise<Opened | undefined> {
  const existing = await threadOf(deps.lhc, registryOf(deps.home), binding.sessionId);
  if (existing !== undefined) {
    const refusal = await refusalOf(deps.lhc, existing);
    return refusal === undefined ? { thread: existing, how: "resumed" } : replace(deps, binding.sessionId, refusal);
  }
  if (binding.source !== "fork") return { thread: await newThread(deps, binding.sessionId), how: "new" };
  return firstRow === undefined ? undefined : fork(deps, binding, firstRow);
}

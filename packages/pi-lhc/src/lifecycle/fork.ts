// A fork produces a new thread seeded by replay and never writes the source.

import { readFileSync } from "node:fs";
import type { MessageEventInput, OpResult, ThreadRef } from "lhc";
import { parseEventKeySource } from "../capture/idempotency.js";
import type { ExtensionContext, SessionStartEvent } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";

export interface ForkInfo {
  sourceThreadRef: ThreadRef;
  forkEntryId: string;
}

/** Detect a fork from PI's session tree when the session_before_fork hook is
 *  absent. This function is called during thread start when we have a
 *  previousSessionFile but no pending fork from the
 *  hook. Returns fork info if the session tree indicates a fork, null otherwise.
 *
 * The fallback uses the previousSessionFile as evidence that we're starting a
 *  new session after an existing one (the fork pattern). The fork point is
 *  inferred as the end of the previous session. */
export function detectForkFromSessionTree(
  ctx: ExtensionContext,
  event: SessionStartEvent,
  sourceThreadRef: ThreadRef,
): ForkInfo | null {
  if (!event.previousSessionFile) return null;

  const previousEntries = readSessionEntries(event.previousSessionFile);
  const previousIds = new Set(previousEntries.map(entryIdOf).filter((id): id is string => id !== null));
  if (previousIds.size === 0) return null;

  const currentEntries = ctx.sessionManager.getEntries();
  const sharedCurrentEntry = lastEntryMatching(currentEntries, (entry) => {
    const id = entryIdOf(entry);
    return id !== null && previousIds.has(id);
  });
  if (sharedCurrentEntry !== null) {
    return { sourceThreadRef, forkEntryId: sharedCurrentEntry };
  }

  const parentLink = firstEntryMatching(currentEntries, (entry) => {
    const parentId = stringField(entry, "parentId");
    return parentId !== null && previousIds.has(parentId);
  });
  if (parentLink !== null) {
    return { sourceThreadRef, forkEntryId: parentLink };
  }

  return null;
}

function stringField(record: { readonly [k: string]: unknown }, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function entryIdOf(entry: { readonly [k: string]: unknown }): string | null {
  return stringField(entry, "id") ?? stringField(entry, "entryId");
}

function lastEntryMatching(
  entries: readonly { readonly [k: string]: unknown }[],
  matches: (entry: { readonly [k: string]: unknown }) => boolean,
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || !matches(entry)) continue;
    return entryIdOf(entry);
  }
  return null;
}

function firstEntryMatching(
  entries: readonly { readonly [k: string]: unknown }[],
  matches: (entry: { readonly [k: string]: unknown }) => boolean,
): string | null {
  for (const entry of entries) {
    if (!matches(entry)) continue;
    const parentId = stringField(entry, "parentId");
    if (parentId !== null) return parentId;
  }
  return null;
}

function readSessionEntries(filePath: string): { readonly [k: string]: unknown }[] {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const entries: { readonly [k: string]: unknown }[] = [];
  for (const line of contents.trim().split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      const entry = parsed as { readonly [k: string]: unknown };
      if (entry.type === "session") continue;
      entries.push(entry);
    } catch {}
  }
  return entries;
}

/** Extract fork info from a `session_before_fork` hook payload. The hook
 *  provides the PI SessionEntry id identifying the fork point. */
export function forkInfoFromHook(entryId: string, _position?: "before" | "at"): Omit<ForkInfo, "sourceThreadRef"> {
  return { forkEntryId: entryId };
}

/** Seed a forked thread by replaying the source's recorded events up to the
 *  fork point, through the normal intake path. The source receives NO writes
 *  Derived derivations requeue rather than copy.
 *
 * Replay reads events from the source thread, filters to those up to and
 * including the fork point (by parsed PI entry source identity), and writes
 * them through the instance's intake path. This preserves event order, dedup
 * keys, and all logical content — the seeded thread's read-back matches the
 * source's read-back through the fork point.
 *
 * The forkEntryId is PI's entry identifier for the session entry at the fork
 * point. LHC does not yet expose a first-class source-metadata field on intake
 * events, so capture stores PI source identity in a structured idempotency key
 * tier and this adapter parses that tier. The limitation is deliberately
 * narrow: fork replay never substring-searches arbitrary key text. */
export async function seedFork(
  source: ThreadRef,
  target: ThreadRef,
  forkEntryId: string,
  instance: LhcInstance,
): Promise<OpResult<void>> {
  const { intakeStream } = instance.sdk;

  // Read all events from the source thread.
  const events = await intakeStream.listEvents(source);
  if (!events.ok) {
    return {
      ok: false,
      error: {
        errorClass: events.error.errorClass,
        code: events.error.code,
        reason: `fork source read failed: ${events.error.reason}`,
      },
    };
  }

  const forkPointEvents = events.value.filter(
    (event) => parseEventKeySource(event.idempotencyKey)?.entryId === forkEntryId,
  );

  if (forkPointEvents.length === 0) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "thread_not_found",
        reason: `fork entryId ${forkEntryId} not found in source thread events`,
      },
    };
  }

  // Use the maximum eventOrder among fork point events as the initial cutoff.
  // This ensures we include all events (including fan-out) at the fork point.
  let maxOrder = Math.max(...forkPointEvents.map((e) => e.eventOrder));

  // Include the turn_end that closes the turn at the fork point.
  // turn_end events don't have entryId in their key (they're generated by
  // the connector), so we need to include the first turn_end after maxOrder.
  // Deliberate (schema v5): that turn_end carries the *source* turn's
  // outcome/startedAt/endedAt host facts, and seedFork replays the payload
  // verbatim into the fork — same turn, same facts, accepted as-is.
  const turnEndAfter = events.value.find((e) => e.eventKind === "turn_end" && e.eventOrder > maxOrder);
  if (turnEndAfter !== undefined) {
    maxOrder = turnEndAfter.eventOrder;
  }

  // Filter to events up to and including the fork point (including turn_end).
  const eventsUpToFork = events.value.filter((e) => e.eventOrder <= maxOrder);

  // Convert EventRecord back to MessageEventInput for replay (strip server fields).
  // Each event preserves its discriminated eventKind by construction from the
  // recorded EventRecord, which carries the exact eventKind that was written.
  const replayEvents: MessageEventInput[] = eventsUpToFork.map(
    (record) =>
      ({
        eventKind: record.eventKind,
        idempotencyKey: record.idempotencyKey,
        actor: record.actor,
        harness: record.harness,
        payload: record.payload,
      }) as MessageEventInput,
  );

  // Replay through the normal intake path into the target thread.
  // This uses the same capture converter path, preserving all semantics.
  const result = await instance.sdk.intakeStream.messageEvents(target, replayEvents);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        errorClass: result.error.errorClass,
        code: result.error.code,
        reason: `fork replay failed: ${result.error.reason}`,
      },
    };
  }

  return { ok: true, value: undefined };
}

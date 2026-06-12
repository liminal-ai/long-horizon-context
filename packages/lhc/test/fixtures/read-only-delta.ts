// The shared read-only delta helper (Epic 04, DD-6): inspect describes,
// never changes — and that is asserted as ABSENCE OF DELTA in observable
// state, not absence of write code. Snapshot everything a forgotten side
// effect could move — queued work through both owners, boundary/zone/view
// identity through the thread-view surface, the event log, the audit message
// listing, and the raw derived-form rows — before and after an operation,
// and require deep equality. Lands with Story 2 and wraps Story 1's read
// ops retroactively (test plan, Chunk 2).
import { deepStrictEqual } from "node:assert/strict";
import { intakeStream, messages, threadView, turns } from "../../src/index.js";
import { readDerivedForms } from "./threads.js";

export interface ObservableState {
  events: unknown;
  messages: unknown;
  messageWork: unknown;
  turnWork: unknown;
  viewStatus: unknown;
  pullMeta: unknown;
  storedView: unknown;
  forms: unknown;
}

export async function observableState(filePath: string): Promise<ObservableState> {
  const pulled = await threadView.pull({ filePath });
  return {
    events: await intakeStream.listEvents({ filePath }),
    messages: await messages.listMessages({ filePath }, { includeDeleted: true }),
    messageWork: await messages.listQueuedWork({ filePath }),
    turnWork: await turns.listQueuedWork({ filePath }),
    viewStatus: await threadView.status({ filePath }),
    pullMeta: pulled.ok ? pulled.value.meta : pulled,
    // The stored snapshot whole (Story 3): a forgotten view touch — config,
    // arrangement, band rows, provenance — moves this even when pull's meta
    // would not show it.
    storedView: await threadView.describe({ filePath }),
    forms: readDerivedForms(filePath),
  };
}

// Run one operation under the before/after snapshot and return its result so
// call sites can keep asserting on it. Throws (deepStrictEqual) when the
// operation moved anything observable.
export async function expectReadOnly<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const before = await observableState(filePath);
  const result = await operation();
  deepStrictEqual(
    await observableState(filePath),
    before,
    "read-only delta: operation changed observable state",
  );
  return result;
}

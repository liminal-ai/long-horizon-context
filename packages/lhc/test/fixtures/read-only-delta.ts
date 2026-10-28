import { deepStrictEqual } from "node:assert/strict";
import { intakeStream, messages, threadView } from "../../src/index.js";
import { openDatabase } from "../../src/shared-tech/storage.js";
import { listItems, type WorkOwner } from "../../src/shared-tech/work-queue/index.js";
import { readDerivedForms } from "./threads.js";
import { o200k, withEstimator } from "./tokens.js";

export interface ObservableState {
  events: unknown;
  messages: unknown;
  messageWork: unknown;
  turnWork: unknown;
  viewStatus: unknown;
  modelContext: unknown;
  storedView: unknown;
  derivations: unknown;
}

function queuedFor(filePath: string, owner: WorkOwner) {
  const db = openDatabase(filePath);
  try {
    return listItems(db, owner);
  } finally {
    db.close();
  }
}

export async function observableState(filePath: string): Promise<ObservableState> {
  return withEstimator(o200k, async () => {
    const contextRead = await threadView.getLlmRequestContext({ filePath });
    return {
      events: await intakeStream.listEvents({ filePath }),
      messages: await messages.list({ filePath }, { includeDeleted: true }),
      messageWork: queuedFor(filePath, "messages"),
      turnWork: queuedFor(filePath, "turns"),
      viewStatus: await threadView.status({ filePath }),
      modelContext: contextRead,
      storedView: await threadView.describe({ filePath }),
      derivations: readDerivedForms(filePath),
    };
  });
}

export async function expectReadOnly<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const before = await observableState(filePath);
  const result = await operation();
  deepStrictEqual(await observableState(filePath), before, "read-only delta: operation changed observable state");
  return result;
}

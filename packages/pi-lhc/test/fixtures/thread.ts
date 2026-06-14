// Temp-thread factory: a REAL temp SQLite thread per test (tech design §Testing
// Strategy — persistence, reattach, replay, and fork are the product contract,
// so the store is never mocked). Mirrors the lhc package's `tempStore` so the
// connector's tests isolate their registry + thread files the same way.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threads, type ThreadRef } from "lhc";

export interface TempStore {
  dir: string;
  registryPath: string;
  threadPath: (name?: string) => string;
  cleanup: () => void;
}

export function tempStore(): TempStore {
  const dir = mkdtempSync(join(tmpdir(), "pi-lhc-test-"));
  let threadCounter = 0;
  return {
    dir,
    registryPath: join(dir, "registry.sqlite"),
    threadPath: (name) => {
      threadCounter += 1;
      return join(dir, `${name ?? `thread-${threadCounter}`}.sqlite`);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface TempThread {
  threadRef: ThreadRef;
  threadId: string;
  filePath: string;
}

/** Create a real thread file + registry row and return its ref/ids. Throws on
 *  failure so a setup error never masquerades as a test assertion. */
export async function makeTempThread(
  store: TempStore,
  opts: { title?: string } = {},
): Promise<TempThread> {
  const filePath = store.threadPath();
  const input: { filePath: string; registryPath: string; title?: string } = {
    filePath,
    registryPath: store.registryPath,
  };
  if (opts.title !== undefined) input.title = opts.title;
  const created = await threads.newThread(input);
  if (!created.ok) {
    throw new Error(`temp thread creation failed: ${created.error.reason}`);
  }
  return { threadRef: { filePath }, threadId: created.value.threadId, filePath };
}

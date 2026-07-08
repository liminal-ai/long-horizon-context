import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SessionThreadView } from "lhc";

import {
  buildRolloutLines,
  formatSwapReceipt,
  receiptRolloutLines,
  serializeRolloutLines,
  sourceMetaFromContent,
  type RebuildSourceMeta,
} from "./rebuild.js";

export interface WriteRebuiltRolloutInput {
  view: SessionThreadView;
  cwd: string;
  /** Source rollout to copy session_meta provenance from (cli_version, base_instructions, forked_from_id). */
  sourceRolloutPath?: string;
  newSessionId?: string;
  /** Codex home; rebuilt file lands under `<codexHome>/sessions/YYYY/MM/DD/`. Default `~/.codex`. */
  codexHome?: string;
  clock?: () => Date;
  readSourceFn?: (path: string) => Promise<string>;
  /** When set, append the swap receipt as trailing runtime-note lines. */
  swapReceipt?: {
    oldSessionId: string;
    threadId: string;
    op: string;
    tokensBefore?: number;
    tokensAfter?: number;
  };
}

export interface WriteRebuiltRolloutResult {
  sessionId: string;
  rolloutPath: string;
  lineCount: number;
  /**
   * Lines the handoff capture must hard-skip as replayed served-view content.
   * The trailing swap-receipt lines are NOT among them: the receipt is
   * genuinely new history that must map into the thread record (the
   * response_item as runtime_note; its event_msg twin is skip-counted) so
   * later rebuilds re-serve it.
   */
  replayedPrefixLines: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `<codexHome>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`, LOCAL time like codex. */
export function rebuiltRolloutPath(codexHome: string, sessionId: string, when: Date): string {
  const year = String(when.getFullYear());
  const month = pad2(when.getMonth() + 1);
  const day = pad2(when.getDate());
  const stamp = `${year}-${month}-${day}T${pad2(when.getHours())}-${pad2(when.getMinutes())}-${pad2(when.getSeconds())}`;
  return join(codexHome, "sessions", year, month, day, `rollout-${stamp}-${sessionId}.jsonl`);
}

async function writeFileFsyncAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

/**
 * Rebuild a codex rollout from a thread view and write it where codex expects
 * sessions. File placement alone registers the session (codex's sqlite catalog
 * backfills on resume — proven live 2026-07-07); no sqlite writes, no
 * session_index write, and the original rollout is never touched.
 */
export async function writeRebuiltRollout(input: WriteRebuiltRolloutInput): Promise<WriteRebuiltRolloutResult> {
  const codexHome = input.codexHome ?? join(homedir(), ".codex");
  const newSessionId = input.newSessionId ?? randomUUID();
  const clock = input.clock ?? ((): Date => new Date());
  const readSource = input.readSourceFn ?? ((path: string) => readFile(path, "utf8"));

  let sourceMeta: RebuildSourceMeta | undefined;
  if (input.sourceRolloutPath !== undefined) {
    try {
      sourceMeta = sourceMetaFromContent(await readSource(input.sourceRolloutPath));
    } catch {
      sourceMeta = undefined;
    }
  }

  const when = clock();
  const lines = buildRolloutLines({
    entries: input.view.entries,
    newSessionId,
    cwd: input.cwd,
    ...(sourceMeta !== undefined ? { sourceMeta } : {}),
    clock: () => when,
  });
  const replayedPrefixLines = lines.length;

  if (input.swapReceipt !== undefined) {
    const receipt = formatSwapReceipt({
      oldSessionId: input.swapReceipt.oldSessionId,
      newSessionId,
      threadId: input.swapReceipt.threadId,
      op: input.swapReceipt.op,
      ...(input.swapReceipt.tokensBefore !== undefined ? { tokensBefore: input.swapReceipt.tokensBefore } : {}),
      ...(input.swapReceipt.tokensAfter !== undefined ? { tokensAfter: input.swapReceipt.tokensAfter } : {}),
      expectedReplayLines: replayedPrefixLines,
    });
    lines.push(...receiptRolloutLines(receipt, new Date(when.getTime() + lines.length).toISOString()));
  }

  const rolloutPath = rebuiltRolloutPath(codexHome, newSessionId, when);
  await writeFileFsyncAtomic(rolloutPath, serializeRolloutLines(lines));

  return { sessionId: newSessionId, rolloutPath, lineCount: lines.length, replayedPrefixLines };
}

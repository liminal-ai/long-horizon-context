import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionThreadView } from "lhc";

import { encodeProjectPath } from "./discover.js";
import {
  buildRolloutLines,
  firstUserPrompt,
  formatSwapReceipt,
  parseRolloutEnvelopeFromContent,
  type RebuildRolloutInput,
  type RolloutEnvelope,
  runtimeNoteRolloutLine,
  serializeRolloutLines,
} from "./rebuild.js";
import {
  appendSessionsIndexEntry,
  loadSessionsIndexForAppend,
  projectPathFromIndex,
  type RolloutWriteDeps,
  rolloutPathForSession,
  writeRolloutFileFsync,
} from "./sessions-index.js";

export interface WriteRebuiltRolloutInput {
  view: SessionThreadView;
  cwd: string;
  sourceRolloutPath?: string;
  newSessionId?: string;
  projectsRoot?: string;
  deps?: RolloutWriteDeps;
  readSourceFn?: (path: string) => Promise<string>;
  /** When set, append the swap receipt as a trailing runtime-note line. */
  swapReceipt?: { oldSessionId: string };
}

export interface WriteRebuiltRolloutResult {
  sessionId: string;
  rolloutPath: string;
  lineCount: number;
  expectedReintakeLines: number;
  /**
   * Lines the handoff capture must hard-skip as replayed served-view content.
   * A trailing swap receipt is NOT among them: it is genuinely new history
   * that must map into the thread record (as runtime_note) so later rebuilds
   * re-serve it.
   */
  replayedPrefixLines: number;
}

export async function writeRebuiltRollout(input: WriteRebuiltRolloutInput): Promise<WriteRebuiltRolloutResult> {
  const projectsRoot = input.projectsRoot ?? join(homedir(), ".claude", "projects");
  const projectDir = join(projectsRoot, encodeProjectPath(input.cwd));
  const newSessionId = input.newSessionId ?? randomUUID();
  const readSource = input.readSourceFn ?? ((path: string) => readFile(path, "utf8"));

  const deps = input.deps ?? {};
  const preloaded = await loadSessionsIndexForAppend(projectDir, deps);
  const projectPath = projectPathFromIndex(preloaded.index, input.cwd);

  let envelope: RolloutEnvelope = { cwd: input.cwd, version: "2.1.201" };
  if (input.sourceRolloutPath !== undefined) {
    const sourceContent = await readSource(input.sourceRolloutPath);
    envelope = parseRolloutEnvelopeFromContent(sourceContent, input.cwd);
  }

  const rebuildInput: RebuildRolloutInput = {
    entries: input.view.entries,
    newSessionId,
    envelope,
  };
  const lines = buildRolloutLines(rebuildInput);
  const replayedPrefixLines = lines.length;
  if (input.swapReceipt !== undefined) {
    // The receipt line itself replays on re-intake, so the count includes it.
    const receipt = formatSwapReceipt(input.swapReceipt.oldSessionId, newSessionId, lines.length + 1);
    const lastUuid = lines.length > 0 ? lines[lines.length - 1]!.line.uuid : null;
    lines.push(runtimeNoteRolloutLine(receipt, newSessionId, envelope, typeof lastUuid === "string" ? lastUuid : null));
  }
  const serialized = serializeRolloutLines(lines);
  const rolloutPath = rolloutPathForSession(projectsRoot, input.cwd, newSessionId);

  await writeRolloutFileFsync(rolloutPath, serialized, deps);
  await appendSessionsIndexEntry(
    {
      projectDir,
      sessionId: newSessionId,
      sessionFilePath: rolloutPath,
      firstPrompt: firstUserPrompt(lines),
      messageCount: lines.length,
      projectPath,
    },
    deps,
  );

  return {
    sessionId: newSessionId,
    rolloutPath,
    lineCount: lines.length,
    expectedReintakeLines: lines.length,
    replayedPrefixLines,
  };
}

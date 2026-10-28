import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionThreadView } from "lhc";

import { computeVerifiedPrefixBoundary, type PrefixBoundaryVerified } from "../intake/prefix-boundary.js";
import { encodeProjectPath } from "./discover.js";
import {
  buildRolloutLines,
  firstUserPrompt,
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
  receipt?: { text: string };
  beforeWrite?: (reservation: RebuiltRolloutReservation) => Promise<void>;
}

export interface RebuiltRolloutReservation {
  sessionId: string;
  rolloutPath: string;
  prefixBoundary: PrefixBoundaryVerified;
}

export interface WriteRebuiltRolloutResult {
  sessionId: string;
  rolloutPath: string;
  lineCount: number;
  expectedReintakeLines: number;
  replayedPrefixLines: number;
  prefixBoundary: PrefixBoundaryVerified;
  totalByteLength: number;
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
  const prefixLines = buildRolloutLines(rebuildInput);
  const prefixSerialized = serializeRolloutLines(prefixLines);
  const replayedPrefixLines = prefixLines.length;
  const prefixBoundary = computeVerifiedPrefixBoundary(prefixSerialized, replayedPrefixLines);

  const lines = [...prefixLines];
  if (input.receipt !== undefined) {
    const lastUuid = lines.length > 0 ? lines[lines.length - 1]!.line.uuid : null;
    lines.push(
      runtimeNoteRolloutLine(
        input.receipt.text,
        newSessionId,
        envelope,
        typeof lastUuid === "string" ? lastUuid : null,
      ),
    );
  }
  const serialized = serializeRolloutLines(lines);
  const rolloutPath = rolloutPathForSession(projectsRoot, input.cwd, newSessionId);

  if (input.beforeWrite !== undefined) {
    await input.beforeWrite({ sessionId: newSessionId, rolloutPath, prefixBoundary });
  }
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
    prefixBoundary,
    totalByteLength: Buffer.byteLength(serialized, "utf8"),
  };
}

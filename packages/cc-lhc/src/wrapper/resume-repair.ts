/**
 * Pre-launch torn-tail repair of the session file a launch resumes (F7).
 * Runs before Claude starts, while the wrapper still owns the terminal: the
 * outcome goes to the wrapper log, and a one-line warning to stderr whenever
 * the file was changed or a torn tail had to be left in place. Never throws.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { rolloutPathForExpectedSession } from "../rollout/expected-session.js";
import { repairTornTranscriptTail, type TornTailRepair } from "../rollout/torn-tail.js";
import { type FileHoldersResult, formatFileHolders } from "../runtime/file-holders.js";

export interface ResumeRepairInput {
  sessionId: string;
  cwd: string;
  home: string;
  log: { info(message: string): void; warn(message: string): void };
  stderr: { write(chunk: string): unknown };
  projectsRoot?: string;
  findHolders?: (path: string) => FileHoldersResult;
}

export function repairResumedTranscript(input: ResumeRepairInput): TornTailRepair {
  const path = rolloutPathForExpectedSession(
    input.projectsRoot ?? join(homedir(), ".claude", "projects"),
    input.cwd,
    input.sessionId,
  );
  const repair = repairTornTranscriptTail({
    path,
    sessionId: input.sessionId,
    home: input.home,
    ...(input.findHolders === undefined ? {} : { findHolders: input.findHolders }),
  });
  const warn = (line: string): void => {
    input.log.warn(line);
    input.stderr.write(`${line}\n`);
  };
  switch (repair.kind) {
    case "missing":
    case "clean":
      break;
    case "newline_appended":
      warn(
        `cc-lhc: ${path} ended in a complete record with no newline (${String(repair.recordBytes)} bytes); ` +
          "appended the newline",
      );
      break;
    case "fragment_trimmed":
      warn(
        `cc-lhc: ${path} ended in a torn line; saved ${String(repair.fragmentBytes)} bytes to ${repair.sideFile} ` +
          `and trimmed the transcript to ${String(repair.truncatedTo)} bytes`,
      );
      break;
    case "held_open":
      warn(
        `cc-lhc: ${path} ends in an unterminated line (${String(repair.fragmentBytes)} bytes) but is held open by ` +
          `${formatFileHolders(repair.holders)}; left untouched`,
      );
      break;
    case "holder_check_unavailable":
      warn(
        `cc-lhc: ${path} ends in an unterminated line (${String(repair.fragmentBytes)} bytes); cannot check ` +
          `whether another process holds it (${repair.reason}); left untouched`,
      );
      break;
    case "failed":
      warn(`cc-lhc: torn-tail check of ${path} failed: ${repair.reason}; left as is`);
      break;
  }
  return repair;
}

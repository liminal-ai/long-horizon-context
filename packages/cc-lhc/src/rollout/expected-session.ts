import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import { encodeProjectPath } from "./discover.js";

/**
 * Minimal internal expected-session structure for deterministic capture.
 * Not a Slice 2 runtime descriptor — only what watcher binding needs.
 */
export interface ExpectedSession {
  /** Claude session UUID the watcher must bind exclusively. */
  sessionId: string;
  /**
   * How the id was chosen.
   * - fresh: generated and passed as --session-id
   * - explicit_new: user --session-id <uuid> for a new session (not resume)
   * - explicit_resume: --resume <uuid>
   * - wrapper_picker: bare --resume resolved by cc-lhc picker
   * - rebuilt_handoff: compact/prune replacement id
   * - continue_resolved: --continue resolved to an explicit id before launch
   * - current_alias: entered through an older alias of the thread and
   *   corrected to the session the thread currently accepts
   * - fork_new: --fork-session with generated/explicit new target id
   */
  source:
    | "fresh"
    | "explicit_new"
    | "explicit_resume"
    | "wrapper_picker"
    | "rebuilt_handoff"
    | "continue_resolved"
    | "current_alias"
    | "fork_new";
}

export function rolloutPathForExpectedSession(
  projectsRoot: string,
  cwd: string,
  sessionId: string,
): string {
  return join(projectsRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`);
}

export function sessionIdFromRolloutPath(rolloutPath: string): string {
  return basename(rolloutPath, ".jsonl");
}

export function createFreshExpectedSession(): ExpectedSession {
  return { sessionId: randomUUID(), source: "fresh" };
}

export function expectedSessionFromExplicitId(
  sessionId: string,
  source: ExpectedSession["source"] = "explicit_resume",
): ExpectedSession {
  return { sessionId, source };
}

/**
 * Claude Code dual session-field semantics (corpus-backed, Slice 1 addendum).
 *
 * Production census (local, 2026-08-09): 4,173 rollout files / 128,125 parsed
 * lines found 8,202 lines carrying BOTH `sessionId` and `session_id` with
 * **different** values, concentrated in Claude Code 2.1.215 and 2.1.220.
 * Representative fork/resume files are **named** for camelCase `sessionId`
 * (current session) while later lines retain snake_case `session_id` as the
 * source/origin session. Treating either field as interchangeable current
 * attribution false-degrades every such line.
 *
 * Rules:
 * 1. Filename + top-level `sessionId` is current-session attribution when
 *    `sessionId` is present.
 * 2. `session_id` is current attribution only when `sessionId` is absent.
 * 3. When both exist and differ, `session_id` is origin/lineage evidence —
 *    not by itself a current-session conflict.
 */
export interface LineSessionAttribution {
  /** Current-session id for attribution (filename must agree). */
  currentSessionId?: string;
  /**
   * Origin/source session when dual fields differ (fork/resume lineage).
   * Diagnostic only — not a conflict signal.
   */
  originSessionId?: string;
  /** True only when current attribution disagrees with the expected id. */
  conflict: boolean;
  /** Observed current-session id when conflict is true. */
  observed?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Attribute a rollout line's session fields against the expected (filename) id.
 */
export function attributeLineSession(
  expectedSessionId: string,
  lineSessionId: string | null | undefined,
  lineSessionIdSnake: string | null | undefined,
): LineSessionAttribution {
  const camel = nonEmptyString(lineSessionId);
  const snake = nonEmptyString(lineSessionIdSnake);

  // Prefer camelCase sessionId as current when present (corpus rule 1).
  const currentSessionId = camel ?? snake;
  // Origin only when both present and differ (corpus dual-field fork/resume).
  const originSessionId =
    camel !== undefined && snake !== undefined && camel !== snake ? snake : undefined;

  if (currentSessionId === undefined) {
    return { conflict: false };
  }
  if (currentSessionId !== expectedSessionId) {
    return {
      conflict: true,
      currentSessionId,
      observed: currentSessionId,
      ...(originSessionId !== undefined ? { originSessionId } : {}),
    };
  }
  return {
    conflict: false,
    currentSessionId,
    ...(originSessionId !== undefined ? { originSessionId } : {}),
  };
}

/**
 * @deprecated Use attributeLineSession. Kept as a thin wrapper for call sites
 * that only need the conflict boolean.
 */
export function lineSessionConflicts(
  expectedSessionId: string,
  lineSessionId: string | null | undefined,
  lineSessionIdSnake: string | null | undefined,
): { conflict: boolean; observed?: string; originSessionId?: string } {
  const attr = attributeLineSession(expectedSessionId, lineSessionId, lineSessionIdSnake);
  if (attr.conflict) {
    return {
      conflict: true,
      ...(attr.observed !== undefined ? { observed: attr.observed } : {}),
      ...(attr.originSessionId !== undefined ? { originSessionId: attr.originSessionId } : {}),
    };
  }
  return {
    conflict: false,
    ...(attr.originSessionId !== undefined ? { originSessionId: attr.originSessionId } : {}),
  };
}

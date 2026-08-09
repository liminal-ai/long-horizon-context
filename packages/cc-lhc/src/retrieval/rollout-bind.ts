/**
 * Independent absent-session rollout cross-check.
 *
 * When CLAUDE_CODE_SESSION_ID is absent, binding cannot trust two fields from
 * the same descriptor assertion alone. The exact rollout file must exist as a
 * regular readable file, basename must match session id, and Slice 1 dual-field
 * attribution must show positive matching evidence without conflict.
 */

import { basename } from "node:path";
import { lstatSync, readFileSync } from "node:fs";

import { attributeLineSession } from "../rollout/expected-session.js";
import type { RuntimeDescriptorV1 } from "../runtime/descriptor.js";

export interface RolloutBindIo {
  lstat: (path: string) => { isFile: () => boolean; mode?: number };
  readFile: (path: string) => string;
}

export function defaultRolloutBindIo(): RolloutBindIo {
  return {
    lstat: (path) => {
      const st = lstatSync(path);
      return { isFile: () => st.isFile(), mode: st.mode };
    },
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

export type RolloutBindResult = { ok: true } | { ok: false; reason: string };

/**
 * Strict deterministic cross-check of descriptor.sessionId against the real
 * rollout file contents. Never scans cwd or chooses "newest".
 */
export function verifyDescriptorRolloutBinding(
  desc: Pick<RuntimeDescriptorV1, "sessionId" | "rolloutPath">,
  io: RolloutBindIo = defaultRolloutBindIo(),
): RolloutBindResult {
  const sessionId = desc.sessionId;
  const rolloutPath = desc.rolloutPath;
  if (sessionId === undefined || sessionId === "") {
    return { ok: false, reason: "descriptor sessionId missing for rollout cross-check" };
  }
  if (rolloutPath === undefined || rolloutPath === "") {
    return { ok: false, reason: "descriptor rolloutPath missing for rollout cross-check" };
  }

  const base = basename(rolloutPath, ".jsonl");
  if (base !== sessionId) {
    return {
      ok: false,
      reason: `rollout basename ${base} != descriptor session ${sessionId}`,
    };
  }

  let st: { isFile: () => boolean };
  try {
    st = io.lstat(rolloutPath);
  } catch (cause) {
    return {
      ok: false,
      reason: `rollout missing/unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!st.isFile()) {
    return { ok: false, reason: "rollout path is not a regular file" };
  }

  let content: string;
  try {
    content = io.readFile(rolloutPath);
  } catch (cause) {
    return {
      ok: false,
      reason: `rollout unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { ok: false, reason: "rollout empty: no positive session evidence" };
  }

  let positiveMatches = 0;
  let sawAnySessionField = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    let item: { sessionId?: unknown; session_id?: unknown };
    try {
      item = JSON.parse(raw) as { sessionId?: unknown; session_id?: unknown };
    } catch {
      return { ok: false, reason: `rollout line ${i + 1} malformed JSON` };
    }
    if (item === null || typeof item !== "object") {
      return { ok: false, reason: `rollout line ${i + 1} not an object` };
    }

    const camel = typeof item.sessionId === "string" ? item.sessionId : undefined;
    const snake = typeof item.session_id === "string" ? item.session_id : undefined;
    if (camel === undefined && snake === undefined) {
      continue;
    }
    sawAnySessionField = true;
    const attr = attributeLineSession(sessionId, camel, snake);
    if (attr.conflict) {
      return {
        ok: false,
        reason: `rollout session conflict: observed ${attr.observed} expected ${sessionId}`,
      };
    }
    if (attr.currentSessionId === sessionId) {
      positiveMatches += 1;
    }
  }

  if (!sawAnySessionField) {
    return { ok: false, reason: "rollout has no session attribution fields" };
  }
  if (positiveMatches === 0) {
    return { ok: false, reason: "rollout has no positive matching session evidence" };
  }
  return { ok: true };
}

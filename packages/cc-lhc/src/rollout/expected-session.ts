import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import { encodeProjectPath } from "./discover.js";

export interface ExpectedSession {
  sessionId: string;
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

export function rolloutPathForExpectedSession(projectsRoot: string, cwd: string, sessionId: string): string {
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

export interface LineSessionAttribution {
  currentSessionId?: string;
  originSessionId?: string;
  conflict: boolean;
  observed?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function attributeLineSession(
  expectedSessionId: string,
  lineSessionId: string | null | undefined,
  lineSessionIdSnake: string | null | undefined,
): LineSessionAttribution {
  const camel = nonEmptyString(lineSessionId);
  const snake = nonEmptyString(lineSessionIdSnake);

  const currentSessionId = camel ?? snake;
  const originSessionId = camel !== undefined && snake !== undefined && camel !== snake ? snake : undefined;

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

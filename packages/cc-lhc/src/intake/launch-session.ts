import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isSessionUuid,
  isUnsupportedSessionChangingFlag,
  type UnsupportedSessionFlag,
} from "./argv.js";
import {
  type ExpectedSession,
  createFreshExpectedSession,
  expectedSessionFromExplicitId,
  rolloutPathForExpectedSession,
} from "../rollout/expected-session.js";
import { encodeProjectPath, resolveContinueSessionId, type DiscoverDeps } from "../rollout/discover.js";

export interface LaunchSessionPlan {
  expected: ExpectedSession;
  /** Argv to pass to the Claude child after normalization. */
  childArgv: string[];
  /** Source resume id when forking (attribution retained separately from target). */
  forkSourceSessionId?: string;
  /** When true, lineage may look up resumeSessionId for thread continuity. */
  resumeSessionIdForLineage?: string;
}

export interface LaunchSessionDeps {
  cwd?: string;
  discoverDeps?: DiscoverDeps;
  pickSessionId?: (candidates: SessionPickCandidate[]) => Promise<string | undefined>;
  listCandidates?: (cwd: string) => Promise<SessionPickCandidate[]>;
  /** Test hook: whether a rollout file exists for --session-id collision. */
  rolloutExistsFn?: (cwd: string, sessionId: string) => Promise<boolean>;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface SessionPickCandidate {
  sessionId: string;
  label: string;
  mtimeMs: number;
}

export class LaunchGrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchGrammarError";
  }
}

type SelectorKind = "resume" | "continue" | "session_id" | "fork_session";

interface ParsedSelector {
  kind: SelectorKind;
  /** Present for resume value / session-id value. */
  value?: string;
  /** resume value is a UUID vs free-text search term. */
  resumeForm?: "uuid" | "search" | "bare";
}

interface NormalizedArgv {
  /** Tokens after `--` pass through untouched. */
  passthrough: string[];
  /** Tokens before `--` excluding consumed selectors. */
  rest: string[];
  selectors: ParsedSelector[];
  unsupported: UnsupportedSessionFlag[];
}

/**
 * One grammar-aware normalization pass. Respects `--`, records selector
 * cardinality, never silently picks the first of conflicting selectors.
 */
export function normalizeLaunchArgv(argv: readonly string[]): NormalizedArgv {
  const passthrough: string[] = [];
  const rest: string[] = [];
  const selectors: ParsedSelector[] = [];
  const unsupported: UnsupportedSessionFlag[] = [];

  let i = 0;
  let afterDashDash = false;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (afterDashDash) {
      passthrough.push(arg);
      i += 1;
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      i += 1;
      // remaining go to passthrough including the separator as child sees it
      passthrough.push("--");
      continue;
    }

    const bad = isUnsupportedSessionChangingFlag(arg);
    if (bad !== undefined) {
      unsupported.push(bad);
      // still consume optional value so rest stays clean
      if (!arg.includes("=") && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (arg === "--fork-session") {
      selectors.push({ kind: "fork_session" });
      i += 1;
      continue;
    }

    if (arg === "--continue" || arg === "-c") {
      // Claude -c/--continue is a boolean flag even when a positional prompt follows.
      selectors.push({ kind: "continue" });
      i += 1;
      continue;
    }

    if (arg === "--resume" || arg === "-r") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        selectors.push({ kind: "resume", resumeForm: "bare" });
        i += 1;
        continue;
      }
      if (isSessionUuid(next)) {
        selectors.push({ kind: "resume", value: next, resumeForm: "uuid" });
      } else {
        selectors.push({ kind: "resume", value: next, resumeForm: "search" });
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length);
      if (value === "") {
        selectors.push({ kind: "resume", resumeForm: "bare" });
      } else if (isSessionUuid(value)) {
        selectors.push({ kind: "resume", value, resumeForm: "uuid" });
      } else {
        selectors.push({ kind: "resume", value, resumeForm: "search" });
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("-r=") && arg.length > 3) {
      const value = arg.slice(3);
      if (value === "") {
        selectors.push({ kind: "resume", resumeForm: "bare" });
      } else if (isSessionUuid(value)) {
        selectors.push({ kind: "resume", value, resumeForm: "uuid" });
      } else {
        selectors.push({ kind: "resume", value, resumeForm: "search" });
      }
      i += 1;
      continue;
    }

    if (arg === "--session-id") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new LaunchGrammarError("cc-lhc: --session-id requires a UUID value");
      }
      if (!isSessionUuid(next)) {
        throw new LaunchGrammarError(`cc-lhc: --session-id value is not a UUID: ${next}`);
      }
      selectors.push({ kind: "session_id", value: next });
      i += 2;
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      const value = arg.slice("--session-id=".length);
      if (!isSessionUuid(value)) {
        throw new LaunchGrammarError(`cc-lhc: --session-id value is not a UUID: ${value}`);
      }
      selectors.push({ kind: "session_id", value });
      i += 1;
      continue;
    }

    rest.push(arg);
    i += 1;
  }

  return { passthrough, rest, selectors, unsupported };
}

/**
 * Build child argv: pre-`--` options, then normalized Claude selectors, then
 * the exact `--` suffix (byte-for-byte order preserved). Selectors must never
 * land after `--` or they become literal prompt tokens.
 */
export function assembleChildArgv(
  rest: readonly string[],
  selectorArgs: readonly string[],
  passthrough: readonly string[],
): string[] {
  return [...rest, ...selectorArgs, ...passthrough];
}

function countKind(selectors: ParsedSelector[], kind: SelectorKind): number {
  return selectors.filter((s) => s.kind === kind).length;
}

async function defaultRolloutExists(cwd: string, sessionId: string, deps: DiscoverDeps): Promise<boolean> {
  const projectsRoot = deps.projectsRoot ?? join(homedir(), ".claude", "projects");
  const path = rolloutPathForExpectedSession(projectsRoot, cwd, sessionId);
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultListCandidates(cwd: string, deps: DiscoverDeps): Promise<SessionPickCandidate[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const projectsRoot = deps.projectsRoot ?? join(homedir(), ".claude", "projects");
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch {
    return [];
  }
  const candidates: SessionPickCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!isSessionUuid(sessionId)) continue;
    try {
      const st = await stat(join(projectDir, name));
      candidates.push({
        sessionId,
        label: `${sessionId}  mtime=${new Date(st.mtimeMs).toISOString()}`,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // skip
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, 30);
}

async function defaultPickSessionId(
  candidates: SessionPickCandidate[],
  deps: LaunchSessionDeps,
): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  const stderr = deps.stderr ?? process.stderr;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  stderr.write("cc-lhc: select a session to resume (wrapper-owned picker)\n");
  candidates.forEach((candidate, index) => {
    stderr.write(`  ${index + 1}. ${candidate.label}\n`);
  });
  stderr.write("Enter number (or session UUID), empty to cancel: ");
  if (!("isTTY" in stdin) || (stdin as NodeJS.ReadStream).isTTY !== true) {
    return undefined;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question("", (line) => resolve(line.trim()));
    });
    if (answer === "") return undefined;
    const asNum = Number.parseInt(answer, 10);
    if (Number.isFinite(asNum) && asNum >= 1 && asNum <= candidates.length) {
      return candidates[asNum - 1]!.sessionId;
    }
    if (isSessionUuid(answer) && candidates.some((c) => c.sessionId === answer)) return answer;
    return undefined;
  } finally {
    rl.close();
  }
}

/**
 * Resolve expected Claude session id and shape child argv before spawn.
 * Fails closed on ambiguous/unsupported selector combinations.
 */
export async function resolveLaunchSession(
  argv: readonly string[],
  deps: LaunchSessionDeps = {},
): Promise<LaunchSessionPlan> {
  const cwd = deps.cwd ?? process.cwd();
  const discoverDeps = deps.discoverDeps ?? {};
  const normalized = normalizeLaunchArgv(argv);

  if (normalized.unsupported.length > 0) {
    const flags = [...new Set(normalized.unsupported)].join(", ");
    throw new LaunchGrammarError(
      `cc-lhc: unsupported session/cwd-changing flag(s) with capture enabled: ${flags}. ` +
        `Attribution is not modeled for these Claude 2.1.226 flags. Use --lhc-no-capture for passthrough, ` +
        `or drop the flag.`,
    );
  }

  const resumes = normalized.selectors.filter((s) => s.kind === "resume");
  const continues = normalized.selectors.filter((s) => s.kind === "continue");
  const sessionIds = normalized.selectors.filter((s) => s.kind === "session_id");
  const forks = normalized.selectors.filter((s) => s.kind === "fork_session");

  if (countKind(normalized.selectors, "resume") > 1) {
    throw new LaunchGrammarError("cc-lhc: duplicate --resume selectors");
  }
  if (countKind(normalized.selectors, "continue") > 1) {
    throw new LaunchGrammarError("cc-lhc: duplicate --continue/-c selectors");
  }
  if (countKind(normalized.selectors, "session_id") > 1) {
    throw new LaunchGrammarError("cc-lhc: duplicate --session-id selectors");
  }
  if (countKind(normalized.selectors, "fork_session") > 1) {
    throw new LaunchGrammarError("cc-lhc: duplicate --fork-session selectors");
  }

  const hasResume = resumes.length === 1;
  const hasContinue = continues.length === 1;
  const hasSessionId = sessionIds.length === 1;
  const hasFork = forks.length === 1;

  if (hasResume && hasContinue) {
    throw new LaunchGrammarError("cc-lhc: cannot combine --resume with --continue/-c");
  }
  if (hasSessionId && (hasResume || hasContinue)) {
    throw new LaunchGrammarError(
      "cc-lhc: --session-id creates a new session and cannot combine with --resume/--continue",
    );
  }
  if (hasFork && !hasResume && !hasContinue) {
    throw new LaunchGrammarError("cc-lhc: --fork-session requires --resume or --continue");
  }
  if (hasFork && hasSessionId) {
    throw new LaunchGrammarError("cc-lhc: --fork-session cannot combine with --session-id");
  }

  const rest = normalized.rest;
  const passthrough = normalized.passthrough;
  const child = (selectorArgs: string[]): string[] => assembleChildArgv(rest, selectorArgs, passthrough);

  // Explicit new session via --session-id
  if (hasSessionId) {
    const id = sessionIds[0]!.value!;
    const exists =
      deps.rolloutExistsFn !== undefined
        ? await deps.rolloutExistsFn(cwd, id)
        : await defaultRolloutExists(cwd, id, discoverDeps);
    if (exists) {
      throw new LaunchGrammarError(
        `cc-lhc: --session-id ${id} already has a rollout file; refuse to overwrite (use --resume for existing sessions)`,
      );
    }
    return {
      expected: expectedSessionFromExplicitId(id, "explicit_new"),
      childArgv: child(["--session-id", id]),
    };
  }

  // Slice 1: capture-enabled --fork-session is not certified. Reject before
  // child spawn / candidate lookup / target lineage mutation. Operators who
  // need Claude's fork path may use --lhc-no-capture passthrough.
  if (hasFork) {
    throw new LaunchGrammarError(
      "cc-lhc: --fork-session is not supported with capture enabled in Slice 1 " +
        "(no certified fork-clone lineage/prefix contract). " +
        "Use --lhc-no-capture to pass --fork-session through to Claude, " +
        "or resume an existing session without fork.",
    );
  }

  if (hasResume) {
    const resume = resumes[0]!;
    if (resume.resumeForm === "search") {
      throw new LaunchGrammarError(
        `cc-lhc: --resume ${JSON.stringify(resume.value)} looks like a picker search term, not a session UUID. ` +
          `Use bare --resume for the wrapper picker, or --resume <uuid>. Claude's in-app search is not capture-bound.`,
      );
    }
    if (resume.resumeForm === "bare") {
      const list = deps.listCandidates ?? ((c: string) => defaultListCandidates(c, discoverDeps));
      const candidates = await list(cwd);
      const pick = deps.pickSessionId ?? ((c) => defaultPickSessionId(c, deps));
      const chosen = await pick(candidates);
      if (chosen === undefined || chosen === "") {
        throw new LaunchGrammarError("cc-lhc: resume picker cancelled or no sessions available");
      }
      if (!isSessionUuid(chosen)) {
        throw new LaunchGrammarError(`cc-lhc: picker returned non-UUID session id: ${chosen}`);
      }
      return {
        expected: expectedSessionFromExplicitId(chosen, "wrapper_picker"),
        childArgv: child(["--resume", chosen]),
        resumeSessionIdForLineage: chosen,
      };
    }
    // uuid
    const id = resume.value!;
    return {
      expected: expectedSessionFromExplicitId(id, "explicit_resume"),
      childArgv: child(["--resume", id]),
      resumeSessionIdForLineage: id,
    };
  }

  if (hasContinue) {
    const continued = await resolveContinueSessionId(cwd, discoverDeps);
    if (continued === undefined) {
      throw new LaunchGrammarError(
        "cc-lhc: --continue/-c found no prior session in this project; refuse to fall through to a fresh session",
      );
    }
    return {
      expected: expectedSessionFromExplicitId(continued, "continue_resolved"),
      childArgv: child(["--resume", continued]),
      resumeSessionIdForLineage: continued,
    };
  }

  // Fresh launch
  const fresh = createFreshExpectedSession();
  return {
    expected: fresh,
    childArgv: child(["--session-id", fresh.sessionId]),
  };
}

// Re-export legacy parse helpers used by tests that only need UUID resume extraction
// from a post-normalization child argv (not production launch).
export function parseResumeSessionId(argv: readonly string[]): string | undefined {
  try {
    const n = normalizeLaunchArgv(argv);
    const resume = n.selectors.find((s) => s.kind === "resume" && s.resumeForm === "uuid");
    return resume?.value;
  } catch {
    return undefined;
  }
}

export function hasContinueFlag(argv: readonly string[]): boolean {
  try {
    return normalizeLaunchArgv(argv).selectors.some((s) => s.kind === "continue");
  } catch {
    return false;
  }
}

export function isBareResume(argv: readonly string[]): boolean {
  try {
    return normalizeLaunchArgv(argv).selectors.some((s) => s.kind === "resume" && s.resumeForm === "bare");
  } catch {
    return false;
  }
}

export function parseSessionIdFlag(argv: readonly string[]): string | undefined {
  try {
    return normalizeLaunchArgv(argv).selectors.find((s) => s.kind === "session_id")?.value;
  } catch {
    return undefined;
  }
}

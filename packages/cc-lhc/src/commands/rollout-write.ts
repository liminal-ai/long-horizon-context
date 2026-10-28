import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createDeterministicInferenceCallbacks, initLhc, type Lhc } from "lhc";

import { defaultLineageDbPath, defaultRegistryPath } from "../intake/paths.js";
import { acceptCurrentSession, claudeSessionAlias } from "../intake/thread-alias.js";
import { rolloutPathForSession } from "../rollout/sessions-index.js";
import { writeRebuiltRollout } from "../rollout/write-rebuilt.js";
import { parseTokenFamilyFlag } from "../shared/token-family-flag.js";
import { registerRebuiltSessionLineage } from "./rebuild-receipt.js";

export interface RolloutWriteCliDeps {
  initSdk?: () => Lhc;
  registryPath?: string;
  lineageDbPath?: string;
  projectsRoot?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function isRolloutWriteArgv(argv: readonly string[]): boolean {
  return argv[0] === "rollout" && argv[1] === "write";
}

const USAGE =
  "usage: cc-lhc rollout write --thread-id ID --session-id UUID --token-family SLUG [--cwd DIR] [--projects-root DIR] [--envelope-from ROLLOUT.jsonl]";
const FLAGS = new Set(["thread-id", "session-id", "cwd", "projects-root", "envelope-from", "token-family"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Parsed = { ok: true; flags: Map<string, string> } | { ok: false; reason: string };

function parseFlags(rest: readonly string[]): Parsed {
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) return { ok: false, reason: `unexpected argument: ${arg}` };
    const key = arg.slice(2);
    if (!FLAGS.has(key)) return { ok: false, reason: `unknown flag: ${arg}` };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, reason: `--${key} needs a value` };
    flags.set(key, value);
    i += 1;
  }
  return { ok: true, flags };
}

export async function runRolloutWriteCli(argv: readonly string[], deps: RolloutWriteCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const refuse = (code: string, reason: string): number => {
    err(`${code}: ${reason}`);
    return 2;
  };

  const parsed = parseFlags(argv.slice(2));
  if (!parsed.ok) {
    err(parsed.reason);
    err(USAGE);
    return 2;
  }
  const flags = parsed.flags;
  const threadIdOrPrefix = flags.get("thread-id");
  const sessionId = flags.get("session-id");
  if (threadIdOrPrefix === undefined || sessionId === undefined) {
    err(USAGE);
    return 2;
  }
  if (!UUID_RE.test(sessionId)) return refuse("usage", `--session-id must be a fresh uuid, got ${sessionId}`);
  const family = parseTokenFamilyFlag(flags.get("token-family"));
  if (!family.ok) return refuse("usage", family.reason);

  const registryPath = deps.registryPath ?? defaultRegistryPath();
  const lineageDbPath = deps.lineageDbPath ?? defaultLineageDbPath();
  const sdk =
    deps.initSdk?.() ??
    initLhc({
      mode: "manual",
      tokenFamily: family.family,
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });

  const resolved = await sdk.threads.resolve({ threadId: threadIdOrPrefix, registryPath });
  if (!resolved.ok) return refuse(resolved.error.code, resolved.error.reason);
  const threadId = resolved.value.threadId;
  const cwd = flags.get("cwd") ?? resolved.value.cwd ?? undefined;
  if (cwd === undefined || cwd === "") {
    return refuse("usage", `thread ${threadId} has no registry cwd; pass --cwd`);
  }

  const projectsRoot = flags.get("projects-root") ?? deps.projectsRoot;
  const rolloutPath = rolloutPathForSession(projectsRoot ?? defaultProjectsRoot(), cwd, sessionId);
  if (existsSync(rolloutPath)) return refuse("path_exists", `rollout ${rolloutPath} already exists`);
  const alias = claudeSessionAlias(sessionId);
  const bound = await sdk.threads.resolveAlias({ alias, registryPath });
  if (bound.ok && bound.value.threadId !== threadId) {
    return refuse("alias_bound_to_other_thread", `${alias} is bound to ${bound.value.threadId}`);
  }

  const view = await sdk.threadView.getSessionThreadView({ threadId, registryPath });
  if (!view.ok) return refuse(view.error.code, view.error.reason);
  if (view.value.entries.length === 0) return refuse("empty_view", `thread ${threadId} serves no entries`);

  const written = await writeRebuiltRollout({
    view: view.value,
    cwd,
    newSessionId: sessionId,
    ...(projectsRoot === undefined ? {} : { projectsRoot }),
    ...(flags.has("envelope-from") ? { sourceRolloutPath: flags.get("envelope-from") as string } : {}),
  });

  const lineage = await registerRebuiltSessionLineage({
    newSessionId: sessionId,
    threadId,
    prefixBoundary: written.prefixBoundary,
    lineageDbPath,
    logError: err,
  });
  if (!lineage.ok) {
    err(`lineage: ${lineage.reason}; rollout ${written.rolloutPath} written but not registered`);
    return 1;
  }
  const accepted = await acceptCurrentSession({ sessionId, threadId, registryPath });
  if (!accepted.ok) {
    err(`alias: ${accepted.reason}; rollout ${written.rolloutPath} written and lineage recorded but not current`);
    return 1;
  }
  out(`${sessionId} ${written.rolloutPath} lines=${written.lineCount}`);
  return 0;
}

function defaultProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

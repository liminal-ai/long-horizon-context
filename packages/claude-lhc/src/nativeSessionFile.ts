/**
 * Write a projected native transcript into the effective Claude home and resume
 * by UUID. Path rules match pinned Agent SDK 0.3.170: CLAUDE_CONFIG_DIR else
 * ~/.claude (NFC-normalized), projects/<So(cwd)>/<uuid>.jsonl. So replaces
 * non-alphanumeric with '-', truncates at 200, and suffixes Java-style hash
 * (abs, base36) for longer keys. Cwd is realpath'd when possible, then NFC on
 * darwin. No sessionStore, no HOME rewrite, no sessions index.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { NativeEntry } from "./projection/project.js";

const PROJECT_KEY_CAP = 200;

/** Pinned SDK `qt`: `CLAUDE_CONFIG_DIR ?? ~/.claude`, then NFC. No trim. */
export function effectiveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");
  return home.normalize("NFC");
}

/** Pinned SDK `Oy`: 32-bit Java string hash. */
export function javaStringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i) | 0;
  }
  return hash;
}

/** Pinned SDK `So`. Encodes the already-canonical cwd. */
export function encodeProjectKey(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= PROJECT_KEY_CAP) return encoded;
  return `${encoded.slice(0, PROJECT_KEY_CAP)}-${Math.abs(javaStringHash(cwd)).toString(36)}`;
}

/** Pinned SDK `KU`: `realpathSync` (not `.native`), then NFC on darwin (`Or`). */
export function canonicalizeCwd(cwd: string, platform = process.platform): string {
  let resolved = cwd;
  try {
    resolved = NodeFS.realpathSync(cwd);
  } catch {
    resolved = NodePath.resolve(cwd);
  }
  return platform === "darwin" ? resolved.normalize("NFC") : resolved;
}

export function nativeProjectDir(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): string {
  return NodePath.join(
    effectiveClaudeHome(input.env),
    "projects",
    encodeProjectKey(canonicalizeCwd(input.cwd, input.platform)),
  );
}

export function nativeMemoryDir(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): string {
  return NodePath.join(nativeProjectDir(input), "memory");
}

export function nativeSessionPath(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): string {
  return NodePath.join(nativeProjectDir(input), `${input.sessionId}.jsonl`);
}

function jsonl(entries: readonly NativeEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * Complete the file before the caller may resume. Write to a sibling tmp, then
 * rename onto the UUID name so a failure does not leave a partial resume file.
 */
export async function writeProjectedSession(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly entries: readonly NativeEntry[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): Promise<string> {
  const dest = nativeSessionPath(input);
  const dir = NodePath.dirname(dest);
  await NodeFS.promises.mkdir(dir, { recursive: true });
  const staging = `${dest}.${process.pid}.tmp`;
  const body = jsonl(input.entries);
  try {
    await NodeFS.promises.writeFile(staging, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await NodeFS.promises.rename(staging, dest);
  } catch (cause) {
    await NodeFS.promises.rm(staging, { force: true }).catch(() => undefined);
    throw cause;
  }
  return dest;
}

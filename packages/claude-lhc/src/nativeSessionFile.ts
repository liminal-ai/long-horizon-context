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

export function effectiveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");
  return home.normalize("NFC");
}

export function javaStringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

export function encodeProjectKey(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= PROJECT_KEY_CAP) return encoded;
  return `${encoded.slice(0, PROJECT_KEY_CAP)}-${Math.abs(javaStringHash(cwd)).toString(36)}`;
}

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

export async function nativeMessageAncestors(input: {
  readonly uuid: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const dir = nativeProjectDir(input);
  const resumed = `${input.sessionId}.jsonl`;
  const names = await NodeFS.promises.readdir(dir).catch(() => [] as string[]);
  for (const name of [resumed, ...names.filter((n) => n.endsWith(".jsonl") && n !== resumed)]) {
    const body = await NodeFS.promises.readFile(NodePath.join(dir, name), "utf8").catch(() => "");
    if (!body.includes(input.uuid)) continue;
    const lines = new Map<string, { parent: unknown; type: unknown }>();
    for (const raw of body.split("\n")) {
      try {
        const line = JSON.parse(raw) as Record<string, unknown>;
        if (typeof line["uuid"] === "string")
          lines.set(line["uuid"], { parent: line["parentUuid"], type: line["type"] });
      } catch {}
    }
    if (!lines.has(input.uuid)) continue;
    const ancestors: string[] = [];
    const seen = new Set([input.uuid]);
    let parent = lines.get(input.uuid)?.parent;
    while (typeof parent === "string" && !seen.has(parent)) {
      seen.add(parent);
      const line = lines.get(parent);
      if (line === undefined) break;
      if (line.type === "user" || line.type === "assistant") ancestors.push(parent);
      parent = line.parent;
    }
    return ancestors;
  }
  return [];
}

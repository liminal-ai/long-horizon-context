/**
 * Launch-scoped context-window observer (tech-design D8).
 *
 * Claude Code publishes `context_window.context_window_size` through its
 * documented status-line command input. CC-LHC installs one launch-scoped
 * `--settings` payload whose status-line command appends every JSON payload
 * to a wrapper-owned capture file, chained in front of the operator's own
 * status-line command so that command still receives the identical bytes and
 * its stdout remains the visible status line. Nothing here writes a settings
 * file, and CC-LHC emits no status text of its own.
 *
 * The observer supplies window size only. Provider-reported usage remains the
 * pressure source; `message.model` is never a class input.
 *
 * Failure posture: anything that cannot be read or merged safely leaves the
 * operator's argv exactly as forwarded and reports detection unavailable, so
 * the conservative 200k policy applies. Two competing `--settings` values are
 * never forwarded.
 *
 * Windows: Claude Code 2.1.252 runs a default-shell status-line command
 * through Git Bash (its hook executor resolves `bash.exe` and fails the hook
 * outright when Git for Windows is absent), so the same POSIX `tee | cmd`
 * chain is the native multiplexer there; the capture path is written in the
 * MSYS form Git Bash resolves (`/c/Users/...`). A status line declaring
 * `shell: "powershell"` or the exec form (`args`) runs outside that shell and
 * cannot be chained without changing how the operator's command executes, so
 * those two shapes report detection unavailable with the exact reason.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { contextWindowDetectionUnavailable, resolveContextWindow } from "../governor/config.js";
import type { ContextWindowResolution } from "../governor/types.js";

// ---------------------------------------------------------------------------
// Operator status line discovery (read-only)
// ---------------------------------------------------------------------------

export interface StatusLineSetting {
  type: string;
  command?: string;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(
  path: string,
): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  try {
    if (!existsSync(path)) return { ok: true, value: null };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(parsed)) return { ok: false, error: `${path} is not a JSON object` };
    return { ok: true, value: parsed };
  } catch (cause) {
    return { ok: false, error: `${path}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/** Claude's user settings directory (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (typeof configured === "string" && configured !== "") return configured;
  return join(homedir(), ".claude");
}

/**
 * The operator's effective status-line setting from Claude's own settings
 * files, read only: project local > project > user. Any unreadable layer
 * makes the result unavailable rather than guessed.
 */
export function resolveOperatorStatusLine(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): { ok: true; statusLine: unknown; origin: string | null } | { ok: false; error: string } {
  const env = options.env ?? process.env;
  const layers = [
    join(options.cwd, ".claude", "settings.local.json"),
    join(options.cwd, ".claude", "settings.json"),
    join(claudeConfigDir(env), "settings.json"),
  ];
  for (const path of layers) {
    const read = readJsonObject(path);
    if (!read.ok) return { ok: false, error: read.error };
    if (read.value !== null && Object.hasOwn(read.value, "statusLine")) {
      return { ok: true, statusLine: read.value.statusLine, origin: path };
    }
  }
  return { ok: true, statusLine: undefined, origin: null };
}

// ---------------------------------------------------------------------------
// One merged launch-scoped --settings payload
// ---------------------------------------------------------------------------

export interface SettingsMergeInput {
  /** Child argv as assembled by the launch grammar (before the observer). */
  argv: readonly string[];
  /** Reads a `--settings <path>` file; null when unreadable. */
  readFile: (path: string) => string | null;
  /** Wrapper-owned capture file the observer appends JSON lines to. */
  capturePath: string;
  /** The operator's effective status line from Claude's settings files, when known. */
  operatorStatusLine?: unknown;
  /** Child platform; defaults to this process. Parameterized so win32 serialization is testable anywhere. */
  platform?: NodeJS.Platform;
}

export type SettingsMergeResult =
  | {
      kind: "merged";
      argv: string[];
      settings: Record<string, unknown>;
      /**
       * How the operator's status line was preserved: chained behind the
       * observer, or absent (observer alone). Never carries the command text —
       * that is the operator's private configuration.
       */
      operatorStatusLine: "chained" | "none";
    }
  | { kind: "detection_unavailable"; reason: string; argv: string[] };

/**
 * The capture path as the status-line shell will resolve it. Git Bash (the
 * Windows executor) takes MSYS paths: `C:\a\b` → `/c/a/b`, UNC `\\\\s\\x` → `//s/x`.
 */
export function shellCapturePath(path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return path;
  if (path.startsWith("\\\\")) return path.replaceAll("\\", "/");
  const drive = path.match(/^([A-Za-z]):[/\\]/);
  if (drive) return `/${drive[1]!.toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
  return path.replaceAll("\\", "/");
}

/** Shell-quote for the POSIX status-line shell; refuses paths it cannot quote. */
function quoted(path: string): string | null {
  if (path.includes("'") || path.includes("\n")) return null;
  return `'${path}'`;
}

function findSettingsFlag(argv: readonly string[]): {
  hits: Array<{ index: number; span: number; value: string | undefined }>;
} {
  const hits: Array<{ index: number; span: number; value: string | undefined }> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a === "--settings") hits.push({ index: i, span: 2, value: argv[i + 1] });
    else if (a.startsWith("--settings=")) hits.push({ index: i, span: 1, value: a.slice("--settings=".length) });
  }
  return { hits };
}

export function mergeLaunchSettings(input: SettingsMergeInput): SettingsMergeResult {
  const argv = [...input.argv];
  const platform = input.platform ?? process.platform;
  const unavailable = (reason: string): SettingsMergeResult => ({ kind: "detection_unavailable", reason, argv });

  const { hits } = findSettingsFlag(argv);
  if (hits.length > 1) return unavailable("multiple --settings values");

  let base: Record<string, unknown> = {};
  const hit = hits[0] ?? null;
  if (hit !== null) {
    if (hit.value === undefined) return unavailable("--settings has no value");
    const text = hit.value.trimStart().startsWith("{") ? hit.value : input.readFile(hit.value);
    if (text === null) return unavailable("settings file unreadable");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return unavailable("settings payload is not JSON");
    }
    if (!isPlainObject(parsed)) return unavailable("settings payload is not an object");
    base = parsed;
  }

  const userLine: unknown = Object.hasOwn(base, "statusLine") ? base.statusLine : input.operatorStatusLine;
  const capture = quoted(shellCapturePath(input.capturePath, platform));
  if (capture === null) return unavailable("capture path not quotable");

  let operatorStatusLine: "chained" | "none";
  let statusLine: Record<string, unknown>;
  if (userLine === undefined || userLine === null) {
    operatorStatusLine = "none";
    statusLine = { type: "command", command: `cat >> ${capture}`, padding: 0 };
  } else {
    if (
      !isPlainObject(userLine) ||
      userLine.type !== "command" ||
      typeof userLine.command !== "string" ||
      userLine.command === ""
    ) {
      return unavailable("existing statusLine cannot be chained");
    }
    // Only a default-shell command shares the POSIX shell the chain relies on.
    if (userLine.shell === "powershell") return unavailable("existing statusLine runs under PowerShell");
    if (userLine.args !== undefined) return unavailable("existing statusLine uses the exec form (args)");
    operatorStatusLine = "chained";
    statusLine = { ...userLine, command: `tee -a ${capture} | ${userLine.command}` };
  }

  const settings = { ...base, statusLine };
  const token = JSON.stringify(settings);
  const out = [...argv];
  if (hit === null) {
    // Ahead of any `--` boundary so the flag stays an option, never a prompt token.
    const boundary = out.indexOf("--");
    if (boundary < 0) out.push("--settings", token);
    else out.splice(boundary, 0, "--settings", token);
  } else {
    out.splice(hit.index, hit.span, "--settings", token);
  }
  return { kind: "merged", argv: out, settings, operatorStatusLine };
}

export function readSettingsFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capture file reader
// ---------------------------------------------------------------------------

/** The documented payload fields the observer reads; everything else is ignored. */
export interface StatusLinePayload {
  sessionId: string;
  contextWindowTokens: number | null;
  modelId: string | null;
}

export function parseStatusLinePayload(line: string): StatusLinePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const sessionId = parsed.session_id;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const window = isPlainObject(parsed.context_window) ? parsed.context_window.context_window_size : undefined;
  const model = isPlainObject(parsed.model) ? parsed.model.id : undefined;
  return {
    sessionId,
    contextWindowTokens: typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : null,
    modelId: typeof model === "string" && model !== "" ? model : null,
  };
}

export interface ContextWindowObserver {
  readonly capturePath: string;
  /** Sessions whose payloads this wrapper owns; anything else is ignored. */
  acceptSession(sessionId: string): void;
  /**
   * Read every payload appended since the last poll and return the newest
   * resolution for an accepted session, or null when nothing new arrived.
   * Synchronous so a caller can run it immediately before a governor
   * decision.
   */
  poll(): ContextWindowResolution | null;
  /** Payloads from sessions this wrapper does not own (diagnostic count). */
  readonly ignoredPayloads: number;
}

export function createContextWindowObserver(capturePath: string): ContextWindowObserver {
  const accepted = new Set<string>();
  let offset = 0;
  let partial = "";
  let ignored = 0;
  return {
    capturePath,
    acceptSession(sessionId) {
      accepted.add(sessionId);
    },
    get ignoredPayloads() {
      return ignored;
    },
    poll() {
      let size: number;
      try {
        size = statSync(capturePath).size;
      } catch {
        return null;
      }
      if (size <= offset) return null;
      let fd: number | null = null;
      let chunk: string;
      try {
        fd = openSync(capturePath, "r");
        const buffer = Buffer.alloc(size - offset);
        const read = readSync(fd, buffer, 0, buffer.length, offset);
        chunk = buffer.subarray(0, read).toString("utf8");
        offset += read;
      } catch {
        return null;
      } finally {
        if (fd !== null) closeSync(fd);
      }
      const text = partial + chunk;
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      let latest: ContextWindowResolution | null = null;
      for (const line of lines) {
        if (line.trim() === "") continue;
        const payload = parseStatusLinePayload(line);
        if (payload === null) continue;
        if (!accepted.has(payload.sessionId)) {
          ignored += 1;
          continue;
        }
        if (payload.contextWindowTokens === null) {
          latest = contextWindowDetectionUnavailable("status-line payload carried no context_window_size");
          continue;
        }
        latest = resolveContextWindow(payload.contextWindowTokens, payload.modelId);
      }
      return latest;
    },
  };
}

/** Wrapper-owned capture file for one launch, under the state root. */
export function newCapturePath(stateRoot: string, wrapperPid: number): string {
  const dir = join(stateRoot, "status-line");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${wrapperPid}-${Date.now().toString(36)}.jsonl`);
}

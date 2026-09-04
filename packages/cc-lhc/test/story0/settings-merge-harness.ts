/**
 * Story 0 (LIM-143) mechanism proof for tech-design D8: one launch-scoped
 * `--settings` payload that installs the context-window observer while
 * preserving the operator's own status-line command and its visible output.
 *
 * Test-only. The product implementation (Story 1) may differ in shape; what
 * this pins is the contract the live probe exercised:
 *
 *  - exactly one `--settings` reaches Claude, in the position the operator's
 *    was (or appended when there was none);
 *  - an existing `statusLine.command` is chained behind the observer capture
 *    (`tee -a`), so it receives the identical JSON bytes and its stdout stays
 *    the visible status line; every other settings field survives untouched;
 *  - anything that cannot be read or merged safely returns
 *    `detection_unavailable` with the operator's argv verbatim — never a
 *    replaced, dropped, or doubled `--settings`.
 */

export interface SettingsMergeInput {
  /** The operator's Claude argv as forwarded by the wrapper. */
  forwardedArgv: readonly string[];
  /** Reads a `--settings <path>` file; null when unreadable. */
  readFile: (path: string) => string | null;
  /** Wrapper-owned capture file the observer appends JSON lines to. */
  observerCapturePath: string;
  /** Text of the operator's user settings file (statusLine fallback), when known. */
  userSettingsText?: string | null;
}

export type SettingsMergeResult =
  | {
      kind: "merged";
      argv: string[];
      settings: Record<string, unknown>;
      /** The operator command preserved behind the observer, or null when there was none. */
      chainedCommand: string | null;
    }
  | { kind: "detection_unavailable"; reason: string; argv: string[] };

/** The conservative class D8 applies whenever detection is unavailable. */
export const DETECTION_UNAVAILABLE_CLASS = "200k";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeLaunchSettings(input: SettingsMergeInput): SettingsMergeResult {
  const argv = [...input.forwardedArgv];
  const unavailable = (reason: string): SettingsMergeResult => ({ kind: "detection_unavailable", reason, argv });

  const hits: Array<{ index: number; span: number; value: string | undefined }> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a === "--settings") hits.push({ index: i, span: 2, value: argv[i + 1] });
    else if (a.startsWith("--settings=")) hits.push({ index: i, span: 1, value: a.slice("--settings=".length) });
  }
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

  let userLine: unknown = base.statusLine;
  if (userLine === undefined && input.userSettingsText !== undefined && input.userSettingsText !== null) {
    let user: unknown;
    try {
      user = JSON.parse(input.userSettingsText);
    } catch {
      return unavailable("user settings file is not JSON");
    }
    if (!isPlainObject(user)) return unavailable("user settings file is not an object");
    userLine = user.statusLine;
  }

  if (input.observerCapturePath.includes("'")) return unavailable("capture path not quotable");

  let chained: string | null = null;
  let statusLine: Record<string, unknown>;
  if (userLine === undefined || userLine === null) {
    statusLine = { type: "command", command: `cat >> '${input.observerCapturePath}'`, padding: 0 };
  } else {
    if (
      !isPlainObject(userLine) ||
      userLine.type !== "command" ||
      typeof userLine.command !== "string" ||
      userLine.command === ""
    ) {
      return unavailable("existing statusLine cannot be chained");
    }
    chained = userLine.command;
    statusLine = { ...userLine, command: `tee -a '${input.observerCapturePath}' | ${userLine.command}` };
  }

  const settings = { ...base, statusLine };
  const out = [...argv];
  const token = JSON.stringify(settings);
  if (hit === null) out.push("--settings", token);
  else out.splice(hit.index, hit.span, "--settings", token);
  return { kind: "merged", argv: out, settings, chainedCommand: chained };
}

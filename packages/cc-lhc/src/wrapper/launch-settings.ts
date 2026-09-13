/**
 * Launch-scoped `--settings` merge for the continuity result-delivery hook.
 *
 * One payload: existing operator `--settings` (if any) plus an appended
 * UserPromptSubmit hook. The operator's other fields, including any status
 * line they already set, are left untouched. Unreadable or unmergeable
 * settings leave the argv as forwarded and report the hook unavailable.
 */

import { readFileSync } from "node:fs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SettingsMergeInput {
  /** Child argv as assembled by the launch grammar. */
  argv: readonly string[];
  /** Reads a `--settings <path>` file; null when unreadable. */
  readFile: (path: string) => string | null;
  /**
   * LIM-146: the launch-scoped `UserPromptSubmit` hook that delivers carried
   * results. Appended to the user's own hooks for that event, never replacing
   * them; a payload whose `hooks` cannot be extended reports the hook
   * unavailable and leaves the rest of the payload intact.
   */
  deliveryHook?: { command: string; timeoutSeconds: number };
}

export type DeliveryHookOutcome =
  | { kind: "installed" }
  | { kind: "already_present" }
  | { kind: "not_requested" }
  | { kind: "unavailable"; reason: string };

export type SettingsMergeResult =
  | {
      kind: "merged";
      argv: string[];
      settings: Record<string, unknown>;
      deliveryHook: DeliveryHookOutcome;
    }
  | { kind: "unmerged"; reason: string; argv: string[] };

/** Extend `hooks.UserPromptSubmit` with the delivery hook, preserving every existing entry byte-for-byte. */
function mergeDeliveryHook(
  base: Record<string, unknown>,
  hook: { command: string; timeoutSeconds: number } | undefined,
): { hooks: unknown; outcome: DeliveryHookOutcome } {
  if (hook === undefined) return { hooks: base.hooks, outcome: { kind: "not_requested" } };
  const hooks: unknown = base.hooks ?? {};
  if (!isPlainObject(hooks))
    return { hooks: base.hooks, outcome: { kind: "unavailable", reason: "hooks is not an object" } };
  const existing: unknown = hooks.UserPromptSubmit ?? [];
  if (!Array.isArray(existing)) {
    return { hooks: base.hooks, outcome: { kind: "unavailable", reason: "hooks.UserPromptSubmit is not an array" } };
  }
  const present = existing.some(
    (group) =>
      isPlainObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => isPlainObject(h) && h.type === "command" && h.command === hook.command),
  );
  if (present) return { hooks, outcome: { kind: "already_present" } };
  const entry = { hooks: [{ type: "command", command: hook.command, timeout: hook.timeoutSeconds }] };
  return { hooks: { ...hooks, UserPromptSubmit: [...existing, entry] }, outcome: { kind: "installed" } };
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
  const unmerged = (reason: string): SettingsMergeResult => ({ kind: "unmerged", reason, argv });

  const { hits } = findSettingsFlag(argv);
  if (hits.length > 1) return unmerged("multiple --settings values");

  let base: Record<string, unknown> = {};
  const hit = hits[0] ?? null;
  if (hit !== null) {
    if (hit.value === undefined) return unmerged("--settings has no value");
    const text = hit.value.trimStart().startsWith("{") ? hit.value : input.readFile(hit.value);
    if (text === null) return unmerged("settings file unreadable");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return unmerged("settings payload is not JSON");
    }
    if (!isPlainObject(parsed)) return unmerged("settings payload is not an object");
    base = parsed;
  }

  const delivery = mergeDeliveryHook(base, input.deliveryHook);
  if (hit === null && input.deliveryHook === undefined) {
    return { kind: "merged", argv, settings: base, deliveryHook: delivery.outcome };
  }
  const settings = { ...base, ...(delivery.hooks === undefined ? {} : { hooks: delivery.hooks }) };
  const token = JSON.stringify(settings);
  const out = [...argv];
  if (hit === null) {
    const boundary = out.indexOf("--");
    if (boundary < 0) out.push("--settings", token);
    else out.splice(boundary, 0, "--settings", token);
  } else {
    out.splice(hit.index, hit.span, "--settings", token);
  }
  return { kind: "merged", argv: out, settings, deliveryHook: delivery.outcome };
}

export function readSettingsFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

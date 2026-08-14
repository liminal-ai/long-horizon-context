import type { RolloutLineItem } from "./types.js";

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];

export const CLAUDE_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "manual",
  "dontAsk",
  "plan",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export interface ClaudeRuntimeSettings {
  effort?: ClaudeEffort;
  permissionMode?: ClaudePermissionMode;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

/** Fold only settings Claude records explicitly in its rollout. */
export function observeClaudeRuntimeSettings(
  current: ClaudeRuntimeSettings,
  item: RolloutLineItem,
): ClaudeRuntimeSettings {
  if (item.isSidechain === true) return current;

  let next = current;
  if (isOneOf(item.permissionMode, CLAUDE_PERMISSION_MODES)) {
    next = { ...next, permissionMode: item.permissionMode };
  }
  if (item.type === "assistant" && isOneOf(item.effort, CLAUDE_EFFORT_LEVELS)) {
    next = { ...next, effort: item.effort };
  }
  return next;
}

function withoutOption(argv: readonly string[], option: "--effort" | "--permission-mode"): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === option) {
      i += 1;
      continue;
    }
    if (arg.startsWith(`${option}=`)) continue;
    kept.push(arg);
  }
  return kept;
}

function beforePassthrough(argv: readonly string[], args: readonly string[]): string[] {
  const boundary = argv.indexOf("--");
  if (boundary < 0) return [...argv, ...args];
  return [...argv.slice(0, boundary), ...args, ...argv.slice(boundary)];
}

/** Replace launch values with the latest confirmed runtime values. */
export function applyClaudeRuntimeSettings(
  argv: readonly string[],
  settings: ClaudeRuntimeSettings,
): string[] {
  let next = [...argv];
  const additions: string[] = [];
  if (settings.effort !== undefined) {
    next = withoutOption(next, "--effort");
    additions.push("--effort", settings.effort);
  }
  if (settings.permissionMode !== undefined) {
    next = withoutOption(next, "--permission-mode");
    // Claude rollout records use `default`; the current CLI names the same
    // approval-required mode `manual`.
    additions.push("--permission-mode", settings.permissionMode === "default" ? "manual" : settings.permissionMode);
  }
  return beforePassthrough(next, additions);
}

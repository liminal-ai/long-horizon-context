import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatTokensShort } from "../commands/context-mutation.js";
import { type NativeAutoCompactState, nativeAutoCompactHomeSegment } from "./terminology.js";

export const ONBOARDING_VERSION = 1;

export function firstLoadMarkerPath(home: string): string {
  return join(home, "first-load.json");
}

export function readShownVersion(path: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const version = (parsed as { shownVersion?: unknown }).shownVersion;
    return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : null;
  } catch {
    return null;
  }
}

export function markShown(path: string, version: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ shownVersion: version })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function formatLeaderKey(leaderByte: number): string {
  if (leaderByte >= 0x01 && leaderByte <= 0x1a) return `ctrl-${String.fromCharCode(leaderByte + 96)}`;
  if (leaderByte >= 0x1b && leaderByte <= 0x1f) return `ctrl-${String.fromCharCode(leaderByte + 64).toLowerCase()}`;
  return `0x${leaderByte.toString(16).padStart(2, "0")}`;
}

export const ACTIONABLE_KINDS = [
  "possible_undelivered_input",
  "unsafe_capture_or_database_state",
  "repeated_replacement_failure",
  "unmanageable_async_identity",
  "native_auto_compact_conflict",
] as const;
export type ActionableKind = (typeof ACTIONABLE_KINDS)[number];

export function isActionableKind(kind: string): kind is ActionableKind {
  return (ACTIONABLE_KINDS as readonly string[]).includes(kind);
}

export interface ActionableCondition {
  kind: ActionableKind;
  lines: readonly string[];
}

const GUIDANCE: Record<ActionableKind, string> = {
  possible_undelivered_input: "input may not have reached Claude — resend what you typed",
  unsafe_capture_or_database_state: "cc-lhc state is unsafe — capture or the database could not be trusted",
  repeated_replacement_failure: "Smart Compact replacements keep failing — the automatic child swap is stopped",
  unmanageable_async_identity: "background work could not be identified — its records were not carried",
  native_auto_compact_conflict: "Claude native auto-compact may run before Smart Compact on this launch",
};

export function actionableGuidanceRows(conditions: readonly ActionableCondition[]): string[] {
  const rows: string[] = [];
  for (const kind of ACTIONABLE_KINDS) {
    const matching = conditions.filter((condition) => condition.kind === kind);
    if (matching.length === 0) continue;
    rows.push(`! ${GUIDANCE[kind]}`);
    for (const condition of matching) rows.push(...condition.lines);
  }
  return rows;
}

export interface FirstLoadFacts {
  targetTokens: number;
  triggerTokens: number;
  nativeAutoCompact: NativeAutoCompactState;
  leaderByte: number;
}

export function firstLoadGuidanceRows(facts: FirstLoadFacts): string[] {
  return [
    "Welcome to CC-LHC. Smart Compact keeps this Claude session within its context window automatically.",
    `target ${formatTokensShort(facts.targetTokens)} after /smart-compact · trigger ${formatTokensShort(facts.triggerTokens)}`,
    nativeAutoCompactHomeSegment(facts.nativeAutoCompact),
    `reopen this panel any time with ${formatLeaderKey(facts.leaderByte)} · press Esc to continue to Claude`,
  ];
}

export interface StartupPanelPlan {
  open: boolean;
  firstLoad: boolean;
  rows: string[];
}

export function planStartupPanel(input: {
  shownVersion: number | null;
  version: number;
  facts: FirstLoadFacts;
  conditions: readonly ActionableCondition[];
}): StartupPanelPlan {
  const firstLoad = input.shownVersion === null || input.shownVersion < input.version;
  const guidance = actionableGuidanceRows(input.conditions);
  if (!firstLoad && guidance.length === 0) return { open: false, firstLoad: false, rows: [] };
  return {
    open: true,
    firstLoad,
    rows: [...guidance, ...(firstLoad ? firstLoadGuidanceRows(input.facts) : [])],
  };
}

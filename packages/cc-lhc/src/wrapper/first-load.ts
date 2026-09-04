/**
 * First-load Control Panel and the visible-message allowlist (AC-3.7).
 *
 * Once Claude owns the terminal the wrapper writes nothing onto its screen.
 * Two things may open the production Control Panel by themselves: the first
 * managed launch of an onboarding version in one CC-LHC home, and a durable
 * condition the operator must act on. Everything else — routine status,
 * successful operations, token counts, active work — waits in the panel for
 * the reopen key and in the wrapper log.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatTokensShort } from "../commands/context-mutation.js";
import type { ContextClass } from "../governor/types.js";
import { type NativeAutoCompactState, nativeAutoCompactHomeSegment } from "./terminology.js";

/** Bump when the onboarding content changes enough that every home should see it once more. */
export const ONBOARDING_VERSION = 1;

/** The one durable fact: which onboarding version this home has already seen. */
export function firstLoadMarkerPath(home: string): string {
  return join(home, "first-load.json");
}

/** The shown version, or null when nothing readable says one was shown. */
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

/** Record that `version` was shown; atomic so a torn write reads as not shown. */
export function markShown(path: string, version: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ shownVersion: version })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The reopen key as the operator types it (`ctrl-]` for the default leader). */
export function formatLeaderKey(leaderByte: number): string {
  if (leaderByte >= 0x01 && leaderByte <= 0x1a) return `ctrl-${String.fromCharCode(leaderByte + 96)}`;
  if (leaderByte >= 0x1b && leaderByte <= 0x1f) return `ctrl-${String.fromCharCode(leaderByte + 64).toLowerCase()}`;
  return `0x${leaderByte.toString(16).padStart(2, "0")}`;
}

/**
 * The closed allowlist of conditions that may open the panel unasked. A
 * message that is not one of these is routine and never auto-opens.
 */
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
  /** Already user-facing text; shown beneath the kind's one-line guidance. */
  lines: readonly string[];
}

/** Priority order: what can lose the operator's work first. */
const GUIDANCE: Record<ActionableKind, string> = {
  possible_undelivered_input: "input may not have reached Claude — resend what you typed",
  unsafe_capture_or_database_state: "cc-lhc state is unsafe — capture or the database could not be trusted",
  repeated_replacement_failure: "Smart Compact replacements keep failing — the automatic child swap is stopped",
  unmanageable_async_identity: "background work could not be identified — its records were not carried",
  native_auto_compact_conflict: "Claude native auto-compact may run before Smart Compact on this launch",
};

/** Concise prioritized rows for the panel: highest priority first, each kind once. */
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
  contextClass: ContextClass;
  nativeAutoCompact: NativeAutoCompactState;
  leaderByte: number;
}

/** The one-time explanation, built from the resolved policy the session actually runs with. */
export function firstLoadGuidanceRows(facts: FirstLoadFacts): string[] {
  return [
    "Welcome to CC-LHC. Smart Compact keeps this Claude session within its context window automatically.",
    `target ${formatTokensShort(facts.targetTokens)} after /smart-compact · trigger ${formatTokensShort(facts.triggerTokens)} · window ${facts.contextClass}`,
    nativeAutoCompactHomeSegment(facts.nativeAutoCompact),
    `reopen this panel any time with ${formatLeaderKey(facts.leaderByte)} · press Esc to continue to Claude`,
  ];
}

export interface StartupPanelPlan {
  open: boolean;
  /** True when this open is the onboarding view that must be marked shown. */
  firstLoad: boolean;
  rows: string[];
}

/**
 * Whether the panel opens at launch and what it says. Onboarding opens once per
 * version per home; allowlisted conditions open it whenever they are present.
 */
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

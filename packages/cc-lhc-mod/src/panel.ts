import type { LastCompact, PanelDerivations, PanelState } from "../mod/types/index.d.ts";
import { isBound, isPercent, MIN_BOUND, type Settings } from "./settings.ts";

export type { Action, ActionKind, LastCompact, PanelState } from "../mod/types/index.d.ts";
export type Derivations = PanelDerivations;
export type ExportAnswer = { path: string; turns: number };
export type Health = {
  recording: { kind: string; threadId?: string; how?: string } | null;
  derivations: Derivations | null;
};

export const EMPTY_PANEL: PanelState = {
  thread: null,
  settings: null,
  policy: null,
  context: null,
  lastCompact: null,
  derivations: null,
  action: null,
};

export function kilo(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${Number((tokens / 1_000_000).toFixed(2))}M`;
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function parseTokens(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim().replaceAll(/[,_]/g, ""));
  if (match === null) return undefined;
  const scale = { "": 1, k: 1000, m: 1_000_000 }[(match[2] ?? "").toLowerCase()] ?? 1;
  const tokens = Math.round(Number(match[1]) * scale);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

export const SETTING_NAMES: Record<keyof Settings, string> = {
  lowerBound: "lower bound",
  upperBound: "upper bound",
  compactPercent: "compact percent",
};

export type SettingEdit = { field: keyof Settings; value: number } | { error: string };

export function parseSetting(field: keyof Settings, text: string): SettingEdit {
  if (field === "compactPercent") {
    const percent = /^\d+(?:\.\d+)?%?$/.test(text.trim()) ? Number.parseFloat(text) : Number.NaN;
    if (!isPercent(percent)) return { error: `The compact percent is a number from 1 to 100, not "${text}"` };
    return { field, value: percent };
  }
  const tokens = parseTokens(text);
  if (tokens === undefined) {
    return { error: `The ${SETTING_NAMES[field]} is a whole number of tokens such as 600000 or 600k, not "${text}"` };
  }
  if (!isBound(tokens)) {
    return {
      error: `The ${SETTING_NAMES[field]} is at least ${kilo(MIN_BOUND)} tokens, not ${tokens}. For thousands, add k: ${text.trim()}k`,
    };
  }
  return { field, value: tokens };
}

export const LHC_USAGE = "/lhc [status | compact | prune | export | bounds <lower> <upper> [percent]]";

export type LhcCommand =
  | { kind: "open" | "status" | "compact" | "prune" | "export" }
  | { kind: "bounds"; edits: Array<{ field: keyof Settings; value: number }> }
  | { kind: "invalid"; text: string };

export function parseLhcArgs(args: string): LhcCommand {
  const [verb = "", ...rest] = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (verb === "") return { kind: "open" };
  if ((verb === "status" || verb === "compact" || verb === "prune" || verb === "export") && rest.length === 0) {
    return { kind: verb };
  }
  if (verb === "bounds" && (rest.length === 2 || rest.length === 3)) {
    const fields: Array<keyof Settings> = ["lowerBound", "upperBound", "compactPercent"];
    const edits = rest.map((text, index) => parseSetting(fields[index] as keyof Settings, text));
    const error = edits.find((edit) => "error" in edit);
    if (error !== undefined && "error" in error)
      return { kind: "invalid", text: `${error.error}. Usage: ${LHC_USAGE}` };
    return { kind: "bounds", edits: edits as Array<{ field: keyof Settings; value: number }> };
  }
  return { kind: "invalid", text: `Usage: ${LHC_USAGE}` };
}

export const pressureOf = (state: PanelState): number | undefined =>
  state.context === null || state.policy === null ? undefined : state.context / state.policy.trigger;

function compactSummary(last: Extract<LastCompact, { by: "lhc" }>): string {
  const verb = last.op === "prune" ? "pruned" : "compacted";
  const from = last.before === undefined ? "" : `${kilo(last.before)} `;
  return `${verb} ${from}to ${kilo(last.after)} (${last.isMidTurn ? "mid-turn" : "settled"})`;
}

export function statusLine(state: PanelState, lastTurnStartedAt: number): string | undefined {
  const last = state.lastCompact;
  if (last?.by === "native") return "fell back to Claude Code's summary";
  if (last === null || last.at <= lastTurnStartedAt) return undefined;
  return last.before === undefined ? `compacted to ${kilo(last.after)}` : `${kilo(last.before)} → ${kilo(last.after)}`;
}

function contextLine(state: PanelState): string | undefined {
  const parts: string[] = [];
  const pressure = pressureOf(state);
  if (pressure !== undefined && state.context !== null && state.policy !== null) {
    parts.push(`Context ${kilo(state.context)} of ${kilo(state.policy.trigger)} (${Math.round(pressure * 100)}%)`);
  }
  if (state.thread !== null) parts.push(`thread ${state.thread.id} (${state.thread.how})`);
  return parts.length === 0 ? undefined : `${parts.join(", ")}.`;
}

export function statusReport(state: PanelState, now: number): string {
  const { policy, settings, lastCompact, derivations } = state;
  const lines = [contextLine(state) ?? "No session is bound to an LHC thread yet."];
  if (policy !== null) {
    const clamp = policy.isClamped
      ? `, clamped: a ${kilo(policy.window)} window allows at most ${kilo(policy.trigger)}`
      : "";
    lines.push(
      `Compacts at ${kilo(policy.trigger)} back to ${kilo(policy.target)} (window ${kilo(policy.window)}${clamp}).`,
    );
  }
  if (settings !== null) {
    lines.push(
      `Settings: lower bound ${kilo(settings.lowerBound)}, upper bound ${kilo(settings.upperBound)}, ${settings.compactPercent}% of the window.`,
    );
  }
  if (lastCompact !== null) {
    const when = ago(now - lastCompact.at);
    lines.push(
      lastCompact.by === "native"
        ? `Last compaction ${when}: LHC fell back to Claude Code's summary (${lastCompact.reason}).`
        : `Last ${lastCompact.op} ${when} (${lastCompact.trigger}): ${compactSummary(lastCompact)}.`,
    );
  }
  if (derivations !== null) {
    lines.push(
      `Derivations: ${derivations.ready} ready, ${derivations.pending} pending, ${derivations.failed} failed, ${derivations.blocked} blocked.`,
    );
  }
  return lines.join("\n");
}

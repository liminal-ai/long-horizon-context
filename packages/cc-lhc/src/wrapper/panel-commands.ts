/**
 * Single Control Panel vocabulary: parser, Help, common actions, and
 * Home/Introduction copy. Accepted mutation spellings are smart-compact and
 * smart-prune; compact/prune are unknown.
 */
import { formatTokensShort } from "../commands/context-mutation.js";
import {
  type BandAllocationId,
  isBandAllocationId,
  PRODUCT_PRESET_IDS,
} from "../governor/band-allocation.js";
import type { ConfigFallback } from "../governor/types.js";
import { presentAllocation } from "./preset-presentation.js";

export const PANEL_TITLE = "Long Horizon Context Control Panel";

export type PanelRoute = "home" | "help" | "introduction" | "allocation";

export interface PanelViewport {
  scrollOffset: number;
  selectedIndex: number;
}

export interface PanelViewSnapshot {
  providerContextTokens: number | null;
  targetTokens: number;
  triggerTokens: number;
  autoCompact: boolean;
  captureHealth: string;
  allocationId: BandAllocationId;
  allocationLabel: string;
  allocationDescription: string;
  low: number;
  medium: number;
  high: number;
  full: number;
  degradedNotices: readonly string[];
  fallbackFields: readonly string[];
  extraStatusRows: readonly string[];
}

export type PanelCommandScope = "none" | "session";

export interface PanelCommandSpec {
  name: string;
  usage: string;
  summary: string;
  scope: PanelCommandScope;
  parse: (args: readonly string[], surface: string) => PanelParseResult;
  homeAction?: { label: string; order: number };
}

export type PanelParseResult =
  | { kind: "execute"; commandLine: string; surface: string }
  | { kind: "route"; route: Exclude<PanelRoute, "home"> }
  | { kind: "unknown"; input: string }
  | { kind: "invalid"; message: string };

function executeNoArgs(commandLine: string): PanelCommandSpec["parse"] {
  return (args, surface) =>
    args.length === 0 ? { kind: "execute", commandLine, surface } : { kind: "unknown", input: surface };
}

function routeNoArgs(route: Exclude<PanelRoute, "home">): PanelCommandSpec["parse"] {
  return (args, surface) => (args.length === 0 ? { kind: "route", route } : { kind: "unknown", input: surface });
}

function isPositiveSafeIntegerToken(raw: string): boolean {
  if (!/^[1-9]\d*$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0;
}

export const SMART_PRUNE_SYNTAX =
  "usage: smart-prune [positive-safe-integer] — reject zero, negative, fractional, overflow, nonnumeric, and extra arguments";

function parseSmartPrune(args: readonly string[], surface: string): PanelParseResult {
  if (args.length === 0) return { kind: "execute", commandLine: "/lhc-prune", surface };
  if (args.length === 1 && isPositiveSafeIntegerToken(args[0]!)) {
    return { kind: "execute", commandLine: `/lhc-prune ${args[0]}`, surface };
  }
  return { kind: "invalid", message: `invalid smart-prune target — ${SMART_PRUNE_SYNTAX}` };
}

function parseAuto(args: readonly string[], surface: string): PanelParseResult {
  if (args.length === 1 && (args[0] === "on" || args[0] === "off")) {
    return { kind: "execute", commandLine: `/lhc-auto ${args[0]}`, surface };
  }
  return { kind: "unknown", input: surface };
}

function parseBounds(args: readonly string[], surface: string): PanelParseResult {
  if (args.length === 2 && /^\d+$/.test(args[0]!) && /^\d+$/.test(args[1]!)) {
    return { kind: "execute", commandLine: `/lhc-bounds ${args[0]} ${args[1]}`, surface };
  }
  return { kind: "unknown", input: surface };
}

export const PANEL_COMMANDS: readonly PanelCommandSpec[] = [
  {
    name: "status",
    usage: "status",
    summary: "thread-view tail, threshold, zone, derivation counts, and thread id",
    scope: "none",
    parse: executeNoArgs("/lhc-status"),
  },
  {
    name: "stats",
    usage: "stats",
    summary: "capture lines, events, skip counts, replayed prefix, parse failures, derivations pending, and thread id",
    scope: "none",
    parse: executeNoArgs("/lhc-stats"),
  },
  {
    name: "smart-compact",
    usage: "smart-compact",
    summary: "run Smart Compact once and rebuild working context from durable history",
    scope: "none",
    parse: executeNoArgs("/lhc-compact"),
    homeAction: { label: "Smart Compact", order: 0 },
  },
  {
    name: "smart-prune",
    usage: "smart-prune [targetTokens]",
    summary: "run Smart Prune with the configured target or one positive safe-integer target",
    scope: "none",
    parse: parseSmartPrune,
    homeAction: { label: "Smart Prune", order: 1 },
  },
  {
    name: "export",
    usage: "export",
    summary: "write canonical transcript dumps (rollout + thread view) to cwd",
    scope: "none",
    parse: executeNoArgs("/lhc-export"),
  },
  {
    name: "auto",
    usage: "auto on|off",
    summary: "turn automatic Smart Compact on or off",
    scope: "session",
    parse: parseAuto,
  },
  {
    name: "bounds",
    usage: "bounds <lower> <upper>",
    summary: "set Smart Compact target (lower) and trigger (upper)",
    scope: "session",
    parse: parseBounds,
  },
  {
    name: "help",
    usage: "help",
    summary: "open the Help screen",
    scope: "none",
    parse: routeNoArgs("help"),
    homeAction: { label: "Help", order: 3 },
  },
  {
    name: "introduction",
    usage: "introduction",
    summary: "open the Introduction screen",
    scope: "none",
    parse: routeNoArgs("introduction"),
    homeAction: { label: "Introduction", order: 4 },
  },
];

const COMMANDS_BY_NAME = new Map(PANEL_COMMANDS.map((command) => [command.name, command]));

export type HomeAction =
  | { id: string; label: string; kind: "command"; command: string }
  | { id: string; label: string; kind: "route"; route: Exclude<PanelRoute, "home"> };

const ALLOCATION_HOME_ACTION: HomeAction = {
  id: "allocation",
  label: "Band allocation",
  kind: "route",
  route: "allocation",
};

export const HOME_ACTIONS: readonly HomeAction[] = [
  ...PANEL_COMMANDS.flatMap((command) => {
    if (command.homeAction === undefined) return [];
    const action: HomeAction =
      command.parse([], command.name).kind === "route"
        ? { id: command.name, label: command.homeAction.label, kind: "route", route: command.name as "help" | "introduction" }
        : { id: command.name, label: command.homeAction.label, kind: "command", command: command.name };
    return [{ order: command.homeAction.order, action }];
  }),
  { order: 2, action: ALLOCATION_HOME_ACTION },
]
  .sort((left, right) => left.order - right.order)
  .map((entry) => entry.action);

export type HomeStatusCanonicalId =
  | "provider"
  | "target"
  | "trigger"
  | "automatic"
  | "capture"
  | "allocation"
  | "description"
  | "low"
  | "medium"
  | "high"
  | "full";

export type HomeStatusRowId = HomeStatusCanonicalId | "notice" | "extra";

export interface HomeStatusRow {
  id: HomeStatusRowId;
  text: string;
}

interface HomeStatusRowSpec {
  readonly id: HomeStatusCanonicalId;
  readonly navigable: boolean;
  readonly text: (view: PanelViewSnapshot) => string;
}

function fallbackField(view: PanelViewSnapshot, field: string, text: string): string {
  return view.fallbackFields.includes(field) ? `${text} (fallback — not selected)` : text;
}

const HOME_STATUS_ROW_SPECS: readonly HomeStatusRowSpec[] = [
  {
    id: "provider",
    navigable: true,
    text: (view) =>
      view.providerContextTokens === null
        ? "provider context: not observed yet"
        : `provider context ${formatTokensShort(view.providerContextTokens)}`,
  },
  {
    id: "target",
    navigable: true,
    text: (view) => fallbackField(view, "lowerBoundTokens", `target ${formatTokensShort(view.targetTokens)}`),
  },
  {
    id: "trigger",
    navigable: true,
    text: (view) => fallbackField(view, "upperBoundTokens", `trigger ${formatTokensShort(view.triggerTokens)}`),
  },
  {
    id: "automatic",
    navigable: true,
    text: (view) =>
      fallbackField(view, "autoCompact", `automatic Smart Compact: ${view.autoCompact ? "on" : "off"}`),
  },
  {
    id: "capture",
    navigable: true,
    text: (view) => (view.captureHealth === "degraded" ? "capture: degraded" : `capture: ${view.captureHealth}`),
  },
  {
    id: "allocation",
    navigable: true,
    text: (view) => fallbackField(view, "profile", `Band allocation: ${view.allocationLabel}`),
  },
  {
    id: "description",
    navigable: false,
    text: (view) => view.allocationDescription,
  },
  { id: "low", navigable: true, text: (view) => `Low ${view.low}%` },
  { id: "medium", navigable: true, text: (view) => `Medium ${view.medium}%` },
  { id: "high", navigable: true, text: (view) => `High ${view.high}%` },
  { id: "full", navigable: true, text: (view) => `Full ${view.full}%` },
];

function homeNavigableStatusIds(): readonly HomeStatusCanonicalId[] {
  return HOME_STATUS_ROW_SPECS.flatMap((spec) => (spec.navigable ? [spec.id] : []));
}

export function homeCursorLength(): number {
  return homeNavigableStatusIds().length + HOME_ACTIONS.length;
}

export function homeSelectedActionIndex(scrollOffset: number): number {
  const statusCount = homeNavigableStatusIds().length;
  if (scrollOffset < statusCount) return -1;
  return Math.max(0, Math.min(HOME_ACTIONS.length - 1, scrollOffset - statusCount));
}

export function focusedHomeBodyRow(scrollOffset: number, rows: readonly HomeStatusRow[]): number {
  const navigableIds = homeNavigableStatusIds();
  const title = 1;
  if (scrollOffset < navigableIds.length) {
    const id = navigableIds[scrollOffset];
    const index = id === undefined ? -1 : rows.findIndex((row) => row.id === id);
    return index >= 0 ? title + index : title;
  }
  const actionIndex = scrollOffset - navigableIds.length;
  const actionStart = title + rows.length + 1 + 1;
  return actionStart + actionIndex;
}

export const MODAL_HELP_LINE = `commands: ${PANEL_COMMANDS.map((command) => command.usage).join(" | ")}`;
export const MODAL_SCOPE_NOTE =
  "auto/bounds edits are session-only (live now; survive handoffs; lost at wrapper exit)";
export const MODAL_ASCII_NOTE = "input is ASCII-only — non-ASCII bytes are ignored";
export const MODAL_UNKNOWN_PREFIX = "unknown command: ";

export function parsePanelCommand(line: string): PanelParseResult {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "unknown", input: trimmed };
  const parts = trimmed.split(/\s+/);
  const name = parts[0] ?? "";
  const spec = COMMANDS_BY_NAME.get(name);
  if (spec === undefined) return { kind: "unknown", input: trimmed };
  return spec.parse(parts.slice(1), trimmed);
}

/** Map a Home command line to the dispatch table's /lhc-* form; null if not executable. */
export function mapModalCommand(line: string): string | null {
  const parsed = parsePanelCommand(line);
  return parsed.kind === "execute" ? parsed.commandLine : null;
}

export function scopeNote(scope: PanelCommandScope): string | null {
  if (scope === "session") {
    return "session only — live now, survives handoffs, lost at wrapper exit";
  }
  return null;
}

export function helpLines(view: PanelViewSnapshot | null): string[] {
  const header =
    view === null
      ? []
      : [
          `active: target ${formatTokensShort(view.targetTokens)} · trigger ${formatTokensShort(view.triggerTokens)} · Band allocation ${view.allocationLabel}`,
          "",
        ];
  const commands = PANEL_COMMANDS.flatMap((command) => {
    const scope = scopeNote(command.scope);
    const lines = [`${command.usage} — ${command.summary}`];
    if (scope !== null) lines.push(`  scope: ${scope}`);
    return lines;
  });
  return [...header, ...commands, "", MODAL_ASCII_NOTE];
}

export function introductionLines(view: PanelViewSnapshot | null): string[] {
  const target = view === null ? "the active target" : formatTokensShort(view.targetTokens);
  const trigger = view === null ? "the active trigger" : formatTokensShort(view.triggerTokens);
  const allocation = view === null ? "the active Band allocation" : view.allocationLabel;
  return [
    "Complete captured history remains durable. Smart Compact does not delete that record.",
    "Recent history stays in Full and High working-context fidelity.",
    "Older history uses Medium and Low compressed bands.",
    `Smart Compact rebuilds working context from that durable history toward ${target}.`,
    `Automatic Smart Compact triggers at ${trigger}.`,
    `Band allocation ${allocation}: Low/Medium/High/Full shares set how much of each fidelity band is kept.`,
  ];
}

export function homeStatusRows(view: PanelViewSnapshot): HomeStatusRow[] {
  return [
    ...HOME_STATUS_ROW_SPECS.map((spec) => ({ id: spec.id, text: spec.text(view) })),
    ...view.degradedNotices.map((text): HomeStatusRow => ({ id: "notice", text })),
    ...view.extraStatusRows.map((text): HomeStatusRow => ({ id: "extra", text })),
  ];
}

export function homeStatusLines(view: PanelViewSnapshot): string[] {
  return homeStatusRows(view).map((row) => row.text);
}

export function homeActionLines(selectedIndex: number): string[] {
  return [
    "Common actions:",
    ...HOME_ACTIONS.map((action, index) => `${index === selectedIndex ? ">" : " "} ${action.label}`),
    "Help and Introduction are also available as typed commands.",
  ];
}

export function buildPanelViewSnapshot(input: {
  providerContextTokens: number | null;
  targetTokens: number;
  triggerTokens: number;
  autoCompact: boolean;
  captureHealth: string;
  profile: string;
  degradedNotices?: readonly string[];
  fallbacks?: readonly ConfigFallback[];
  extraStatusRows?: readonly string[];
}): PanelViewSnapshot {
  const allocationId: BandAllocationId = isBandAllocationId(input.profile) ? input.profile : "default";
  const shown = presentAllocation(allocationId);
  return {
    providerContextTokens: input.providerContextTokens,
    targetTokens: input.targetTokens,
    triggerTokens: input.triggerTokens,
    autoCompact: input.autoCompact,
    captureHealth: input.captureHealth,
    allocationId,
    allocationLabel: shown.label,
    allocationDescription: shown.description,
    low: shown.low,
    medium: shown.medium,
    high: shown.high,
    full: shown.full,
    degradedNotices: input.degradedNotices ?? [],
    fallbackFields: (input.fallbacks ?? []).flatMap((fallback) =>
      fallback.field === null ? [] : [fallback.field],
    ),
    extraStatusRows: input.extraStatusRows ?? [],
  };
}

export function allocationIndex(id: BandAllocationId): number {
  const index = PRODUCT_PRESET_IDS.indexOf(id);
  return index < 0 ? 0 : index;
}

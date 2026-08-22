/**
 * Single Control Panel vocabulary and content model: parser, Help, Details,
 * Introduction, common actions, and the Home status rows. This module owns
 * WHAT the panel says; panel.ts owns how it is drawn.
 *
 * Accepted mutation spellings are smart-compact and smart-prune; compact and
 * prune are unknown. Command names are matched case-insensitively and every
 * label the panel displays as an action round-trips through the parser, so a
 * user who types what they see never gets `unknown command`.
 */
import { formatTokensShort } from "../commands/context-mutation.js";
import { type BandAllocationId, isBandAllocationId, PRODUCT_PRESET_IDS } from "../governor/band-allocation.js";
import type { ConfigFallback } from "../governor/types.js";
import { presentAllocation } from "./preset-presentation.js";
import { SMART_COMPACT } from "./terminology.js";

/** Full product name; used as the card title wherever it fits. */
export const PANEL_TITLE = "Long Horizon Context Control Panel";
/** Card title for narrow cards, where the full name would crowd the border. */
export const PANEL_TITLE_SHORT = "Long Horizon Context";

export type PanelRoute = "home" | "help" | "introduction" | "details" | "allocation";

/** Routes that render a scrolling read-only screen (no command line). */
export type ReadonlyPanelRoute = "help" | "introduction" | "details";

export function isReadonlyRoute(route: PanelRoute): route is ReadonlyPanelRoute {
  return route === "help" || route === "introduction" || route === "details";
}

export function readonlyRouteTitle(route: ReadonlyPanelRoute): string {
  if (route === "help") return "Help";
  if (route === "details") return "Details";
  return "Introduction";
}

export interface PanelViewport {
  scrollOffset: number;
  selectedIndex: number;
}

/** One diagnostics row on the Details screen. An empty label spans the card. */
export interface DetailsRow {
  label: string;
  value: string;
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
  /** Standing alarms — drawn red on Home. */
  alarms: readonly string[];
  /** Degraded/configuration notices — drawn yellow on Home. */
  degradedNotices: readonly string[];
  fallbackFields: readonly string[];
  /** Non-default operational state — drawn as Home notices. Default states are elided. */
  extraStatusRows: readonly string[];
  /** Diagnostics for the typed `details` screen; never shown on Home. */
  details: readonly DetailsRow[];
}

export type PanelCommandScope = "none" | "session";

export interface PanelHomeAction {
  label: string;
  order: number;
  description: string;
}

export interface PanelCommandSpec {
  name: string;
  usage: string;
  summary: string;
  scope: PanelCommandScope;
  parse: (args: readonly string[], surface: string) => PanelParseResult;
  homeAction?: PanelHomeAction;
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
  // The argument is matched case-insensitively for the same reason the name
  // is: the panel must accept what it prints, in any casing a user types.
  const value = (args[0] ?? "").toLowerCase();
  if (args.length === 1 && (value === "on" || value === "off")) {
    return { kind: "execute", commandLine: `/lhc-auto ${value}`, surface };
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
    summary: `run ${SMART_COMPACT} once and rebuild working context from durable history`,
    scope: "none",
    parse: executeNoArgs("/lhc-compact"),
    homeAction: { label: SMART_COMPACT, order: 0, description: "rebuild from durable history" },
  },
  {
    name: "smart-prune",
    usage: "smart-prune [targetTokens]",
    summary: "run Smart Prune with the configured target or one positive safe-integer target",
    scope: "none",
    parse: parseSmartPrune,
    homeAction: { label: "Smart Prune", order: 1, description: "trim working context to target" },
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
    summary: `turn automatic ${SMART_COMPACT} on or off`,
    scope: "session",
    parse: parseAuto,
  },
  {
    name: "bounds",
    usage: "bounds <lower> <upper>",
    summary: `set ${SMART_COMPACT} target (lower) and trigger (upper)`,
    scope: "session",
    parse: parseBounds,
  },
  {
    name: "allocation",
    usage: "allocation",
    summary: "open the Band allocation selector",
    scope: "none",
    parse: routeNoArgs("allocation"),
    homeAction: { label: "Band allocation", order: 2, description: "Default · Balanced · Historical" },
  },
  {
    name: "details",
    usage: "details",
    summary: "retrieval, scope, precedence, and last action",
    scope: "none",
    parse: routeNoArgs("details"),
  },
  {
    name: "help",
    usage: "help",
    summary: "open the Help screen",
    scope: "none",
    parse: routeNoArgs("help"),
    homeAction: { label: "Help", order: 3, description: "commands and keys" },
  },
  {
    name: "introduction",
    usage: "introduction",
    summary: "open the Introduction screen",
    scope: "none",
    parse: routeNoArgs("introduction"),
    homeAction: { label: "Introduction", order: 4, description: "how context is managed" },
  },
];

const COMMANDS_BY_NAME = new Map(PANEL_COMMANDS.map((command) => [command.name, command]));

/**
 * Every displayed action label, lowercased, mapped back to its command. A
 * label that the parser rejects is a defect the user sees as
 * `unknown command: Introduction`, so labels are part of the vocabulary.
 */
const COMMANDS_BY_LABEL = new Map(
  PANEL_COMMANDS.flatMap((command) =>
    command.homeAction === undefined ? [] : [[command.homeAction.label.toLowerCase(), command] as const],
  ),
);

export type HomeAction =
  | { id: string; label: string; description: string; kind: "command"; command: string }
  | { id: string; label: string; description: string; kind: "route"; route: Exclude<PanelRoute, "home"> };

export const HOME_ACTIONS: readonly HomeAction[] = PANEL_COMMANDS.flatMap((command) => {
  const home = command.homeAction;
  if (home === undefined) return [];
  const parsed = command.parse([], command.name);
  const action: HomeAction =
    parsed.kind === "route"
      ? { id: command.name, label: home.label, description: home.description, kind: "route", route: parsed.route }
      : { id: command.name, label: home.label, description: home.description, kind: "command", command: command.name };
  return [{ order: home.order, action }];
})
  .sort((left, right) => left.order - right.order)
  .map((entry) => entry.action);

export type HomeStatusCanonicalId =
  | "provider"
  | "target"
  | "trigger"
  | "automatic"
  | "capture"
  | "allocation"
  | "low"
  | "medium"
  | "high"
  | "full";

export type HomeStatusRowId = HomeStatusCanonicalId | "notice" | "extra";

export type HomeStatusGroupId = "context" | "capture" | "allocation" | "notice";

export type StatusTone = "normal" | "notice" | "alarm";

/**
 * One Home status fact. Rows carry their group so the renderer can lay a
 * whole group out under one gutter label, and their own condensed spelling so
 * survival mode can show a single focused fact inside 20 columns.
 */
export interface HomeStatusRow {
  id: HomeStatusRowId;
  group: HomeStatusGroupId;
  /** Gutter label; only the first row of a group carries one. */
  label: string;
  segments: readonly string[];
  /** Same fact, shorter, for the compact tier's narrower value column. */
  compactSegments: readonly string[];
  /** Segments from this index on are descriptive: drawn dim, dropped first. */
  dimFrom: number;
  /** Joins this row's own segments (values that read as one phrase). */
  separator: string;
  /** Start a new value line inside the group. */
  breakBefore: boolean;
  navigable: boolean;
  tone: StatusTone;
  /** Survival-mode spelling: one self-describing fact inside ~18 columns. */
  tiny: string;
  /** Flat text form (logs, tests, non-layout consumers). */
  text: string;
}

interface HomeStatusRowSpec {
  readonly id: HomeStatusCanonicalId;
  readonly group: HomeStatusGroupId;
  readonly label?: string;
  readonly navigable: boolean;
  readonly breakBefore?: boolean;
  readonly separator?: string;
  readonly dimFrom?: number;
  readonly segments: (view: PanelViewSnapshot) => string[];
  /** Compact-tier spelling; defaults to the first full segment. */
  readonly compactSegments?: (view: PanelViewSnapshot) => string[];
  readonly tiny: (view: PanelViewSnapshot) => string;
}

function fallbackField(view: PanelViewSnapshot, field: string, text: string): string {
  return view.fallbackFields.includes(field) ? `${text} (fallback — not selected)` : text;
}

const HOME_STATUS_ROW_SPECS: readonly HomeStatusRowSpec[] = [
  {
    id: "provider",
    group: "context",
    label: "Context",
    navigable: true,
    segments: (view) => [
      view.providerContextTokens === null
        ? "not observed yet"
        : `${formatTokensShort(view.providerContextTokens)} in window`,
    ],
    compactSegments: (view) => [
      view.providerContextTokens === null ? "not observed" : formatTokensShort(view.providerContextTokens),
    ],
    tiny: (view) =>
      view.providerContextTokens === null ? "ctx not observed" : `ctx ${formatTokensShort(view.providerContextTokens)}`,
  },
  {
    id: "target",
    group: "context",
    navigable: true,
    segments: (view) => [fallbackField(view, "lowerBoundTokens", `target ${formatTokensShort(view.targetTokens)}`)],
    tiny: (view) => `target ${formatTokensShort(view.targetTokens)}`,
  },
  {
    id: "trigger",
    group: "context",
    navigable: true,
    segments: (view) => [fallbackField(view, "upperBoundTokens", `trigger ${formatTokensShort(view.triggerTokens)}`)],
    tiny: (view) => `trigger ${formatTokensShort(view.triggerTokens)}`,
  },
  {
    id: "automatic",
    group: "context",
    navigable: true,
    segments: (view) => [
      fallbackField(view, "autoCompact", `automatic ${SMART_COMPACT} ${view.autoCompact ? "on" : "off"}`),
    ],
    compactSegments: (view) => [fallbackField(view, "autoCompact", `auto ${view.autoCompact ? "on" : "off"}`)],
    tiny: (view) => `auto ${view.autoCompact ? "on" : "off"}`,
  },
  {
    id: "capture",
    group: "capture",
    label: "Capture",
    navigable: true,
    segments: (view) => [view.captureHealth],
    tiny: (view) => `capture ${view.captureHealth}`,
  },
  {
    id: "allocation",
    group: "allocation",
    label: "Allocation",
    navigable: true,
    separator: " — ",
    dimFrom: 1,
    segments: (view) => [fallbackField(view, "profile", view.allocationLabel), view.allocationDescription],
    compactSegments: (view) => [fallbackField(view, "profile", view.allocationLabel)],
    tiny: (view) => `alloc ${view.allocationLabel}`,
  },
  {
    id: "low",
    group: "allocation",
    navigable: true,
    breakBefore: true,
    segments: (view) => [`Low ${view.low}%`],
    tiny: (view) => `Low ${view.low}%`,
  },
  {
    id: "medium",
    group: "allocation",
    navigable: true,
    segments: (view) => [`Medium ${view.medium}%`],
    tiny: (view) => `Medium ${view.medium}%`,
  },
  {
    id: "high",
    group: "allocation",
    navigable: true,
    segments: (view) => [`High ${view.high}%`],
    tiny: (view) => `High ${view.high}%`,
  },
  {
    id: "full",
    group: "allocation",
    navigable: true,
    segments: (view) => [`Full ${view.full}%`],
    tiny: (view) => `Full ${view.full}%`,
  },
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

/** The status row the unified cursor is on, or null when it is on an action. */
export function focusedHomeStatusId(scrollOffset: number): HomeStatusCanonicalId | null {
  const navigable = homeNavigableStatusIds();
  if (scrollOffset < 0 || scrollOffset >= navigable.length) return null;
  return navigable[scrollOffset] ?? null;
}

export const MODAL_SCOPE_NOTE = "auto/bounds edits are session-scoped: live now, survive handoffs, lost at wrapper exit";
export const MODAL_ASCII_NOTE = "input is ASCII-only — non-ASCII bytes are ignored";
export const MODAL_CASE_NOTE = "commands are case-insensitive";
export const MODAL_UNKNOWN_PREFIX = "unknown command: ";
/** Bounded recovery: the full vocabulary lives in Help, where it has room. */
export const MODAL_UNKNOWN_HINT = "type help to list commands";
/** Marker for session-scoped commands in the Help table. */
export const SESSION_SCOPE_MARKER = "◦s";

export function parsePanelCommand(line: string): PanelParseResult {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "unknown", input: trimmed };
  // A displayed label typed back verbatim ("Band allocation", "Introduction")
  // resolves to the same command the label activates.
  const labelSpec = COMMANDS_BY_LABEL.get(trimmed.toLowerCase().replace(/\s+/g, " "));
  if (labelSpec !== undefined) return labelSpec.parse([], trimmed);
  const parts = trimmed.split(/\s+/);
  const name = (parts[0] ?? "").toLowerCase();
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

// ---------------------------------------------------------------------------
// Read-only screen content model
// ---------------------------------------------------------------------------

export type PanelRowKind = "pair" | "heading" | "text" | "note" | "blank";

/**
 * One line of read-only content before layout. `pair` rows are gutter-aligned
 * (dim label, value in the value column); headings and notes are dim.
 */
export interface PanelRow {
  kind: PanelRowKind;
  label?: string;
  value?: string;
  /** Draw the value dim (Help summaries read as metadata, not values). */
  dimValue?: boolean;
  /** Right-hand marker on the first line of a pair (session-scope flag). */
  marker?: string;
}

function pair(label: string, value: string, extra: Omit<PanelRow, "kind" | "label" | "value"> = {}): PanelRow {
  return { kind: "pair", label, value, ...extra };
}
function heading(value: string): PanelRow {
  return { kind: "heading", value };
}
function text(value: string): PanelRow {
  return { kind: "text", value };
}
function note(value: string): PanelRow {
  return { kind: "note", value };
}
function blank(): PanelRow {
  return { kind: "blank" };
}

export function panelRowText(row: PanelRow): string {
  if (row.kind === "blank") return "";
  if (row.kind === "pair") {
    const marker = row.marker === undefined ? "" : `  ${row.marker}`;
    return `${row.label ?? ""}  ${row.value ?? ""}${marker}`.trim();
  }
  return row.value ?? "";
}

export function helpRows(view: PanelViewSnapshot | null): PanelRow[] {
  const header =
    view === null
      ? []
      : [
          pair(
            "Active",
            [
              `target ${formatTokensShort(view.targetTokens)}`,
              `trigger ${formatTokensShort(view.triggerTokens)}`,
              view.allocationLabel,
            ].join(" · "),
          ),
          blank(),
        ];
  const commands = PANEL_COMMANDS.map((command) =>
    pair(command.usage, command.summary, {
      dimValue: true,
      ...(command.scope === "session" ? { marker: SESSION_SCOPE_MARKER } : {}),
    }),
  );
  return [
    ...header,
    ...commands,
    blank(),
    note(`${SESSION_SCOPE_MARKER} ${scopeNote("session")}`),
    note(`${MODAL_CASE_NOTE} · ${MODAL_ASCII_NOTE}`),
  ];
}

export function helpLines(view: PanelViewSnapshot | null): string[] {
  return helpRows(view).map(panelRowText);
}

export function introductionRows(view: PanelViewSnapshot | null): PanelRow[] {
  const target = view === null ? "the active target" : formatTokensShort(view.targetTokens);
  const trigger = view === null ? "the active trigger" : formatTokensShort(view.triggerTokens);
  const allocation = view === null ? "the active Band allocation" : view.allocationLabel;
  return [
    heading("Durable history"),
    text("Complete captured history remains durable."),
    text(`${SMART_COMPACT} does not delete that record.`),
    blank(),
    heading("Working context"),
    text("Recent history stays in Full and High working-context fidelity."),
    text("Older history uses Medium and Low compressed bands."),
    blank(),
    heading(SMART_COMPACT),
    text(`${SMART_COMPACT} rebuilds working context from that durable history toward ${target}.`),
    text(`Automatic ${SMART_COMPACT} triggers at ${trigger}.`),
    blank(),
    heading(`Band allocation — ${allocation}`),
    text("Low/Medium/High/Full shares set how much of each fidelity band is kept."),
  ];
}

export function introductionLines(view: PanelViewSnapshot | null): string[] {
  return introductionRows(view).map(panelRowText);
}

/**
 * The diagnostics Home no longer carries. Reachable as the typed `details`
 * command and listed in Help; deliberately not a sixth Home action.
 */
export function detailsRows(view: PanelViewSnapshot | null): PanelRow[] {
  const rows = view?.details ?? [];
  if (rows.length === 0) return [note("no session details yet")];
  return rows.map((row) => (row.label === "" ? text(row.value) : pair(row.label, row.value)));
}

export function detailsLines(view: PanelViewSnapshot | null): string[] {
  return detailsRows(view).map(panelRowText);
}

export function readonlyRows(route: ReadonlyPanelRoute, view: PanelViewSnapshot | null): PanelRow[] {
  if (route === "help") return helpRows(view);
  if (route === "details") return detailsRows(view);
  return introductionRows(view);
}

// ---------------------------------------------------------------------------
// Home status rows
// ---------------------------------------------------------------------------

function noticeRow(id: HomeStatusRowId, tone: StatusTone, value: string): HomeStatusRow {
  return {
    id,
    group: "notice",
    label: "",
    segments: [value],
    compactSegments: [value],
    dimFrom: 1,
    separator: " · ",
    breakBefore: true,
    navigable: false,
    tone,
    tiny: value,
    text: value,
  };
}

export function homeStatusRows(view: PanelViewSnapshot): HomeStatusRow[] {
  const facts = HOME_STATUS_ROW_SPECS.map((spec): HomeStatusRow => {
    const segments = spec.segments(view);
    const separator = spec.separator ?? " · ";
    return {
      id: spec.id,
      group: spec.group,
      label: spec.label ?? "",
      segments,
      compactSegments: spec.compactSegments?.(view) ?? segments.slice(0, 1),
      dimFrom: spec.dimFrom ?? segments.length,
      separator,
      breakBefore: spec.breakBefore ?? false,
      navigable: spec.navigable,
      tone: "normal",
      tiny: spec.tiny(view),
      text: `${spec.label ?? ""} ${segments.join(separator)}`.trim(),
    };
  });
  return [
    ...facts,
    ...view.alarms.map((value) => noticeRow("notice", "alarm", value)),
    ...view.degradedNotices.map((value) => noticeRow("notice", "notice", value)),
    ...view.extraStatusRows.map((value) => noticeRow("extra", "notice", value)),
  ];
}

export function homeStatusLines(view: PanelViewSnapshot): string[] {
  return homeStatusRows(view).map((row) => row.text);
}

/**
 * One-line Home summary for survival mode: the longest truthful spelling that
 * fits the width. Anything dropped here stays reachable through the cursor.
 */
export function homeSummaryLine(view: PanelViewSnapshot | null, width: number): string {
  if (view === null) return PANEL_TITLE_SHORT.slice(0, Math.max(0, width));
  const context = view.providerContextTokens === null ? "ctx ?" : formatTokensShort(view.providerContextTokens);
  const bounds = `${formatTokensShort(view.targetTokens)}/${formatTokensShort(view.triggerTokens)}`;
  const auto = view.autoCompact ? "auto on" : "auto off";
  const candidates = [
    `${context} · ${bounds} · ${auto}`,
    `${context}·${bounds}·${auto}`,
    `${context}·${bounds}`,
    context,
  ];
  return candidates.find((candidate) => candidate.length <= width) ?? context.slice(0, Math.max(0, width));
}

export function buildPanelViewSnapshot(input: {
  providerContextTokens: number | null;
  targetTokens: number;
  triggerTokens: number;
  autoCompact: boolean;
  captureHealth: string;
  profile: string;
  alarms?: readonly string[];
  degradedNotices?: readonly string[];
  fallbacks?: readonly ConfigFallback[];
  extraStatusRows?: readonly string[];
  details?: readonly DetailsRow[];
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
    alarms: input.alarms ?? [],
    degradedNotices: input.degradedNotices ?? [],
    fallbackFields: (input.fallbacks ?? []).flatMap((fallback) => (fallback.field === null ? [] : [fallback.field])),
    extraStatusRows: input.extraStatusRows ?? [],
    details: input.details ?? [],
  };
}

export function allocationIndex(id: BandAllocationId): number {
  const index = PRODUCT_PRESET_IDS.indexOf(id);
  return index < 0 ? 0 : index;
}

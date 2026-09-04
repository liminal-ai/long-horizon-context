/**
 * Single Control Panel vocabulary and content model: parser, suggestions,
 * Home rows, Help, Introduction, and Details. This module owns WHAT the panel
 * says; panel.ts owns how it is drawn.
 *
 * The panel is a CLI. Commands are lowercase kebab-case names with a leading
 * slash, and this registry is the only place they exist: the parser, the Home
 * command rows, the Help table, the autocomplete menu, and route activation
 * all read it. A command deleted here disappears from every one of those
 * surfaces at once.
 *
 * The slash is required and the name is matched exactly — no bare or
 * title-case aliases. This vocabulary has not shipped publicly, so there is no
 * compatibility obligation that would justify two interaction models; a bare
 * name gets bounded guidance instead of a silent second grammar.
 */
import { formatTokensShort } from "../commands/context-mutation.js";
import { type BandAllocationId, isBandAllocationId, PRODUCT_PRESET_IDS } from "../governor/band-allocation.js";
import { BUILTIN_CONTEXT_POLICIES } from "../governor/config.js";
import type {
  ConfigFallback,
  ContextClass,
  ContextWindowResolution,
  ContextWindowSource,
  PolicyFieldSource,
} from "../governor/types.js";
import { presentAllocation } from "./preset-presentation.js";
import { type NativeAutoCompactState, nativeAutoCompactHomeSegment } from "./terminology.js";

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

/** Where each Smart Compact policy value came from (AC-1.6 "configuration source"). */
export interface PanelPolicySources {
  target: PolicyFieldSource;
  trigger: PolicyFieldSource;
  runway: PolicyFieldSource;
}

export interface PanelViewSnapshot {
  providerContextTokens: number | null;
  targetTokens: number;
  triggerTokens: number;
  /** Minimum trigger − target runway the active policy requires. */
  minRunwayTokens: number;
  policySources: PanelPolicySources;
  /** Active context class and how it was resolved (tech-design D8). */
  contextClass: ContextClass;
  contextWindowSource: ContextWindowSource;
  contextWindowDetail: string | null;
  /** What cc-lhc did about Claude's automatic Compact for this launch; shared with `/status` and `/details`. */
  nativeAutoCompact: NativeAutoCompactState;
  captureHealth: string;
  allocationId: BandAllocationId;
  allocationLabel: string;
  allocationDescription: string;
  /** Home's shorter phrase for the same allocation (one row, not two). */
  allocationHomeDescription: string;
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

/** Help's three outcome groups, in the order Help renders them. */
export type PanelCommandGroup = "common" | "tune" | "inspect";

export const HELP_GROUPS: readonly { id: PanelCommandGroup; title: string }[] = [
  { id: "common", title: "Common tasks" },
  { id: "tune", title: "Tune this wrapper run" },
  { id: "inspect", title: "Inspect and export" },
];

export interface PanelCommandSpec {
  /** Canonical visible spelling, with the slash: the parser key. */
  name: string;
  /** Canonical spelling plus argument shape, as displayed. */
  usage: string;
  /** Canonical description of what the command reports or does. */
  summary: string;
  /** One short outcome phrase: Home command rows and the suggestion menu. */
  short: string;
  /** Help-screen sentence: what the command is for and when to reach for it. */
  helpSummary: string;
  /** Which Help group the command belongs to. */
  group: PanelCommandGroup;
  scope: PanelCommandScope;
  parse: (args: readonly string[], surface: string) => PanelParseResult;
  homeAction?: PanelHomeAction;
}

export type PanelParseResult =
  | { kind: "execute"; commandLine: string; surface: string }
  | { kind: "route"; route: Exclude<PanelRoute, "home"> }
  /** A real command name typed without its slash: guide, never execute. */
  | { kind: "needs_slash"; input: string; command: string }
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
  "usage: /smart-prune [tokens] — the approximate estimated-token target for the newest eligible tool results kept visible, a positive whole number";

function parseSmartPrune(args: readonly string[], surface: string): PanelParseResult {
  if (args.length === 0) return { kind: "execute", commandLine: "/lhc-prune", surface };
  if (args.length === 1 && isPositiveSafeIntegerToken(args[0]!)) {
    return { kind: "execute", commandLine: `/lhc-prune ${args[0]}`, surface };
  }
  return { kind: "invalid", message: `invalid /smart-prune target — ${SMART_PRUNE_SYNTAX}` };
}

/** Canonical usage strings, shared by the registry and its argument errors. */
export const BOUNDS_USAGE = "/bounds <target> <trigger>";

function parseBounds(args: readonly string[], surface: string): PanelParseResult {
  if (args.length === 2 && /^\d+$/.test(args[0]!) && /^\d+$/.test(args[1]!)) {
    return { kind: "execute", commandLine: `/lhc-bounds ${args[0]} ${args[1]}`, surface };
  }
  return { kind: "invalid", message: `usage: ${BOUNDS_USAGE} (whole numbers of tokens)` };
}

export const PANEL_COMMANDS: readonly PanelCommandSpec[] = [
  {
    name: "/status",
    usage: "/status",
    summary: "latest provider context, /smart-compact settings, and LHC health",
    short: "context, /smart-compact settings, health",
    helpSummary: "Show provider context, the target and trigger, Claude native auto-compact state, and LHC health.",
    group: "common",
    scope: "none",
    parse: executeNoArgs("/lhc-status"),
  },
  {
    name: "/smart-compact",
    usage: "/smart-compact",
    summary: "run /smart-compact once and rebuild working context from stored LHC history",
    short: "rebuild working context now",
    helpSummary: "Rebuild a smaller context now. Use before a large task or when context is near the trigger.",
    group: "common",
    scope: "none",
    parse: executeNoArgs("/lhc-compact"),
    homeAction: { label: "/smart-compact", order: 0, description: "rebuild working context now" },
  },
  {
    name: "/smart-prune",
    usage: "/smart-prune [tokens]",
    summary:
      "shorten older eligible tool results toward an approximate estimated-token target for the newest ones kept visible",
    short: "keep newest tool output near target",
    helpSummary:
      "[tokens] is the approximate estimated-token target for the newest eligible tool results kept visible; older eligible results shorten. Omit it for the default.",
    group: "common",
    scope: "none",
    parse: parseSmartPrune,
    homeAction: { label: "/smart-prune", order: 1, description: "keep newest tool output near target" },
  },
  {
    name: "/introduction",
    usage: "/introduction",
    summary: "open the Introduction screen",
    short: "how CC-LHC works",
    helpSummary: "Learn how stored history and working context fit together.",
    group: "common",
    scope: "none",
    parse: routeNoArgs("introduction"),
    homeAction: { label: "/introduction", order: 4, description: "how CC-LHC works" },
  },
  {
    name: "/allocation",
    usage: "/allocation",
    summary: "open the band allocation selector",
    short: "choose recent vs older history",
    // Opening the selector changes nothing; applying a choice is a session
    // policy edit, so the command carries session scope like /bounds.
    helpSummary:
      "Choose how context space is split between recent detail and older compressed history. Applying a choice takes effect for this wrapper run.",
    group: "tune",
    scope: "session",
    parse: routeNoArgs("allocation"),
    homeAction: { label: "/allocation", order: 2, description: "choose recent vs older history" },
  },
  {
    name: "/bounds",
    usage: BOUNDS_USAGE,
    summary: "set the /smart-compact target and the automatic trigger",
    short: "set size after /smart-compact and its trigger",
    helpSummary: "Set the size after /smart-compact and the point where it runs automatically.",
    group: "tune",
    scope: "session",
    parse: parseBounds,
  },
  {
    name: "/stats",
    usage: "/stats",
    summary: "capture lines, events, skip counts, replayed prefix, parse failures, derivations pending, and thread id",
    short: "capture counters and thread",
    helpSummary: "Show capture counters and the current LHC thread.",
    group: "inspect",
    scope: "none",
    parse: executeNoArgs("/lhc-stats"),
  },
  {
    name: "/details",
    usage: "/details",
    summary: "retrieval, scope, precedence, and last action",
    short: "active settings and last action",
    helpSummary: "Show active settings, their sources, and the last context action.",
    group: "inspect",
    scope: "none",
    parse: routeNoArgs("details"),
  },
  {
    name: "/export",
    usage: "/export",
    summary: "write canonical transcript dumps (rollout + thread view) to cwd",
    short: "write transcript files to cwd",
    helpSummary: "Write LHC transcript files to the current directory.",
    group: "inspect",
    scope: "none",
    parse: executeNoArgs("/lhc-export"),
  },
  {
    name: "/help",
    usage: "/help",
    summary: "open the Help screen",
    short: "commands and when to use them",
    helpSummary: "Show this command reference.",
    group: "inspect",
    scope: "none",
    parse: routeNoArgs("help"),
    homeAction: { label: "/help", order: 3, description: "commands and when to use them" },
  },
];

const COMMANDS_BY_NAME = new Map(PANEL_COMMANDS.map((command) => [command.name, command]));

/** Bare spellings of real commands: recognized only to say "add the slash". */
const COMMANDS_BY_BARE_NAME = new Map(PANEL_COMMANDS.map((command) => [command.name.slice(1), command] as const));

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
  | "window"
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

/**
 * The second segment of the window row: silent for an observed class, the
 * fallback reason otherwise (D8 reports every conservative fallback).
 */
function contextWindowPhrase(view: PanelViewSnapshot): string {
  if (view.contextWindowSource === "observed") return "observed";
  return view.contextWindowDetail ?? "conservative fallback";
}

function fallbackField(view: PanelViewSnapshot, field: string, text: string): string {
  return view.fallbackFields.includes(field) ? `${text} (fallback — not selected)` : text;
}

/** Operator-facing name of a policy value's source; built-in values name their window class. */
export function formatPolicySource(source: PolicyFieldSource, contextClass: ContextClass): string {
  if (source === "builtin") return `built-in ${contextClass} policy`;
  if (source === "session") return "session";
  return `${source} config`;
}

/**
 * Home spelling of a configured value: the built-in default is the norm and
 * says nothing; an explicit source is named beside the value it set.
 */
function sourcedValue(view: PanelViewSnapshot, source: PolicyFieldSource, text: string): string {
  return source === "builtin" ? text : `${text} (${formatPolicySource(source, view.contextClass)})`;
}

/**
 * The one concise notice retained when the effective context class changes
 * (TC-1.6c): old and new class plus the policy now in force. Shown on the next
 * Control Panel open; never written onto Claude's screen.
 */
/** How many finished carried items Home names before counting the rest. */
export const MAX_NAMED_PENDING_RESULTS = 3;

/**
 * Home notices for carried work that finished and has not yet been delivered
 * to the replacement (LIM-146 AC-2.7). Read-only: naming a result here is not
 * delivering it. The label is the stored sanitized one; never output or a command.
 */
export function formatPendingResultRows(
  results: readonly { label: string; outcome: string }[],
  maxNamed: number = MAX_NAMED_PENDING_RESULTS,
): string[] {
  if (results.length === 0) return [];
  const named = results
    .slice(0, maxNamed)
    .map((result) => `carried work finished: ${result.label} — ${result.outcome}`);
  const rest = results.length - named.length;
  return rest > 0 ? [...named, `${rest} more carried item(s) finished — see cc-lhc tasks status`] : named;
}

export function formatContextClassChangeNotice(change: {
  from: ContextClass;
  to: ContextClass;
  targetTokens: number;
  triggerTokens: number;
  minRunwayTokens: number;
}): string {
  return (
    `context window changed ${change.from} → ${change.to} · Smart Compact now target ${formatTokensShort(change.targetTokens)}` +
    ` · trigger ${formatTokensShort(change.triggerTokens)} · runway ${formatTokensShort(change.minRunwayTokens)} minimum`
  );
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
        : `${formatTokensShort(view.providerContextTokens)} used`,
    ],
    compactSegments: (view) => [
      view.providerContextTokens === null ? "not observed" : `${formatTokensShort(view.providerContextTokens)} used`,
    ],
    tiny: (view) =>
      view.providerContextTokens === null ? "ctx not observed" : `ctx ${formatTokensShort(view.providerContextTokens)}`,
  },
  {
    id: "target",
    group: "context",
    navigable: true,
    breakBefore: true,
    dimFrom: 1,
    segments: (view) => [
      fallbackField(
        view,
        "lowerBoundTokens",
        sourcedValue(view, view.policySources.target, `target ${formatTokensShort(view.targetTokens)}`),
      ),
      "size after /smart-compact",
    ],
    tiny: (view) => `target ${formatTokensShort(view.targetTokens)}`,
  },
  {
    id: "trigger",
    group: "context",
    navigable: true,
    breakBefore: true,
    dimFrom: 1,
    segments: (view) => [
      fallbackField(
        view,
        "upperBoundTokens",
        sourcedValue(view, view.policySources.trigger, `trigger ${formatTokensShort(view.triggerTokens)}`),
      ),
      "automatic /smart-compact point",
    ],
    tiny: (view) => `trigger ${formatTokensShort(view.triggerTokens)}`,
  },
  {
    id: "window",
    group: "context",
    navigable: true,
    breakBefore: true,
    segments: (view) => [
      `window ${view.contextClass}`,
      contextWindowPhrase(view),
      sourcedValue(view, view.policySources.runway, `runway ${formatTokensShort(view.minRunwayTokens)} minimum`),
      nativeAutoCompactHomeSegment(view.nativeAutoCompact),
    ],
    compactSegments: (view) => [`window ${view.contextClass}`],
    tiny: (view) => `window ${view.contextClass}`,
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
    separator: " · ",
    dimFrom: 1,
    segments: (view) => [fallbackField(view, "profile", view.allocationLabel), view.allocationHomeDescription],
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

export const MODAL_SCOPE_NOTE =
  "/bounds and /allocation changes are session-scoped: live now, survive handoffs, lost at wrapper exit";
export const MODAL_ASCII_NOTE = "input is ASCII-only — non-ASCII bytes are ignored";
export const MODAL_UNKNOWN_PREFIX = "unknown command: ";
/** Bounded recovery: one grammar rule and one place to read the rest. */
export const MODAL_UNKNOWN_HINT = "commands start with / · try /help";
/** Marker for session-scoped commands in the Help table. */
export const SESSION_SCOPE_MARKER = "◦s";

/**
 * Parse one Control Panel line. The leading slash is required and the name is
 * matched exactly: `/status` runs, `status` and `/Status` do not. A bare real
 * name is answered with guidance rather than a second, invisible grammar.
 */
export function parsePanelCommand(line: string): PanelParseResult {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "unknown", input: trimmed };
  const parts = trimmed.split(/\s+/);
  const name = parts[0] ?? "";
  const spec = COMMANDS_BY_NAME.get(name);
  if (spec === undefined) {
    const bare = COMMANDS_BY_BARE_NAME.get(name);
    if (bare !== undefined) return { kind: "needs_slash", input: trimmed, command: bare.name };
    return { kind: "unknown", input: trimmed };
  }
  return spec.parse(parts.slice(1), trimmed);
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/** One suggestion row: the canonical usage and its short outcome phrase. */
export interface CommandSuggestion {
  name: string;
  usage: string;
  description: string;
}

/** The command token a line starts with ("" when the line is not a command). */
export function commandToken(line: string): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) return "";
  return trimmed.split(/\s+/)[0] ?? "";
}

/**
 * Suggestions for a line, straight from the registry: case-sensitive prefix
 * match on the first token. Non-slash input never suggests anything, so the
 * menu cannot appear over ordinary typing.
 */
export function commandSuggestions(line: string): CommandSuggestion[] {
  const token = commandToken(line);
  if (token === "") return [];
  return PANEL_COMMANDS.filter((command) => command.name.startsWith(token)).map((command) => ({
    name: command.name,
    usage: command.usage,
    description: command.short,
  }));
}

/** The canonical command a line already names exactly, or null. */
export function exactCommandName(line: string): string | null {
  const token = commandToken(line);
  return token !== "" && COMMANDS_BY_NAME.has(token) ? token : null;
}

/** Replace the line's command token with a canonical name, keeping arguments. */
export function completeCommandLine(line: string, name: string): string {
  const trimmed = line.trimStart();
  const token = commandToken(line);
  if (token === "") return name;
  return `${name}${trimmed.slice(token.length)}`;
}

/** Map a Home command line to the dispatch table's /lhc-* form; null if not executable. */
export function mapModalCommand(line: string): string | null {
  const parsed = parsePanelCommand(line);
  return parsed.kind === "execute" ? parsed.commandLine : null;
}

export function scopeNote(scope: PanelCommandScope): string | null {
  if (scope === "session") {
    return "/bounds and /allocation changes survive handoffs and reset when this wrapper exits.";
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
  /**
   * Marker that belongs TO the description (session-scope flag). It is drawn
   * attached to the end of the description text, never parked at the card
   * edge or alone on a row of its own.
   */
  marker?: string;
  /**
   * Size this row's label column to its own label instead of the screen's
   * shared gutter — a one-off header should not inherit a command table's
   * column and wrap because of it.
   */
  ownGutter?: boolean;
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
    const marker = row.marker === undefined ? "" : ` ${row.marker}`;
    return `${row.label ?? ""}  ${row.value ?? ""}${marker}`.trim();
  }
  return row.value ?? "";
}

/**
 * Help teaches outcomes: what to reach for, and when. Every canonical command
 * appears exactly once, under the group it belongs to, straight from the
 * registry — there is no second list to forget to update.
 */
export function helpRows(view: PanelViewSnapshot | null): PanelRow[] {
  const rows: PanelRow[] = [
    text("Most users can keep working and let CC-LHC manage context automatically."),
    text("Use these commands when you want to check or change it."),
  ];
  if (view !== null) {
    rows.push(
      blank(),
      pair(
        "Active",
        [
          `target ${formatTokensShort(view.targetTokens)}`,
          `trigger ${formatTokensShort(view.triggerTokens)}`,
          view.allocationLabel,
        ].join(" · "),
        { ownGutter: true },
      ),
    );
  }
  for (const group of HELP_GROUPS) {
    rows.push(blank(), heading(group.title));
    for (const command of PANEL_COMMANDS.filter((entry) => entry.group === group.id)) {
      rows.push(
        pair(command.usage, command.helpSummary, {
          dimValue: true,
          ...(command.scope === "session" ? { marker: SESSION_SCOPE_MARKER } : {}),
        }),
      );
    }
  }
  rows.push(
    blank(),
    note("/smart-compact and /smart-prune change Claude's working context. They do not delete stored LHC history."),
    note(`${SESSION_SCOPE_MARKER} ${scopeNote("session")}`),
  );
  return rows;
}

export function helpLines(view: PanelViewSnapshot | null): string[] {
  return helpRows(view).map(panelRowText);
}

/**
 * First-use orientation, in the order a new reader asks: what this does, what
 * happens without them, how context is kept, and what to do. Target, trigger,
 * and allocation come from the live snapshot — when a value is not available
 * the truthful fallback wording is used instead of a default. Smart Compact is
 * always on, so there is exactly one automatic-behaviour story to tell.
 */
export function introductionRows(view: PanelViewSnapshot | null): PanelRow[] {
  const target = view === null ? "the active target" : formatTokensShort(view.targetTokens);
  const trigger = view === null ? "the active trigger" : formatTokensShort(view.triggerTokens);
  const keptHeading = view === null ? "How context is kept" : `How context is kept — ${view.allocationLabel}`;
  const automaticRows =
    view === null
      ? [
          text("CC-LHC runs /smart-compact automatically at the active trigger and rebuilds toward the target."),
          text("Use /status to see the current window, target, and trigger."),
        ]
      : [text(`Keep working normally. At ${trigger}, CC-LHC runs /smart-compact and rebuilds toward ${target}.`)];
  return [
    heading("What CC-LHC does"),
    text("CC-LHC saves your Claude Code session in durable LHC history."),
    text(
      "Claude works from a smaller context built from that history, so long-running work can continue after the original context would fill.",
    ),
    blank(),
    heading("What happens automatically"),
    ...automaticRows,
    // What survives a handoff is the stored record and a note about the work
    // that cannot report back — the old session's tracked work may have been
    // terminated, orphaned, or left in an unknown state.
    text("It continues in a replacement Claude Code session. Stored LHC history remains available."),
    text("The replacement session gets a continuity note for tracked unfinished work."),
    blank(),
    heading(keptHeading),
    text("Recent work stays in greater detail. Older work moves through Full, High, Medium, and Low fidelity bands."),
    text("/allocation controls how much context space each band receives. It does not change stored history."),
    blank(),
    heading("Start here"),
    text("1. Keep the defaults and work normally."),
    text("2. Use /status to check context size, target, and trigger."),
    text("3. Use /smart-compact before a large task or when you want a smaller working context now."),
    text("4. Use /smart-prune after tool-heavy work when you want to reduce context without replacing the session."),
    blank(),
    note("Neither command deletes stored LHC history."),
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
  const window = `window ${view.contextClass}`;
  const candidates = [
    `${context} · ${bounds} · ${window}`,
    `${context}·${bounds}·${window}`,
    `${context}·${bounds}`,
    context,
  ];
  return candidates.find((candidate) => candidate.length <= width) ?? context.slice(0, Math.max(0, width));
}

export function buildPanelViewSnapshot(input: {
  providerContextTokens: number | null;
  targetTokens: number;
  triggerTokens: number;
  contextWindow: ContextWindowResolution;
  /** Defaults to the active class's built-in runway. */
  minRunwayTokens?: number;
  /** Defaults to built-in for every field. */
  policySources?: Partial<PanelPolicySources>;
  /** Defaults to the wrapper's own posture: disabled per managed child. */
  nativeAutoCompact?: NativeAutoCompactState;
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
    minRunwayTokens:
      input.minRunwayTokens ?? BUILTIN_CONTEXT_POLICIES[input.contextWindow.contextClass].minRunwayTokens,
    policySources: {
      target: input.policySources?.target ?? "builtin",
      trigger: input.policySources?.trigger ?? "builtin",
      runway: input.policySources?.runway ?? "builtin",
    },
    contextClass: input.contextWindow.contextClass,
    contextWindowSource: input.contextWindow.source,
    contextWindowDetail: input.contextWindow.detail,
    nativeAutoCompact: input.nativeAutoCompact ?? "disabled",
    captureHealth: input.captureHealth,
    allocationId,
    allocationLabel: shown.label,
    allocationDescription: shown.description,
    allocationHomeDescription: shown.homeDescription,
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

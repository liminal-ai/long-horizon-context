import { formatTokensShort } from "../commands/context-mutation.js";
import { type BandAllocationId, isBandAllocationId, PRODUCT_PRESET_IDS } from "../governor/band-allocation.js";
import { BUILTIN_CONTEXT_POLICY } from "../governor/config.js";
import type { ConfigFallback, PolicyFieldSource } from "../governor/types.js";
import { presentAllocation } from "./preset-presentation.js";
import { type NativeAutoCompactState, nativeAutoCompactHomeSegment } from "./terminology.js";

export const PANEL_TITLE = "Long Horizon Context Control Panel";
export const PANEL_TITLE_SHORT = "Long Horizon Context";

export type PanelRoute = "home" | "help" | "introduction" | "details" | "allocation";

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

export interface DetailsRow {
  label: string;
  value: string;
}

export interface PanelPolicySources {
  target: PolicyFieldSource;
  trigger: PolicyFieldSource;
  runway: PolicyFieldSource;
}

export interface PanelViewSnapshot {
  providerContextTokens: number | null;
  targetTokens: number;
  triggerTokens: number;
  minRunwayTokens: number;
  policySources: PanelPolicySources;
  nativeAutoCompact: NativeAutoCompactState;
  captureHealth: string;
  allocationId: BandAllocationId;
  allocationLabel: string;
  allocationDescription: string;
  allocationHomeDescription: string;
  low: number;
  medium: number;
  high: number;
  full: number;
  alarms: readonly string[];
  degradedNotices: readonly string[];
  fallbackFields: readonly string[];
  extraStatusRows: readonly string[];
  details: readonly DetailsRow[];
}

export type PanelCommandScope = "none" | "session";

export interface PanelHomeAction {
  label: string;
  order: number;
  description: string;
}

export type PanelCommandGroup = "common" | "tune" | "inspect";

export const HELP_GROUPS: readonly { id: PanelCommandGroup; title: string }[] = [
  { id: "common", title: "Common tasks" },
  { id: "tune", title: "Tune this wrapper run" },
  { id: "inspect", title: "Inspect and export" },
];

export interface PanelCommandSpec {
  name: string;
  usage: string;
  summary: string;
  short: string;
  helpSummary: string;
  group: PanelCommandGroup;
  scope: PanelCommandScope;
  parse: (args: readonly string[], surface: string) => PanelParseResult;
  homeAction?: PanelHomeAction;
}

export type PanelParseResult =
  | { kind: "execute"; commandLine: string; surface: string }
  | { kind: "route"; route: Exclude<PanelRoute, "home"> }
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
  | "runway"
  | "capture"
  | "allocation"
  | "low"
  | "medium"
  | "high"
  | "full";

export type HomeStatusRowId = HomeStatusCanonicalId | "notice" | "extra";

export type HomeStatusGroupId = "context" | "capture" | "allocation" | "notice";

export type StatusTone = "normal" | "notice" | "alarm";

export interface HomeStatusRow {
  id: HomeStatusRowId;
  group: HomeStatusGroupId;
  label: string;
  segments: readonly string[];
  compactSegments: readonly string[];
  dimFrom: number;
  separator: string;
  breakBefore: boolean;
  navigable: boolean;
  tone: StatusTone;
  tiny: string;
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
  readonly compactSegments?: (view: PanelViewSnapshot) => string[];
  readonly tiny: (view: PanelViewSnapshot) => string;
}

function fallbackField(view: PanelViewSnapshot, field: string, text: string): string {
  return view.fallbackFields.includes(field) ? `${text} (fallback — not selected)` : text;
}

export function formatPolicySource(source: PolicyFieldSource): string {
  if (source === "builtin") return "built-in policy";
  if (source === "session") return "session";
  return `${source} config`;
}

function sourcedValue(source: PolicyFieldSource, text: string): string {
  return source === "builtin" ? text : `${text} (${formatPolicySource(source)})`;
}

export const MAX_NAMED_PENDING_RESULTS = 3;

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
        sourcedValue(view.policySources.target, `target ${formatTokensShort(view.targetTokens)}`),
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
        sourcedValue(view.policySources.trigger, `trigger ${formatTokensShort(view.triggerTokens)}`),
      ),
      "automatic /smart-compact point",
    ],
    tiny: (view) => `trigger ${formatTokensShort(view.triggerTokens)}`,
  },
  {
    id: "runway",
    group: "context",
    navigable: true,
    breakBefore: true,
    segments: (view) => [
      sourcedValue(view.policySources.runway, `runway ${formatTokensShort(view.minRunwayTokens)} minimum`),
      nativeAutoCompactHomeSegment(view.nativeAutoCompact),
    ],
    compactSegments: (view) => [
      sourcedValue(view.policySources.runway, `runway ${formatTokensShort(view.minRunwayTokens)}`),
    ],
    tiny: (view) => `runway ${formatTokensShort(view.minRunwayTokens)}`,
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

export function focusedHomeStatusId(scrollOffset: number): HomeStatusCanonicalId | null {
  const navigable = homeNavigableStatusIds();
  if (scrollOffset < 0 || scrollOffset >= navigable.length) return null;
  return navigable[scrollOffset] ?? null;
}

export const MODAL_SCOPE_NOTE =
  "/bounds and /allocation changes are session-scoped: live now, survive handoffs, lost at wrapper exit";
export const MODAL_ASCII_NOTE = "input is ASCII-only — non-ASCII bytes are ignored";
export const MODAL_UNKNOWN_PREFIX = "unknown command: ";
export const MODAL_UNKNOWN_HINT = "commands start with / · try /help";
export const SESSION_SCOPE_MARKER = "◦s";

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

export interface CommandSuggestion {
  name: string;
  usage: string;
  description: string;
}

export function commandToken(line: string): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) return "";
  return trimmed.split(/\s+/)[0] ?? "";
}

export function commandSuggestions(line: string): CommandSuggestion[] {
  const token = commandToken(line);
  if (token === "") return [];
  return PANEL_COMMANDS.filter((command) => command.name.startsWith(token)).map((command) => ({
    name: command.name,
    usage: command.usage,
    description: command.short,
  }));
}

export function exactCommandName(line: string): string | null {
  const token = commandToken(line);
  return token !== "" && COMMANDS_BY_NAME.has(token) ? token : null;
}

export function completeCommandLine(line: string, name: string): string {
  const trimmed = line.trimStart();
  const token = commandToken(line);
  if (token === "") return name;
  return `${name}${trimmed.slice(token.length)}`;
}

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

export type PanelRowKind = "pair" | "heading" | "text" | "note" | "blank";

export interface PanelRow {
  kind: PanelRowKind;
  label?: string;
  value?: string;
  dimValue?: boolean;
  marker?: string;
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

export function introductionRows(view: PanelViewSnapshot | null): PanelRow[] {
  const target = view === null ? "the active target" : formatTokensShort(view.targetTokens);
  const trigger = view === null ? "the active trigger" : formatTokensShort(view.triggerTokens);
  const keptHeading = view === null ? "How context is kept" : `How context is kept — ${view.allocationLabel}`;
  const automaticRows =
    view === null
      ? [
          text("CC-LHC runs /smart-compact automatically at the active trigger and rebuilds toward the target."),
          text("Use /status to see the current target and trigger."),
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

export function homeSummaryLine(view: PanelViewSnapshot | null, width: number): string {
  if (view === null) return PANEL_TITLE_SHORT.slice(0, Math.max(0, width));
  const context = view.providerContextTokens === null ? "ctx ?" : formatTokensShort(view.providerContextTokens);
  const bounds = `${formatTokensShort(view.targetTokens)}/${formatTokensShort(view.triggerTokens)}`;
  const candidates = [`${context} · ${bounds}`, `${context}·${bounds}`, context];
  return candidates.find((candidate) => candidate.length <= width) ?? context.slice(0, Math.max(0, width));
}

export function buildPanelViewSnapshot(input: {
  providerContextTokens: number | null;
  targetTokens: number;
  triggerTokens: number;
  minRunwayTokens?: number;
  policySources?: Partial<PanelPolicySources>;
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
    minRunwayTokens: input.minRunwayTokens ?? BUILTIN_CONTEXT_POLICY.minRunwayTokens,
    policySources: {
      target: input.policySources?.target ?? "builtin",
      trigger: input.policySources?.trigger ?? "builtin",
      runway: input.policySources?.runway ?? "builtin",
    },
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

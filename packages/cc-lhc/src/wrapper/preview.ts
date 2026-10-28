import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContinuityStore, openContinuityStore } from "../continuity/store.js";
import { BUILTIN_CONTEXT_POLICY } from "../governor/config.js";
import {
  type ActionableCondition,
  firstLoadMarkerPath,
  formatLeaderKey,
  markShown,
  ONBOARDING_VERSION,
  planStartupPanel,
  readShownVersion,
} from "./first-load.js";
import {
  clampPanelViewport,
  createInputState,
  DEFAULT_LEADER_BYTE,
  type InputState,
  processInputChunk,
  resolveBareEsc,
  resolveLeaderByte,
} from "./modal.js";
import { type PanelStyle, panelStyleFromEnv, panelTier, renderPanel } from "./panel.js";
import { buildPanelViewSnapshot, formatPendingResultRows, type PanelViewSnapshot } from "./panel-commands.js";
import { formatRetrievalStateRow, toPanelWording } from "./panel-wording.js";
import { formatReplacementNonviabilityAlarm, formatSurvivalRelaunchNotice } from "./replacement-nonviability.js";
import { type NativeAutoCompactState, nativeCompactAdvisoryLine } from "./terminology.js";
import { TYPED_AHEAD_RESEND_NOTICE } from "./typed-ahead-input.js";

export const PREVIEW_FIXTURE_NAMES = [
  "normal-first-launch",
  "native-auto-compact-conflict",
  "capture-database-unsafe",
  "replacement-failure",
  "possible-undelivered-input",
  "unmanageable-async-identity",
  "multiple-prioritized-messages",
  "no-messages",
] as const;
export type PreviewFixtureName = (typeof PREVIEW_FIXTURE_NAMES)[number];

export const PREVIEW_GEOMETRIES = {
  normal: { cols: 100, rows: 30 },
  narrow: { cols: 44, rows: 20 },
  tiny: { cols: 20, rows: 5 },
} as const;
export type PreviewGeometryName = keyof typeof PREVIEW_GEOMETRIES;
export const PREVIEW_GEOMETRY_NAMES = Object.keys(PREVIEW_GEOMETRIES) as PreviewGeometryName[];

export interface PreviewFixture {
  name: PreviewFixtureName;
  shownVersion: number | null;
  nativeAutoCompact: NativeAutoCompactState;
  alarms: readonly string[];
  extraStatusRows: readonly string[];
  retrievalState: "ready" | "opening";
  conditions: readonly ActionableCondition[];
}

const REPLACEMENT_ALARM = [
  ...formatReplacementNonviabilityAlarm({
    rebuiltSessionId: "rebuilt-2222",
    oldSessionId: "old-1111",
    nonviableSwaps: 3,
    lastReason: "attempt 1: candidate no_output",
  }),
  formatSurvivalRelaunchNotice("old-1111", true),
];

const CONDITIONS = {
  native: {
    kind: "native_auto_compact_conflict",
    lines: ["explicit --autocompact on this launch — see /details for the cause and the way back"],
  },
  unsafe: {
    kind: "unsafe_capture_or_database_state",
    lines: [
      "continuity database unavailable: file is not a database; background work is not carried across Smart Compact",
    ],
  },
  replacement: { kind: "repeated_replacement_failure", lines: REPLACEMENT_ALARM.map(toPanelWording) },
  input: { kind: "possible_undelivered_input", lines: [TYPED_AHEAD_RESEND_NOTICE] },
  identity: {
    kind: "unmanageable_async_identity",
    lines: ["carried work for thread th_preview is unreadable; nothing seeded — see the wrapper log"],
  },
} satisfies Record<string, ActionableCondition>;

const shown = ONBOARDING_VERSION;
const quiet = {
  nativeAutoCompact: "disabled" as const,
  alarms: [] as const,
  extraStatusRows: [] as const,
  retrievalState: "opening" as const,
};

export const PREVIEW_FIXTURES: Record<PreviewFixtureName, PreviewFixture> = {
  "normal-first-launch": { name: "normal-first-launch", shownVersion: null, ...quiet, conditions: [] },
  "native-auto-compact-conflict": {
    name: "native-auto-compact-conflict",
    shownVersion: shown,
    ...quiet,
    nativeAutoCompact: "passthrough",
    extraStatusRows: [nativeCompactAdvisoryLine()],
    conditions: [CONDITIONS.native],
  },
  "capture-database-unsafe": {
    name: "capture-database-unsafe",
    shownVersion: shown,
    ...quiet,
    conditions: [CONDITIONS.unsafe],
  },
  "replacement-failure": {
    name: "replacement-failure",
    shownVersion: shown,
    ...quiet,
    alarms: REPLACEMENT_ALARM.map(toPanelWording),
    conditions: [CONDITIONS.replacement],
  },
  "possible-undelivered-input": {
    name: "possible-undelivered-input",
    shownVersion: shown,
    ...quiet,
    conditions: [CONDITIONS.input],
  },
  "unmanageable-async-identity": {
    name: "unmanageable-async-identity",
    shownVersion: shown,
    ...quiet,
    conditions: [CONDITIONS.identity],
  },
  "multiple-prioritized-messages": {
    name: "multiple-prioritized-messages",
    shownVersion: null,
    ...quiet,
    nativeAutoCompact: "passthrough",
    alarms: REPLACEMENT_ALARM.map(toPanelWording),
    extraStatusRows: [nativeCompactAdvisoryLine()],
    conditions: [CONDITIONS.native, CONDITIONS.identity, CONDITIONS.replacement, CONDITIONS.unsafe, CONDITIONS.input],
  },
  "no-messages": { name: "no-messages", shownVersion: shown, ...quiet, retrievalState: "ready", conditions: [] },
};

export interface PreviewHome {
  path: string;
  store: ContinuityStore;
  dispose(): void;
}

export function createPreviewHome(): PreviewHome {
  const path = mkdtempSync(join(tmpdir(), "cc-lhc-preview-"));
  const store = openContinuityStore(join(path, "cc-lhc.sqlite"));
  return {
    path,
    store,
    dispose() {
      store.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export function previewPanelView(fixture: PreviewFixture, home: PreviewHome): PanelViewSnapshot {
  return buildPanelViewSnapshot({
    providerContextTokens: null,
    targetTokens: BUILTIN_CONTEXT_POLICY.lowerBoundTokens,
    triggerTokens: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
    nativeAutoCompact: fixture.nativeAutoCompact,
    captureHealth: "ready",
    profile: "default",
    alarms: fixture.alarms,
    extraStatusRows: [
      ...(fixture.retrievalState === "ready" ? [] : [formatRetrievalStateRow(fixture.retrievalState)]),
      ...fixture.extraStatusRows,
      ...formatPendingResultRows(home.store.listPendingResults("th_preview")),
    ],
  });
}

export interface PreviewRender {
  fixture: PreviewFixtureName;
  geometry: PreviewGeometryName;
  cols: number;
  rows: number;
  tier: ReturnType<typeof panelTier>;
  autoOpened: boolean;
  panelRows: string[];
  frame: string;
  escapeClosed: boolean;
  reopenReturned: boolean;
}

export interface PreviewOptions {
  leaderByte?: number;
  style?: PanelStyle;
}

export function renderPreview(
  fixture: PreviewFixture,
  geometry: PreviewGeometryName,
  home: PreviewHome,
  options: PreviewOptions = {},
): PreviewRender {
  const leaderByte = options.leaderByte ?? DEFAULT_LEADER_BYTE;
  const style = options.style ?? panelStyleFromEnv();
  const { cols, rows } = PREVIEW_GEOMETRIES[geometry];
  const marker = firstLoadMarkerPath(home.path);
  rmSync(marker, { force: true });
  if (fixture.shownVersion !== null) markShown(marker, fixture.shownVersion);

  const plan = planStartupPanel({
    shownVersion: readShownVersion(marker),
    version: ONBOARDING_VERSION,
    facts: {
      targetTokens: BUILTIN_CONTEXT_POLICY.lowerBoundTokens,
      triggerTokens: BUILTIN_CONTEXT_POLICY.upperBoundTokens,
      nativeAutoCompact: fixture.nativeAutoCompact,
      leaderByte,
    },
    conditions: fixture.conditions,
  });
  const panelView = previewPanelView(fixture, home);
  const draw = (state: InputState): string =>
    renderPanel(clampPanelViewport(state, cols, rows), cols, rows, undefined, style);

  const open = (from: InputState): InputState => {
    const pressed = processInputChunk(Buffer.from([leaderByte]), from);
    if (!pressed.actions.some((action) => action.kind === "enter_modal")) {
      throw new Error(`leader ${formatLeaderKey(leaderByte)} did not open the panel`);
    }
    return {
      ...pressed.state,
      panelView,
      panelRows: plan.rows,
      route: "home",
      viewport: { scrollOffset: 0, selectedIndex: -1 },
    };
  };

  const opened = open(createInputState(leaderByte));
  const frame = draw(opened);

  const escaped = processInputChunk(Buffer.from([0x1b]), opened);
  const bare = resolveBareEsc(escaped.state);
  const afterEsc = bare === null ? escaped : bare;
  const escapeClosed =
    afterEsc.state.mode === "passthrough" &&
    [...escaped.actions, ...(bare?.actions ?? [])].some((action) => action.kind === "exit_modal");

  const reopened = open(afterEsc.state);
  const reopenReturned = draw(reopened) === frame;

  return {
    fixture: fixture.name,
    geometry,
    cols,
    rows,
    tier: panelTier(cols, rows),
    autoOpened: plan.open,
    panelRows: plan.rows,
    frame,
    escapeClosed,
    reopenReturned,
  };
}

export function renderPreviewMatrix(
  options: PreviewOptions & {
    fixtures?: readonly PreviewFixtureName[];
    geometries?: readonly PreviewGeometryName[];
  } = {},
): PreviewRender[] {
  const home = createPreviewHome();
  try {
    const out: PreviewRender[] = [];
    for (const name of options.fixtures ?? PREVIEW_FIXTURE_NAMES) {
      for (const geometry of options.geometries ?? PREVIEW_GEOMETRY_NAMES) {
        out.push(renderPreview(PREVIEW_FIXTURES[name], geometry, home, options));
      }
    }
    return out;
  } finally {
    home.dispose();
  }
}

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const CURSOR_MOVE = new RegExp(`^${ESC}\\[(\\d+);(\\d+)H$`);

export function frameGrid(frame: string, cols: number, rows: number): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
  let row = 0;
  let col = 0;
  let last = 0;
  const put = (text: string): void => {
    for (const character of text) {
      if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row]![col] = character;
      col += 1;
    }
  };
  for (const match of frame.matchAll(ANSI)) {
    const at = match.index ?? 0;
    put(frame.slice(last, at));
    const move = CURSOR_MOVE.exec(match[0]);
    if (move !== null) {
      row = Number.parseInt(move[1]!, 10) - 1;
      col = Number.parseInt(move[2]!, 10) - 1;
    }
    last = at + match[0].length;
  }
  put(frame.slice(last));
  return grid.map((line) => line.join("").replace(/\s+$/, ""));
}

export function isPreviewArgv(argv: readonly string[]): boolean {
  return argv[0] === "preview";
}

export const PREVIEW_USAGE = `usage: cc-lhc preview [--fixture NAME] [--geometry normal|narrow|tiny] [--raw]
  Draws the first-load Control Panel fixtures with the production renderer in a
  disposable home. --raw prints one fixture at one geometry as the exact frame.
  fixtures: ${PREVIEW_FIXTURE_NAMES.join(", ")}`;

export function runPreviewCli(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void; env?: NodeJS.ProcessEnv },
): number {
  const env = io.env ?? process.env;
  let fixtures: readonly PreviewFixtureName[] = PREVIEW_FIXTURE_NAMES;
  let geometries: readonly PreviewGeometryName[] = PREVIEW_GEOMETRY_NAMES;
  let raw = false;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--raw") raw = true;
    else if (arg === "--fixture" || arg === "--geometry") {
      const value = rest[i + 1];
      i += 1;
      if (arg === "--fixture") {
        if (!(PREVIEW_FIXTURE_NAMES as readonly string[]).includes(value ?? "")) {
          io.stderr(`cc-lhc preview: unknown fixture ${JSON.stringify(value ?? "")}\n${PREVIEW_USAGE}\n`);
          return 2;
        }
        fixtures = [value as PreviewFixtureName];
      } else {
        if (!(PREVIEW_GEOMETRY_NAMES as readonly string[]).includes(value ?? "")) {
          io.stderr(`cc-lhc preview: unknown geometry ${JSON.stringify(value ?? "")}\n${PREVIEW_USAGE}\n`);
          return 2;
        }
        geometries = [value as PreviewGeometryName];
      }
    } else {
      io.stderr(`cc-lhc preview: unknown argument ${JSON.stringify(arg)}\n${PREVIEW_USAGE}\n`);
      return 2;
    }
  }
  if (raw && (fixtures.length !== 1 || geometries.length !== 1)) {
    io.stderr(`cc-lhc preview: --raw needs exactly one --fixture and one --geometry\n${PREVIEW_USAGE}\n`);
    return 2;
  }
  const leaderByte = resolveLeaderByte(env.CC_LHC_LEADER, (message) => io.stderr(`${message}\n`));
  const renders = renderPreviewMatrix({ fixtures, geometries, leaderByte, style: panelStyleFromEnv(env) });
  if (raw) {
    io.stdout(renders[0]!.frame);
    return 0;
  }
  for (const render of renders) {
    io.stdout(
      `## ${render.fixture} @ ${render.geometry} (${render.cols}x${render.rows}, ${render.tier}) — ` +
        `${render.autoOpened ? "opens at launch" : "on demand only"} · ` +
        `Esc ${render.escapeClosed ? "closes" : "DID NOT CLOSE"} · ` +
        `${formatLeaderKey(leaderByte)} ${render.reopenReturned ? "reopens" : "DID NOT REOPEN"}\n`,
    );
    for (const line of frameGrid(render.frame, render.cols, render.rows)) io.stdout(`${line}\n`);
    io.stdout("\n");
  }
  return 0;
}

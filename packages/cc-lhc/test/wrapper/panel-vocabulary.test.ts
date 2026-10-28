import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatCompactReceipt, formatPruneReceipt } from "../../src/commands/context-mutation.js";
import { createInputState, type InputState, processInputChunk } from "../../src/wrapper/modal.js";
import { commandProgressLabel, PANEL_PROMPT_PLACEHOLDER, renderPanel } from "../../src/wrapper/panel.js";
import {
  buildPanelViewSnapshot,
  commandSuggestions,
  detailsLines,
  HELP_GROUPS,
  HOME_ACTIONS,
  helpLines,
  helpRows,
  homeStatusLines,
  introductionLines,
  MODAL_SCOPE_NOTE,
  MODAL_UNKNOWN_HINT,
  PANEL_COMMANDS,
  parsePanelCommand,
  SESSION_SCOPE_MARKER,
} from "../../src/wrapper/panel-commands.js";
import {
  formatActiveOperation,
  formatActiveOperationRow,
  formatHandoffFailureSummary,
  formatLastActionRow,
  panelOperationName,
  toPanelWording,
} from "../../src/wrapper/panel-wording.js";
import { formatReplacementNonviabilityAlarm } from "../../src/wrapper/replacement-nonviability.js";
import { panelReceiptRows } from "../../src/wrapper/run.js";
import {
  formatAutoDeferredSummary,
  formatAutoGuardBusyDetail,
  formatAutoGuardBusyLog,
  formatAutoMutationLog,
  formatAutoMutationSummary,
  formatAutoNotRescheduledSummary,
  formatAutoSuspendedSummary,
  formatAutoThrew,
  formatCompactBlocked,
  formatCompactPreviewError,
  formatCompactSdkError,
  formatCompactViewLine,
} from "../../src/wrapper/terminology.js";
import { panelText } from "../helpers/panel-text.js";

const VIEW = buildPanelViewSnapshot({
  providerContextTokens: 84_000,
  targetTokens: 100_000,
  triggerTokens: 200_000,
  captureHealth: "ready",
  profile: "balanced",
  details: [
    { label: "Retrieval", value: "ready" },
    { label: "Last action", value: "none this wrapper session" },
  ],
});

function home_(line = ""): InputState {
  return { ...createInputState(), mode: "modal", panelView: VIEW, line };
}

function feed(state: InputState, text: string): InputState {
  return processInputChunk(Buffer.from(text, "latin1"), state).state;
}

function panelOwnedCopy(): string[] {
  return [
    ...PANEL_COMMANDS.flatMap((command) => [
      command.name,
      command.usage,
      command.short,
      command.helpSummary,
      command.summary,
    ]),
    ...homeStatusLines(VIEW),
    ...HOME_ACTIONS.flatMap((action) => [action.label, action.description]),
    ...helpLines(VIEW),
    ...introductionLines(VIEW),
    ...detailsLines(VIEW),
    ...commandSuggestions("/").flatMap((entry) => [entry.usage, entry.description]),
    PANEL_PROMPT_PLACEHOLDER,
    MODAL_UNKNOWN_HINT,
    commandProgressLabel("/smart-compact", 3),
    commandProgressLabel("/smart-prune 2500"),
    panelText(renderPanel(home_(), 100, 29)),
    panelText(renderPanel(feed(home_(), "/help\r"), 100, 29)),
    panelText(renderPanel(feed(home_(), "/introduction\r"), 100, 29)),
    panelText(renderPanel(feed(home_(), "/details\r"), 100, 29)),
  ];
}

function panelOwnedCopyWithTypedLine(): string[] {
  return [...panelOwnedCopy(), panelText(renderPanel(home_("/sm"), 100, 29))];
}

describe("panel-owned copy speaks the canonical slash vocabulary", () => {
  it("never shows the title-case operation names", () => {
    for (const text of panelOwnedCopyWithTypedLine()) {
      expect(text, `title-case Smart Compact drifted back: ${text}`).not.toContain("Smart Compact");
      expect(text, `title-case Smart Prune drifted back: ${text}`).not.toContain("Smart Prune");
      expect(text, `prose allocation label drifted back: ${text}`).not.toContain("Band allocation");
    }
  });

  it("prints commands only in their canonical form", () => {
    const canonical = new Set(PANEL_COMMANDS.map((command) => command.name));
    for (const text of panelOwnedCopy()) {
      for (const token of text.match(/(?<=^|[\s(])\/[a-zA-Z][\w-]*/g) ?? []) {
        if (token.startsWith("/lhc-")) continue;
        if (token === "/compact") continue;
        expect(canonical.has(token), `${token} is not a canonical command: ${text}`).toBe(true);
      }
    }
    for (const command of PANEL_COMMANDS) {
      expect(command.name).toMatch(/^\/[a-z][a-z-]*$/);
      expect(command.usage.startsWith(command.name), command.usage).toBe(true);
      const parsed = parsePanelCommand(command.name);
      expect(parsed.kind, command.name).not.toBe("unknown");
      expect(parsed.kind, command.name).not.toBe("needs_slash");
    }
  });

  it("keeps the two visible spellings the owner fixed", () => {
    const shown = panelOwnedCopy().join("\n");
    expect(shown).toContain("/allocation");
    expect(shown).not.toContain("/band-allocation");
    expect(shown).toContain("/bounds <target> <trigger>");
    expect(shown).not.toContain("<lower>");
    expect(shown).not.toContain("<upper>");
    expect(shown).toContain("/smart-prune [tokens]");
    expect(shown).not.toContain("[targetTokens]");
  });

  it("uses the slash spellings on the progress line", () => {
    expect(commandProgressLabel("/smart-compact", 3)).toBe("/smart-compact — rebuilding… (3s)");
    expect(commandProgressLabel("/smart-prune")).toBe("/smart-prune — rebuilding…");
  });
});

function panelProductionProjections(): Array<[string, string]> {
  const compactReceipt = formatCompactReceipt({
    viewId: "v9",
    tailTokens: 5,
    totalTokens: 9,
    bands: { smooth: { entries: 1, tokens: 4 }, detailed: { entries: 0, tokens: 0 }, brief: { entries: 0, tokens: 0 } },
  } as never);
  const pruneReceipt = formatPruneReceipt({
    previousBoundary: 3,
    newBoundary: 7,
    zoneTokensBefore: 900,
    zoneTokensAfter: 400,
    toolResultsPruned: 2,
    noOp: false,
  } as never);
  return [
    [
      "nonviability alarm",
      formatReplacementNonviabilityAlarm({
        rebuiltSessionId: "new",
        oldSessionId: "old",
        nonviableSwaps: 3,
        lastReason: "no_output",
      })
        .map(toPanelWording)
        .join("\n"),
    ],
    ["auto deferred", formatAutoDeferredSummary("command_guard_busy", formatActiveOperation("/status"))],
    ["auto not re-scheduled", formatAutoNotRescheduledSummary("r1")],
    ["auto suspended", formatAutoSuspendedSummary()],
    ["auto mutation", formatAutoMutationSummary("refused", toPanelWording(formatCompactBlocked("record damage")))],
    [
      "last action compact",
      formatLastActionRow({
        operation: "auto_compact",
        origin: "auto",
        ago: "3s ago",
        triggerTokens: "6.0k",
        viewTokens: "9",
      }),
    ],
    [
      "last action prune",
      formatLastActionRow({ operation: "prune", origin: "manual", ago: "1m ago", zoneBefore: "900", zoneAfter: "400" }),
    ],
    ["active operation auto", formatActiveOperationRow("auto-compact")],
    ["active operation manual", formatActiveOperationRow("/smart-prune 2500")],
    ["operation detail row", formatActiveOperation("auto-compact")],
    [
      "auto deferred on busy guard",
      formatAutoDeferredSummary("command_guard_busy", formatActiveOperation("auto-compact")),
    ],
    ["handoff cancelled", formatHandoffFailureSummary("auto_compact", "cancelled", "operator declined")],
    ["handoff nonviable", formatHandoffFailureSummary("prune", "nonviable", "no_output")],
    ["compact receipt", panelReceiptRows([compactReceipt]).join("\n")],
    ["prune receipt", panelReceiptRows([pruneReceipt]).join("\n")],
    ["prune error", panelReceiptRows(["prune error: prune broke"]).join("\n")],
    ["compact preview error", panelReceiptRows([formatCompactPreviewError("record damage")]).join("\n")],
    ["compact blocked", panelReceiptRows([formatCompactBlocked("record damage")]).join("\n")],
    ["compact sdk error", panelReceiptRows([formatCompactSdkError("EIO")]).join("\n")],
    ["compact view line", panelReceiptRows([formatCompactViewLine("v1", 5, 9)]).join("\n")],
  ];
}

describe("runtime projections reach the panel in slash form", () => {
  it("never sends a title-case or bare operation label to a panel surface", () => {
    for (const [name, text] of panelProductionProjections()) {
      expect(text, `${name}: title-case product name reached the panel`).not.toContain("Smart Compact");
      expect(text, `${name}: title-case product name reached the panel`).not.toContain("Smart Prune");
      expect(text, `${name}: internal guard label reached the panel`).not.toContain("auto-compact");
      expect(text, `${name}: internal operation id reached the panel`).not.toContain("auto_compact");
      for (const line of text.split("\n")) {
        expect(line, `${name}: bare prune label`).not.toMatch(/^(prune|pruned)\b/);
        expect(line, `${name}: bare compact label`).not.toMatch(/^(compact|compacted)\b/);
      }
    }
  });

  it("names the operation the reader could type", () => {
    const byName = new Map(panelProductionProjections());
    expect(byName.get("nonviability alarm")).toContain("Manual /smart-compact still runs.");
    expect(byName.get("auto deferred")).toBe("/smart-compact deferred: command_guard_busy (/status)");
    expect(byName.get("auto suspended")).toBe("/smart-compact suspended: replacement incompatibility alarm");
    expect(byName.get("last action compact")).toBe("/smart-compact 3s ago (auto) · trigger 6.0k · view 9");
    expect(byName.get("last action prune")).toBe("/smart-prune 1m ago (manual) · zone 900 -> 400");
    expect(byName.get("active operation auto")).toBe("active operation: /smart-compact");
    expect(byName.get("active operation manual")).toBe("active operation: /smart-prune 2500");
    expect(byName.get("auto deferred on busy guard")).toBe(
      "/smart-compact deferred: command_guard_busy (/smart-compact)",
    );
    expect(panelOperationName("auto-compact")).toBe("/smart-compact");
    expect(byName.get("handoff cancelled")).toBe("/smart-compact cancelled: operator declined");
    expect(byName.get("handoff nonviable")).toBe("/smart-prune replacement not viable: no_output");
    expect(byName.get("compact view line")).toContain("/smart-compact view=v1");
    expect(byName.get("prune receipt")).toContain("/smart-prune boundary 3 -> 7");
    expect(byName.get("prune error")).toBe("/smart-prune error: prune broke");
  });

  it("keeps the shared alarm and the durable outcome detail in product terminology", () => {
    const raw = formatReplacementNonviabilityAlarm({
      rebuiltSessionId: "new",
      oldSessionId: "old",
      nonviableSwaps: 3,
      lastReason: "no_output",
    });
    expect(raw.join("\n")).toContain("Manual Smart Compact still runs.");
    expect(raw.join("\n")).not.toContain("/smart-compact");
    expect(raw.map(toPanelWording).join("\n")).toContain("Manual /smart-compact still runs.");
    expect(raw.map(toPanelWording).join("\n")).not.toContain("Smart Compact");

    expect(formatAutoGuardBusyDetail("auto-compact")).toBe(
      "command guard busy (auto-compact); Smart Compact not started",
    );
    expect(formatAutoDeferredSummary("command_guard_busy", formatActiveOperation("auto-compact"))).toBe(
      "/smart-compact deferred: command_guard_busy (/smart-compact)",
    );
  });

  it("leaves the wrapper log and durable records in product terminology", () => {
    expect(formatAutoMutationLog("refused", "detail")).toContain("Smart Compact");
    expect(formatAutoGuardBusyLog("/status", "r1")).toContain("Smart Compact");
    expect(formatAutoThrew("EIO")).toContain("Smart Compact");
    expect(formatCompactViewLine("v1", 5, 9)).toContain("Smart Compact");
    expect(toPanelWording(formatCompactViewLine("v1", 5, 9))).toContain("/smart-compact");
  });
});

describe("work in flight names the command, not the guard label", () => {
  it("cannot render the internal auto-compact label on Home", () => {
    const inFlight = buildPanelViewSnapshot({
      providerContextTokens: 84_000,
      targetTokens: 100_000,
      triggerTokens: 200_000,
      captureHealth: "ready",
      profile: "balanced",
      extraStatusRows: [formatActiveOperationRow("auto-compact")],
      details: [{ label: "Operation", value: formatActiveOperation("auto-compact") }],
    });
    const home = panelText(renderPanel({ ...home_(), panelView: inFlight }, 100, 29));
    expect(home).toContain("active operation: /smart-compact");
    expect(home, "the guard label reached Home").not.toMatch(/(?<!native )auto-compact/);
    expect(homeStatusLines(inFlight).join("\n")).not.toMatch(/(?<!native )auto-compact/);

    const details = panelText(renderPanel({ ...home_(), panelView: inFlight, route: "details" }, 100, 29));
    expect(details).toContain("Operation /smart-compact");
    expect(details).not.toContain("auto-compact");
  });
});

describe("the standing alarm on Home", () => {
  it("renders the projected alarm, never the shared raw wording", () => {
    const raw = formatReplacementNonviabilityAlarm({
      rebuiltSessionId: "new",
      oldSessionId: "old",
      nonviableSwaps: 3,
      lastReason: "no_output",
    });
    const alarmed = buildPanelViewSnapshot({
      providerContextTokens: 84_000,
      targetTokens: 100_000,
      triggerTokens: 200_000,
      captureHealth: "ready",
      profile: "balanced",
      alarms: raw.map(toPanelWording),
    });
    const drawn = panelText(renderPanel({ ...home_(), panelView: alarmed }, 100, 34));
    expect(drawn).toContain("Manual /smart-compact still runs.");
    expect(drawn, "the shared raw wording reached Home").not.toContain("Smart Compact");
    expect(homeStatusLines(alarmed).join("\n")).not.toContain("Smart Compact");
  });
});

describe("session scope is declared truthfully", () => {
  it("marks exactly the commands whose changes outlive the child but not the wrapper", () => {
    const sessionScoped = PANEL_COMMANDS.filter((command) => command.scope === "session").map(
      (command) => command.name,
    );
    expect(sessionScoped.sort()).toEqual(["/allocation", "/bounds"]);

    const note = helpLines(VIEW).find((line) => line.startsWith(SESSION_SCOPE_MARKER)) ?? "";
    expect(note).toContain("survive handoffs and reset when this wrapper exits");
    for (const name of sessionScoped) expect(note, `${name} missing from the scope note`).toContain(name);
    for (const command of PANEL_COMMANDS) {
      const row = helpRows(VIEW).find((entry) => entry.kind === "pair" && entry.label === command.usage);
      const marked = row?.marker === SESSION_SCOPE_MARKER;
      expect(marked, `${command.name} scope marker disagrees with its metadata`).toBe(command.scope === "session");
    }
    for (const oneShot of ["/status", "/stats", "/smart-compact", "/smart-prune", "/export", "/details", "/help"]) {
      const command = PANEL_COMMANDS.find((entry) => entry.name === oneShot)!;
      expect(command.scope, oneShot).toBe("none");
    }
  });

  it("says what /allocation actually mutates, and where that is recorded", () => {
    const allocation = PANEL_COMMANDS.find((command) => command.name === "/allocation")!;
    expect(allocation.helpSummary).toContain("Applying a choice takes effect for this wrapper run.");
    expect(MODAL_SCOPE_NOTE).toContain("/bounds");
    expect(MODAL_SCOPE_NOTE).not.toContain("/auto");
    expect(MODAL_SCOPE_NOTE).toContain("/bounds");
    expect(MODAL_SCOPE_NOTE).toContain("/allocation");
    expect(MODAL_SCOPE_NOTE).toContain("session-scoped");
  });
});

describe("the Introduction does not overstate the handoff contract", () => {
  it("promises stored history, and a continuity note for work that cannot report back", () => {
    const lines = introductionLines(VIEW).join("\n");
    expect(lines).toContain("It continues in a replacement Claude Code session. Stored LHC history remains available.");
    expect(lines).toContain("The replacement session gets a continuity note for tracked unfinished work.");

    expect(lines).not.toContain("tracked unfinished work remain available");
    expect(lines).not.toContain("tracked unfinished work remains available");
    expect(lines).not.toMatch(/unfinished work[^.]*\b(remain|remains|are|is|stay|stays)\b[^.]*available/i);
    expect(lines).not.toMatch(/work (continues|keeps running) in the replacement/i);
  });
});

describe("run.ts routes every panel-bound string through the wording seam", () => {
  it("keeps each panel projection call site in place", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/wrapper/run.ts"), "utf8");
    for (const [seam, sites] of [
      ["formatActiveOperation(inFlight.label)", 1],
      ["formatActiveOperationRow(", 1],
      ['formatAutoDeferredSummary("command_guard_busy", formatActiveOperation(busyLabel))', 1],
      ["formatLastActionRow(", 1],
      ["formatHandoffFailureSummary(", 1],
      ["panelReceiptRows(", 4],
      ["standingNonviabilityAlarm.map(toPanelWording)", 2],
      ["toPanelWording(outcome.messages", 1],
    ] as const) {
      const found = source.split(seam).length - 1;
      expect(found, `run.ts projects through ${seam} at ${found} call sites, expected ${sites}`).toBe(sites);
    }
  });
});

describe("one registry drives parser, Home, Help, and autocomplete", () => {
  it("every registry command reaches every surface it belongs on", () => {
    const help = helpLines(VIEW).join("\n");
    const suggestions = commandSuggestions("/").map((entry) => entry.name);
    for (const command of PANEL_COMMANDS) {
      expect(help, `Help omitted ${command.name}`).toContain(command.usage);
      expect(suggestions, `autocomplete omitted ${command.name}`).toContain(command.name);
      const probe = command.name === "/bounds" ? "/bounds 1 2" : command.name;
      expect(parsePanelCommand(probe).kind, command.name).not.toBe("unknown");
    }
    const homeRows = PANEL_COMMANDS.flatMap((command) =>
      command.homeAction === undefined ? [] : [{ order: command.homeAction.order, name: command.name }],
    ).sort((left, right) => left.order - right.order);
    expect(HOME_ACTIONS.map((action) => action.label)).toEqual(homeRows.map((entry) => entry.name));
    const grouped = HELP_GROUPS.flatMap((group) =>
      PANEL_COMMANDS.filter((command) => command.group === group.id).map((command) => command.name),
    );
    expect(grouped.sort()).toEqual(PANEL_COMMANDS.map((command) => command.name).sort());
  });

  it("a command removed from the registry disappears from all four surfaces at once", () => {
    const mutated = PANEL_COMMANDS.filter((command) => command.name !== "/export");
    const helpFromMutated = mutated.map((command) => command.usage).join("\n");
    const suggestionsFromMutated = mutated.filter((command) => command.name.startsWith("/e"));
    expect(helpFromMutated).not.toContain("/export");
    expect(suggestionsFromMutated).toHaveLength(0);
    expect(helpLines(VIEW).join("\n")).toContain("/export");
    expect(commandSuggestions("/e").map((entry) => entry.name)).toEqual(["/export"]);
    expect(parsePanelCommand("/export").kind).toBe("execute");
    expect(HOME_ACTIONS.some((action) => action.label === "/export")).toBe(false);
    expect(PANEL_COMMANDS.filter((command) => command.name === "/export")).toHaveLength(1);
  });
});

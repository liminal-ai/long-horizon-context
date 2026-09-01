/**
 * The Control Panel's own vocabulary audit.
 *
 * The panel is a CLI: everything it prints as a command must be a canonical
 * slash command from the one registry, and the title-case product spellings
 * must not drift back onto these screens, their confirmations, their progress
 * lines, or their receipts. This test is the guard that makes that structural
 * rather than a habit.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatCompactReceipt, formatPruneReceipt } from "../../src/commands/context-mutation.js";
import { resolveContextWindow } from "../../src/governor/config.js";
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
  contextWindow: resolveContextWindow(1_000_000, null),
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

/** Every string the panel itself is responsible for putting on screen. */
function panelOwnedCopy(): string[] {
  return [
    // The registry's own copy fields, rendered or not: dead copy is where
    // title-case labels come back from.
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

/** What the panel prints of its own accord, plus what the user typed. */
function panelOwnedCopyWithTypedLine(): string[] {
  return [...panelOwnedCopy(), panelText(renderPanel(home_("/sm"), 100, 29))];
}

describe("panel-owned copy speaks the canonical slash vocabulary", () => {
  it("never shows the title-case operation names", () => {
    // Includes a screen with a half-typed command, where the menu is open.
    for (const text of panelOwnedCopyWithTypedLine()) {
      expect(text, `title-case Smart Compact drifted back: ${text}`).not.toContain("Smart Compact");
      expect(text, `title-case Smart Prune drifted back: ${text}`).not.toContain("Smart Prune");
      expect(text, `prose allocation label drifted back: ${text}`).not.toContain("Band allocation");
    }
  });

  it("prints commands only in their canonical form", () => {
    const canonical = new Set(PANEL_COMMANDS.map((command) => command.name));
    // Every slash token the panel draws is a real command, spelled exactly.
    for (const text of panelOwnedCopy()) {
      // Command position only: a slash inside a word is not a command.
      for (const token of text.match(/(?<=^|[\s(])\/[a-zA-Z][\w-]*/g) ?? []) {
        if (token.startsWith("/lhc-")) continue; // internal dispatch, never displayed
        if (token === "/compact") continue; // Claude's own command, named as theirs
        expect(canonical.has(token), `${token} is not a canonical command: ${text}`).toBe(true);
      }
    }
    // And each canonical spelling is exactly what the parser accepts.
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

/**
 * Strings the WRAPPER builds at runtime and hands to the panel: standing
 * alarms, automatic last-attempt notices, the Details last-action row, settled
 * receipts, and handoff failures. These are the projections a fixture-only
 * audit misses.
 */
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
    // Standing alarm: the formatter's array is shared raw text, so run.ts
    // projects it on the way to Home notices and pending panel notices.
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
    // Automatic last-attempt notices on Home.
    ["auto deferred", formatAutoDeferredSummary("command_guard_busy", formatActiveOperation("/status"))],
    ["auto not re-scheduled", formatAutoNotRescheduledSummary("r1")],
    ["auto suspended", formatAutoSuspendedSummary()],
    // run.ts projects the raw mutation detail before it becomes a Home notice.
    ["auto mutation", formatAutoMutationSummary("refused", toPanelWording(formatCompactBlocked("record damage")))],
    // Details last-action row.
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
    // Work in flight: the guard's internal label, as Home and Details show it.
    ["active operation auto", formatActiveOperationRow("auto-compact")],
    ["active operation manual", formatActiveOperationRow("/smart-prune 2500")],
    ["operation detail row", formatActiveOperation("auto-compact")],
    [
      "auto deferred on busy guard",
      formatAutoDeferredSummary("command_guard_busy", formatActiveOperation("auto-compact")),
    ],
    // Handoff failures.
    ["handoff cancelled", formatHandoffFailureSummary("auto_compact", "cancelled", "operator declined")],
    ["handoff nonviable", formatHandoffFailureSummary("prune", "nonviable", "no_output")],
    // Settled receipts, exactly as run.ts projects them onto the panel.
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
      // Bare operation labels at the head of a line are command names.
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
    // The alarm array is written to the wrapper log, the terminal line, and a
    // governor refusal log as-is: those readers keep the product name.
    const raw = formatReplacementNonviabilityAlarm({
      rebuiltSessionId: "new",
      oldSessionId: "old",
      nonviableSwaps: 3,
      lastReason: "no_output",
    });
    expect(raw.join("\n")).toContain("Manual Smart Compact still runs.");
    expect(raw.join("\n")).not.toContain("/smart-compact");
    // The panel sees the same alarm through the projection run.ts applies.
    expect(raw.map(toPanelWording).join("\n")).toContain("Manual /smart-compact still runs.");
    expect(raw.map(toPanelWording).join("\n")).not.toContain("Smart Compact");

    // The busy-guard detail is durable governor outcome text, not panel copy:
    // it keeps the product name and the internal label.
    expect(formatAutoGuardBusyDetail("auto-compact")).toBe(
      "command guard busy (auto-compact); Smart Compact not started",
    );
    // Home's notice for the same event names the command instead.
    expect(formatAutoDeferredSummary("command_guard_busy", formatActiveOperation("auto-compact"))).toBe(
      "/smart-compact deferred: command_guard_busy (/smart-compact)",
    );
  });

  it("leaves the wrapper log and durable records in product terminology", () => {
    // The log-side formatters beside the panel ones keep the product name, so
    // this pass changed panel wording without rewriting log semantics.
    expect(formatAutoMutationLog("refused", "detail")).toContain("Smart Compact");
    expect(formatAutoGuardBusyLog("/status", "r1")).toContain("Smart Compact");
    expect(formatAutoThrew("EIO")).toContain("Smart Compact");
    // And the raw mutation messages are untouched until the panel seam.
    expect(formatCompactViewLine("v1", 5, 9)).toContain("Smart Compact");
    expect(toPanelWording(formatCompactViewLine("v1", 5, 9))).toContain("/smart-compact");
  });
});

describe("work in flight names the command, not the guard label", () => {
  it("cannot render the internal auto-compact label on Home", () => {
    // Exactly the row run.ts pushes while the automatic operation holds the
    // command guard.
    const inFlight = buildPanelViewSnapshot({
      providerContextTokens: 84_000,
      targetTokens: 100_000,
      triggerTokens: 200_000,
      contextWindow: resolveContextWindow(1_000_000, null),
      captureHealth: "ready",
      profile: "balanced",
      extraStatusRows: [formatActiveOperationRow("auto-compact")],
      details: [{ label: "Operation", value: formatActiveOperation("auto-compact") }],
    });
    const home = panelText(renderPanel({ ...home_(), panelView: inFlight }, 100, 29));
    expect(home).toContain("active operation: /smart-compact");
    // The window row legitimately names "Claude native auto-compact"; the bare guard label never appears.
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
    // Exactly what run.ts hands the snapshot for Home.
    const alarmed = buildPanelViewSnapshot({
      providerContextTokens: 84_000,
      targetTokens: 100_000,
      triggerTokens: 200_000,
      contextWindow: resolveContextWindow(1_000_000, null),
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
    // /allocation opens a selector, and applying a choice edits session policy
    // the same way /auto and /bounds do. Anything that can change the run must
    // carry the scope, or the note under Help is a lie.
    const sessionScoped = PANEL_COMMANDS.filter((command) => command.scope === "session").map(
      (command) => command.name,
    );
    expect(sessionScoped.sort()).toEqual(["/allocation", "/bounds"]);

    // The note names exactly those commands, and each one carries the marker.
    const note = helpLines(VIEW).find((line) => line.startsWith(SESSION_SCOPE_MARKER)) ?? "";
    expect(note).toContain("survive handoffs and reset when this wrapper exits");
    for (const name of sessionScoped) expect(note, `${name} missing from the scope note`).toContain(name);
    for (const command of PANEL_COMMANDS) {
      const row = helpRows(VIEW).find((entry) => entry.kind === "pair" && entry.label === command.usage);
      const marked = row?.marker === SESSION_SCOPE_MARKER;
      expect(marked, `${command.name} scope marker disagrees with its metadata`).toBe(command.scope === "session");
    }
    // One-shot operations stay unmarked.
    for (const oneShot of ["/status", "/stats", "/smart-compact", "/smart-prune", "/export", "/details", "/help"]) {
      const command = PANEL_COMMANDS.find((entry) => entry.name === oneShot)!;
      expect(command.scope, oneShot).toBe("none");
    }
  });

  it("says what /allocation actually mutates, and where that is recorded", () => {
    const allocation = PANEL_COMMANDS.find((command) => command.name === "/allocation")!;
    // Opening the selector is not the mutation; applying a choice is.
    expect(allocation.helpSummary).toContain("Applying a choice takes effect for this wrapper run.");
    // Details reports the same scope for all three session commands.
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

    // The old session's tracked work can be terminated, orphaned, or unknown:
    // the panel must never say that work itself survives the replacement.
    expect(lines).not.toContain("tracked unfinished work remain available");
    expect(lines).not.toContain("tracked unfinished work remains available");
    expect(lines).not.toMatch(/unfinished work[^.]*\b(remain|remains|are|is|stay|stays)\b[^.]*available/i);
    expect(lines).not.toMatch(/work (continues|keeps running) in the replacement/i);
  });
});

describe("run.ts routes every panel-bound string through the wording seam", () => {
  it("keeps each panel projection call site in place", () => {
    // The repo's terminology audit guards formatter USE the same way. These
    // are the seams that turn a runtime label into panel copy; deleting one
    // is how a bare or title-case label reaches the screen again.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/wrapper/run.ts"), "utf8");
    // [seam, how many call sites must use it]
    for (const [seam, sites] of [
      // Home notice + Details row for work in flight.
      ["formatActiveOperation(inFlight.label)", 1],
      ["formatActiveOperationRow(", 1],
      // Home notice when the automatic path finds the guard busy.
      ['formatAutoDeferredSummary("command_guard_busy", formatActiveOperation(busyLabel))', 1],
      // Details last action, handoff failure notice, settled receipts.
      ["formatLastActionRow(", 1],
      ["formatHandoffFailureSummary(", 1],
      ["panelReceiptRows(", 4], // its definition plus the three panel sinks
      // Standing alarm: BOTH panel sinks — Home rows and the notices a
      // reopened panel replays. The log, terminal line, and governor refusal
      // log read the same array raw.
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
    // Home shows the subset marked as command rows, in their declared order.
    const homeRows = PANEL_COMMANDS.flatMap((command) =>
      command.homeAction === undefined ? [] : [{ order: command.homeAction.order, name: command.name }],
    ).sort((left, right) => left.order - right.order);
    expect(HOME_ACTIONS.map((action) => action.label)).toEqual(homeRows.map((entry) => entry.name));
    // Help groups partition the registry: every command in exactly one group.
    const grouped = HELP_GROUPS.flatMap((group) =>
      PANEL_COMMANDS.filter((command) => command.group === group.id).map((command) => command.name),
    );
    expect(grouped.sort()).toEqual(PANEL_COMMANDS.map((command) => command.name).sort());
  });

  it("a command removed from the registry disappears from all four surfaces at once", () => {
    // The mutation: drop /export from the registry the surfaces read.
    const mutated = PANEL_COMMANDS.filter((command) => command.name !== "/export");
    const helpFromMutated = mutated.map((command) => command.usage).join("\n");
    const suggestionsFromMutated = mutated.filter((command) => command.name.startsWith("/e"));
    expect(helpFromMutated).not.toContain("/export");
    expect(suggestionsFromMutated).toHaveLength(0);
    // …and the live registry still owns all four, proving the surfaces read it
    // rather than keeping private copies.
    expect(helpLines(VIEW).join("\n")).toContain("/export");
    expect(commandSuggestions("/e").map((entry) => entry.name)).toEqual(["/export"]);
    expect(parsePanelCommand("/export").kind).toBe("execute");
    expect(HOME_ACTIONS.some((action) => action.label === "/export")).toBe(false);
    expect(PANEL_COMMANDS.filter((command) => command.name === "/export")).toHaveLength(1);
  });
});

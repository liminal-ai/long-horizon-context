/**
 * TC-3.3a — Product terminology audit.
 *
 * CC-LHC behavior is Smart Compact. Claude's built-in behavior is Claude native
 * Compact. Bare "Compact" (capital C) is allowed only inside literal interfaces
 * such as `/compact`. After masking those literals, legacy lowercase product
 * phrases are also rejected.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatDurableReceipt } from "../../src/commands/context-mutation.js";
import { formatContinuityNote } from "../../src/commands/continuity-note.js";
import { dispatchLhcCommand } from "../../src/commands/dispatch.js";
import { resolveContextWindow } from "../../src/governor/config.js";
import { CC_LHC_HELP } from "../../src/help.js";
import type { OpenAsyncWork } from "../../src/observation/async-work.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { formatHandoffResult } from "../../src/wrapper/handoff.js";
import { NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY } from "../../src/wrapper/native-auto-compact.js";
import { buildPanelViewSnapshot, homeStatusLines, PANEL_COMMANDS } from "../../src/wrapper/panel-commands.js";
import {
  formatReplacementNonviabilityAlarm,
  formatSurvivalRelaunchNotice,
} from "../../src/wrapper/replacement-nonviability.js";
import {
  CLAUDE_NATIVE_AUTO_COMPACT,
  CLAUDE_NATIVE_COMPACT,
  formatAutoDeferredSummary,
  formatAutoGuardBusyDetail,
  formatAutoGuardBusyLog,
  formatAutoInMemoryReceipt,
  formatAutoMutationLog,
  formatAutoMutationSummary,
  formatAutoNotRescheduledSummary,
  formatAutoSuspendedSummary,
  formatAutoThrew,
  formatCompactBlocked,
  formatCompactPreviewError,
  formatCompactSdkError,
  formatCompactViewLine,
  formatOneShotCompactedBeforeLaunch,
  formatOneShotMissingThread,
  formatOneShotPreLaunchOutcome,
  formatOneShotPreLaunchThrew,
  formatOneShotStandDown,
  nativeAutoCompactHomeSegment,
  nativeAutoCompactStatusLine,
  nativeCompactAdvisoryDetailsRows,
  nativeCompactAdvisoryLine,
  nativeCompactAnomalyNotice,
  nativeCompactDisabledStatusLine,
  nativeCompactPassthroughStatusLine,
  SMART_COMPACT,
} from "../../src/wrapper/terminology.js";

/** The Control Panel's own spelling of the operation. */
const SMART_COMPACT_COMMAND = "/smart-compact";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const README = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
const ONBOARDING = readFileSync(join(PKG_ROOT, "../../docs/onboard/05-host-cc-lhc.md"), "utf8");
const SRC_ROOT = join(PKG_ROOT, "src");

function work(family: OpenAsyncWork["family"], description: string): OpenAsyncWork {
  return { key: family, family, description };
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function maskLiteralInterfaces(text: string): string {
  return (
    text
      .replaceAll("Smart Compact", " ")
      // Control Panel commands are literal interfaces, like /compact below.
      .replaceAll("/smart-compact", " ")
      .replaceAll("/smart-prune", " ")
      .replaceAll("Claude native Compact", " ")
      .replaceAll("/compact", " ")
      .replaceAll("DISABLE_AUTO_COMPACT", " ")
      .replaceAll("DISABLE_COMPACT", " ")
      .replaceAll("--lhc-auto-compact", " ")
      .replaceAll("--autocompact", " ")
      .replaceAll("[lhc compact:", " ")
      .replaceAll("autoCompact", " ")
      .replaceAll("auto_compact", " ")
      .replaceAll("context_compact_continue", " ")
      .replaceAll("compact-continuation", " ")
  );
}

function bareCompactHits(text: string): string[] {
  const masked = maskLiteralInterfaces(text);
  return [...masked.matchAll(/\bCompact\b/g)].map((match) => {
    const at = match.index ?? 0;
    return masked.slice(Math.max(0, at - 40), at + 48).replace(/\s+/g, " ");
  });
}

const LEGACY_PRODUCT_PHRASES: Array<{ name: string; pattern: RegExp }> = [
  { name: "automatic compact", pattern: /\bautomatic compact\b/i },
  { name: "auto compact", pattern: /\bauto compact\b/i },
  { name: "auto compact not authorized", pattern: /auto compact not authorized/i },
  { name: "auto compact deferred", pattern: /auto compact deferred/i },
  { name: "auto compact not re-scheduled", pattern: /auto compact not re-scheduled/i },
  { name: "auto compact suspended", pattern: /auto compact suspended/i },
  { name: "compacted before launch", pattern: /compact(?:ed|ing)\b[\s\S]{0,80}?\bbefore launch/i },
  { name: "own automatic compaction", pattern: /own automatic compaction/i },
  { name: "Claude's own automatic compaction", pattern: /Claude's own automatic compaction/i },
  { name: "Claude's own compaction", pattern: /Claude's own compaction/i },
  { name: "without compacting", pattern: /without compacting/i },
  { name: "manual compact", pattern: /\bmanual compact\b/i },
  { name: "operator authorized compact over", pattern: /operator authorized compact over/i },
  { name: "asking before compact kills", pattern: /asking before compact kills/i },
  { name: "pre-launch compact", pattern: /pre-launch compact/i },
  { name: "auto-compact mutation", pattern: /auto-compact mutation/i },
  { name: "auto-compact operation threw", pattern: /auto-compact operation threw/i },
  { name: "the session still compacts", pattern: /the session still compacts/i },
];

const REQUIRED_RUN_FORMATTERS = [
  "formatOneShotStandDown",
  "formatOneShotMissingThread",
  "formatOneShotCompactedBeforeLaunch",
  "formatOneShotPreLaunchOutcome",
  "formatOneShotPreLaunchThrew",
  "formatAutoDeferredSummary",
  "formatAutoNotRescheduledSummary",
  "formatAutoInMemoryReceipt",
  "formatAutoSuspendedSummary",
  "formatAutoGuardBusyDetail",
  "formatAutoGuardBusyLog",
  "formatAutoMutationLog",
  "formatAutoMutationSummary",
  "formatAutoThrew",
] as const;

const REQUIRED_MUTATION_FORMATTERS = [
  "formatCompactViewLine",
  "formatCompactPreviewError",
  "formatCompactBlocked",
  "formatCompactSdkError",
] as const;

function legacyHits(text: string): string[] {
  const masked = maskLiteralInterfaces(text);
  const hits: string[] = [];
  for (const phrase of LEGACY_PRODUCT_PHRASES) {
    if (phrase.pattern.test(masked)) hits.push(phrase.name);
  }
  return hits;
}

describe("TC-3.3a product terminology audit", () => {
  it("renders every user/agent-facing surface and permits bare Compact only inside literal interfaces", async () => {
    const helpCommand = await dispatchLhcCommand("/lhc-help", {
      stats: emptyCaptureStats(),
      sdk: undefined,
      threadRef: undefined,
      cwd: "/work",
      sourceRolloutPath: undefined,
      sourceSessionId: undefined,
    });
    const continuity = formatContinuityNote([work("agent", "reviewer"), work("monitor", "ci")]) ?? "";
    const receipt = formatDurableReceipt(
      "auto_compact",
      { origin: "auto", triggerContextTokens: 508_000, viewTokens: 247_000, targetTokens: 240_000 },
      [],
      continuity,
    );
    const handoffTerminated = formatHandoffResult({
      kind: "success",
      newSessionId: "new",
      evidence: { processAlive: true, sessionFileWritten: true },
      attempts: 1,
      oldChildCleanup: { kind: "terminated", pid: 1 },
      handoffId: "h",
    });
    const handoffOrphan = formatHandoffResult({
      kind: "success",
      newSessionId: "new",
      evidence: { processAlive: true, sessionFileWritten: true },
      attempts: 1,
      oldChildCleanup: { kind: "surviving_orphan", pid: 2 },
      handoffId: "h",
    });
    const handoffUnknown = formatHandoffResult({
      kind: "success",
      newSessionId: "new",
      evidence: { processAlive: true, sessionFileWritten: true },
      attempts: 1,
      oldChildCleanup: { kind: "unknown", pid: 3, detail: "probe failed" },
      handoffId: "h",
    });
    const alarm = formatReplacementNonviabilityAlarm({
      rebuiltSessionId: "new",
      oldSessionId: "old",
      nonviableSwaps: 3,
      lastReason: "no_output",
    }).join("\n");

    const surfaces: Array<[string, string]> = [
      ["cli help", CC_LHC_HELP],
      ["panel help", helpCommand.messages.join("\n")],
      ["native compact anomaly", nativeCompactAnomalyNotice("summary")],
      ["native compact override", NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY],
      ["native compact disabled status", nativeCompactDisabledStatusLine()],
      ["native compact passthrough status", nativeCompactPassthroughStatusLine()],
      ["native compact advisory", nativeCompactAdvisoryLine()],
      ["native auto-compact home off", nativeAutoCompactHomeSegment("disabled")],
      ["native auto-compact home passthrough", nativeAutoCompactHomeSegment("passthrough")],
      ["native auto-compact status off", nativeAutoCompactStatusLine("disabled")],
      ["native auto-compact status passthrough", nativeAutoCompactStatusLine("passthrough")],
      [
        "home rows",
        homeStatusLines(
          buildPanelViewSnapshot({
            providerContextTokens: 1_000,
            targetTokens: 70_000,
            triggerTokens: 140_000,
            contextWindow: resolveContextWindow(200_000, null),
            captureHealth: "ready",
            profile: "default",
          }),
        ).join("\n"),
      ],
      [
        "panel command copy",
        PANEL_COMMANDS.map((c) => `${c.summary} ${c.short ?? ""} ${c.helpSummary ?? ""}`).join("\n"),
      ],
      [
        "native compact advisory details",
        nativeCompactAdvisoryDetailsRows("--autocompact 500000")
          .map((row) => row.value)
          .join("\n"),
      ],
      ["nonviability alarm", alarm],
      ["survival relaunch true", formatSurvivalRelaunchNotice("old", true)],
      ["survival relaunch false", formatSurvivalRelaunchNotice("old", false)],
      ["continuity note", continuity],
      ["durable receipt", receipt],
      ["compact view line", formatCompactViewLine("v1", 5, 9)],
      ["compact preview error", formatCompactPreviewError("record damage")],
      ["compact blocked", formatCompactBlocked("record damage")],
      ["compact sdk error", formatCompactSdkError("record damage")],
      ["handoff terminated", handoffTerminated],
      ["handoff orphan", handoffOrphan],
      ["handoff unknown", handoffUnknown],
      ["one-shot stand-down", formatOneShotStandDown("capture is binding", "sess-1")],
      ["one-shot missing thread", formatOneShotMissingThread()],
      ["one-shot before launch", formatOneShotCompactedBeforeLaunch("old-id", "new-id")],
      ["one-shot prelaunch outcome", formatOneShotPreLaunchOutcome("rebuilt", "ok")],
      ["one-shot prelaunch threw", formatOneShotPreLaunchThrew("EIO")],
      ["auto deferred summary", formatAutoDeferredSummary("command_guard_busy", "status")],
      ["auto not rescheduled", formatAutoNotRescheduledSummary("r1")],
      ["auto in-memory receipt", formatAutoInMemoryReceipt("mem-1")],
      ["auto suspended", formatAutoSuspendedSummary()],
      ["auto guard detail", formatAutoGuardBusyDetail("status")],
      ["auto guard log", formatAutoGuardBusyLog("status", "r1")],
      ["auto mutation log", formatAutoMutationLog("refused", "no")],
      ["auto mutation summary", formatAutoMutationSummary("refused", "no")],
      ["auto threw", formatAutoThrew("EIO")],
      ["last action row", `last action: ${SMART_COMPACT} 3s ago (auto)`],
      ["public readme", README],
    ];

    const oneShotLogs = [
      formatOneShotStandDown("capture is binding", "sess-1"),
      formatOneShotMissingThread(),
      formatOneShotCompactedBeforeLaunch("old-id", "new-id"),
      formatOneShotPreLaunchOutcome("rebuilt", formatCompactViewLine("v1", 5, 9)),
      formatOneShotPreLaunchThrew("EIO"),
    ].join("\n");
    const automaticLogs = [
      formatAutoDeferredSummary("command_guard_busy", "status"),
      formatAutoNotRescheduledSummary("r1"),
      formatAutoInMemoryReceipt("mem-1"),
      formatAutoSuspendedSummary(),
      formatAutoGuardBusyDetail("status"),
      formatAutoGuardBusyLog("status", "r1"),
      formatAutoMutationLog("rebuilt", formatCompactViewLine("v1", 5, 9)),
      formatAutoMutationSummary("rebuilt", formatCompactViewLine("v1", 5, 9)),
      formatAutoThrew("EIO"),
    ].join("\n");
    surfaces.push(["one-shot production logs", oneShotLogs], ["automatic production logs", automaticLogs]);

    const productionSources: Array<[string, string]> = [
      ["run.ts", stripComments(readFileSync(join(SRC_ROOT, "wrapper/run.ts"), "utf8"))],
      ["decide.ts", stripComments(readFileSync(join(SRC_ROOT, "governor/decide.ts"), "utf8"))],
      ["panel-commands.ts", stripComments(readFileSync(join(SRC_ROOT, "wrapper/panel-commands.ts"), "utf8"))],
      ["dispatch.ts", stripComments(readFileSync(join(SRC_ROOT, "commands/dispatch.ts"), "utf8"))],
      ["terminology.ts", stripComments(readFileSync(join(SRC_ROOT, "wrapper/terminology.ts"), "utf8"))],
      [
        "replacement-nonviability.ts",
        stripComments(readFileSync(join(SRC_ROOT, "wrapper/replacement-nonviability.ts"), "utf8")),
      ],
      ["context-mutation.ts", stripComments(readFileSync(join(SRC_ROOT, "commands/context-mutation.ts"), "utf8"))],
      ["help.ts", stripComments(readFileSync(join(SRC_ROOT, "help.ts"), "utf8"))],
    ];
    surfaces.push(...productionSources);

    for (const [name, text] of surfaces) {
      const hits = bareCompactHits(text);
      expect(hits, `${name}: bare Compact ${JSON.stringify(hits)}`).toEqual([]);
      const legacy = legacyHits(text);
      expect(legacy, `${name}: legacy product phrases ${JSON.stringify(legacy)}`).toEqual([]);
    }

    const runSource = productionSources.find(([name]) => name === "run.ts")?.[1] ?? "";
    const mutationSource = productionSources.find(([name]) => name === "context-mutation.ts")?.[1] ?? "";
    for (const name of REQUIRED_RUN_FORMATTERS) {
      expect(runSource, `run.ts must render via ${name}`).toContain(name);
    }
    for (const name of REQUIRED_MUTATION_FORMATTERS) {
      expect(mutationSource, `context-mutation.ts must render via ${name}`).toContain(name);
    }

    expect(CC_LHC_HELP).toContain(SMART_COMPACT);
    // Control Panel surfaces name the COMMAND, not the product: the panel is
    // a CLI and its screens must print what the parser accepts.
    expect(helpCommand.messages.join("\n")).toContain(SMART_COMPACT_COMMAND);
    expect(helpCommand.messages.join("\n")).not.toContain(SMART_COMPACT);
    expect(nativeCompactAnomalyNotice()).toContain(CLAUDE_NATIVE_COMPACT);
    expect(NATIVE_AUTOCOMPACT_OVERRIDE_ANOMALY).toContain(CLAUDE_NATIVE_COMPACT);
    expect(nativeCompactDisabledStatusLine()).toContain("/compact");
    expect(formatSurvivalRelaunchNotice("old", true)).toContain(CLAUDE_NATIVE_COMPACT);
    expect(formatSurvivalRelaunchNotice("old", false)).toContain(CLAUDE_NATIVE_COMPACT);
    expect(formatOneShotCompactedBeforeLaunch("a", "b")).toContain(SMART_COMPACT);
    expect(formatOneShotCompactedBeforeLaunch("a", "b")).not.toMatch(/compacted\b/i);
    // Panel-facing summaries name the command; their log counterparts keep
    // the product name.
    expect(formatAutoMutationSummary("refused", "d")).toContain(SMART_COMPACT_COMMAND);
    expect(formatAutoMutationLog("refused", "d")).toContain(SMART_COMPACT);
    expect(formatCompactViewLine("v1", 1, 1)).toContain(SMART_COMPACT);
    expect(formatAutoThrew("EIO")).toContain(SMART_COMPACT);
    expect(README).toContain(SMART_COMPACT);
    expect(README).toContain(CLAUDE_NATIVE_COMPACT);
  });

  it("TC-3.4a/b: documentation names both token measures and claims no fixed relationship between them", () => {
    for (const [name, text] of [
      ["public readme", README],
      ["onboarding", ONBOARDING],
    ] as const) {
      expect(text, name).toContain("no fixed ratio or direction");
      expect(text, name).toMatch(/may differ|may\s+differ/);
      // Fixed-relationship claims: guaranteed inequality, or a percentage/direction of bias.
      expect(text, name).not.toMatch(
        /never the same number|always (?:higher|lower|larger|smaller)|(?:over|under)-?estimates? by|\d+\s*% (?:higher|lower|more|less)/i,
      );
    }
    expect(README).toContain("Provider-reported context");
    expect(README).toContain("LHC\nestimated tokens");
  });

  it("TC-3.6a/b: CC-LHC behavior is /smart-compact on the panel and Smart Compact elsewhere; Claude's own behavior is named native and distinctly", () => {
    const homeRows = homeStatusLines(
      buildPanelViewSnapshot({
        providerContextTokens: 1_000,
        targetTokens: 70_000,
        triggerTokens: 140_000,
        contextWindow: resolveContextWindow(200_000, null),
        nativeAutoCompact: "passthrough",
        captureHealth: "ready",
        profile: "default",
      }),
    ).join("\n");
    expect(homeRows).toContain("size after /smart-compact");
    expect(homeRows).toContain("automatic /smart-compact point");
    expect(homeRows).toContain(`${CLAUDE_NATIVE_AUTO_COMPACT} may run (--autocompact)`);
    // Bare lowercase "compact" standing for the product is gone from panel copy.
    const panelCopy = PANEL_COMMANDS.map((c) => `${c.summary} ${c.short ?? ""} ${c.helpSummary ?? ""}`).join("\n");
    expect(panelCopy).not.toMatch(/(?<![/-])\bcompact\b/);
    expect(homeRows).not.toMatch(/(?<![/-])\bcompact\b/);
    // Governor reasons that land in durable receipts name the products.
    const decideSource = stripComments(readFileSync(join(SRC_ROOT, "governor/decide.ts"), "utf8"));
    expect(decideSource).toContain("Smart Compact, Tool Prune, or handoff already in flight");
    expect(decideSource).toContain("capability-limited Smart Compact eligible at settled seam");
    expect(decideSource).toContain("Smart Compact only at settled boundary");
    expect(decideSource).not.toMatch(/"[^"]*\bcompact\b[^"]*"|`[^`]*\bcompact\b[^`]*`/);
    expect(nativeAutoCompactStatusLine("disabled")).toContain(CLAUDE_NATIVE_AUTO_COMPACT);
    expect(nativeAutoCompactStatusLine("passthrough")).toContain(CLAUDE_NATIVE_AUTO_COMPACT);
    expect(nativeAutoCompactStatusLine("disabled")).not.toContain("may run");
  });
});

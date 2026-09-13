/**
 * LIM-118: TC-1.1a-c, TC-3.4a. Home status and Help/status/stats contract.
 */
import { describe, expect, it } from "vitest";
import { dispatchLhcCommand, type LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { CONFIG_FALLBACK_NOTICE } from "../../src/governor/config.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { createInputState, type InputState } from "../../src/wrapper/modal.js";
import { renderPanel } from "../../src/wrapper/panel.js";
import { buildPanelViewSnapshot, helpLines, PANEL_COMMANDS, PANEL_TITLE } from "../../src/wrapper/panel-commands.js";
import { nativeCompactDisabledStatusLine } from "../../src/wrapper/terminology.js";
import { panelText } from "../helpers/panel-text.js";

function homeState(
  view = buildPanelViewSnapshot({
    providerContextTokens: 31_000,
    targetTokens: 180_000,
    triggerTokens: 360_000,
    captureHealth: "ready",
    profile: "default",
  }),
): InputState {
  return { ...createInputState(), mode: "modal", route: "home", panelView: view };
}

describe("TC-1.1a Home shows active state", () => {
  it("Home renders measured provider total, target, trigger, auto mode, capture health, and allocation", () => {
    const out = panelText(renderPanel(homeState(), 120, 40));
    expect(out).toContain(PANEL_TITLE);
    expect(out).toContain("Context 31k used");
    expect(out).toContain("target 180k");
    expect(out).toContain("trigger 360k");
    expect(out).toContain("runway 50k minimum");
    expect(out).not.toContain("window 1M");
    expect(out).toContain("Capture ready");
    expect(out).toContain("Allocation Default · favors recent detail");
    expect(out).toContain("Low 20%");
    expect(out).toContain("Medium 20%");
    expect(out).toContain("High 30%");
    expect(out).toContain("Full 30%");
    expect(out).not.toMatch(/\b100\s*%/);
  });

  it("Home carries no wrapper internals: they live on the typed details screen", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 180_000,
      triggerTokens: 360_000,
      captureHealth: "ready",
      profile: "default",
      details: [
        { label: "Retrieval", value: "ready" },
        { label: "Last action", value: "none this wrapper session" },
        { label: "Precedence", value: "builtin < user /home/u/.config/cc-lhc/config.json < session" },
      ],
    });
    const home = panelText(renderPanel(homeState(view), 120, 40));
    expect(home).not.toContain("precedence");
    expect(home).not.toContain("Precedence");
    expect(home).not.toContain("last action");
    expect(home).not.toContain("Last action");
    expect(home).not.toContain("retrieval");
    expect(home).not.toMatch(/: none/);

    const details = panelText(renderPanel({ ...homeState(view), route: "details" }, 120, 40));
    expect(details).toContain("Details");
    expect(details).toContain("Retrieval ready");
    expect(details).toContain("Last action none this wrapper session");
    expect(details).toContain("builtin < user /home/u/.config/cc-lhc/config.json < session");
  });
});

describe("TC-1.1b Home shows degraded state truthfully", () => {
  it("degraded capture/config is explicit and fallback values are not shown as selected", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 8_000,
      targetTokens: 180_000,
      triggerTokens: 360_000,
      captureHealth: "degraded",
      profile: "default",
      degradedNotices: [CONFIG_FALLBACK_NOTICE, "  user config: profile must be one of default, balanced, historical"],
      fallbacks: [
        { origin: "user config", field: "profile", detail: "profile must be one of default, balanced, historical" },
      ],
    });
    const out = panelText(renderPanel(homeState(view), 120, 40));
    expect(out).toContain("Capture degraded");
    expect(out).toContain(CONFIG_FALLBACK_NOTICE);
    expect(out).toContain("Allocation Default (fallback — not selected)");
    expect(out).not.toMatch(/Allocation Default(?! \(fallback)/);
  });
});

describe("TC-1.1c Provider context not observed", () => {
  it("absent provider measurement renders not observed yet and no estimate masquerades as measured", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: null,
      targetTokens: 180_000,
      triggerTokens: 360_000,
      captureHealth: "ready",
      profile: "balanced",
    });
    const out = panelText(renderPanel(homeState(view), 120, 40));
    expect(out).toContain("Context not observed yet");
    expect(out).not.toMatch(/Context \d/);
    expect(out).not.toMatch(/\d+k used/);
    expect(out.toLowerCase()).not.toContain("estimate");
  });
});

describe("TC-3.4a Status contract is truthful", () => {
  it("Help descriptions match actual status and stats fields exactly", async () => {
    const help = helpLines(null).join("\n");
    const statusSpec = PANEL_COMMANDS.find((command) => command.name === "/status");
    const statsSpec = PANEL_COMMANDS.find((command) => command.name === "/stats");
    expect(statusSpec?.summary).toContain("latest provider context");
    expect(statusSpec?.summary).toContain("/smart-compact settings");
    expect(statusSpec?.summary).toContain("LHC health");
    expect(statsSpec?.summary).toContain("lines");
    expect(statsSpec?.summary).toContain("events");
    expect(statsSpec?.summary).toContain("thread id");
    expect(help).toContain(statusSpec!.usage);
    expect(help).toContain(statsSpec!.usage);

    const runtime: LhcCommandRuntime = {
      stats: { ...emptyCaptureStats(), linesSeen: 3, eventsSent: 2, threadId: "th_test" },
      sdk: {
        threadView: {
          status: async () => ({
            ok: true,
            value: {
              tailTokens: 1200,
              threshold: 8000,
              compactRecommended: false,
              derivation: { pending: 1, failed: 2, blocked: 0 },
              view: null,
              visibility: { boundaryPosition: 0, zoneTokens: 400, maxTokens: 2000 },
            },
          }),
        },
      } as never,
      threadRef: { threadId: "th_test" } as never,
      cwd: "/work",
      sourceRolloutPath: undefined,
      sourceSessionId: undefined,
      statusSnapshot: {
        latestProviderContextTokens: 123_456,
        targetTokens: 180_000,
        triggerTokens: 360_000,
        nativeAutoCompact: "disabled",
      },
    };
    const status = await dispatchLhcCommand("/lhc-status", runtime);
    expect(status.messages[0]).toContain("Latest provider context: 123,456 tokens (provider-reported)");
    expect(status.messages[0]).toContain("/smart-compact: 180,000-token target · 360,000-token trigger (configured)");
    expect(status.messages[0]).toContain("LHC history since last Smart Compact: 1,200 estimated tokens");
    expect(status.messages[0]).toContain("/smart-prune: 400 estimated tokens in eligible tool results");
    expect(status.messages[0]).toContain("Derivations: 1 pending · 2 failed");
    expect(status.messages[0]).toContain("Thread: th_test");
    expect(status.messages[0]).toContain(nativeCompactDisabledStatusLine());
    // TC-3.5c: the Tool Prune argument is explained as an approximate estimated-token target.
    const pruneSpec = PANEL_COMMANDS.find((command) => command.name === "/smart-prune");
    expect(pruneSpec?.helpSummary).toContain("approximate estimated-token target");
    expect(pruneSpec?.helpSummary).toContain("newest eligible tool results kept visible");
    expect(pruneSpec?.helpSummary).toContain("older eligible results shorten");
    expect(help).toContain("approximate estimated-token target");
    const stats = await dispatchLhcCommand("/lhc-stats", runtime);
    expect(stats.messages[0]).toContain("lines=3");
    expect(stats.messages[0]).toContain("events=2");
    expect(stats.messages[0]).toContain("thread=th_test");
  });
});

describe("Home reports the built-in policy without a normal-state warning", () => {
  it("180k target, 360k trigger, 50k minimum runway, and no warning", () => {
    const out = panelText(renderPanel(homeState(), 120, 40));
    expect(out).toContain("target 180k");
    expect(out).toContain("trigger 360k");
    expect(out).toContain("runway 50k minimum");
    expect(out).not.toContain("window ");
    expect(out).not.toMatch(/WARNING|advisory|unresolved|fallback|ANOMALY|may run/i);
  });

  it("built-in values carry no source suffix; an explicit source is named beside the value it set", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 90_000,
      triggerTokens: 400_000,
      minRunwayTokens: 50_000,
      policySources: { target: "user", trigger: "builtin", runway: "builtin" },
      captureHealth: "ready",
      profile: "default",
    });
    const out = panelText(renderPanel(homeState(view), 120, 40));
    expect(out).toContain("target 90k (user config)");
    expect(out).toMatch(/trigger 400k(?! \()/);
    expect(out).toMatch(/runway 50k minimum(?! \()/);
  });

  it("Details reports family, policy values with their configuration source, and no warning in normal state", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 180_000,
      triggerTokens: 360_000,
      captureHealth: "ready",
      profile: "default",
      details: [
        { label: "Family", value: "claude-2026 (provider fallback)" },
        {
          label: "Policy",
          value:
            "target 180,000 (built-in policy) · trigger 360,000 (built-in policy) · minimum runway 50,000 (built-in policy)",
        },
        { label: "", value: nativeCompactDisabledStatusLine() },
      ],
    });
    const details = panelText(renderPanel({ ...homeState(view), route: "details" }, 120, 40));
    expect(details).toContain("Family claude-2026 (provider fallback)");
    expect(details).toContain("target 180,000 (built-in policy)");
    expect(details).toContain("trigger 360,000 (built-in policy)");
    expect(details).toContain("minimum runway 50,000 (built-in policy)");
    expect(details).not.toMatch(/WARNING|advisory|ANOMALY|may run/i);
  });

  it("carries no automatic on/off state anywhere on Home", () => {
    const out = panelText(renderPanel(homeState(), 120, 40));
    expect(out).not.toMatch(/\bauto (on|off)\b|automatic \/smart-compact (on|off)/);
  });
});

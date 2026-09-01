/**
 * LIM-118: TC-1.1a-c, TC-3.4a. Home status and Help/status/stats contract.
 */
import { describe, expect, it } from "vitest";
import { dispatchLhcCommand, type LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { CONFIG_FALLBACK_NOTICE, resolveContextWindow } from "../../src/governor/config.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { createInputState, type InputState } from "../../src/wrapper/modal.js";
import { renderPanel } from "../../src/wrapper/panel.js";
import {
  buildPanelViewSnapshot,
  formatContextClassChangeNotice,
  helpLines,
  PANEL_COMMANDS,
  PANEL_TITLE,
} from "../../src/wrapper/panel-commands.js";
import { nativeCompactDisabledStatusLine } from "../../src/wrapper/terminology.js";
import { panelText } from "../helpers/panel-text.js";

function homeState(
  view = buildPanelViewSnapshot({
    providerContextTokens: 31_000,
    targetTokens: 180_000,
    triggerTokens: 360_000,
    contextWindow: resolveContextWindow(1_000_000, null),
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
    expect(out).toContain("window 1M");
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
      contextWindow: resolveContextWindow(1_000_000, null),
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
      contextWindow: resolveContextWindow(1_000_000, null),
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
      contextWindow: resolveContextWindow(1_000_000, null),
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
        contextClass: "1M",
      },
    };
    const status = await dispatchLhcCommand("/lhc-status", runtime);
    expect(status.messages[0]).toContain("Latest provider context: 123,456 tokens (provider-reported)");
    expect(status.messages[0]).toContain(
      "/smart-compact: 180,000-token target · 360,000-token trigger (configured) · 1M window",
    );
    expect(status.messages[0]).toContain("LHC history since last Smart Compact: 1,200 estimated tokens");
    expect(status.messages[0]).toContain("/smart-prune: 400 estimated tokens in eligible tool results");
    expect(status.messages[0]).toContain("Derivations: 1 pending · 2 failed");
    expect(status.messages[0]).toContain("Thread: th_test");
    const stats = await dispatchLhcCommand("/lhc-stats", runtime);
    expect(stats.messages[0]).toContain("lines=3");
    expect(stats.messages[0]).toContain("events=2");
    expect(stats.messages[0]).toContain("thread=th_test");
  });
});

describe("TC-1.6a/b/d Home reports the active window and its policy without a normal-state warning", () => {
  function homeFor(window: Parameters<typeof resolveContextWindow>[0], model: string, target: number, trigger: number) {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: target,
      triggerTokens: trigger,
      contextWindow: resolveContextWindow(window, model),
      captureHealth: "ready",
      profile: "default",
    });
    return panelText(renderPanel(homeState(view), 120, 40));
  }

  it("200k: window 200k with 70k target, 140k trigger, 40k minimum runway, and no warning (TC-1.6a)", () => {
    const out = homeFor(200_000, "claude-haiku-4-5-20251001", 70_000, 140_000);
    expect(out).toContain("window 200k");
    expect(out).toContain("observed");
    expect(out).toContain("target 70k");
    expect(out).toContain("trigger 140k");
    expect(out).toContain("runway 40k minimum");
    expect(out).not.toMatch(/WARNING|advisory|unresolved|fallback|ANOMALY|may run/i);
  });

  it("1M: window 1M with 180k target, 360k trigger, 50k minimum runway, and no warning (TC-1.6b)", () => {
    const out = homeFor(1_000_000, "claude-opus-5", 180_000, 360_000);
    expect(out).toContain("window 1M");
    expect(out).toContain("target 180k");
    expect(out).toContain("trigger 360k");
    expect(out).toContain("runway 50k minimum");
    expect(out).not.toMatch(/WARNING|advisory|unresolved|fallback|ANOMALY|may run/i);
  });

  it("built-in values carry no source suffix; an explicit source is named beside the value it set", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 90_000,
      triggerTokens: 140_000,
      contextWindow: resolveContextWindow(200_000, "claude-haiku-4-5-20251001"),
      minRunwayTokens: 40_000,
      policySources: { target: "user", trigger: "builtin", runway: "builtin" },
      captureHealth: "ready",
      profile: "default",
    });
    const out = panelText(renderPanel(homeState(view), 120, 40));
    expect(out).toContain("target 90k (user config)");
    expect(out).toMatch(/trigger 140k(?! \()/);
    expect(out).toMatch(/runway 40k minimum(?! \()/);
  });

  it("Details reports class, policy values with their configuration source, and no warning in normal state (TC-1.6a/b/d)", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 70_000,
      triggerTokens: 140_000,
      contextWindow: resolveContextWindow(200_000, "claude-haiku-4-5-20251001"),
      captureHealth: "ready",
      profile: "default",
      details: [
        { label: "Window", value: "200k (observed 200000 claude-haiku-4-5-20251001)" },
        {
          label: "Policy",
          value:
            "target 70,000 (built-in 200k policy) · trigger 140,000 (built-in 200k policy) · minimum runway 40,000 (built-in 200k policy)",
        },
        { label: "", value: nativeCompactDisabledStatusLine() },
      ],
    });
    const details = panelText(renderPanel({ ...homeState(view), route: "details" }, 120, 40));
    expect(details).toContain("Window 200k (observed 200000 claude-haiku-4-5-20251001)");
    expect(details).toContain("target 70,000 (built-in 200k policy)");
    expect(details).toContain("trigger 140,000 (built-in 200k policy)");
    expect(details).toContain("minimum runway 40,000 (built-in 200k policy)");
    expect(details).not.toMatch(/WARNING|advisory|ANOMALY|may run/i);
  });

  it("the retained class-change notice names old and new class and the resolved policy (TC-1.6c)", () => {
    const notice = formatContextClassChangeNotice({
      from: "200k",
      to: "1M",
      targetTokens: 180_000,
      triggerTokens: 360_000,
      minRunwayTokens: 50_000,
    });
    expect(notice).toBe(
      "context window changed 200k → 1M · Smart Compact now target 180k · trigger 360k · runway 50k minimum",
    );
    expect(notice.includes("\n")).toBe(false);
    // Shown as a Home notice row on the next panel open — same path every
    // detached receipt takes; nothing is painted onto Claude's screen.
    const view = buildPanelViewSnapshot({
      providerContextTokens: 31_000,
      targetTokens: 180_000,
      triggerTokens: 360_000,
      contextWindow: resolveContextWindow(1_000_000, "claude-opus-5"),
      captureHealth: "ready",
      profile: "default",
    });
    const out = panelText(renderPanel({ ...homeState(view), panelRows: [notice] }, 120, 40));
    expect(out).toContain(notice);
  });

  it("an unsupported observed value reports the conservative fallback on the window row (TC-1.1d)", () => {
    const out = homeFor(500_000, "claude-x", 70_000, 140_000);
    expect(out).toContain("window 200k");
    expect(out).toContain("observed context window 500000 is not a supported class");
  });

  it("carries no automatic on/off state anywhere on Home", () => {
    const out = homeFor(200_000, "m", 70_000, 140_000);
    expect(out).not.toMatch(/\bauto (on|off)\b|automatic \/smart-compact (on|off)/);
  });
});

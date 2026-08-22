/**
 * LIM-118: TC-1.1a-c, TC-3.4a. Home status and Help/status/stats contract.
 */
import { describe, expect, it } from "vitest";

import { dispatchLhcCommand, type LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { CONFIG_FALLBACK_NOTICE } from "../../src/governor/config.js";
import { emptyCaptureStats } from "../../src/stats.js";
import { createInputState, type InputState } from "../../src/wrapper/modal.js";
import {
  buildPanelViewSnapshot,
  helpLines,
  PANEL_COMMANDS,
  PANEL_TITLE,
} from "../../src/wrapper/panel-commands.js";
import { renderPanel } from "../../src/wrapper/panel.js";
import { panelText } from "../helpers/panel-text.js";

function homeState(view = buildPanelViewSnapshot({
  providerContextTokens: 31_000,
  targetTokens: 180_000,
  triggerTokens: 360_000,
  autoCompact: true,
  captureHealth: "ready",
  profile: "default",
})): InputState {
  return { ...createInputState(), mode: "modal", route: "home", panelView: view };
}

describe("TC-1.1a Home shows active state", () => {
  it("Home renders measured provider total, target, trigger, auto mode, capture health, and allocation", () => {
    const out = panelText(renderPanel(homeState(), 120, 40));
    expect(out).toContain(PANEL_TITLE);
    expect(out).toContain("Context 31k used");
    expect(out).toContain("target 180k");
    expect(out).toContain("trigger 360k");
    expect(out).toContain("automatic /smart-compact on");
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
      autoCompact: true,
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
      autoCompact: true,
      captureHealth: "degraded",
      profile: "default",
      degradedNotices: [CONFIG_FALLBACK_NOTICE, "  user config: profile must be one of default, balanced, historical"],
      fallbacks: [{ origin: "user config", field: "profile", detail: "profile must be one of default, balanced, historical" }],
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
      autoCompact: true,
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
    expect(statusSpec?.summary).toContain("tail");
    expect(statusSpec?.summary).toContain("threshold");
    expect(statusSpec?.summary).toContain("zone");
    expect(statusSpec?.summary).toContain("derivation");
    expect(statusSpec?.summary).toContain("thread id");
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
    };
    const status = await dispatchLhcCommand("/lhc-status", runtime);
    expect(status.messages[0]).toContain("tail=1200");
    expect(status.messages[0]).toContain("threshold=8000");
    expect(status.messages[0]).toContain("zone=400/2000");
    expect(status.messages[0]).toContain("derivation pending=1 failed=2");
    expect(status.messages[0]).toContain("thread=th_test");
    const stats = await dispatchLhcCommand("/lhc-stats", runtime);
    expect(stats.messages[0]).toContain("lines=3");
    expect(stats.messages[0]).toContain("events=2");
    expect(stats.messages[0]).toContain("thread=th_test");
  });
});

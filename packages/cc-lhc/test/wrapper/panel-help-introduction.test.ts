/**
 * LIM-118: TC-2.1a-b, TC-2.2a-c. Help/parser bijection and Introduction copy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  createInputState,
  DEFAULT_LEADER_BYTE,
  type InputState,
  processInputChunk,
} from "../../src/wrapper/modal.js";
import {
  buildPanelViewSnapshot,
  helpLines,
  introductionLines,
  parsePanelCommand,
} from "../../src/wrapper/panel-commands.js";
import { ENTER_ALT_SCREEN, PANEL_PROMPT, renderPanel } from "../../src/wrapper/panel.js";
import { run } from "../../src/wrapper/run.js";

const LEADER = Buffer.from([DEFAULT_LEADER_BYTE]);

function feed(state: InputState, text: string): InputState {
  return processInputChunk(Buffer.from(text, "latin1"), state).state;
}

function openHome(): InputState {
  return {
    ...feed(createInputState(), LEADER.toString("latin1")),
    panelView: buildPanelViewSnapshot({
      providerContextTokens: 12_000,
      targetTokens: 50_000,
      triggerTokens: 90_000,
      autoCompact: true,
      captureHealth: "ready",
      profile: "balanced",
    }),
  };
}

describe("TC-2.1a Help matches parser behavior", () => {
  it("Help and parser vocabularies are bijective and removed spellings are absent", () => {
    const home = openHome();
    const helpState = feed(home, "help\r");
    const out = renderPanel(helpState, 120, 40);
    const helpUsages = helpLines(helpState.panelView)
      .filter(
        (line) =>
          line.includes(" — ") &&
          !line.startsWith(" ") &&
          !line.startsWith("active:") &&
          !line.startsWith("input is"),
      )
      .map((line) => line.split(" — ")[0]!);
    expect(helpUsages.length).toBeGreaterThan(0);
    for (const usage of helpUsages) {
      expect(out).toContain(usage);
      const example =
        usage === "auto on|off" ? "auto on" : usage.startsWith("bounds") ? "bounds 1000 2000" : usage.split(" ")[0]!;
      const parsed = parsePanelCommand(example);
      expect(parsed.kind === "execute" || parsed.kind === "route", usage).toBe(true);
    }
    const probes = [
      "status",
      "stats",
      "smart-compact",
      "smart-prune",
      "export",
      "auto on",
      "bounds 1 2",
      "help",
      "introduction",
      "?",
      "compact",
      "prune",
      "secret",
      "foo",
    ];
    for (const probe of probes) {
      const parsed = parsePanelCommand(probe);
      const accepted = parsed.kind === "execute" || parsed.kind === "route";
      const token = probe.split(" ")[0]!;
      if (accepted) {
        expect(out, `parser accepted ${probe} but Help omitted it`).toContain(token === "auto" ? "auto on|off" : token);
      } else if (token === "?" || token === "compact" || token === "prune" || token === "secret" || token === "foo") {
        expect(helpUsages.some((usage) => usage.split(" ")[0] === token)).toBe(false);
      }
    }
    expect(parsePanelCommand("?").kind).toBe("unknown");
    expect(parsePanelCommand("compact").kind).toBe("unknown");
    expect(parsePanelCommand("prune").kind).toBe("unknown");
    expect(out).not.toMatch(/(^|[^\w-])compact([^\w-]|$)/);
    expect(out).not.toMatch(/(^|[^\w-])prune([^\w-]|$)/);
    expect(out).not.toContain(PANEL_PROMPT);
  });
});

describe("TC-2.1b Help distinguishes setting scope", () => {
  it("each setting command states session or persisted scope accurately", () => {
    const lines = helpLines(openHome().panelView).join("\n");
    expect(lines).toContain("auto on|off");
    expect(lines).toContain("bounds <lower> <upper>");
    expect(lines).toMatch(/auto on\|off[\s\S]*session only/);
    expect(lines).toMatch(/bounds <lower> <upper>[\s\S]*session only/);
    expect(lines).toContain("survives handoffs, lost at wrapper exit");
    const statusBlock = lines.slice(lines.indexOf("status —"));
    const statusOnly = statusBlock.slice(0, statusBlock.indexOf("stats —"));
    expect(statusOnly).not.toContain("session only");
  });
});

describe("TC-2.2a Introduction presents the mental model", () => {
  it("Introduction explains durable record and Low/Medium/High/Full working-context fidelity", () => {
    const home = openHome();
    const intro = feed(home, "introduction\r");
    const out = renderPanel(intro, 120, 40);
    expect(out).toContain("Complete captured history remains durable");
    expect(out).toContain("Smart Compact does not delete that record");
    expect(out).toContain("Full");
    expect(out).toContain("High");
    expect(out).toContain("Medium");
    expect(out).toContain("Low");
    expect(out).toContain("rebuilds working context");
    expect(out.toLowerCase()).not.toContain("deletes the transcript");
    expect(out).not.toContain(PANEL_PROMPT);
  });
});

describe("TC-2.2b Introduction uses current values", () => {
  it("Introduction renders active target/trigger rather than hardcoded defaults", () => {
    const view = buildPanelViewSnapshot({
      providerContextTokens: 1_000,
      targetTokens: 42_000,
      triggerTokens: 77_000,
      autoCompact: false,
      captureHealth: "ready",
      profile: "historical",
    });
    const lines = introductionLines(view).join("\n");
    expect(lines).toContain("42k");
    expect(lines).toContain("77k");
    expect(lines).toContain("Historical");
    expect(lines).not.toContain("180k");
    expect(lines).not.toContain("360k");
  });
});

describe("TC-2.2c Values refresh after selection", () => {
  const dirs: string[] = [];
  const savedHome = process.env.CC_LHC_HOME;
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("Help/Introduction refresh from the same resolved configuration used by the runtime", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-panel-refresh-"));
    dirs.push(home);
    process.env.CC_LHC_HOME = home;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.defineProperty(stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(stdout, "rows", { value: 40, configurable: true });
    Object.defineProperty(stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    let out = "";
    (stdout as unknown as PassThrough).on("data", (chunk: Buffer) => {
      out += chunk.toString("latin1");
    });
    const exitCbs: Array<(arg: { exitCode: number }) => void> = [];
    const pty = {
      pid: 11,
      write: () => {},
      resize: () => {},
      kill: () => {
        setImmediate(() => {
          for (const cb of exitCbs) cb({ exitCode: 0 });
        });
      },
      onData: (cb: (data: string) => void) => {
        setTimeout(() => cb("tick\r\n"), 10);
        return { dispose() {} };
      },
      onExit: (cb: (arg: { exitCode: number }) => void) => {
        exitCbs.push(cb);
        return { dispose() {} };
      },
    };
    const runPromise = run([], {
      claudeBin: "fake",
      spawnPty: (() => pty) as never,
      stdin,
      stdout,
      noInference: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    (stdin as unknown as PassThrough).write(Buffer.from([DEFAULT_LEADER_BYTE]));
    await waitFor(() => out.includes(ENTER_ALT_SCREEN) && out.includes("Default"), "home default");
    expect(out).toContain("target 180k");
    expect(out).toContain("trigger 360k");
    (stdin as unknown as PassThrough).write(
      Buffer.from("\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r"),
    );
    await waitFor(() => out.includes("Band allocation") && out.includes("Historical"), "allocation selector");
    (stdin as unknown as PassThrough).write(Buffer.from("\x1b[B\x1b[B\r"));
    await waitFor(() => out.includes("Band allocation: Historical"), "preset applied");
    const afterSelect = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("help\r"));
    await waitFor(() => out.slice(afterSelect).includes("Band allocation Historical"), "help after select");
    expect(out.slice(afterSelect)).toContain("target 180k");
    expect(out.slice(afterSelect)).toContain("trigger 360k");
    const afterHelpEnter = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("\r"));
    await waitFor(() => out.slice(afterHelpEnter).includes("Common actions:"), "home after help");
    const afterHome = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("bounds 100000 200000\r"));
    await waitFor(
      () => out.slice(afterHome).includes("bounds 100000 200000") && out.slice(afterHome).includes("applied live"),
      "bounds applied",
    );
    const afterBounds = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("help\r"));
    await waitFor(() => out.slice(afterBounds).includes("target 100k"), "help after bounds");
    expect(out.slice(afterBounds)).toContain("trigger 200k");
    expect(out.slice(afterBounds)).toContain("Band allocation Historical");
    expect(out.slice(afterBounds)).not.toContain("trigger 360k");
    const afterSecondHelpEnter = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("\r"));
    await waitFor(() => out.slice(afterSecondHelpEnter).includes("Common actions:"), "home after second help");
    const afterHelpHome = out.length;
    (stdin as unknown as PassThrough).write(Buffer.from("introduction\r"));
    await waitFor(() => out.slice(afterHelpHome).includes("toward 100k"), "introduction after bounds");
    expect(out.slice(afterHelpHome)).toContain("triggers at 200k");
    expect(out.slice(afterHelpHome)).toContain("Historical");
    pty.kill();
    await runPromise;
  }, 20_000);
});

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

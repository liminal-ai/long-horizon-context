import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DETECTION_UNAVAILABLE_CLASS,
  mergeLaunchSettings,
  type SettingsMergeInput,
} from "../story0/settings-merge-harness.js";

/**
 * Story 0 (LIM-143): settings-preservation proof for tech-design D8.
 *
 * Two layers, labelled: the `mechanism` block is a deterministic proof over
 * production-shaped argv and settings data; the `live` block replays the
 * Claude Code 2.1.252 probe in which the same mechanism produced the argv
 * that was actually launched, and the operator's command received the
 * identical bytes the observer captured.
 */

const CAPTURE = "<probe-dir>/out/observer.jsonl";
const USER_COMMAND = "LIM143_MODE=x <probe-dir>/user-status.sh";
const userSettings = { statusLine: { type: "command", command: USER_COMMAND, padding: 0 }, env: { LIM143_MARK: "x" } };
const noFile = (): string | null => null;

function countSettings(argv: readonly string[]): number {
  return argv.filter((a) => a === "--settings" || a.startsWith("--settings=")).length;
}

function settingsOf(argv: readonly string[]): Record<string, unknown> {
  const i = argv.indexOf("--settings");
  return JSON.parse(argv[i + 1]!) as Record<string, unknown>;
}

describe("D8 settings merge: mechanism (deterministic)", () => {
  it("preserves the operator's status-line command behind the observer and every other field verbatim", () => {
    const forwardedArgv = ["--settings", JSON.stringify(userSettings), "--model", "haiku"];
    const r = mergeLaunchSettings({ forwardedArgv, readFile: noFile, observerCapturePath: CAPTURE });
    expect(r.kind).toBe("merged");
    if (r.kind !== "merged") return;
    expect(r.chainedCommand).toBe(USER_COMMAND);
    const line = r.settings.statusLine as Record<string, unknown>;
    expect(line.command).toBe(`tee -a '${CAPTURE}' | ${USER_COMMAND}`);
    expect(line.type).toBe("command");
    expect(line.padding).toBe(0);
    expect(r.settings.env).toEqual(userSettings.env);
    expect(Object.keys(r.settings).sort()).toEqual(Object.keys(userSettings).sort());
  });

  it("forwards exactly one --settings, in the operator's position, with the rest of argv untouched", () => {
    const forwardedArgv = ["--effort", "high", "--settings", JSON.stringify(userSettings), "--model", "haiku"];
    const r = mergeLaunchSettings({ forwardedArgv, readFile: noFile, observerCapturePath: CAPTURE });
    expect(r.kind).toBe("merged");
    expect(countSettings(r.argv)).toBe(1);
    expect(r.argv.indexOf("--settings")).toBe(2);
    expect(r.argv.slice(0, 2)).toEqual(["--effort", "high"]);
    expect(r.argv.slice(4)).toEqual(["--model", "haiku"]);
  });

  it("handles the equals form the same way", () => {
    const forwardedArgv = [`--settings=${JSON.stringify(userSettings)}`, "--model", "haiku"];
    const r = mergeLaunchSettings({ forwardedArgv, readFile: noFile, observerCapturePath: CAPTURE });
    expect(r.kind).toBe("merged");
    expect(countSettings(r.argv)).toBe(1);
    expect(r.argv[0]).toBe("--settings");
    expect((settingsOf(r.argv).statusLine as { command: string }).command).toContain(USER_COMMAND);
  });

  it("reads a --settings <file> status line and merges it into one inline payload", () => {
    const files = new Map([["<probe-dir>/user-settings.json", JSON.stringify(userSettings)]]);
    const forwardedArgv = ["--settings", "<probe-dir>/user-settings.json"];
    const r = mergeLaunchSettings({
      forwardedArgv,
      readFile: (p) => files.get(p) ?? null,
      observerCapturePath: CAPTURE,
    });
    expect(r.kind).toBe("merged");
    expect(countSettings(r.argv)).toBe(1);
    expect(r.argv).not.toContain("<probe-dir>/user-settings.json");
    expect((settingsOf(r.argv).statusLine as { command: string }).command).toBe(
      `tee -a '${CAPTURE}' | ${USER_COMMAND}`,
    );
    expect(settingsOf(r.argv).env).toEqual(userSettings.env);
  });

  it("chains a status line that lives only in the user settings file, without forwarding that file", () => {
    const r = mergeLaunchSettings({
      forwardedArgv: ["--model", "haiku"],
      readFile: noFile,
      observerCapturePath: CAPTURE,
      userSettingsText: JSON.stringify({ statusLine: { type: "command", command: "my-status" }, model: "opus" }),
    });
    expect(r.kind).toBe("merged");
    if (r.kind !== "merged") return;
    expect(r.chainedCommand).toBe("my-status");
    expect((r.settings.statusLine as { command: string }).command).toBe(`tee -a '${CAPTURE}' | my-status`);
    // Only the status line is lifted: the user file keeps its own precedence
    // for everything else and is never re-sent as a launch override.
    expect(r.settings.model).toBeUndefined();
    expect(countSettings(r.argv)).toBe(1);
  });

  it("gives the argv status line precedence over the user settings file", () => {
    const r = mergeLaunchSettings({
      forwardedArgv: ["--settings", JSON.stringify(userSettings)],
      readFile: noFile,
      observerCapturePath: CAPTURE,
      userSettingsText: JSON.stringify({ statusLine: { type: "command", command: "my-status" } }),
    });
    expect(r.kind === "merged" && r.chainedCommand).toBe(USER_COMMAND);
  });

  it("installs the observer alone when nobody has a status line", () => {
    const r = mergeLaunchSettings({
      forwardedArgv: ["--model", "haiku"],
      readFile: noFile,
      observerCapturePath: CAPTURE,
    });
    expect(r.kind).toBe("merged");
    if (r.kind !== "merged") return;
    expect(r.chainedCommand).toBeNull();
    expect(r.argv.slice(0, 2)).toEqual(["--model", "haiku"]);
    expect(countSettings(r.argv)).toBe(1);
    expect((r.settings.statusLine as { command: string }).command).toBe(`cat >> '${CAPTURE}'`);
  });

  const unmergeable: Array<[string, Partial<SettingsMergeInput> & { forwardedArgv: string[] }]> = [
    ["unreadable settings file", { forwardedArgv: ["--settings", "<probe-dir>/missing.json"] }],
    ["malformed inline JSON", { forwardedArgv: ["--settings", "{not json"] }],
    ["non-object payload", { forwardedArgv: ["--settings", "[1,2]"] }],
    ["--settings without a value", { forwardedArgv: ["--model", "haiku", "--settings"] }],
    [
      "two competing --settings values",
      { forwardedArgv: ["--settings", JSON.stringify(userSettings), "--settings", "{}"] },
    ],
    [
      "a status line that is not a command",
      { forwardedArgv: ["--settings", JSON.stringify({ statusLine: { type: "static", text: "hi" } })] },
    ],
    ["a malformed user settings file", { forwardedArgv: ["--model", "haiku"], userSettingsText: "{oops" }],
  ];

  for (const [label, input] of unmergeable) {
    it(`falls to detection-unavailable (${DETECTION_UNAVAILABLE_CLASS}) on ${label}, argv verbatim`, () => {
      const forwardedArgv = [...input.forwardedArgv];
      const r = mergeLaunchSettings({ readFile: noFile, observerCapturePath: CAPTURE, ...input, forwardedArgv });
      expect(r.kind).toBe("detection_unavailable");
      expect(r.argv).toEqual(input.forwardedArgv);
      expect(DETECTION_UNAVAILABLE_CLASS).toBe("200k");
    });
  }

  it("never forwards a payload it could not merge, even partially", () => {
    const r = mergeLaunchSettings({
      forwardedArgv: ["--settings", "{not json"],
      readFile: noFile,
      observerCapturePath: CAPTURE,
    });
    expect(r.argv).toEqual(["--settings", "{not json"]);
    expect(countSettings(r.argv)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Live 2.1.252 evidence
// ---------------------------------------------------------------------------

const LIVE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "context-window",
  "claude-2.1.252-settings-chain-live.json",
);

interface LiveMode {
  mode: "control" | "inline" | "file";
  forwardedArgv: string[];
  userSettingsFileText: string | null;
  launchedArgv: string[];
  mergeKind: string;
  chainedCommand: string | null;
  userCommandSeenSha256: string[];
  observerSeenSha256: string[];
  userCommandSeen: Array<{ version: string; model: { id: string }; context_window: { context_window_size: number } }>;
  visibleStatusLines: string[];
  envMarkSeenByUserCommand: string[];
}

const live = JSON.parse(readFileSync(LIVE_PATH, "utf8")) as { source: string; modes: LiveMode[] };
const byMode = new Map(live.modes.map((m) => [m.mode, m]));
const control = byMode.get("control")!;

describe("D8 settings merge: live evidence (Claude Code 2.1.252)", () => {
  it("captured all three modes from the pinned binary", () => {
    expect([...byMode.keys()].sort()).toEqual(["control", "file", "inline"]);
    for (const m of live.modes) for (const p of m.userCommandSeen) expect(p.version, m.mode).toBe("2.1.252");
  });

  for (const mode of ["inline", "file"] as const) {
    describe(`mode ${mode}`, () => {
      const m = byMode.get(mode)!;

      it("launched exactly the argv this mechanism derives from the forwarded argv", () => {
        const r = mergeLaunchSettings({
          forwardedArgv: m.forwardedArgv,
          readFile: (p) => (p === "<probe-dir>/user-settings.json" ? m.userSettingsFileText : null),
          observerCapturePath: `<probe-dir>/out/observer-${mode}.jsonl`,
        });
        expect(r.kind).toBe("merged");
        expect(r.argv).toEqual(m.launchedArgv);
        expect(countSettings(m.launchedArgv)).toBe(1);
        expect(r.kind === "merged" && r.chainedCommand).toBe(m.chainedCommand);
      });

      it("delivered byte-identical JSON to the observer and to the operator's command", () => {
        expect(m.observerSeenSha256.length).toBeGreaterThan(0);
        expect(m.observerSeenSha256).toEqual(m.userCommandSeenSha256);
      });

      it("kept the operator's visible status line exactly as in the unchained control run", () => {
        expect(m.visibleStatusLines).toEqual(control.visibleStatusLines);
        expect(control.visibleStatusLines).toEqual(["USERLINE claude-haiku-4-5-20251001"]);
      });

      it("carried the non-statusLine settings fields through to the session", () => {
        expect(m.envMarkSeenByUserCommand).toEqual([`mark=${mode}`]);
      });

      it("observed the documented window value on the operator's route", () => {
        for (const p of m.userCommandSeen) expect(p.context_window.context_window_size).toBe(200_000);
      });
    });
  }

  it("control run had no observer and still produced the same visible line", () => {
    expect(control.observerSeenSha256).toEqual([]);
    expect(control.mergeKind).toBe("control");
    expect(control.envMarkSeenByUserCommand).toEqual(["mark=control"]);
  });
});

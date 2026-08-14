import { describe, expect, it } from "vitest";

import {
  applyClaudeRuntimeSettings,
  observeClaudeRuntimeSettings,
} from "../../src/rollout/runtime-settings.js";

describe("Claude runtime settings", () => {
  it("observes permission mode and assistant effort from rollout fields", () => {
    let settings = observeClaudeRuntimeSettings({}, {
      type: "permission-mode",
      permissionMode: "auto",
    });
    settings = observeClaudeRuntimeSettings(settings, {
      type: "assistant",
      effort: "max",
      message: { role: "assistant", content: [] },
    });
    expect(settings).toEqual({ permissionMode: "auto", effort: "max" });
  });

  it("ignores unknown values and sidechain records", () => {
    const original = { permissionMode: "manual" as const, effort: "high" as const };
    expect(observeClaudeRuntimeSettings(original, {
      type: "assistant",
      permissionMode: "future-mode",
      effort: "future-effort",
    })).toBe(original);
    expect(observeClaudeRuntimeSettings(original, {
      type: "user",
      isSidechain: true,
      permissionMode: "auto",
    })).toBe(original);
  });

  it("replaces launch values and preserves the resume selector", () => {
    expect(applyClaudeRuntimeSettings(
      ["--effort", "medium", "--permission-mode=manual", "--resume", "rebuilt"],
      { effort: "max", permissionMode: "auto" },
    )).toEqual(["--resume", "rebuilt", "--effort", "max", "--permission-mode", "auto"]);
  });

  it("leaves launch values unchanged without a newer confirmed setting", () => {
    const argv = ["--effort", "medium", "--permission-mode", "manual", "--resume", "rebuilt"];
    expect(applyClaudeRuntimeSettings(argv, {})).toEqual(argv);
  });

  it("maps Claude's recorded default mode to the current CLI manual mode", () => {
    expect(applyClaudeRuntimeSettings(["--resume", "rebuilt"], { permissionMode: "default" })).toEqual([
      "--resume",
      "rebuilt",
      "--permission-mode",
      "manual",
    ]);
  });
});

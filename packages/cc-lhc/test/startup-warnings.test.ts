import { describe, expect, it, vi } from "vitest";

import { installNodeSqliteWarningFilter, needsNodeSqliteWarningFilter } from "../src/startup-warnings.js";

describe("Node SQLite startup warning", () => {
  it.each([
    ["24.3.0", true],
    ["24.14.9", true],
    ["24.15.0", false],
    ["24.2.0", false],
    ["25.0.0", false],
  ])("filter needed for %s -> %s", (version, expected) => {
    expect(needsNodeSqliteWarningFilter(version)).toBe(expected);
  });

  it("suppresses only the exact node:sqlite experimental warning", () => {
    const emitWarning = vi.fn();
    const runtime = { emitWarning } as unknown as Pick<NodeJS.Process, "emitWarning">;
    installNodeSqliteWarningFilter(runtime, "24.3.0");

    runtime.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    runtime.emitWarning("another experimental warning", "ExperimentalWarning");
    runtime.emitWarning("SQLite is an experimental feature and might change at any time", "Warning");

    expect(emitWarning).toHaveBeenCalledTimes(2);
    expect(emitWarning).toHaveBeenNthCalledWith(1, "another experimental warning", "ExperimentalWarning");
    expect(emitWarning).toHaveBeenNthCalledWith(
      2,
      "SQLite is an experimental feature and might change at any time",
      "Warning",
    );
  });

  it("does not patch runtimes where SQLite no longer emits the warning", () => {
    const emitWarning = vi.fn();
    const runtime = { emitWarning } as unknown as Pick<NodeJS.Process, "emitWarning">;
    installNodeSqliteWarningFilter(runtime, "24.15.0");
    expect(runtime.emitWarning).toBe(emitWarning);
  });
});

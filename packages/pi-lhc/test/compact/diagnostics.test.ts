import { describe, expect, it, vi } from "vitest";
import {
  compactCancelLogMessage,
  createCompactDiagnosticsBuffer,
  writeCompactCancelLog,
} from "../../src/compact/diagnostics.js";
import type { CompactDiagnostic } from "../../src/compact/handler.js";
import { syntheticCtx } from "../capture/support.js";

describe("compact diagnostics buffer", () => {
  it("accumulates multiple cancel diagnostics", () => {
    const buffer = createCompactDiagnosticsBuffer();
    buffer.push({ code: "no_op", reason: "fits budget" });
    buffer.push({ code: "open_turn", reason: "turn open" });
    expect(buffer.snapshot()).toEqual([
      { code: "no_op", reason: "fits budget" },
      { code: "open_turn", reason: "turn open" },
    ]);
    expect(buffer.last()).toEqual({ code: "open_turn", reason: "turn open" });
  });

  it("clears all entries", () => {
    const buffer = createCompactDiagnosticsBuffer();
    buffer.push({ code: "mapping_failed", reason: "stale" });
    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.last()).toBeNull();
  });
});

describe("writeCompactCancelLog", () => {
  it("writes a fail-soft warning log entry with cancel code as reason", async () => {
    const diagnostic: CompactDiagnostic = { code: "no_op", reason: "closed history fits full-tail budget" };
    const write = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const instance = {
      sdk: { logging: { write } },
      threadRef: { threadId: "th_test" },
    };

    await writeCompactCancelLog(instance as never, { threadId: "th_test" }, diagnostic);

    expect(write).toHaveBeenCalledWith(
      { threadId: "th_test" },
      {
        level: "warning",
        message: compactCancelLogMessage(diagnostic),
        reason: "no_op",
      },
    );
  });

  it("skips logging when thread or instance is unavailable", async () => {
    const write = vi.fn();
    await writeCompactCancelLog(null, null, { code: "no_thread", reason: "missing" });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("compactCancelLogMessage", () => {
  it("includes code and reason for operator and log surfaces", () => {
    const message = compactCancelLogMessage({ code: "mapping_failed", reason: "stale branch" });
    expect(message).toBe("pi-lhc compact cancelled (mapping_failed): stale branch");
    expect(syntheticCtx().hasUI).toBe(false);
  });
});

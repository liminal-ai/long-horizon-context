import { describe, expect, it } from "vitest";

import { CommandInFlightGuard, formatBusyMessage } from "../../src/wrapper/command-guard.js";

describe("CommandInFlightGuard", () => {
  it("allows one acquire at a time and remembers what is running", () => {
    const guard = new CommandInFlightGuard();
    expect(guard.current()).toBeNull();
    expect(guard.tryAcquire("status", 1_000)).toBe(true);
    expect(guard.tryAcquire("compact", 2_000)).toBe(false);
    expect(guard.current()).toEqual({ label: "status", startedAtMs: 1_000 });
    guard.release();
    expect(guard.current()).toBeNull();
    expect(guard.tryAcquire("compact", 3_000)).toBe(true);
    expect(guard.current()).toEqual({ label: "compact", startedAtMs: 3_000 });
  });

  it("formats a named busy message with elapsed seconds", () => {
    expect(formatBusyMessage({ label: "prune 30000", startedAtMs: 1_000 }, 42_400)).toBe(
      "busy — prune 30000 still running (41s); its receipt will land here when it settles",
    );
    // clock skew never yields a negative elapsed
    expect(formatBusyMessage({ label: "status", startedAtMs: 5_000 }, 4_000)).toBe(
      "busy — status still running (0s); its receipt will land here when it settles",
    );
  });
});

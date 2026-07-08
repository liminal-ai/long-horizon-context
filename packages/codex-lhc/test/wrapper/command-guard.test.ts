import { describe, expect, it } from "vitest";

import { COMMAND_BUSY_MESSAGE, CommandInFlightGuard } from "../../src/wrapper/command-guard.js";

describe("CommandInFlightGuard", () => {
  it("allows one acquire at a time", () => {
    const guard = new CommandInFlightGuard();
    expect(guard.tryAcquire()).toBe(true);
    expect(guard.tryAcquire()).toBe(false);
    guard.release();
    expect(guard.tryAcquire()).toBe(true);
  });

  it("exposes the busy message constant", () => {
    expect(COMMAND_BUSY_MESSAGE).toBe("busy — command in progress");
  });
});

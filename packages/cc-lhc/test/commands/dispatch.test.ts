import { describe, expect, it } from "vitest";

import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";

import {
  CAPTURE_DISABLED_MESSAGE,
  dispatchLhcCommand,
  formatCommandOutput,
  UNKNOWN_COMMAND_MESSAGE,
  type LhcCommandRuntime,
} from "../../src/commands/dispatch.js";
import { emptyCaptureStats } from "../../src/stats.js";

function fakeRuntime(overrides: Partial<LhcCommandRuntime> = {}): LhcCommandRuntime {
  return {
    captureDisabled: false,
    stats: {
      ...emptyCaptureStats(),
      linesSeen: 3,
      eventsSent: 2,
      threadId: "th_test",
    },
    sdk: undefined,
    threadRef: undefined,
    cwd: "/work",
    sourceRolloutPath: undefined,
    sourceSessionId: undefined,
    ...overrides,
  };
}

const sampleStatus: ViewStatus = {
  tailTokens: 1200,
  threshold: 8000,
  compactRecommended: false,
  derivation: { pending: 1, retrying: 0, failed: 2, blocked: 0 },
  view: null,
  visibility: { boundaryPosition: 0, zoneTokens: 400, maxTokens: 2000 },
};

describe("dispatchLhcCommand", () => {
  it("returns capture disabled when capture is off", async () => {
    const outcome = await dispatchLhcCommand("/lhc-status", fakeRuntime({ captureDisabled: true }));
    expect(outcome.messages).toEqual([CAPTURE_DISABLED_MESSAGE]);
  });

  it("prints status from threadView.status", async () => {
    const sdk = {
      threadView: {
        status: async (): Promise<OpResult<ViewStatus>> => ({ ok: true, value: sampleStatus }),
      },
    } as unknown as Lhc;
    const outcome = await dispatchLhcCommand(
      "/lhc-status",
      fakeRuntime({ sdk, threadRef: { threadId: "th_test" } as ThreadRef }),
    );
    expect(outcome.messages[0]).toContain("tail=1200 threshold=8000 zone=400/2000");
    expect(outcome.messages[0]).toContain("derivation pending=1 failed=2 thread=th_test");
  });

  it("prints the capture stats line", async () => {
    const outcome = await dispatchLhcCommand("/lhc-stats", fakeRuntime());
    expect(outcome.messages[0]).toContain("cc-lhc-capture lines=3 events=2");
    expect(outcome.messages[0]).toContain("thread=th_test");
  });

  it("lists help including compact and prune", async () => {
    const outcome = await dispatchLhcCommand("/lhc-help", fakeRuntime());
    expect(outcome.messages[0]).toContain("/lhc-compact");
    expect(outcome.messages[0]).toContain("/lhc-prune");
  });

  it("reports unknown /lhc-* commands", async () => {
    const outcome = await dispatchLhcCommand("/lhc-foo", fakeRuntime());
    expect(outcome.messages).toEqual([UNKNOWN_COMMAND_MESSAGE]);
  });

  it("returns an error string when a handler throws", async () => {
    const sdk = {
      threadView: {
        status: async (): Promise<OpResult<ViewStatus>> => {
          throw new Error("db exploded");
        },
      },
    } as unknown as Lhc;
    const outcome = await dispatchLhcCommand(
      "/lhc-status",
      fakeRuntime({ sdk, threadRef: { threadId: "th_test" } as ThreadRef }),
    );
    expect(outcome.messages).toEqual(["command failed: db exploded"]);
  });
});

describe("formatCommandOutput", () => {
  it("prefixes each line for terminal rendering", () => {
    expect(formatCommandOutput("one\ntwo")).toBe("\r\n[cc-lhc] one\r\n[cc-lhc] two");
  });
});

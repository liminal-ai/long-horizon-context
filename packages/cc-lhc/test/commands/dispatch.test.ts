import { describe, expect, it } from "vitest";

import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";

import {
  CAPTURE_DISABLED_MESSAGE,
  dispatchLhcCommand,
  formatCommandOutput,
  UNKNOWN_COMMAND_MESSAGE,
  type CaptureCommandContext,
} from "../../src/commands/dispatch.js";
import { emptyCaptureStats } from "../../src/stats.js";

function fakeContext(overrides: Partial<CaptureCommandContext> = {}): CaptureCommandContext {
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
    const text = await dispatchLhcCommand("/lhc-status", fakeContext({ captureDisabled: true }));
    expect(text).toBe(CAPTURE_DISABLED_MESSAGE);
  });

  it("prints status from threadView.status", async () => {
    const sdk = {
      threadView: {
        status: async (): Promise<OpResult<ViewStatus>> => ({ ok: true, value: sampleStatus }),
      },
    } as unknown as Lhc;
    const text = await dispatchLhcCommand(
      "/lhc-status",
      fakeContext({ sdk, threadRef: { threadId: "th_test" } as ThreadRef }),
    );
    expect(text).toContain("tail=1200 threshold=8000 zone=400/2000");
    expect(text).toContain("derivation pending=1 failed=2 thread=th_test");
  });

  it("prints the capture stats line", async () => {
    const text = await dispatchLhcCommand("/lhc-stats", fakeContext());
    expect(text).toContain("cc-lhc-capture lines=3 events=2");
    expect(text).toContain("thread=th_test");
  });

  it("lists help including coming-soon commands", async () => {
    const text = await dispatchLhcCommand("/lhc-help", fakeContext());
    expect(text).toContain("/lhc-status");
    expect(text).toContain("/lhc-compact — (coming soon)");
    expect(text).toContain("/lhc-prune — (coming soon)");
  });

  it("reports unknown /lhc-* commands", async () => {
    const text = await dispatchLhcCommand("/lhc-foo", fakeContext());
    expect(text).toBe(UNKNOWN_COMMAND_MESSAGE);
  });

  it("returns an error string when a handler throws", async () => {
    const sdk = {
      threadView: {
        status: async (): Promise<OpResult<ViewStatus>> => {
          throw new Error("db exploded");
        },
      },
    } as unknown as Lhc;
    const text = await dispatchLhcCommand(
      "/lhc-status",
      fakeContext({ sdk, threadRef: { threadId: "th_test" } as ThreadRef }),
    );
    expect(text).toBe("command failed: db exploded");
  });
});

describe("formatCommandOutput", () => {
  it("prefixes each line for terminal rendering", () => {
    expect(formatCommandOutput("one\ntwo")).toBe("\r\n[cc-lhc] one\r\n[cc-lhc] two");
  });
});

import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchLhcCommand,
  formatCommandOutput,
  type LhcCommandRuntime,
  TURN_OPEN_REFUSAL,
  UNKNOWN_COMMAND_MESSAGE,
} from "../../src/commands/dispatch.js";
import { emptyCaptureStats } from "../../src/stats.js";

function fakeRuntime(overrides: Partial<LhcCommandRuntime> = {}): LhcCommandRuntime {
  return {
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
    statusSnapshot: {
      latestProviderContextTokens: 123_456,
      targetTokens: 180_000,
      triggerTokens: 360_000,
      autoCompact: true,
    },
    ...overrides,
  };
}

const sampleStatus: ViewStatus = {
  tailTokens: 1200,
  threshold: 8000,
  compactRecommended: false,
  derivation: { pending: 1, failed: 2, blocked: 0 },
  view: null,
  visibility: { boundaryPosition: 0, zoneTokens: 400, maxTokens: 2000 },
};

describe("dispatchLhcCommand", () => {
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
    expect(outcome.messages[0]).toContain("Latest provider context: 123,456 tokens (provider-reported)");
    expect(outcome.messages[0]).toContain(
      "/smart-compact: 180,000-token target · 360,000-token trigger (configured) · automatic on",
    );
    expect(outcome.messages[0]).toContain("LHC history since last Smart Compact: 1,200 estimated tokens");
    expect(outcome.messages[0]).toContain("/smart-prune: 400 estimated tokens in eligible tool results");
    expect(outcome.messages[0]).toContain("Derivations: 1 pending · 2 failed");
    expect(outcome.messages[0]).toContain("Thread: th_test");
  });

  it("prints the capture stats line", async () => {
    const outcome = await dispatchLhcCommand("/lhc-stats", fakeRuntime());
    expect(outcome.messages[0]).toContain("cc-lhc-capture lines=3 events=2");
    expect(outcome.messages[0]).toContain("thread=th_test");
  });

  it("lists help including /smart-compact and /smart-prune (panel command names)", async () => {
    const outcome = await dispatchLhcCommand("/lhc-help", fakeRuntime());
    expect(outcome.messages[0]).toContain("/smart-compact");
    expect(outcome.messages[0]).toContain("/smart-prune [tokens]");
    expect(outcome.messages[0]).toContain("Keep newest eligible tool results near [tokens] estimated tokens");
  });

  it("reports unknown /lhc-* commands", async () => {
    const outcome = await dispatchLhcCommand("/lhc-foo", fakeRuntime());
    expect(outcome.messages).toEqual([UNKNOWN_COMMAND_MESSAGE]);
  });

  it("refuses prune while a turn is open, before touching the view", async () => {
    const prune = vi.fn();
    const sdk = { threadView: { prune } } as unknown as Lhc;
    const outcome = await dispatchLhcCommand(
      "/lhc-prune",
      fakeRuntime({ sdk, threadRef: { threadId: "th_test" } as ThreadRef, isTurnOpen: () => true }),
    );
    expect(outcome.messages).toEqual([TURN_OPEN_REFUSAL]);
    expect(outcome.restart).toBeUndefined();
    expect(prune).not.toHaveBeenCalled();
  });

  it("refuses compact while a turn is open, before touching the view", async () => {
    const previewCompact = vi.fn();
    const sdk = { threadView: { previewCompact } } as unknown as Lhc;
    const outcome = await dispatchLhcCommand(
      "/lhc-compact",
      fakeRuntime({ sdk, threadRef: { threadId: "th_test" } as ThreadRef, isTurnOpen: () => true }),
    );
    expect(outcome.messages).toEqual([TURN_OPEN_REFUSAL]);
    expect(outcome.restart).toBeUndefined();
    expect(previewCompact).not.toHaveBeenCalled();
  });

  it("status and stats stay available while a turn is open", async () => {
    const sdk = {
      threadView: {
        status: async (): Promise<OpResult<ViewStatus>> => ({ ok: true, value: sampleStatus }),
      },
    } as unknown as Lhc;
    const status = await dispatchLhcCommand(
      "/lhc-status",
      fakeRuntime({ sdk, threadRef: { threadId: "th_test" } as ThreadRef, isTurnOpen: () => true }),
    );
    expect(status.messages[0]).toContain("LHC history since last Smart Compact: 1,200 estimated tokens");
    const stats = await dispatchLhcCommand("/lhc-stats", fakeRuntime({ isTurnOpen: () => true }));
    expect(stats.messages[0]).toContain("cc-lhc-capture");
  });

  it("status appends a warning-count line only when warnings exist", async () => {
    const sdk = {
      threadView: {
        status: async (): Promise<OpResult<ViewStatus>> => ({ ok: true, value: sampleStatus }),
      },
    } as unknown as Lhc;
    const base = { sdk, threadRef: { threadId: "th_test" } as ThreadRef };

    const withWarnings = await dispatchLhcCommand(
      "/lhc-status",
      fakeRuntime({ ...base, warnings: { count: 2, logPath: "/home/u/.cc-lhc/wrapper.log" } }),
    );
    expect(withWarnings.messages[withWarnings.messages.length - 1]).toBe(
      "2 warnings since launch — see /home/u/.cc-lhc/wrapper.log",
    );

    const oneWarning = await dispatchLhcCommand(
      "/lhc-status",
      fakeRuntime({ ...base, warnings: { count: 1, logPath: "/tmp/w.log" } }),
    );
    expect(oneWarning.messages[oneWarning.messages.length - 1]).toBe("1 warning since launch — see /tmp/w.log");

    const clean = await dispatchLhcCommand(
      "/lhc-status",
      fakeRuntime({ ...base, warnings: { count: 0, logPath: "/tmp/w.log" } }),
    );
    expect(clean.messages.join("\n")).not.toContain("since launch");
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
    expect(formatCommandOutput("one\ntwo")).toBe("\r\n\x1b[2K[cc-lhc] one\r\n\x1b[2K[cc-lhc] two");
  });
});

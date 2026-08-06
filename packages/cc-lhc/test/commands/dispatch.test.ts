import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";
import { describe, expect, it, vi } from "vitest";

import {
  CAPTURE_DISABLED_MESSAGE,
  dispatchLhcCommand,
  formatCommandOutput,
  type LhcCommandRuntime,
  TURN_OPEN_REFUSAL,
  UNKNOWN_COMMAND_MESSAGE,
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
  derivation: { pending: 1, failed: 2, blocked: 0 },
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

  it("lists help including compact and prune (modal command names)", async () => {
    const outcome = await dispatchLhcCommand("/lhc-help", fakeRuntime());
    expect(outcome.messages[0]).toContain("compact");
    expect(outcome.messages[0]).toContain("prune [targetTokens]");
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
    expect(status.messages[0]).toContain("tail=1200");
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

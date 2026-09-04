/**
 * LIM-117 AR-6: both captureSdkConfig branches share identical view.profiles
 * and construct an SDK that actually resolves the host profiles.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type ThreadRef } from "lhc";

import { CAPTURE_VIEW_CONFIG, HOST_VIEW_PROFILES } from "../../src/governor/band-allocation.js";
import { mapRolloutLine } from "../../src/intake/map.js";
import { captureSdkConfig } from "../../src/intake/session.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function threadWithTurns(sdk: Lhc): Promise<ThreadRef> {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-ar6-"));
  roots.push(root);
  mkdirSync(join(root, "threads"), { recursive: true });
  const created = await sdk.threads.newThread({
    filePath: join(root, "threads", "t.sqlite"),
    registryPath: join(root, "registry.sqlite"),
  });
  if (!created.ok) throw new Error(created.error.reason);
  const threadRef: ThreadRef = { filePath: join(root, "threads", "t.sqlite") };
  for (let i = 0; i < 8; i += 1) {
    const line = (item: RolloutLineItem) => mapRolloutLine(item).events;
    const events = [
      ...line({
        type: "user",
        uuid: `u${i}`,
        message: { role: "user", content: `question ${i}: ${"context ".repeat(40)}` },
      } as RolloutLineItem),
      ...line({
        type: "assistant",
        uuid: `a${i}`,
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: `answer ${i}: ${"detail ".repeat(40)}` }],
        },
      } as RolloutLineItem),
    ];
    const intake = await sdk.intakeStream.messageEvents(threadRef, events);
    if (!intake.ok) throw new Error(intake.error.reason);
  }
  return threadRef;
}

describe("AR-6 captureSdkConfig view.profiles", () => {
  it("manual and background captureSdkConfig() branches contain identical view.profiles definitions", () => {
    const previous = process.env.CC_LHC_NO_INFERENCE;
    delete process.env.CC_LHC_NO_INFERENCE;
    try {
      const manual = captureSdkConfig({ noInference: true });
      const background = captureSdkConfig({ noInference: false });
      expect(manual.mode).toBe("manual");
      expect(background.mode).toBe("background");
      expect(manual.inference).toBeUndefined();
      expect(background.inferenceCallbacks).toBeUndefined();
      expect(background.inference).toBeDefined();
      expect(manual.view).toBe(CAPTURE_VIEW_CONFIG);
      expect(background.view).toBe(CAPTURE_VIEW_CONFIG);
      expect(manual.view?.profiles).toBe(background.view?.profiles);
      expect(manual.view?.profiles).toEqual([...HOST_VIEW_PROFILES]);
      expect(manual.view?.profiles?.map((profile) => profile.name)).toEqual([
        "cc-lhc-balanced",
        "cc-lhc-historical",
      ]);
    } finally {
      if (previous === undefined) delete process.env.CC_LHC_NO_INFERENCE;
      else process.env.CC_LHC_NO_INFERENCE = previous;
    }
  });

  it("both production branches construct an SDK that resolves and uses Balanced and Historical", async () => {
    const previous = process.env.CC_LHC_NO_INFERENCE;
    delete process.env.CC_LHC_NO_INFERENCE;
    try {
      for (const noInference of [true, false] as const) {
        const config = captureSdkConfig({ noInference });
        expect(config.view?.profiles?.map((profile) => profile.name)).toEqual([
          "cc-lhc-balanced",
          "cc-lhc-historical",
        ]);
        const sdk = initLhc(config);
        const threadRef = await threadWithTurns(sdk);
        const balanced = await sdk.threadView.compact(threadRef, {
          profile: "cc-lhc-balanced",
          params: { lowerBound: 2_000 },
        });
        expect(balanced.ok, balanced.ok ? "" : balanced.error.reason).toBe(true);
        const historical = await sdk.threadView.previewCompact(threadRef, {
          profile: "cc-lhc-historical",
          params: { lowerBound: 2_000 },
        });
        expect(historical.ok, historical.ok ? "" : historical.error.reason).toBe(true);
        if (historical.ok) expect(historical.value.kind).not.toBe("error");
      }
    } finally {
      if (previous === undefined) delete process.env.CC_LHC_NO_INFERENCE;
      else process.env.CC_LHC_NO_INFERENCE = previous;
    }
  }, 60_000);
});

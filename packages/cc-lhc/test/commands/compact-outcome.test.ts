/**
 * What a compact is actually for, driven end to end against the real SDK and
 * the real rollout materializer: the session gets smaller and the settled
 * content the agent is working from survives.
 *
 * No mocked thread view here — the LHC compact decides what the bands hold, and
 * `writeRebuiltRollout` writes the file a replacement child would resume.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type ThreadRef } from "lhc";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { compactConstruction } from "../../src/governor/band-allocation.js";
import { captureSdkConfig } from "../../src/intake/session.js";
import { mapRolloutLine } from "../../src/intake/map.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import { writeRebuiltRollout } from "../../src/rollout/write-rebuilt.js";

const TURNS = 40;
const CWD = "/work/compact-outcome";
const LAST_PROMPT = `question ${TURNS - 1}: ${"context ".repeat(120)}`.trim();
const LAST_ANSWER = `answer ${TURNS - 1}: ${"detail ".repeat(200)}`.trim();

const roots: string[] = [];

function tempProjectsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-outcome-projects-"));
  roots.push(root);
  mkdirSync(join(root, encodeProjectPath(CWD)), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a compact makes the session smaller and keeps the settled content", () => {
  let sdk: Lhc;
  let threadRef: ThreadRef;
  let tailTokensBefore: number;
  let bytesBefore: number;
  let bytesAfter: number;
  let rebuiltAfterText: string;
  let compactTotalTokens: number;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-outcome-"));
    roots.push(root);
    mkdirSync(join(root, "threads"), { recursive: true });
    sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const created = await sdk.threads.newThread({
      filePath: join(root, "threads", "t.sqlite"),
      registryPath: join(root, "registry.sqlite"),
    });
    if (!created.ok) throw new Error(created.error.reason);
    threadRef = { filePath: join(root, "threads", "t.sqlite") };

    for (let i = 0; i < TURNS; i += 1) {
      const line = (item: RolloutLineItem) => mapRolloutLine(item).events;
      const events = [
        ...line({
          type: "user",
          uuid: `u${i}`,
          message: { role: "user", content: `question ${i}: ${"context ".repeat(120)}` },
        } as RolloutLineItem),
        ...line({
          type: "assistant",
          uuid: `a${i}`,
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: `answer ${i}: ${"detail ".repeat(200)}` }],
          },
        } as RolloutLineItem),
      ];
      const intake = await sdk.intakeStream.messageEvents(threadRef, events);
      if (!intake.ok) throw new Error(intake.error.reason);
    }
    const drained = await sdk.work.drain(threadRef, { maxItems: 10_000 });
    if (!drained.ok) throw new Error(drained.error.reason);

    const status = await sdk.threadView.status(threadRef);
    if (!status.ok) throw new Error(status.error.reason);
    tailTokensBefore = status.value.tailTokens;

    // The rollout a replacement would resume, built from the uncompacted view.
    const viewBefore = await sdk.threadView.getSessionThreadView(threadRef);
    if (!viewBefore.ok) throw new Error(viewBefore.error.reason);
    const rebuiltBefore = await writeRebuiltRollout({
      view: viewBefore.value,
      cwd: CWD,
      projectsRoot: tempProjectsRoot(),
      receipt: { text: "[lhc compact:auto] baseline." },
    });
    bytesBefore = rebuiltBefore.totalByteLength;

    const compacted = await sdk.threadView.compact(threadRef, {
      profile: "continuation",
      params: { lowerBound: 3_000 },
    });
    if (!compacted.ok) throw new Error(compacted.error.reason);
    compactTotalTokens = compacted.value.totalTokens;

    const viewAfter = await sdk.threadView.getSessionThreadView(threadRef);
    if (!viewAfter.ok) throw new Error(viewAfter.error.reason);
    const rebuiltAfter = await writeRebuiltRollout({
      view: viewAfter.value,
      cwd: CWD,
      projectsRoot: tempProjectsRoot(),
      receipt: { text: "[lhc compact:auto] rebuilt LHC view." },
    });
    bytesAfter = rebuiltAfter.totalByteLength;
    rebuiltAfterText = readFileSync(rebuiltAfter.rolloutPath, "utf8");
  }, 60_000);

  it("shrinks the served context well below the uncompacted tail", () => {
    expect(compactTotalTokens).toBeLessThan(tailTokensBefore / 2);
  });

  it("shrinks the rollout a replacement child would resume", () => {
    expect(bytesAfter).toBeLessThan(bytesBefore / 2);
  });

  it("keeps the most recent settled turn verbatim in the rebuilt session", () => {
    expect(rebuiltAfterText).toContain(LAST_PROMPT);
    expect(rebuiltAfterText).toContain(LAST_ANSWER);
  });

  it("still carries the oldest history, compressed rather than dropped", () => {
    // The brief band names the turns it covers, so nothing silently vanishes.
    expect(rebuiltAfterText).toContain("<turns>");
    expect(rebuiltAfterText).toContain("t1 ");
  });

  it("carries the durable compact receipt into the rebuilt session", () => {
    expect(rebuiltAfterText).toContain("[lhc compact:auto] rebuilt LHC view.");
  });
});

describe("AR-7 selected internal profile and explicit lowerBound reach core", () => {
  it("maps Historical to cc-lhc-historical plus params.lowerBound on a captureSdkConfig SDK", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-ar7-"));
    roots.push(root);
    mkdirSync(join(root, "threads"), { recursive: true });
    const sdk = initLhc(captureSdkConfig({ noInference: true }));
    const created = await sdk.threads.newThread({
      filePath: join(root, "threads", "t.sqlite"),
      registryPath: join(root, "registry.sqlite"),
    });
    if (!created.ok) throw new Error(created.error.reason);
    const threadRef: ThreadRef = { filePath: join(root, "threads", "t.sqlite") };
    for (let i = 0; i < TURNS; i += 1) {
      const line = (item: RolloutLineItem) => mapRolloutLine(item).events;
      const events = [
        ...line({
          type: "user",
          uuid: `u${i}`,
          message: { role: "user", content: `question ${i}: ${"context ".repeat(120)}` },
        } as RolloutLineItem),
        ...line({
          type: "assistant",
          uuid: `a${i}`,
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: `answer ${i}: ${"detail ".repeat(200)}` }],
          },
        } as RolloutLineItem),
      ];
      const intake = await sdk.intakeStream.messageEvents(threadRef, events);
      if (!intake.ok) throw new Error(intake.error.reason);
    }
    const drained = await sdk.work.drain(threadRef, { maxItems: 10_000 });
    if (!drained.ok) throw new Error(drained.error.reason);

    const construction = compactConstruction({ profile: "historical", lowerBoundTokens: 3_000 });
    expect(construction).toEqual({ profile: "cc-lhc-historical", params: { lowerBound: 3_000 } });
    const compacted = await sdk.threadView.compact(threadRef, construction);
    expect(compacted.ok, compacted.ok ? "" : compacted.error.reason).toBe(true);

    const balanced = compactConstruction({ profile: "balanced", lowerBoundTokens: 4_000 });
    expect(balanced).toEqual({ profile: "cc-lhc-balanced", params: { lowerBound: 4_000 } });
  }, 60_000);
});

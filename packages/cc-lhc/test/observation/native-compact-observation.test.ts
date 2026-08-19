/**
 * Native compact observation on the installed Claude Code 2.1.235 shape
 * (LIM-95/R8 amendment).
 *
 * The loud notice and the intake transform must agree about what a native
 * summary is, and a rebuilt historical prefix must produce neither.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Lhc, MessageEventInput } from "lhc";
import { describe, expect, it } from "vitest";

import { registerRebuiltSessionLineage } from "../../src/commands/rebuild-receipt.js";
import { startCaptureSession } from "../../src/intake/session.js";
import { observeWatcherEmission } from "../../src/observation/observe.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const TAG_OPEN = "<claude-compact-summary>";

/** Same retained canary (d) exhibit the intake suite drives. */
const FIXTURE_LINES: RolloutLineItem[] = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/native-compact-2.1.235.jsonl"),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as RolloutLineItem);

const BOUNDARY_RECORD = FIXTURE_LINES[0]!;
const INSTALLED_SUMMARY = FIXTURE_LINES[1]!;

function observe(item: RolloutLineItem, suppressRuntimeLifecycle = false): LifecycleSignal[] {
  return observeWatcherEmission({ kind: "line", item, raw: JSON.stringify(item) }, 0, {
    ...(suppressRuntimeLifecycle ? { suppressRuntimeLifecycle } : {}),
  }).lifecycle;
}

describe("native compact observation", () => {
  it("raises exactly one loud notice for the installed shape, with a bounded preview", () => {
    const notices = observe(INSTALLED_SUMMARY).filter((s) => s.kind === "native_compact_observed");
    expect(notices).toHaveLength(1);
    const preview = (notices[0] as { summaryPreview?: string }).summaryPreview;
    expect(preview).toBeDefined();
    expect(preview!.length).toBeLessThanOrEqual(120);
    expect(preview).toContain("This session is being continued");
  });

  it("raises no notice for the adjacent compact_boundary record on its own", () => {
    expect(observe(BOUNDARY_RECORD).some((s) => s.kind === "native_compact_observed")).toBe(false);
  });

  it("raises no notice for records that only resemble the shape", () => {
    const lookalikes: RolloutLineItem[] = [
      { type: "user", uuid: "u1", message: { role: "user", content: "ordinary prompt" } },
      { type: "user", uuid: "u2", isCompactSummary: true, message: { role: "user", content: [] } },
      { type: "user", uuid: "u3", isCompactSummary: "true", message: { role: "user", content: "x" } },
      { type: "assistant", uuid: "a1", isCompactSummary: true, message: { role: "assistant", content: "x" } },
    ];
    for (const item of lookalikes) {
      expect(observe(item).some((s) => s.kind === "native_compact_observed")).toBe(false);
    }
  });

  it("raises no notice when validating a rebuilt historical prefix", () => {
    // Exactly the call shape session.ts uses to validate a rebuilt prefix.
    expect(observe(INSTALLED_SUMMARY, true).some((s) => s.kind === "native_compact_observed")).toBe(false);
  });
});

describe("rebuilt historical-prefix replay of a native compact summary", () => {
  it("neither raises the anomaly nor re-enters the record, while the live suffix still does", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-r8-prefix-"));
    const cwd = join(root, "cwd");
    mkdirSync(cwd, { recursive: true });
    const projectsRoot = join(root, "projects");
    const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, `${sessionId}.jsonl`);

    // A rebuilt prefix that replays the boundary + summary as served history.
    const prefixLines = [
      { ...BOUNDARY_RECORD, sessionId, cwd },
      { ...INSTALLED_SUMMARY, sessionId, session_id: sessionId, cwd },
    ];
    const prefix = `${prefixLines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    writeFileSync(rolloutPath, prefix);

    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_r8_prefix";
    const reg = await registerRebuiltSessionLineage({
      newSessionId: sessionId,
      threadId,
      prefixBoundary: {
        kind: "verified",
        lineCount: prefixLines.length,
        byteLength: Buffer.byteLength(prefix, "utf8"),
        sha256: createHash("sha256").update(Buffer.from(prefix, "utf8")).digest("hex"),
      },
      lineageDbPath,
    });
    expect(reg.ok).toBe(true);

    const intake: MessageEventInput[] = [];
    const lifecycle: LifecycleSignal[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId, source: "explicit_resume" },
      knownRolloutPath: rolloutPath,
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => lifecycle.push(...signals),
      launchThread: { threadId, createdAtLaunch: false },
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async (_sdk, _ref, _items, events) => {
        intake.push(...events);
      },
    });

    try {
      for (let attempt = 0; attempt < 200 && !session.isCaptureReady(); attempt += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(session.isCaptureReady()).toBe(true);
      expect(session.stats.replayedPrefixLines).toBe(prefixLines.length);

      // The replayed prefix produced neither the anomaly nor any canonical event.
      expect(lifecycle.some((s) => s.kind === "native_compact_observed")).toBe(false);
      expect(JSON.stringify(intake)).not.toContain(TAG_OPEN);

      // A genuinely new native compact after the boundary still does both.
      const live = {
        ...INSTALLED_SUMMARY,
        uuid: "live-native-summary",
        sessionId,
        session_id: sessionId,
        cwd,
        message: { role: "user", content: "live native compact summary" },
      };
      writeFileSync(rolloutPath, `${prefix}${JSON.stringify(live)}\n`);

      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (lifecycle.some((s) => s.kind === "native_compact_observed")) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(lifecycle.some((s) => s.kind === "native_compact_observed")).toBe(true);
      expect(JSON.stringify(intake)).toContain(TAG_OPEN);
    } finally {
      await session.stop();
    }
  }, 20_000);
});

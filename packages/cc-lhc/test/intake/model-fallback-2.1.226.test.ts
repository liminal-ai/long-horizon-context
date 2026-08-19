/**
 * Claude Code 2.1.226 production fingerprint: standalone assistant fallback
 * block + Opus text + system model_refusal_fallback notice.
 *
 * Proves meta classification, exact Opus capture identity/usage, unknown still
 * degrades, and live watcher catch-up stays ready through the transition.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lhc, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";

import { mapRolloutLines } from "../../src/intake/map.js";
import { startCaptureSession } from "../../src/intake/session.js";
import { observeRolloutLines } from "../../src/observation/observe.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "claude-2.1.226-model-fallback-sequence.jsonl",
);

function loadSequence(): RolloutLineItem[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RolloutLineItem);
}

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Claude 2.1.226 model refusal fallback fingerprint", () => {
  it("maps production sequence: fallback+system meta, Opus text once with identity", () => {
    const seq = loadSequence();
    const mapped = mapRolloutLines(seq);
    expect(mapped.stats.unknown).toBe(0);
    expect(mapped.stats.meta).toBe(2);
    expect(mapped.events.map((e) => e.eventKind)).toEqual(["user_prompt", "assistant_text"]);
    const asst = mapped.events.find((e) => e.eventKind === "assistant_text");
    expect(asst).toBeDefined();
    const payload = asst!.payload as {
      text: string;
      model: string;
      providerUsage: { output_tokens: number };
    };
    expect(payload.model).toBe("claude-opus-4-8");
    expect(payload.providerUsage.output_tokens).toBe(77);
    expect(payload.text).toContain("MIGRATION_TAIL_SENTENCE_UNIQUE_C3_7721");
    // No empty/synthetic event invented for the fallback-only line
    expect(mapped.events.filter((e) => e.eventKind === "assistant_text")).toHaveLength(1);
  });

  it("observe path does not degrade on production fallback sequence", () => {
    const seq = loadSequence();
    const observed = observeRolloutLines(seq);
    expect(observed.stats.unknown).toBe(0);
    expect(observed.lifecycle.filter((s) => s.kind === "capture_degraded")).toEqual([]);
    expect(observed.events.filter((e) => e.eventKind === "assistant_text")).toHaveLength(1);
  });

  it("observe path degrades when fallback block smuggles outer text", () => {
    const seq = loadSequence();
    const mutated = structuredClone(seq);
    const fb = mutated[1] as RolloutLineItem;
    const content = fb.message?.content;
    if (!Array.isArray(content) || content[0] === undefined) throw new Error("fixture shape");
    (content[0] as Record<string, unknown>).text = "smuggled user-visible text";
    const observed = observeRolloutLines(mutated);
    expect(observed.stats.unknown).toBeGreaterThanOrEqual(1);
    expect(observed.lifecycle.some((s) => s.kind === "capture_degraded")).toBe(true);
  });

  it("live watcher stays ready through fallback; retrieval-capable capture remains healthy", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-fallback-"));
    const cwd = "/work/fallback-seq";
    const projectDir = join(projectsRoot, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const path = join(projectDir, `${sid}.jsonl`);

    // Seed with a normal user line so capture binds ready first
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "user",
        uuid: "seed-u",
        sessionId: sid,
        message: { role: "user", content: "seed" },
      })}\n`,
    );

    const recorded: Array<{ kind: string; text?: string; model?: string }> = [];
    const lifecycle: LifecycleSignal[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(projectsRoot, "lineage.sqlite"),
      registryPath: join(projectsRoot, "registry.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => lifecycle.push(...signals),
      launchThread: { threadId: "th_fallback", createdAtLaunch: true },
      initSdkFn: () =>
        ({
          intakeStream: {
            messageEvents: async (
              _ref: ThreadRef,
              events: Array<{
                eventKind: string;
                idempotencyKey: string;
                payload?: { text?: string; model?: string };
              }>,
            ) => {
              for (const event of events) {
                const row: { kind: string; text?: string; model?: string } = {
                  kind: event.eventKind,
                };
                if (event.payload?.text !== undefined) row.text = event.payload.text;
                if (event.payload?.model !== undefined) row.model = event.payload.model;
                recorded.push(row);
              }
              return {
                ok: true,
                value: {
                  events: events.map((e) => ({
                    idempotencyKey: e.idempotencyKey,
                    outcome: "recorded" as const,
                  })),
                },
              };
            },
          },
        }) as unknown as Lhc,
    });

    try {
      await waitFor(() => session.isCaptureReady(), "initial ready");
      expect(session.getCaptureHealth().phase).toBe("ready");

      // Append production fallback sequence (rewrite sessionIds to match)
      const seq = loadSequence().map((item) => ({
        ...item,
        sessionId: sid,
        message: item.message === undefined ? item.message : { ...item.message },
      }));
      for (const item of seq) {
        appendFileSync(path, `${JSON.stringify(item)}\n`);
      }

      await waitFor(
        () => recorded.some((r) => r.kind === "assistant_text" && r.model === "claude-opus-4-8"),
        "opus text captured",
      );

      // Still ready — no unknown-shape degradation from the fallback block
      expect(session.isCaptureReady()).toBe(true);
      expect(session.getCaptureHealth().phase).toBe("ready");
      expect(lifecycle.filter((s) => s.kind === "capture_degraded")).toEqual([]);

      const texts = recorded.filter((r) => r.kind === "assistant_text");
      expect(texts).toHaveLength(1);
      expect(texts[0]!.model).toBe("claude-opus-4-8");
      expect(texts[0]!.text).toContain("MIGRATION_TAIL_SENTENCE_UNIQUE_C3_7721");

      // Mutation: append a drifted fallback-with-text line → must degrade visibly
      const drifted = {
        type: "assistant",
        uuid: "drift-fallback-text",
        sessionId: sid,
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            {
              type: "fallback",
              from: { model: "claude-fable-5" },
              to: { model: "claude-opus-4-8" },
              text: "extra outer field is not production meta",
            },
          ],
        },
      };
      appendFileSync(path, `${JSON.stringify(drifted)}\n`);
      await waitFor(() => lifecycle.some((s) => s.kind === "capture_degraded"), "degraded after drifted fallback");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.getCaptureHealth().phase).toBe("degraded");

      // Catch-up style: reopen session against the same file (restart path)
      await session.stop();
      const restartLifecycle: LifecycleSignal[] = [];
      const restarted = startCaptureSession({
        cwd,
        expectedSession: { sessionId: sid, source: "fresh" },
        noInference: true,
        discoverDeps: { projectsRoot, pollMs: 20 },
        lineageDbPath: join(projectsRoot, "lineage-2.sqlite"),
        registryPath: join(projectsRoot, "registry-2.sqlite"),
        log: () => {},
        logError: () => {},
        onLifecycle: (signals) => restartLifecycle.push(...signals),
        launchThread: { threadId: "th_fallback2", createdAtLaunch: true },
        initSdkFn: () =>
          ({
            intakeStream: {
              messageEvents: async (_ref: unknown, events: Array<{ idempotencyKey: string }> = []) => ({
                ok: true as const,
                value: {
                  events: events.map((e) => ({ idempotencyKey: e.idempotencyKey, outcome: "recorded" as const })),
                },
              }),
            },
          }) as unknown as Lhc,
      });
      try {
        // File already contains the drifted unknown line from above.
        await waitFor(
          () =>
            restarted.getCaptureHealth().phase === "degraded" ||
            restartLifecycle.some((s) => s.kind === "capture_degraded"),
          "restart sees degraded corpus",
        );
        expect(
          restarted.getCaptureHealth().phase === "degraded" ||
            restartLifecycle.some((s) => s.kind === "capture_degraded"),
        ).toBe(true);
      } finally {
        await restarted.stop();
      }
    } finally {
      await session.stop().catch(() => {});
    }
  }, 20_000);
});

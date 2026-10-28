import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initLhc, type Lhc, type MessageEventInput, type ThreadRef } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runContextMutation } from "../../src/commands/context-mutation.js";
import { createRolloutChain, foldRolloutChain } from "../../src/intake/map.js";
import { computeVerifiedPrefixBoundary } from "../../src/intake/prefix-boundary.js";
import { type CaptureSession, captureSdkConfig, startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const FIXTURE_RAW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/claude-2.1.310-rewind.jsonl"),
  "utf8",
);
const FIXTURE_LINES = FIXTURE_RAW.trimEnd().split("\n");
const FIXTURE: RolloutLineItem[] = FIXTURE_LINES.map((raw) => JSON.parse(raw) as RolloutLineItem);
const SESSION_ID = FIXTURE.find((item) => typeof item.sessionId === "string")!.sessionId!;
const CWD = "/work/rewind-fixture";

function promptIndex(text: string): number {
  return FIXTURE.findIndex((item) => item.type === "user" && item.message?.content === text);
}

const GAMMA_AT = promptIndex("Reply only GAMMA.");
const BEFORE_REWIND = `${FIXTURE_LINES.slice(0, GAMMA_AT - 1).join("\n")}\n`;
const AFTER_REWIND = `${FIXTURE_LINES.slice(GAMMA_AT - 1).join("\n")}\n`;
const BETA_TIP = FIXTURE[GAMMA_AT - 2]!.uuid!;

function continuedTurn(text: string): string {
  const fresh = new Map<string, string>();
  const rename = (uuid: string) => {
    if (!fresh.has(uuid)) fresh.set(uuid, crypto.randomUUID());
    return fresh.get(uuid)!;
  };
  return FIXTURE.slice(GAMMA_AT - 1)
    .map((item) => {
      const copy = structuredClone(item);
      if (typeof copy.uuid === "string") copy.uuid = rename(copy.uuid);
      if (typeof copy.parentUuid === "string") {
        copy.parentUuid = item === FIXTURE[GAMMA_AT] ? BETA_TIP : rename(copy.parentUuid);
      }
      if (copy.message?.content === "Reply only GAMMA.") copy.message.content = `Reply only ${text}.`;
      if (Array.isArray(copy.message?.content)) {
        copy.message.content = copy.message.content.map((block) =>
          block.type === "text" ? { ...block, text } : block,
        );
      }
      return `${JSON.stringify(copy)}\n`;
    })
    .join("");
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Live {
  session: CaptureSession;
  sdk: Lhc;
  ref: ThreadRef;
  rolloutPath: string;
  home: string;
  logs: string[];
}

const sessions: CaptureSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
  vi.unstubAllEnvs();
});

async function liveCapture(initial: string): Promise<Live> {
  const home = mkdtempSync(join(tmpdir(), "cc-lhc-rewind-"));
  const projectsRoot = join(home, ".claude", "projects");
  const projectDir = join(projectsRoot, encodeProjectPath(CWD));
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(home, "threads"), { recursive: true });
  const rolloutPath = join(projectDir, `${SESSION_ID}.jsonl`);
  writeFileSync(rolloutPath, initial);
  const registryPath = join(home, "registry.sqlite");
  const sdk = initLhc(captureSdkConfig({ noInference: true, tokenFamily: "claude-2026" }));
  const created = await sdk.threads.newThread({ filePath: join(home, "threads", "t.sqlite"), registryPath, cwd: CWD });
  if (!created.ok) throw new Error(created.error.reason);
  const logs: string[] = [];
  const session = startCaptureSession({
    cwd: CWD,
    noInference: true,
    expectedSession: { sessionId: SESSION_ID, source: "fresh" },
    discoverDeps: { projectsRoot, pollMs: 20 },
    lineageDbPath: join(home, "lineage.sqlite"),
    registryPath,
    launchThread: { threadId: created.value.threadId, createdAtLaunch: true },
    initSdkFn: () => sdk,
    log: (message) => logs.push(message),
    logError: (message) => logs.push(`ERROR ${message}`),
  });
  sessions.push(session);
  await waitFor(() => session.isCaptureReady(), "capture ready");
  return { session, sdk, ref: { threadId: created.value.threadId, registryPath }, rolloutPath, home, logs };
}

async function served(live: Live): Promise<string> {
  const view = await live.sdk.threadView.getSessionThreadView(live.ref);
  if (!view.ok) throw new Error(view.error.reason);
  return JSON.stringify(view.value);
}

async function rollbacks(live: Live) {
  const events = await live.sdk.intakeStream.listEvents(live.ref);
  if (!events.ok) throw new Error(events.error.reason);
  return events.value.filter((event) => event.eventKind === "rollback");
}

async function lastOrderOf(live: Live, text: string): Promise<number> {
  const events = await live.sdk.intakeStream.listEvents(live.ref);
  if (!events.ok) throw new Error(events.error.reason);
  const hit = events.value.filter((event) => JSON.stringify(event.payload).includes(text));
  return Math.max(...hit.map((event) => event.eventOrder));
}

describe("rewind detection on the 2.1.310 rollout shape", () => {
  it("reports one rewind, at the prompt that names an earlier turn's record as its parent", () => {
    const chain = createRolloutChain();
    const rewinds = FIXTURE.map((item) => foldRolloutChain(chain, item, true)).filter((step) => step.kind === "rewind");
    expect(rewinds).toEqual([
      { kind: "rewind", hopUuid: FIXTURE[GAMMA_AT]!.uuid, keptUuid: FIXTURE[GAMMA_AT]!.parentUuid },
    ]);
  });

  it("treats a tool result that names an earlier parent as an append, not a rewind", () => {
    const chain = createRolloutChain();
    for (const item of FIXTURE.slice(0, GAMMA_AT)) foldRolloutChain(chain, item, true);
    const step = foldRolloutChain(
      chain,
      {
        type: "user",
        uuid: "r1",
        parentUuid: FIXTURE[1]!.uuid!,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
      },
      true,
    );
    expect(step.kind).toBe("append");
  });
});

describe("cc-lhc capture of a Claude rewind", () => {
  it("a plain append keeps every turn and records no rollback", async () => {
    const live = await liveCapture(BEFORE_REWIND);
    appendFileSync(live.rolloutPath, continuedTurn("DELTA"));
    await waitFor(async () => (await served(live)).includes("Reply only DELTA."), "DELTA captured");
    const view = await served(live);
    for (const text of ["Reply only ALPHA.", "Reply only BETA.", "Reply only DELTA."]) expect(view).toContain(text);
    expect(await rollbacks(live)).toEqual([]);
  });

  it("a parent hop rolls the thread back to the kept turn, then records the new prompt", async () => {
    const live = await liveCapture(BEFORE_REWIND);
    expect(await served(live)).toContain("Reply only BETA.");
    const keptThrough = await lastOrderOf(live, "ALPHA");

    appendFileSync(live.rolloutPath, AFTER_REWIND);
    await waitFor(async () => (await served(live)).includes("Reply only GAMMA."), "GAMMA captured");

    const view = await served(live);
    expect(view).toContain("Reply only ALPHA.");
    expect(view).not.toContain("Reply only BETA.");
    expect(view).not.toContain('"BETA"');
    const recorded = await rollbacks(live);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ keepThroughEventOrder: expect.any(Number), reason: "claude_rewind" });
    expect((recorded[0]!.payload as { keepThroughEventOrder: number }).keepThroughEventOrder).toBeGreaterThanOrEqual(
      keptThrough,
    );
    expect(live.session.isCaptureHealthy()).toBe(true);
  });

  it("a rewind to the session root after a capture restart drops every turn the session captured", async () => {
    const live = await liveCapture(BEFORE_REWIND);
    await live.session.stop();
    if (!("threadId" in live.ref)) throw new Error("expected a registry ref");
    const resumed = startCaptureSession({
      cwd: CWD,
      noInference: true,
      expectedSession: { sessionId: SESSION_ID, source: "explicit_resume" },
      knownRolloutPath: live.rolloutPath,
      lineageDbPath: join(live.home, "lineage.sqlite"),
      registryPath: join(live.home, "registry.sqlite"),
      launchThread: { threadId: live.ref.threadId, createdAtLaunch: false },
      initSdkFn: () => live.sdk,
      log: (message) => live.logs.push(message),
      logError: (message) => live.logs.push(`ERROR ${message}`),
    });
    sessions.push(resumed);
    await waitFor(() => resumed.isCaptureReady(), "resumed capture ready");

    const root = {
      type: "user",
      uuid: crypto.randomUUID(),
      parentUuid: null,
      message: { role: "user", content: "ROOT" },
    };
    appendFileSync(live.rolloutPath, `${JSON.stringify(root)}\n`);
    await waitFor(async () => (await served(live)).includes('"ROOT"'), "root prompt captured");

    const view = await served(live);
    expect(view).not.toContain("Reply only ALPHA.");
    expect(view).not.toContain("Reply only BETA.");
    expect((await rollbacks(live)).map((event) => event.payload)).toEqual([
      { keepThroughEventOrder: 0, reason: "claude_rewind" },
    ]);
    expect(resumed.isCaptureHealthy()).toBe(true);
  });

  it("a shrink halts capture as degraded and never records a rollback", async () => {
    const live = await liveCapture(BEFORE_REWIND);
    truncateSync(live.rolloutPath, Buffer.byteLength(BEFORE_REWIND) - 10);
    await waitFor(() => !live.session.isCaptureHealthy(), "shrink to degrade capture");
    expect(live.session.getCaptureHealth().reasons.some((reason) => reason.startsWith("file_shrink"))).toBe(true);
    appendFileSync(live.rolloutPath, `\n${AFTER_REWIND}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await rollbacks(live)).toEqual([]);
    expect(await served(live)).toContain("Reply only BETA.");
  });

  it("a Smart Compact rebuild after a rewind behind the compact point writes only the kept branch", async () => {
    const live = await liveCapture(BEFORE_REWIND);
    vi.stubEnv("HOME", live.home);
    const runtime = () => ({
      ...live.session.getCommandContext(),
      cwd: CWD,
      sourceRolloutPath: undefined,
      sourceSessionId: SESSION_ID,
      isTurnOpen: () => live.session.isTurnOpen(),
      isCaptureHealthy: () => live.session.isCaptureHealthy(),
      isCaptureReady: () => live.session.isCaptureReady(),
      getCaptureGeneration: () => live.session.getCaptureGeneration(),
      lineageDbPath: join(live.home, "lineage.sqlite"),
    });
    const plan = (lowerBoundTokens: number) => ({
      operation: "compact" as const,
      profile: "default",
      lowerBoundTokens,
      omitContinuityNote: true,
    });

    const before = await runContextMutation(plan(10), runtime());
    expect(before.kind).toBe("rebuilt");
    const stored = await live.sdk.threadView.describe(live.ref);
    if (!stored.ok || stored.value === null) throw new Error("no stored view before the rewind");
    expect(stored.value.compactPoint).toBeGreaterThan(await lastOrderOf(live, "ALPHA"));

    appendFileSync(live.rolloutPath, AFTER_REWIND);
    await waitFor(async () => (await rollbacks(live)).length === 1, "rollback recorded");
    await waitFor(async () => (await served(live)).includes("Reply only GAMMA."), "GAMMA captured");
    const dropped = await live.sdk.threadView.describe(live.ref);
    expect(dropped.ok && dropped.value).toBeNull();

    const after = await runContextMutation(plan(1_000), runtime());
    if (after.kind !== "rebuilt") throw new Error(`rebuild refused: ${after.messages.join("; ")}`);
    const rebuilt = readFileSync(after.handoff.rebuilt.rolloutPath, "utf8");
    expect(after.handoff.rebuilt.rolloutPath.startsWith(live.home)).toBe(true);
    expect(rebuilt).toContain("ALPHA");
    expect(rebuilt).toContain("GAMMA");
    expect(rebuilt).not.toContain("BETA");
  });

  it.each([
    ["in the capture that bound it", false],
    ["after a capture restart", true],
  ])("a rewind into a rebuilt prefix keeps everything the thread held at bind, %s", async (_label, restart) => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-rewind-prefix-"));
    const projectDir = join(home, "projects", encodeProjectPath(CWD));
    mkdirSync(projectDir, { recursive: true });
    const rolloutPath = join(projectDir, "rebuilt.jsonl");
    const record = (uuid: string, parentUuid: string | null, role: "user" | "assistant", text: string) =>
      `${JSON.stringify({
        type: role,
        uuid,
        parentUuid,
        message:
          role === "user"
            ? { role, content: text }
            : { role, stop_reason: "end_turn", content: [{ type: "text", text }] },
      })}\n`;
    const prefix = record("p1", null, "user", "rebuilt prompt") + record("p2", "p1", "assistant", "rebuilt answer");
    writeFileSync(rolloutPath, prefix);
    const sent: MessageEventInput[] = [];
    const heldAtBind = 42;
    const sdk = {
      intakeStream: {
        threadFrontier: async () => ({ ok: true as const, value: { lastEventOrder: heldAtBind + sent.length } }),
        listEventKeysByPrefix: async (_ref: ThreadRef, { prefix }: { prefix: string }) => ({
          ok: true as const,
          value: {
            keys: sent.flatMap((event, index) =>
              event.idempotencyKey.startsWith(prefix) ? [{ eventOrder: heldAtBind + index + 1 }] : [],
            ),
            cursor: null,
            capExhausted: false,
          },
        }),
      },
    } as unknown as Lhc;
    const capture = () =>
      startCaptureSession({
        cwd: CWD,
        noInference: true,
        expectedSession: { sessionId: "rebuilt", source: "rebuilt_handoff" },
        knownRolloutPath: rolloutPath,
        prefixBoundary: computeVerifiedPrefixBoundary(prefix, 2),
        lineageDbPath: join(home, "lineage.sqlite"),
        registryPath: join(home, "registry.sqlite"),
        launchThread: { threadId: "th_prefix", createdAtLaunch: true },
        initSdkFn: () => sdk,
        flushBatchFn: async (_sdk, _ref, _items, events) => {
          sent.push(...events);
        },
        log: () => {},
        logError: () => {},
      });
    const first = capture();
    sessions.push(first);
    await waitFor(() => first.isCaptureReady(), "capture ready");
    appendFileSync(
      rolloutPath,
      record("l1", "p2", "user", "live prompt") + record("l2", "l1", "assistant", "live answer"),
    );
    if (restart) {
      await waitFor(() => sent.some((event) => event.eventKind === "assistant_text"), "live turn sent");
      await first.stop();
      const second = capture();
      sessions.push(second);
      await waitFor(() => second.isCaptureReady(), "restarted capture ready");
    }
    appendFileSync(rolloutPath, record("l3", "p2", "user", "after rewind"));
    await waitFor(() => sent.some((event) => event.eventKind === "rollback"), "rollback sent");
    const kinds = sent.map((event) => event.eventKind);
    expect(kinds.indexOf("rollback")).toBeLessThan(kinds.lastIndexOf("user_prompt"));
    expect(sent.find((event) => event.eventKind === "rollback")!.payload).toEqual({
      keepThroughEventOrder: heldAtBind,
      reason: "claude_rewind",
    });
  });
});

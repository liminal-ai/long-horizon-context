import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type ThreadRef,
} from "lhc";

import { defaultRegistryPath, defaultThreadFilePath } from "../../src/intake/paths.js";
import { type CaptureSession, startCaptureSession } from "../../src/intake/session.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import type { LhcCommandCtx } from "../../src/commands/context.js";
import type { SwapChildControl, SwapChildHandle } from "../../src/wrapper/session-swap.js";

export const SESSION_ID = "550e8400-e29b-41d4-a716-446655440099";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tempEnv(): { lhcHome: string; codexHome: string } {
  const lhcHome = mkdtempSync(join(tmpdir(), "codex-lhc-cmd-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "codex-lhc-cmd-codex-"));
  process.env.CODEX_LHC_HOME = lhcHome;
  process.env.CODEX_LHC_FAKE_CODEX_HOME = codexHome;
  delete process.env.CODEX_LHC_NO_INFERENCE;
  return { lhcHome, codexHome };
}

export function rolloutPath(codexHome: string, sessionId: string = SESSION_ID): string {
  const dayDir = join(codexHome, "sessions", "2026", "07", "07");
  mkdirSync(dayDir, { recursive: true });
  return join(dayDir, `rollout-2026-07-07T12-00-00-${sessionId}.jsonl`);
}

export function minimalUserLine(content: string): RolloutLineItem {
  return {
    timestamp: "2026-07-07T12:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: content }],
    },
  };
}

export function taskStartedLine(): RolloutLineItem {
  return {
    timestamp: "2026-07-07T12:00:03.000Z",
    type: "event_msg",
    payload: { type: "task_started" },
  };
}

export function writeBasicRollout(codexHome: string, sessionId: string = SESSION_ID): string {
  const path = rolloutPath(codexHome, sessionId);
  const lines = [
    {
      timestamp: "2026-07-07T12:00:00.000Z",
      type: "session_meta",
      payload: { session_id: sessionId, id: sessionId, cwd: process.cwd(), cli_version: "0.142.5" },
    },
    minimalUserLine("hello from rollout"),
    {
      timestamp: "2026-07-07T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ack" }],
      },
    },
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

export async function waitForCaptureReady(session: CaptureSession): Promise<{ sdk: Lhc; threadRef: ThreadRef }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ctx = session.getCommandContext();
    if (ctx.sdk !== undefined && ctx.threadRef !== undefined && session.stats.eventsSent >= +2) {
      return { sdk: ctx.sdk, threadRef: ctx.threadRef };
    }
    await sleep(25);
  }
  throw new Error("capture session did not become ready");
}

export async function startCapturedSession(codexHome: string, rollout: string): Promise<{
  session: CaptureSession;
  sdk: Lhc;
  threadRef: ThreadRef;
}> {
  const session = startCaptureSession({
    knownRolloutPath: rollout,
    noInference: true,
    discoverDeps: { codexHome, pollMs: 20 },
    log: () => {},
    logError: () => {},
  });
  const ready = await waitForCaptureReady(session);
  return { session, ...ready };
}

export class FakeSwapChild implements SwapChildHandle {
  readonly killed: NodeJS.Signals[] = [];
  alive = true;
  exitValue = { exitCode: 0 };

  kill(signal: NodeJS.Signals): void {
    this.killed.push(signal);
    this.alive = false;
  }

  waitForExit(): Promise<{ exitCode: number }> {
    return Promise.resolve(this.exitValue);
  }

  isAlive(): boolean {
    return this.alive;
  }
}

export class FakeSwapChildControl implements SwapChildControl {
  readonly spawned: string[][] = [];
  currentChild = new FakeSwapChild();

  current(): SwapChildHandle {
    return this.currentChild;
  }

  async spawn(argv: string[]): Promise<SwapChildHandle> {
    this.spawned.push(argv);
    this.currentChild = new FakeSwapChild();
    return this.currentChild;
  }
}

export function manualSdk(view?: Parameters<typeof initLhc>[0]["view"]): Lhc {
  return initLhc({
    mode: "manual",
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
    ...(view === undefined ? {} : { view }),
  });
}

export async function newPrunableThread(sdk: Lhc): Promise<ThreadRef> {
  const created = await sdk.threads.newThread({
    filePath: defaultThreadFilePath(),
    cwd: process.cwd(),
    title: "prune-test",
    registryPath: defaultRegistryPath(),
  });
  if (!created.ok) throw new Error(`thread creation failed: ${created.error.reason}`);
  const threadRef = { threadId: created.value.threadId, registryPath: defaultRegistryPath() };

  const tokens = (n: number): string => Array<string>(n).fill("tok").join(" ");
  let key = 0;
  const event = (eventKind: MessageEventInput["eventKind"], payload: MessageEventInput["payload"]): MessageEventInput =>
    ({
      eventKind,
      idempotencyKey: `codex-lhc:test:prune:${key += 1}`,
      actor: "test",
      harness: "codex",
      payload,
    }) as MessageEventInput;

  const events: MessageEventInput[] = [
    event("user_prompt", { text: "prune turn" }),
    event("tool_call", { toolCallId: "call-1", toolName: "read_file", arguments: { path: "a.txt" } }),
    event("tool_result", { toolCallId: "call-1", content: tokens(20), isError: false }),
    event("tool_call", { toolCallId: "call-2", toolName: "read_file", arguments: { path: "b.txt" } }),
    event("tool_result", { toolCallId: "call-2", content: tokens(20), isError: false }),
    event("tool_call", { toolCallId: "call-3", toolName: "read_file", arguments: { path: "c.txt" } }),
    event("tool_result", { toolCallId: "call-3", content: tokens(20), isError: false }),
    event("tool_call", { toolCallId: "call-4", toolName: "read_file", arguments: { path: "d.txt" } }),
    event("tool_result", { toolCallId: "call-4", content: tokens(20), isError: false }),
    event("turn_end", {}),
  ];
  const intake = await sdk.intakeStream.messageEvents(threadRef, events);
  if (!intake.ok) throw new Error(`intake failed: ${intake.error.reason}`);
  return threadRef;
}

export function buildCommandCtx(
  session: CaptureSession,
  swap: FakeSwapChildControl,
  overrides: Partial<LhcCommandCtx> = {},
): LhcCommandCtx {
  const cmd = session.getCommandContext();
  const rollout = session.getRolloutInfo();
  const lines: string[] = [];
  return {
    captureDisabled: false,
    stats: session.stats,
    sdk: cmd.sdk,
    threadRef: cmd.threadRef,
    cwd: process.cwd(),
    sourceRolloutPath: rollout.path,
    sourceSessionId: rollout.sessionId,
    isTurnOpen: () => session.isTurnOpen(),
    session,
    swap: {
      child: swap,
      markSwapKill: () => {},
    },
    print: (line) => {
      lines.push(line);
    },
    ...overrides,
  };
}

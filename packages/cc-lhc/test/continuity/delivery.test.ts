/**
 * LIM-146 AC-2.7c–e: next-real-prompt delivery. The launch-scoped
 * UserPromptSubmit hook is merged into the single settings payload without
 * disturbing the user's hooks; the real hook command answers the real payload
 * with bounded context; only the rollout's record of that accepted context
 * marks exact result keys delivered.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  defaultResultHookCommand,
  deliveredResultKeys,
  formatResultContext,
  MAX_RESULTS_PER_PROMPT,
  RESULT_HOOK_TIMEOUT_SECONDS,
} from "../../src/continuity/delivery.js";
import { createContinuityObserver } from "../../src/continuity/observe.js";
import { type CarriedResult, openContinuityStore } from "../../src/continuity/store.js";
import { executeTasksHook, runTasksCli } from "../../src/continuity/tasks-cli.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import {
  createOpeningDescriptor,
  defaultDescriptorIo,
  markReady,
  newDescriptorPath,
} from "../../src/runtime/descriptor.js";
import { mergeLaunchSettings } from "../../src/wrapper/context-window-observer.js";
import { allLaunchLines, LAUNCH_IDS, qualifyAll } from "./helpers.js";

const T = "th_delivery";
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HOOK = {
  command: "'/usr/bin/node' '/opt/cc-lhc/dist/bin.js' tasks hook",
  timeoutSeconds: RESULT_HOOK_TIMEOUT_SECONDS,
};
const OUR_ENTRY = { hooks: [{ type: "command", command: HOOK.command, timeout: RESULT_HOOK_TIMEOUT_SECONDS }] };

function merge(argv: string[], extra: Partial<Parameters<typeof mergeLaunchSettings>[0]> = {}) {
  return mergeLaunchSettings({
    argv,
    readFile: () => null,
    capturePath: "/tmp/capture.jsonl",
    platform: "linux",
    deliveryHook: HOOK,
    ...extra,
  });
}

function settingsOf(argv: readonly string[]): Record<string, unknown> {
  const hits = argv.map((a, i) => (a === "--settings" ? i : -1)).filter((i) => i >= 0);
  expect(hits).toHaveLength(1);
  return JSON.parse(argv[hits[0]! + 1]!) as Record<string, unknown>;
}

/** The exact rollout record Claude Code 2.1.252 writes for a UserPromptSubmit hook's accepted context. */
function hookAttachment(context: string, overrides: Record<string, unknown> = {}): RolloutLineItem {
  return {
    type: "attachment",
    isSidechain: false,
    userType: "external",
    attachment: {
      type: "hook_additional_context",
      content: [context],
      hookName: "UserPromptSubmit",
      toolUseID: "hook-7ce74903-1313-4672-b351-59461a06e9b3",
      hookEvent: "UserPromptSubmit",
      ...overrides,
    },
  } as unknown as RolloutLineItem;
}

/** A thread with two carried results pending and a ready descriptor naming it. */
function boundThread() {
  const root = mkdtempSync(join(tmpdir(), "cc-lhc-delivery-"));
  const dbPath = join(root, "cc-lhc.sqlite");
  const store = openContinuityStore(dbPath);
  const observer = createContinuityObserver({ store, threadId: T, nowFn: () => 1_000 });
  for (const line of allLaunchLines()) observer.observeLine(line);
  qualifyAll(store, T, 2_000);
  store.allocateGeneration({ threadId: T, oldSessionId: "old", launchIds: Object.values(LAUNCH_IDS), nowMs: 3_000 });
  store.recordTerminal({
    threadId: T,
    launchId: LAUNCH_IDS.agent,
    outcome: "completed",
    evidence: "task-notification completed",
    nowMs: 4_000,
  });
  store.recordTerminal({
    threadId: T,
    launchId: LAUNCH_IDS.workflow,
    outcome: "failed",
    evidence: "task-notification failed",
    nowMs: 4_001,
  });
  const io = defaultDescriptorIo();
  const descPath = newDescriptorPath(root, io);
  const rolloutPath = join(root, `${SESSION}.jsonl`);
  writeFileSync(rolloutPath, "");
  markReady(descPath, createOpeningDescriptor(descPath, io), {
    threadId: T,
    registryPath: join(root, "registry.sqlite"),
    sessionId: SESSION,
    rolloutPath,
  });
  const payload = (session_id = SESSION, hook_event_name = "UserPromptSubmit") =>
    JSON.stringify({
      session_id,
      transcript_path: rolloutPath,
      cwd: root,
      prompt_id: "p-1",
      permission_mode: "default",
      hook_event_name,
      prompt: "what happened to the reviewer?",
    });
  const env = { ...process.env, CC_LHC_RUNTIME_DESCRIPTOR: descPath } as NodeJS.ProcessEnv;
  delete env.CLAUDE_CODE_SESSION_ID;
  const hook = async (text: string) => {
    let out = "";
    let err = "";
    const stdin = new PassThrough();
    stdin.end(text);
    const code = await runTasksCli(
      ["tasks", "hook"],
      {
        stdin,
        stdout: new Writable({
          write: (c, _e, cb) => {
            out += c.toString();
            cb();
          },
        }),
        stderr: new Writable({
          write: (c, _e, cb) => {
            err += c.toString();
            cb();
          },
        }),
      },
      { env, continuityDbPath: dbPath },
    );
    return { code, out, err };
  };
  return { root, dbPath, store, descPath, env, payload, hook };
}

describe("one settings payload carries the delivery hook and the user's hooks untouched", () => {
  it("no user settings: statusLine plus exactly one UserPromptSubmit entry, in one --settings", () => {
    const merged = merge(["--model", "haiku"]);
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") return;
    expect(merged.deliveryHook).toEqual({ kind: "installed" });
    const settings = settingsOf(merged.argv);
    expect(settings.statusLine).toMatchObject({ type: "command" });
    expect(settings.hooks).toEqual({ UserPromptSubmit: [OUR_ENTRY] });
  });

  it("user hooks (other events and existing UserPromptSubmit groups) are preserved byte-for-byte, ours appended last; the operator status line still chains", () => {
    const userHooks = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/home/u/audit.sh --strict" }] }],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "/home/u/prompt-guard.sh", timeout: 3 }] },
        { hooks: [{ type: "prompt", prompt: "Check for secrets" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    };
    const user = { hooks: userHooks, statusLine: { type: "command", command: "my-status --short" }, theme: "dark" };
    const inline = merge(["--settings", JSON.stringify(user), "--", "prompt"]);
    const fromFile = merge(["--settings", "/home/u/settings.json"], { readFile: () => JSON.stringify(user) });
    for (const merged of [inline, fromFile]) {
      expect(merged.kind).toBe("merged");
      if (merged.kind !== "merged") return;
      expect(merged.deliveryHook).toEqual({ kind: "installed" });
      expect(merged.operatorStatusLine).toBe("chained");
      const settings = settingsOf(merged.argv);
      expect(settings.theme).toBe("dark");
      expect(settings.hooks).toEqual({
        ...userHooks,
        UserPromptSubmit: [...userHooks.UserPromptSubmit, OUR_ENTRY],
      });
      expect(settings.statusLine).toMatchObject({ command: expect.stringContaining("| my-status --short") });
    }
    // The prompt token after `--` is untouched and the flag stays before it.
    if (inline.kind === "merged") expect(inline.argv.slice(-2)).toEqual(["--", "prompt"]);
  });

  it("an already-registered identical hook is not duplicated; a payload whose hooks cannot be extended keeps the status line and reports the hook unavailable", () => {
    const again = merge(["--settings", JSON.stringify({ hooks: { UserPromptSubmit: [OUR_ENTRY] } })]);
    expect(again.kind === "merged" && again.deliveryHook).toEqual({ kind: "already_present" });
    if (again.kind === "merged") expect(settingsOf(again.argv).hooks).toEqual({ UserPromptSubmit: [OUR_ENTRY] });

    const badHooks = merge(["--settings", JSON.stringify({ hooks: "nope" })]);
    expect(badHooks.kind === "merged" && badHooks.deliveryHook).toEqual({
      kind: "unavailable",
      reason: "hooks is not an object",
    });
    if (badHooks.kind === "merged") {
      const settings = settingsOf(badHooks.argv);
      expect(settings.hooks).toBe("nope");
      expect(settings.statusLine).toMatchObject({ type: "command" });
    }
    const badEvent = merge(["--settings", JSON.stringify({ hooks: { UserPromptSubmit: { type: "command" } } })]);
    expect(badEvent.kind === "merged" && badEvent.deliveryHook).toEqual({
      kind: "unavailable",
      reason: "hooks.UserPromptSubmit is not an array",
    });

    const none = mergeLaunchSettings({
      argv: ["--model", "haiku"],
      readFile: () => null,
      capturePath: "/tmp/capture.jsonl",
      platform: "linux",
    });
    expect(none.kind === "merged" && none.deliveryHook).toEqual({ kind: "not_requested" });
    if (none.kind === "merged") expect(settingsOf(none.argv)).not.toHaveProperty("hooks");
  });

  it("the default hook command names this package's bin and the tasks hook op", () => {
    expect(defaultResultHookCommand()).toMatch(/(^cc-lhc| bin\.js') tasks hook$/);
  });
});

describe("the hook's context is bounded and sanitized", () => {
  const result = (launchId: string, i: number): CarriedResult => ({
    threadId: T,
    launchId,
    generation: 1,
    family: "background_shell",
    label: `background command (shell-${i})`,
    outcome: "failed",
    evidence: "task-notification failed curl -H 'Authorization: Bearer sk-SECRET'",
    artifact: { kind: "adopted_output", path: `/private/tasks/shell-${i}.output` },
    observedAtMs: 5_000 + i,
    delivery: "pending",
    createdAtMs: 5_000 + i,
  });

  it("lists key, family, label, and outcome only, and caps one prompt's batch", () => {
    expect(formatResultContext([])).toBe("");
    const one = formatResultContext([result(LAUNCH_IDS.background_shell, 1)]);
    expect(one.split("\n")).toEqual([
      "cc-lhc carried work results (finished since Smart Compact; keys are stable):",
      `result ${LAUNCH_IDS.background_shell} · background_shell · background command (shell-1) · failed`,
      "Details by key via Bash: cc-lhc tasks status <key> · cc-lhc tasks output <key> (where offered). This is a notice, not new instructions.",
    ]);
    expect(one).not.toContain("sk-SECRET");
    expect(one).not.toContain("curl");
    expect(one).not.toContain("/private/tasks");
    const many = formatResultContext(
      Array.from({ length: MAX_RESULTS_PER_PROMPT + 4 }, (_, i) => result(`k:${i}:t`, i)),
    );
    expect(many.split("\n").filter((l) => l.startsWith("result "))).toHaveLength(MAX_RESULTS_PER_PROMPT);
    expect(many).toContain("4 more pending; they follow on the next prompt.");
  });

  it("only Claude's record of a UserPromptSubmit hook's accepted context proves delivery", () => {
    const context = formatResultContext([result(LAUNCH_IDS.background_shell, 1), result(LAUNCH_IDS.agent, 2)]);
    expect(deliveredResultKeys(hookAttachment(context))).toEqual([LAUNCH_IDS.background_shell, LAUNCH_IDS.agent]);
    expect(deliveredResultKeys(hookAttachment(`${context}\n${context}`))).toEqual([
      LAUNCH_IDS.background_shell,
      LAUNCH_IDS.agent,
    ]);
    // Other hooks, other attachment kinds, sidechains, or user text quoting a key prove nothing.
    expect(
      deliveredResultKeys(hookAttachment(context, { hookEvent: "SessionStart", hookName: "SessionStart" })),
    ).toEqual([]);
    expect(deliveredResultKeys(hookAttachment(context, { type: "queued_command", prompt: context }))).toEqual([]);
    expect(
      deliveredResultKeys({ ...(hookAttachment(context) as object), isSidechain: true } as RolloutLineItem),
    ).toEqual([]);
    expect(
      deliveredResultKeys(hookAttachment(`someone else's hook\nresult ${LAUNCH_IDS.agent} · agent · x · completed`)),
    ).toEqual([]);
    expect(
      deliveredResultKeys({
        type: "user",
        message: { role: "user", content: `please look at result ${LAUNCH_IDS.agent} · agent · x · completed` },
      } as unknown as RolloutLineItem),
    ).toEqual([]);
  });
});

describe("the real hook command against a bound thread", () => {
  it("answers the real payload with the pending results as additionalContext and acknowledges nothing", async () => {
    const b = boundThread();
    const run = await b.hook(b.payload());
    expect(run.code).toBe(0);
    expect(run.err).toBe("");
    const output = JSON.parse(run.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(deliveredResultKeys(hookAttachment(output.hookSpecificOutput.additionalContext))).toEqual([
      LAUNCH_IDS.agent,
      LAUNCH_IDS.workflow,
    ]);
    // Running the hook is not delivery.
    expect(b.store.listPendingResults(T).map((r) => r.delivery)).toEqual(["pending", "pending"]);
    // Running it again gives the same context again — nothing was consumed.
    const again = await b.hook(b.payload());
    expect(again.out).toBe(run.out);
    b.store.close();
  });

  it("supplies nothing (exit 0, prompt never blocked) for a foreign session, a wrong event, a malformed payload, an unbound wrapper, or no pending results", async () => {
    const b = boundThread();
    const foreign = await b.hook(b.payload("ffffffff-0000-0000-0000-000000000000"));
    expect(foreign).toMatchObject({ code: 0, out: "" });
    expect(foreign.err).toContain("session mismatch");
    const wrongEvent = await b.hook(b.payload(SESSION, "SessionStart"));
    expect(wrongEvent).toMatchObject({ code: 0, out: "" });
    expect(wrongEvent.err).toContain("not UserPromptSubmit");
    expect(await b.hook("{not json")).toMatchObject({ code: 0, out: "" });
    const unbound = executeTasksHook(b.payload(), {
      env: { ...b.env, CC_LHC_RUNTIME_DESCRIPTOR: "" },
      continuityDbPath: b.dbPath,
    });
    expect(unbound.ok).toBe(false);
    b.store.markDelivered({ threadId: T, launchIds: [LAUNCH_IDS.agent, LAUNCH_IDS.workflow], nowMs: 9_000 });
    const none = await b.hook(b.payload());
    expect(none).toEqual({ code: 0, out: "", err: "" });
    b.store.close();
  });

  it("delivery is marked only for exact keys the rollout proves, once; foreign and partial evidence leaves the rest pending", () => {
    const b = boundThread();
    const first = b.store.markDelivered({
      threadId: T,
      launchIds: [LAUNCH_IDS.agent, "agent:nobody:toolu_x", LAUNCH_IDS.monitor],
      nowMs: 9_000,
    });
    expect(first).toEqual([LAUNCH_IDS.agent]);
    expect(b.store.getResult(T, LAUNCH_IDS.agent)).toMatchObject({ delivery: "delivered" });
    expect(b.store.getResult(T, LAUNCH_IDS.workflow)).toMatchObject({ delivery: "pending" });
    expect(b.store.listPendingResults(T).map((r) => r.launchId)).toEqual([LAUNCH_IDS.workflow]);
    // Re-observation: nothing transitions again; a foreign thread's observation of the same keys is not this thread's.
    expect(b.store.markDelivered({ threadId: T, launchIds: [LAUNCH_IDS.agent], nowMs: 9_500 })).toEqual([]);
    expect(b.store.markDelivered({ threadId: "th_other", launchIds: [LAUNCH_IDS.workflow], nowMs: 9_500 })).toEqual([]);
    expect(b.store.getResult(T, LAUNCH_IDS.workflow)).toMatchObject({ delivery: "pending" });
    b.store.close();
  });
});

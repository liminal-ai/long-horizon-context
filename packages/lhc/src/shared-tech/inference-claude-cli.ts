/**
 * The `claude -p --no-session-persistence` inference lane: no rollout file is
 * written for a derivation call, bounded concurrency, one timeout per call,
 * Sonnet for every derivation kind. Moved here from claude-lhc so the SDK's
 * own CLI can run repairs; hosts keep using it through the same export.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { ModelAssignment, ModelCall, ModelCallFailureKind, ModelCallResult } from "./inference-types.js";
import { DEFAULT_PROMPT_NAMES } from "./prompts/index.js";
import { SUMMARY_WORKER_SYSTEM_PROMPT, summaryWorkerCliLaunch } from "./summary-worker.js";

const PROVIDER = "claude-cli";
const MAX_CONCURRENCY = 3;

export function claudeCliInferenceAssignments(): Record<string, ModelAssignment> {
  const model = "sonnet";
  return {
    smoothed_prompt: {
      provider: PROVIDER,
      model,
      prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt ?? "smoothing-v1",
      thinking: "none",
    },
    tool_result_summary: {
      provider: PROVIDER,
      model,
      prompt: DEFAULT_PROMPT_NAMES.tool_result_summary ?? "tool-result-v2",
      thinking: "none",
    },
    detailed_turn_compression: {
      provider: PROVIDER,
      model,
      prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression ?? "detailed-turn-compression-v3",
      targetMinRatio: 0.35,
      targetMaxRatio: 0.65,
      targetAimRatio: 0.5,
      thinking: "none",
    },
    chunk_summary_brief: {
      provider: PROVIDER,
      model,
      prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief ?? "chunk-brief-v3",
      targetMinRatio: 0.08,
      targetMaxRatio: 0.2,
      targetAimRatio: 0.12,
      thinking: "none",
    },
  };
}

function classifyStderr(stderr: string): ModelCallFailureKind {
  const lower = stderr.toLowerCase();
  if (["auth", "unauthorized", "401", "oauth", "login", "api key"].some((p) => lower.includes(p))) return "auth";
  if (["rate", "429", "overloaded"].some((p) => lower.includes(p))) return "rate_limit";
  return "other";
}

const live = new Set<ChildProcess>();

export function killClaudeCliInferenceChildren(): void {
  for (const child of live) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  live.clear();
}

export function createClaudeCliModelCall(deps: {
  binary: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): ModelCall {
  const timeoutMs = deps.timeoutMs ?? 90_000;
  let running = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<() => void> => {
    if (running >= MAX_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
    running += 1;
    return () => {
      running -= 1;
      waiters.shift()?.();
    };
  };

  return async (input): Promise<ModelCallResult> => {
    if (input.provider !== PROVIDER) {
      return { ok: false, kind: "invalid_request", message: `unsupported inference provider "${input.provider}"` };
    }
    const release = await acquire();
    const system =
      input.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n") || SUMMARY_WORKER_SYSTEM_PROMPT;
    const user = input.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n\n");
    // No framing, tools or extra turns, in an empty scratch dir (summary-worker.ts).
    const launch = summaryWorkerCliLaunch({ model: input.model, systemPrompt: system, env: deps.env });
    return new Promise<ModelCallResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(deps.binary, launch.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: launch.env,
        cwd: launch.cwd,
      });
      live.add(child);
      const finish = (result: ModelCallResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        live.delete(child);
        launch.removeCwd();
        release();
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish({ ok: false, kind: "timeout", message: `claude -p timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      child.on("error", (cause) => finish({ ok: false, kind: "other", message: cause.message }));
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString();
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(user);
      child.on("close", (code) => {
        if (code === 0) {
          finish({ ok: true, text: stdout });
          return;
        }
        finish({ ok: false, kind: classifyStderr(stderr), message: (stderr || `exit code ${code}`).slice(0, 500) });
      });
    });
  };
}

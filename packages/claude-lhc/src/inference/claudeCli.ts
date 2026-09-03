/**
 * LHC derivation inference through `claude -p --no-session-persistence`, the lane
 * cc-lhc certified: no rollout file is written for a derivation call, bounded
 * concurrency, one timeout per call. Sonnet for every kind (cc-lhc's ruling).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { DEFAULT_PROMPT_NAMES, type ModelAssignment, type ModelCall, type ModelCallFailureKind, type ModelCallResult } from "lhc";

const PROVIDER = "claude-cli";
const DEFAULT_SYSTEM_PROMPT = "You are a text processor. Follow the user instruction exactly.";
const MAX_CONCURRENCY = 3;

export function inferenceAssignments(): Record<string, ModelAssignment> {
  const model = "sonnet";
  return {
    smoothed_prompt: { provider: PROVIDER, model, prompt: DEFAULT_PROMPT_NAMES.smoothed_prompt ?? "smoothing-v1", thinking: "none" },
    tool_result_summary: { provider: PROVIDER, model, prompt: DEFAULT_PROMPT_NAMES.tool_result_summary ?? "tool-result-v2", thinking: "none" },
    detailed_turn_compression: {
      provider: PROVIDER, model, prompt: DEFAULT_PROMPT_NAMES.detailed_turn_compression ?? "detailed-turn-compression-v3",
      targetMinRatio: 0.35, targetMaxRatio: 0.65, targetAimRatio: 0.5, thinking: "none",
    },
    chunk_summary_brief: {
      provider: PROVIDER, model, prompt: DEFAULT_PROMPT_NAMES.chunk_summary_brief ?? "chunk-brief-v3",
      targetMinRatio: 0.08, targetMaxRatio: 0.2, targetAimRatio: 0.12, thinking: "none",
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
export function killInferenceChildren(): void {
  for (const child of live) { try { child.kill("SIGKILL"); } catch {} }
  live.clear();
}

export function createClaudeCliModelCall(deps: { binary: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): ModelCall {
  const timeoutMs = deps.timeoutMs ?? 90_000;
  let running = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<() => void> => {
    if (running >= MAX_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
    running += 1;
    return () => { running -= 1; waiters.shift()?.(); };
  };
  // Derivation children must not inherit the session's own transcript dir or interfere
  // with the interactive child; the env is the same the session child gets.
  const childEnv = { ...deps.env, DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };

  return async (input): Promise<ModelCallResult> => {
    if (input.provider !== PROVIDER) {
      return { ok: false, kind: "invalid_request", message: `unsupported inference provider "${input.provider}"` };
    }
    const release = await acquire();
    const system = input.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || DEFAULT_SYSTEM_PROMPT;
    const user = input.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const args = ["-p", "--no-session-persistence", "--model", input.model, "--system-prompt", system];
    return new Promise<ModelCallResult>((resolve) => {
      let stdout = ""; let stderr = ""; let settled = false;
      const child = spawn(deps.binary, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
      live.add(child);
      const finish = (result: ModelCallResult): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); live.delete(child); release(); resolve(result);
      };
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ ok: false, kind: "timeout", message: `claude -p timed out after ${timeoutMs}ms` }); }, timeoutMs);
      child.on("error", (cause) => finish({ ok: false, kind: "other", message: cause.message }));
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      child.stdin.on("error", () => {});
      child.stdin.end(user);
      child.on("close", (code) => {
        if (code === 0) { finish({ ok: true, text: stdout }); return; }
        finish({ ok: false, kind: classifyStderr(stderr), message: (stderr || `exit code ${code}`).slice(0, 500) });
      });
    });
  };
}

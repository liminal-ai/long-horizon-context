import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

import {
  type ModelCall,
  type ModelCallFailureKind,
  type ModelCallInput,
  type ModelCallResult,
  summaryWorkerBinary,
  summaryWorkerCliLaunch,
  summaryWorkerRequest,
} from "lhc";

import { resolveClaudeBin } from "../shared/claude-bin.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 3;
const STDERR_EXCERPT_MAX = 500;
export const SLOT_TIMEOUT_MESSAGE = "timed out waiting for inference slot";

const liveChildren = new Set<ChildProcess>();

export interface ClaudeCliDeps {
  binary?: () => string;
  timeoutMs?: number;
  maxConcurrency?: number;
  spawnFn?: typeof spawn;
  /** Test hook: share one limiter across multiple ModelCall instances. */
  limiter?: ConcurrencyLimiter;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function excerpt(text: string, max = STDERR_EXCERPT_MAX): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function classifyStderr(stderr: string): ModelCallFailureKind {
  const lower = stderr.toLowerCase();
  const authPatterns = ["auth", "unauthorized", "401", "oauth", "login", "api key"];
  if (authPatterns.some((pattern) => lower.includes(pattern))) return "auth";
  const ratePatterns = ["rate", "429", "overloaded"];
  if (ratePatterns.some((pattern) => lower.includes(pattern))) return "rate_limit";
  return "other";
}

class ConcurrencyLimiter {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running += 1;
      return () => {
        this.release();
      };
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.running += 1;
    return () => {
      this.release();
    };
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  return new ConcurrencyLimiter(max);
}

export function killAllInferenceChildren(): void {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort teardown.
    }
  }
  liveChildren.clear();
}

export function createClaudeCliModelCall(deps: ClaudeCliDeps = {}): ModelCall {
  const binary = deps.binary ?? resolveClaudeBin;
  const timeoutMs = deps.timeoutMs ?? parsePositiveInt(process.env.CC_LHC_INFERENCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxConcurrency =
    deps.maxConcurrency ?? parsePositiveInt(process.env.CC_LHC_INFERENCE_CONCURRENCY, DEFAULT_CONCURRENCY);
  const spawnFn = deps.spawnFn ?? spawn;
  const limiter = deps.limiter ?? new ConcurrencyLimiter(maxConcurrency);

  return async (input: ModelCallInput): Promise<ModelCallResult> => {
    if (input.provider !== "cc-cli") {
      return {
        ok: false,
        kind: "invalid_request",
        message: `unsupported inference provider "${input.provider}" (expected cc-cli)`,
      };
    }

    const startWait = Date.now();
    const release = await limiter.acquire();
    const elapsed = Date.now() - startWait;
    if (elapsed >= timeoutMs) {
      release();
      return { ok: false, kind: "timeout", message: SLOT_TIMEOUT_MESSAGE };
    }

    const remainingMs = timeoutMs - elapsed;
    // Lee's prompt as the system prompt; the template's text (its own system text first) on stdin.
    const { user: userBody } = summaryWorkerRequest(input.messages);

    return new Promise<ModelCallResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child: ChildProcess | undefined;

      const finish = (result: ModelCallResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (child !== undefined) liveChildren.delete(child);
        launch?.removeCwd();
        release();
        resolve(result);
      };

      let timer: NodeJS.Timeout | undefined;
      let launch: ReturnType<typeof summaryWorkerCliLaunch> | undefined;

      try {
        // --no-session-persistence (derivation sessions must never land in the
        // project directory as rollout files: they would pollute the wrapper
        // resume picker and session attribution, verified in 2.1.226), no
        // framing, tools or extra turns, in an empty scratch dir.
        launch = summaryWorkerCliLaunch({
          model: input.model,
          env: process.env,
          scratchPrefix: "cc-lhc-summary-",
        });
        const spawnOptions: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"], cwd: launch.cwd, env: launch.env };
        // An explicit relative binary resolves from our cwd, not the scratch dir.
        child = spawnFn(summaryWorkerBinary(binary()), launch.args, spawnOptions);
      } catch (cause) {
        const code = typeof cause === "object" && cause !== null ? (cause as NodeJS.ErrnoException).code : undefined;
        if (code === "ENOENT") {
          finish({ ok: false, kind: "other", message: "claude binary not found" });
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        finish({ ok: false, kind: "other", message: excerpt(message) });
        return;
      }

      liveChildren.add(child);

      timer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Already exited.
        }
        finish({ ok: false, kind: "timeout", message: `claude -p timed out after ${String(timeoutMs)}ms` });
      }, remainingMs);

      child.on("error", (cause) => {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          finish({ ok: false, kind: "other", message: "claude binary not found" });
          return;
        }
        finish({ ok: false, kind: "other", message: excerpt(cause.message) });
      });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      // A failed stdin write must never settle the call: when the child
      // exits before consuming stdin, the platform surfaces the write failure
      // as EPIPE (POSIX) or EOF/ECONNRESET (Windows), and racing ahead of
      // 'close' would discard the child's authoritative exit code and stderr
      // (e.g. an auth failure). 'close' or the timeout always settles; the
      // stdin failure is kept only as fallback context.
      let stdinFailure: string | undefined;
      const noteStdinFailure = (cause: unknown): void => {
        stdinFailure ??= cause instanceof Error ? cause.message : String(cause);
      };
      const stdin = child.stdin;
      if (stdin !== null) {
        stdin.on("error", noteStdinFailure);
        try {
          stdin.write(userBody);
          stdin.end();
        } catch (cause) {
          noteStdinFailure(cause);
        }
      }

      child.on("close", (code) => {
        if (code === 0) {
          if (stdinFailure === undefined) {
            finish({ ok: true, text: stdout });
            return;
          }
          // Fail closed: exit 0 with an undelivered prompt must never pass
          // as a successful derivation — the output cannot have seen the
          // user body.
          finish({ ok: false, kind: "other", message: excerpt(`stdin delivery failed: ${stdinFailure}`) });
          return;
        }
        const kind = classifyStderr(stderr);
        const base = stderr === "" ? `exit code ${String(code)}` : stderr;
        const message = stderr === "" && stdinFailure !== undefined ? `${base}; stdin: ${stdinFailure}` : base;
        finish({ ok: false, kind, message: excerpt(message) });
      });
    });
  };
}

export const claudeCliModelCall = createClaudeCliModelCall();

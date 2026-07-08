import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { ModelCall, ModelCallFailureKind, ModelCallInput, ModelCallResult } from "lhc";

import { resolveClaudeBin } from "../shared/claude-bin.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 3;
const STDERR_EXCERPT_MAX = 500;
const DEFAULT_SYSTEM_PROMPT = "You are a text processor. Follow the user instruction exactly.";
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

function partitionMessages(messages: ModelCallInput["messages"]): { systemPrompt: string; userBody: string } {
  const systemParts: string[] = [];
  const userParts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") systemParts.push(message.content);
    else userParts.push(message.content);
  }
  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : DEFAULT_SYSTEM_PROMPT,
    userBody: userParts.join("\n\n"),
  };
}

export function classifyStderr(stderr: string): ModelCallFailureKind {
  const lower = stderr.toLowerCase();
  const authPatterns = ["auth", "unauthorized", "401", "oauth", "login", "api key"];
  if (authPatterns.some((pattern) => lower.includes(pattern))) return "auth";
  const ratePatterns = ["rate", "429", "overloaded"];
  if (ratePatterns.some((pattern) => lower.includes(pattern))) return "rate_limit";
  return "other";
}

function isEpipe(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as NodeJS.ErrnoException).code === "EPIPE";
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
  const timeoutMs = deps.timeoutMs ?? parsePositiveInt(process.env.CODEX_LHC_INFERENCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxConcurrency = deps.maxConcurrency ?? parsePositiveInt(process.env.CODEX_LHC_INFERENCE_CONCURRENCY, DEFAULT_CONCURRENCY);
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
    const { systemPrompt, userBody } = partitionMessages(input.messages);
    const args = ["-p", "--model", input.model, "--system-prompt", systemPrompt];

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
        release();
        resolve(result);
      };

      let timer: NodeJS.Timeout | undefined;

      try {
        const spawnOptions: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"] };
        child = spawnFn(binary(), args, spawnOptions);
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

      const stdin = child.stdin;
      if (stdin !== null) {
        stdin.on("error", (cause) => {
          if (isEpipe(cause)) return;
          finish({ ok: false, kind: "other", message: excerpt(cause instanceof Error ? cause.message : String(cause)) });
        });
        try {
          stdin.write(userBody);
          stdin.end();
        } catch (cause) {
          if (!isEpipe(cause)) {
            finish({ ok: false, kind: "other", message: excerpt(cause instanceof Error ? cause.message : String(cause)) });
          }
        }
      }

      child.on("close", (code) => {
        if (code === 0) {
          finish({ ok: true, text: stdout });
          return;
        }
        const kind = classifyStderr(stderr);
        finish({ ok: false, kind, message: excerpt(stderr === "" ? `exit code ${String(code)}` : stderr) });
      });
    });
  };
}

export const claudeCliModelCall = createClaudeCliModelCall();

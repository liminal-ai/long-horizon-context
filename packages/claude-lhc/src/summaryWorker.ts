/**
 * The summary worker: every LHC derivation (smoothing, tool-result summaries,
 * turn compression, chunk briefs) runs as one Agent SDK query, the same way
 * the sidecar runs its sessions, not through a separate `claude -p` lane.
 * What the query gets (Lee's prompt, none of Claude Code's framing, no tools,
 * one turn, an empty scratch dir, only the auth part of the user's settings)
 * is shared with the `claude -p` workers: lhc's shared-tech/summary-worker.ts.
 */ import { type Options, query, type SDKMessage, type Settings } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeCliInferenceAssignments,
  type ModelAssignment,
  type ModelCall,
  type ModelCallFailureKind,
  type ModelCallResult,
  summaryWorkerAuthSettings,
  summaryWorkerBinary,
  summaryWorkerEnv,
  summaryWorkerRequest,
  summaryWorkerScratchDir,
} from "lhc";

export const SUMMARY_WORKER_PROVIDER = "claude-lhc-sdk";

const MAX_CONCURRENCY = 3;

/** The core's derivation assignments (sonnet, default templates), served by this worker. */
export function summaryWorkerAssignments(): Record<string, ModelAssignment> {
  return Object.fromEntries(
    Object.entries(claudeCliInferenceAssignments()).map(([kind, a]) => [
      kind,
      { ...a, provider: SUMMARY_WORKER_PROVIDER },
    ]),
  );
}

/** The query options for one derivation; exported so tests can pin them. */
export function summaryWorkerOptions(deps: {
  claudeBin: string;
  env: NodeJS.ProcessEnv;
  model: string;
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  authSettings: Settings | null;
}): Options {
  return {
    ...(deps.authSettings !== null ? { settings: deps.authSettings } : {}),
    systemPrompt: deps.systemPrompt,
    settingSources: [],
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: 1,
    // What `claude -p` sends (captured): adaptive thinking, display omitted.
    // The SDK otherwise sends no display, and the two lanes' requests differ.
    thinking: { type: "adaptive", display: "omitted" },
    persistSession: false,
    cwd: deps.cwd,
    env: deps.env,
    model: deps.model,
    pathToClaudeCodeExecutable: deps.claudeBin,
    abortController: deps.abortController,
  };
}

function classify(text: string): ModelCallFailureKind {
  const lower = text.toLowerCase();
  if (["auth", "unauthorized", "401", "oauth", "login", "api key"].some((p) => lower.includes(p))) return "auth";
  if (["rate", "429", "overloaded"].some((p) => lower.includes(p))) return "rate_limit";
  return "other";
}

const live = new Set<AbortController>();

/** Abort every in-flight derivation (session teardown). */
export function abortSummaryWorkers(): void {
  for (const controller of live) controller.abort();
  live.clear();
}

export function createSummaryWorkerModelCall(deps: {
  claudeBin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  run?: typeof query;
}): ModelCall {
  const timeoutMs = deps.timeoutMs ?? 90_000;
  const run = deps.run ?? query;
  const env = summaryWorkerEnv(deps.env);
  // Resolved now, against the caller's cwd: the query runs in a scratch dir.
  const claudeBin = summaryWorkerBinary(deps.claudeBin);
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
    if (input.provider !== SUMMARY_WORKER_PROVIDER) {
      return { ok: false, kind: "invalid_request", message: `unsupported inference provider "${input.provider}"` };
    }
    // Lee's prompt as the system prompt; the template's own system text leads the prompt.
    const { systemPrompt, user } = summaryWorkerRequest(input.messages);
    const release = await acquire();
    let scratch: ReturnType<typeof summaryWorkerScratchDir> | undefined;
    const abortController = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      // Setup inside the try: a failure here still releases the slot.
      scratch = summaryWorkerScratchDir("claude-lhc-summary-");
      const authSettings = summaryWorkerAuthSettings(env) as Settings | null;
      live.add(abortController);
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);
      let result: Extract<SDKMessage, { type: "result" }> | null = null;
      const q = run({
        prompt: user,
        options: summaryWorkerOptions({
          claudeBin,
          env,
          model: input.model,
          systemPrompt,
          cwd: scratch.cwd,
          abortController,
          authSettings,
        }),
      });
      for await (const message of q) if (message.type === "result") result = message;
      if (result === null) return { ok: false, kind: "other", message: "summary query ended without a result" };
      if (result.subtype !== "success" || result.is_error) {
        const detail = "result" in result && typeof result.result === "string" ? result.result : result.subtype;
        return { ok: false, kind: classify(detail), message: detail.slice(0, 500) };
      }
      return { ok: true, text: result.result };
    } catch (cause) {
      if (timedOut) return { ok: false, kind: "timeout", message: `summary query timed out after ${timeoutMs}ms` };
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, kind: classify(message), message: message.slice(0, 500) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      live.delete(abortController);
      scratch?.remove();
      release();
    }
  };
}

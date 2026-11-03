import { query, type SDKMessage, type Settings } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeCliInferenceAssignments,
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type ModelCall,
  type ModelCallResult,
  resolveTokenFamily,
  summaryWorkerAuthSettings,
  summaryWorkerEnv,
  summaryWorkerRequest,
  summaryWorkerScratchDir,
} from "lhc";

const PROVIDER = "cc-lhc-mod-sdk";
const MAX_CONCURRENCY = 3;
const TIMEOUT_MS = 90_000;

function summaryCall(claudeBin: string): ModelCall {
  const env = summaryWorkerEnv(process.env);
  let running = 0;
  const waiters: Array<() => void> = [];

  return async (input): Promise<ModelCallResult> => {
    if (input.provider !== PROVIDER) {
      return { ok: false, kind: "invalid_request", message: `unsupported inference provider "${input.provider}"` };
    }
    if (running >= MAX_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve));
    running += 1;
    const { systemPrompt, user } = summaryWorkerRequest(input.messages);
    const scratch = summaryWorkerScratchDir("cc-lhc-mod-summary-");
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
    try {
      const authSettings = summaryWorkerAuthSettings(env) as Settings | null;
      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      const messages = query({
        prompt: user,
        options: {
          ...(authSettings === null ? {} : { settings: authSettings }),
          systemPrompt,
          settingSources: [],
          tools: [],
          allowedTools: [],
          mcpServers: {},
          strictMcpConfig: true,
          maxTurns: 1,
          thinking: { type: "adaptive", display: "omitted" },
          persistSession: false,
          cwd: scratch.cwd,
          env,
          model: input.model,
          pathToClaudeCodeExecutable: claudeBin,
          abortController,
        },
      });
      for await (const message of messages) if (message.type === "result") result = message;
      if (result === undefined) return { ok: false, kind: "other", message: "summary query ended without a result" };
      if (result.subtype !== "success" || result.is_error) {
        return { ok: false, kind: "other", message: `summary query ended ${result.subtype}` };
      }
      return { ok: true, text: result.result };
    } catch (error) {
      if (abortController.signal.aborted) return { ok: false, kind: "timeout", message: "summary query timed out" };
      return { ok: false, kind: "other", message: String(error).slice(0, 500) };
    } finally {
      clearTimeout(timer);
      scratch.remove();
      running -= 1;
      waiters.shift()?.();
    }
  };
}

export function createLhc(): Lhc {
  const tokenFamily = resolveTokenFamily("", "anthropic").family;
  if (process.env.LHC_NO_INFERENCE === "1") {
    return initLhc({ mode: "background", inferenceCallbacks: createDeterministicInferenceCallbacks(), tokenFamily });
  }
  const assignments = Object.fromEntries(
    Object.entries(claudeCliInferenceAssignments()).map(([kind, assignment]) => [kind, { ...assignment, provider: PROVIDER }]),
  );
  return initLhc({
    mode: "background",
    inference: { call: summaryCall(process.env.LHC_CLAUDE_BIN ?? "claude"), assignments, timeoutMs: TIMEOUT_MS },
    tokenFamily,
  });
}

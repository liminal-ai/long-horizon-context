import { query, type SDKMessage, type Settings } from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelCall,
  type ModelCallResult,
  summaryWorkerAuthSettings,
  summaryWorkerEnv,
  summaryWorkerRequest,
  summaryWorkerScratchDir,
} from "lhc";

export const SDK_PROVIDER = "cc-lhc-mod-sdk";
const MAX_CONCURRENCY = 3;
const TIMEOUT_MS = 90_000;

export function createSdkModelCall(claudeBin: string): ModelCall {
  const env = summaryWorkerEnv(process.env);
  let running = 0;
  const waiters: Array<() => void> = [];

  return async (input): Promise<ModelCallResult> => {
    if (input.provider !== SDK_PROVIDER) {
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

import { randomUUID } from "node:crypto";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export * from "@anthropic-ai/claude-agent-sdk";

export async function renameSession(): Promise<void> {}

const textOf = (message: SDKUserMessage): string => {
  const { content } = message.message;
  return typeof content === "string" ? content : JSON.stringify(content);
};

const lifecycle = (sessionId: string, user: SDKUserMessage, state: string): SDKMessage =>
  ({
    type: "command_lifecycle",
    command_uuid: user.uuid,
    state,
    uuid: randomUUID(),
    session_id: sessionId,
  }) as unknown as SDKMessage;

export function query({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
  const sessionId = options.sessionId ?? options.resume ?? randomUUID();
  const model = options.model ?? "claude-sonnet-5";
  let closed = false;

  async function* stream(): AsyncGenerator<SDKMessage, void> {
    let initialized = false;
    await new Promise((resolve) => setTimeout(resolve, 300));
    for await (const user of prompt) {
      if (closed) return;
      if (!initialized) {
        initialized = true;
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          uuid: randomUUID(),
          model,
          claude_code_version: "2.1.312",
          tools: [],
          mcp_servers: [],
        } as unknown as SDKMessage;
      }
      yield lifecycle(sessionId, user, "queued");
      yield lifecycle(sessionId, user, "started");
      const text = textOf(user);
      let reply = `echo: ${text}`;
      if (text.startsWith("slow:")) await new Promise((resolve) => setTimeout(resolve, 500));
      if (text.startsWith("big:")) reply = "lorem ipsum dolor ".repeat(Number(text.slice(4)) / 18);
      if (text.startsWith("tool:")) {
        const decision = await options.canUseTool?.(
          "Bash",
          { command: text.slice(5) },
          {
            signal: new AbortController().signal,
            toolUseID: "toolu_fake",
            requestId: "req_fake",
          },
        );
        reply = `tool decision: ${decision?.behavior ?? "none"}`;
      }
      yield {
        type: "assistant",
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { id: `msg_${randomUUID()}`, model, role: "assistant", content: [{ type: "text", text: reply }] },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: reply,
        uuid: randomUUID(),
        session_id: sessionId,
      } as unknown as SDKMessage;
      yield lifecycle(sessionId, user, "completed");
    }
  }

  const base = Object.assign(stream(), {
    getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
    close: () => {
      closed = true;
    },
  });
  return new Proxy(base, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (value !== undefined) return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => ({ method: String(key), args });
    },
  });
}

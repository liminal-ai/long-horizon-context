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
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };

  // Like the CLI, it reads each prompt as soon as it arrives and reports it queued, then runs the
  // prompts one turn at a time.
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const out: SDKMessage[] = [];
    const waiting: SDKUserMessage[] = [];
    let inputDone = false;
    let initialized = false;
    void (async () => {
      for await (const user of prompt) {
        if (closed) break;
        if (!initialized)
          out.push({
            type: "system",
            subtype: "init",
            session_id: sessionId,
            uuid: randomUUID(),
            model,
            claude_code_version: "2.1.312",
            tools: [],
            mcp_servers: [],
          } as unknown as SDKMessage);
        initialized = true;
        waiting.push(user);
        out.push(lifecycle(sessionId, user, "queued"));
        notify();
      }
      inputDone = true;
      notify();
    })();
    for (;;) {
      while (out.length > 0) yield out.shift() as SDKMessage;
      if (closed) return;
      const user = waiting.shift();
      if (user === undefined) {
        if (inputDone) return;
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      yield lifecycle(sessionId, user, "started");
      const text = textOf(user);
      let reply = `echo: ${text}`;
      if (text.startsWith("slow:")) await new Promise((resolve) => setTimeout(resolve, 500));
      if (text.startsWith("env:")) reply = `env ${options.env?.[text.slice(4)]}`;
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
      while (out.length > 0) yield out.shift() as SDKMessage;
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
      notify();
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

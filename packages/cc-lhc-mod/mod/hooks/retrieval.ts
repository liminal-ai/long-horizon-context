import { MESSAGES_DESCRIPTION, RETRIEVAL_MAX_IDS, type RetrievalOp, TURNS_DESCRIPTION } from "claude-adapter";
import type { EngineInterface, On } from "claude-code";
import type { RetrieveAnswer } from "../../src/compact.ts";
import { boundSession, log, post } from "./sidecar.ts";

const TOOLS: ReadonlyArray<{ op: RetrievalOp; description: string }> = [
  { op: "get_turns", description: TURNS_DESCRIPTION },
  { op: "get_messages", description: MESSAGES_DESCRIPTION },
];

const inputSchema = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: RETRIEVAL_MAX_IDS,
      description: "Ids exactly as labeled: turns like t12, messages like m340.",
    },
    fromToken: {
      type: "integer",
      minimum: 0,
      description: "Continue a sliced item from this token offset (copy it from the slice line).",
    },
  },
  required: ["ids"],
};

export async function registerRetrievalTools($: EngineInterface): Promise<void> {
  for (const { op, description } of TOOLS) {
    const registered = await $.tool.register({ name: op, description, inputSchema, isDeferred: false });
    if ("deny" in registered) log($, `tool ${op} not registered: ${registered.deny}`);
  }
}

async function retrieve($: EngineInterface, op: RetrievalOp, ids: unknown, fromToken: unknown): Promise<RetrieveAnswer> {
  const sessionId = boundSession();
  if (sessionId === undefined) return { text: `${op} unavailable: no session is bound`, isError: true };
  try {
    return (await post($, "/retrieve", { sessionId, op, ids, ...(fromToken === undefined ? {} : { fromToken }) })) as RetrieveAnswer;
  } catch (error) {
    return { text: `${op} failed: ${String(error)}`, isError: true };
  }
}

/** Served here, with no permission prompt: a hook that answers `tool.call` itself never reaches the check. */
export function registerRetrieval(on: On): void {
  for (const { op } of TOOLS) {
    on("tool.call", { tool: `mcp__lhc__${op}` }, async ($, e) => {
      const answer = await retrieve($, op, e.ids, e.fromToken);
      log($, `${op} ${JSON.stringify(e.ids)} answered ${answer.text.length} chars${answer.isError ? " error" : ""}`);
      return answer.isError ? { deny: answer.text } : { result: answer.text };
    });
  }
}

import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  MESSAGES_DESCRIPTION,
  RETRIEVAL_MAX_IDS,
  type RetrievalOp,
  runRetrieval,
  TURNS_DESCRIPTION,
} from "claude-adapter";
import type { Lhc, ThreadRef } from "lhc";
import { z } from "zod";
import { HARNESS } from "./capture/mapper.js";

export const RETRIEVAL_SERVER_NAME = "lhc";
export const GET_TURNS_TOOL = `mcp__${RETRIEVAL_SERVER_NAME}__get_turns`;
export const GET_MESSAGES_TOOL = `mcp__${RETRIEVAL_SERVER_NAME}__get_messages`;
export const RETRIEVAL_TOOL_NAMES: readonly string[] = [GET_TURNS_TOOL, GET_MESSAGES_TOOL];

export function createRetrievalServer(lhc: Lhc, thread: () => ThreadRef): McpSdkServerConfigWithInstance {
  const shape = {
    ids: z
      .array(z.string())
      .min(1)
      .max(RETRIEVAL_MAX_IDS)
      .describe("Ids exactly as labeled: turns like t12, messages like m340."),
    fromToken: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Continue a sliced item from this token offset (copy it from the slice line)."),
  };
  const call = (op: RetrievalOp) => async (args: { ids: string[]; fromToken?: number | undefined }) => {
    const out = await runRetrieval(HARNESS, lhc, thread(), op, args.ids, args.fromToken);
    return { content: [{ type: "text" as const, text: out.text }], ...(out.isError ? { isError: true } : {}) };
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  return createSdkMcpServer({
    name: RETRIEVAL_SERVER_NAME,
    version: "0.1.1",
    tools: [
      tool("get_turns", TURNS_DESCRIPTION, shape, call("get_turns"), { annotations }),
      tool("get_messages", MESSAGES_DESCRIPTION, shape, call("get_messages"), { annotations }),
    ],
  });
}

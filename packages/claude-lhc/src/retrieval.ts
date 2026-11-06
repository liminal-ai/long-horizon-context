import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  MEMBANK_GET_DESCRIPTION,
  MEMBANK_LIST_DESCRIPTION,
  MESSAGES_DESCRIPTION,
  RETRIEVAL_MAX_IDS,
  type RetrievalOp,
  runMembankGet,
  runMembankList,
  runRetrieval,
  TURNS_DESCRIPTION,
} from "claude-adapter";
import type { Lhc, ThreadRef } from "lhc";
import { z } from "zod";
import { HARNESS } from "./capture/mapper.js";

export const RETRIEVAL_SERVER_NAME = "lhc";
export const GET_TURNS_TOOL = `mcp__${RETRIEVAL_SERVER_NAME}__get_turns`;
export const GET_MESSAGES_TOOL = `mcp__${RETRIEVAL_SERVER_NAME}__get_messages`;
const MEMBANK_LIST_TOOL = `mcp__${RETRIEVAL_SERVER_NAME}__membank_list`;
const MEMBANK_GET_TOOL = `mcp__${RETRIEVAL_SERVER_NAME}__membank_get`;

export function lhcToolNames(membank: boolean): readonly string[] {
  return membank
    ? [GET_TURNS_TOOL, GET_MESSAGES_TOOL, MEMBANK_LIST_TOOL, MEMBANK_GET_TOOL]
    : [GET_TURNS_TOOL, GET_MESSAGES_TOOL];
}

type ToolAnswer = { text: string; isError: boolean };

const reply = (out: ToolAnswer) => ({
  content: [{ type: "text" as const, text: out.text }],
  ...(out.isError ? { isError: true } : {}),
});

export function createRetrievalServer(
  lhc: Lhc,
  thread: () => ThreadRef,
  membank: { log: (line: string) => void } | null,
): McpSdkServerConfigWithInstance {
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
  const call = (op: RetrievalOp) => async (args: { ids: string[]; fromToken?: number | undefined }) =>
    reply(await runRetrieval(HARNESS, lhc, thread(), op, args.ids, args.fromToken));
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const retrievalTools = [
    tool("get_turns", TURNS_DESCRIPTION, shape, call("get_turns"), { annotations }),
    tool("get_messages", MESSAGES_DESCRIPTION, shape, call("get_messages"), { annotations }),
  ];
  if (membank === null)
    return createSdkMcpServer({ name: RETRIEVAL_SERVER_NAME, version: "0.1.1", tools: retrievalTools });

  const timed = async (label: string, run: () => Promise<ToolAnswer>) => {
    const started = performance.now();
    const out = await run();
    membank.log(`${label} answered in ${(performance.now() - started).toFixed(1)} ms`);
    return reply(out);
  };
  return createSdkMcpServer({
    name: RETRIEVAL_SERVER_NAME,
    version: "0.1.1",
    tools: [
      ...retrievalTools,
      tool(
        "membank_list",
        MEMBANK_LIST_DESCRIPTION,
        { kind: z.enum(["lesson", "skill"]).optional().describe("List only lessons or only skills.") },
        (args) => timed(`membank_list ${args.kind ?? "all"}`, () => runMembankList(lhc, thread(), args.kind)),
        { annotations },
      ),
      tool(
        "membank_get",
        MEMBANK_GET_DESCRIPTION,
        { id: z.string().describe("The item id exactly as membank_list shows it, such as L1 or S2.") },
        (args) => timed(`membank_get ${args.id}`, () => runMembankGet(lhc, thread(), args.id)),
        { annotations },
      ),
    ],
  });
}

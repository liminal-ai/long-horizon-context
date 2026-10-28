import {
  deterministicText,
  type InferenceCallbacks,
  type InferenceResult,
  type ToolOutcome,
  type ToolResultFacts,
  type ToolResultOperationClass,
  type ToolResultPromptMode,
  type ToolResultResponseShape,
} from "../../src/index.js";

export type InferenceCallbackOpName =
  | "smoothPrompt"
  | "summarizeToolResult"
  | "compressDetailedTurn"
  | "summarizeChunkBrief";

const KIND_ALIASES: Record<string, InferenceCallbackOpName> = {
  smoothPrompt: "smoothPrompt",
  summarizeToolResult: "summarizeToolResult",
  compressDetailedTurn: "compressDetailedTurn",
  summarizeChunkBrief: "summarizeChunkBrief",
  prompt_smoothing: "smoothPrompt",
  smoothed_prompt: "smoothPrompt",
  tool_result_summary: "summarizeToolResult",
  detailed_turn_compression: "compressDetailedTurn",
  chunk_summary_brief: "summarizeChunkBrief",
};

function resolveOpName(kind: string): InferenceCallbackOpName {
  const op = KIND_ALIASES[kind];
  if (op === undefined) throw new Error(`inference callbacks double: unknown operation/kind "${kind}"`);
  return op;
}

interface FailScript {
  remaining: number;
  reason: string;
}

export interface CapturedInput {
  op: InferenceCallbackOpName;
  input: unknown;
}

export class InferenceCallbacksDouble implements InferenceCallbacks {
  private failNextScript: FailScript | null = null;
  private readonly failByOp = new Map<InferenceCallbackOpName, FailScript>();
  private readonly delayByOp = new Map<InferenceCallbackOpName, number>();
  private capturing = false;
  private readonly captured: CapturedInput[] = [];

  failNext(n: number, failure?: { reason?: string }): void {
    this.failNextScript = {
      remaining: n,
      reason: failure?.reason ?? "scripted failure (failNext)",
    };
  }

  failKind(kind: string, n: number, failure?: { reason?: string }): void {
    const op = resolveOpName(kind);
    this.failByOp.set(op, {
      remaining: n,
      reason: failure?.reason ?? `scripted failure (${op})`,
    });
  }

  delayKind(kind: string, ms: number): void {
    this.delayByOp.set(resolveOpName(kind), ms);
  }

  captureInputs(): readonly CapturedInput[] {
    this.capturing = true;
    return this.captured;
  }

  private async run(op: InferenceCallbackOpName, input: unknown, text: string, suffix = ""): Promise<InferenceResult> {
    if (this.capturing) this.captured.push({ op, input: structuredClone(input) });
    const delay = this.delayByOp.get(op);
    if (delay !== undefined && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const scripts = [this.failNextScript, this.failByOp.get(op) ?? null];
    for (const script of scripts) {
      if (script !== null && script.remaining > 0) {
        script.remaining -= 1;
        return { ok: false, reason: script.reason };
      }
    }
    return { ok: true, text: deterministicText(op, input, text) + suffix };
  }

  smoothPrompt(i: { text: string }): Promise<InferenceResult> {
    return this.run("smoothPrompt", i, i.text);
  }

  summarizeToolResult(i: {
    toolName: string;
    content: string;
    outcome?: ToolOutcome;
    targetTokens?: number;
    operationClass?: ToolResultOperationClass;
    responseShape?: ToolResultResponseShape;
    promptMode?: ToolResultPromptMode;
    facts?: ToolResultFacts;
  }): Promise<InferenceResult> {
    return this.run("summarizeToolResult", i, i.content);
  }

  compressDetailedTurn(i: {
    dialogueText: string;
    inputTokens: number;
    targetMinTokens: number;
    targetAimTokens: number;
    targetMaxTokens: number;
  }): Promise<InferenceResult> {
    return this.run("compressDetailedTurn", i, i.dialogueText);
  }

  summarizeChunkBrief(i: {
    text: string;
    inputTokens: number;
    targetMinTokens: number;
    targetAimTokens: number;
    targetMaxTokens: number;
  }): Promise<InferenceResult> {
    return this.run("summarizeChunkBrief", i, i.text);
  }
}

export function createInferenceCallbacksDouble(): InferenceCallbacksDouble {
  return new InferenceCallbacksDouble();
}

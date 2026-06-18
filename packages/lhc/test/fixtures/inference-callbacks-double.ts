// Deterministic InferenceCallbacks double (DD-7, test plan §Test Substrate).
// Injected at the same seam production adapters use — dependency injection,
// not a mock of internals. Every operation returns marked, input-derived
// output: `<marker>(<digest>:<prefix>)` where the digest and prefix are pure
// functions of the input, so identical input to the same operation yields
// identical output across double instances, and different operations are
// distinguishable by marker. Scripting (failNext / failKind / delayKind /
// captureInputs) is per-instance state and never leaks across tests that
// construct their own double.
import {
  deterministicOutcomesSuffix,
  deterministicReceiptsSuffix,
  deterministicText,
  type InferenceCallbacks,
  type InferenceResult,
  type RenderingPart,
  type ToolOutcome,
  type ToolRunReceipt,
} from "../../src/index.js";

export type InferenceCallbackOpName =
  | "smoothPrompt"
  | "summarizeToolResult"
  | "composeTurnRendering"
  | "compressSmoothTurn"
  | "summarizeChunkDetailed"
  | "summarizeChunkBrief";

// Tests script by work-kind / form-kind vocabulary (the test plan writes
// `failKind(prompt_smoothing, …)`); the double accepts those aliases as well
// as the operation names themselves.
const KIND_ALIASES: Record<string, InferenceCallbackOpName> = {
  smoothPrompt: "smoothPrompt",
  summarizeToolResult: "summarizeToolResult",
  composeTurnRendering: "composeTurnRendering",
  compressSmoothTurn: "compressSmoothTurn",
  summarizeChunkDetailed: "summarizeChunkDetailed",
  summarizeChunkBrief: "summarizeChunkBrief",
  prompt_smoothing: "smoothPrompt",
  smoothed_prompt: "smoothPrompt",
  tool_result_summary: "summarizeToolResult",
  turn_rendering: "composeTurnRendering",
  smooth_turn_compression: "compressSmoothTurn",
  chunk_summary_detailed: "summarizeChunkDetailed",
  chunk_summary_brief: "summarizeChunkBrief",
};

function resolveOpName(kind: string): InferenceCallbackOpName {
  const op = KIND_ALIASES[kind];
  if (op === undefined) throw new Error(`inference callbacks double: unknown operation/kind "${kind}"`);
  return op;
}

interface FailScript {
  remaining: number;
  retryable: boolean;
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

  // Fail the next n calls to any operation, then succeed.
  failNext(n: number, opts?: { retryable?: boolean; reason?: string }): void {
    this.failNextScript = {
      remaining: n,
      retryable: opts?.retryable ?? true,
      reason: opts?.reason ?? "scripted failure (failNext)",
    };
  }

  // Fail the next n calls to one operation (kind names and op names both
  // accepted). retryable: false scripts a terminal failure.
  failKind(kind: string, n: number, opts?: { retryable?: boolean; reason?: string }): void {
    const op = resolveOpName(kind);
    this.failByOp.set(op, {
      remaining: n,
      retryable: opts?.retryable ?? true,
      reason: opts?.reason ?? `scripted failure (${op})`,
    });
  }

  delayKind(kind: string, ms: number): void {
    this.delayByOp.set(resolveOpName(kind), ms);
  }

  // Start capturing inputs; returns the live log (appended in call order).
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
        return { ok: false, retryable: script.retryable, reason: script.reason };
      }
    }
    // Output format shared with src/shared-tech/deterministic.ts so this double
    // and deterministic inference callbacks produce byte-identical artifacts;
    // the chunk-summary
    // receipt/outcome suffixes (AC-3.8) come from the same shared helpers.
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
    guidance?: string;
  }): Promise<InferenceResult> {
    return this.run("summarizeToolResult", i, i.content);
  }

  composeTurnRendering(i: { parts: RenderingPart[] }): Promise<InferenceResult> {
    return this.run("composeTurnRendering", i, i.parts.map((p) => p.text).join(" | "));
  }

  compressSmoothTurn(i: { rendering: string }): Promise<InferenceResult> {
    return this.run("compressSmoothTurn", i, i.rendering);
  }

  summarizeChunkDetailed(i: {
    memberProjections: string[];
    memberReceipts?: ToolRunReceipt[][];
  }): Promise<InferenceResult> {
    return this.run(
      "summarizeChunkDetailed",
      i,
      i.memberProjections.join(" | "),
      deterministicReceiptsSuffix(i.memberReceipts),
    );
  }

  summarizeChunkBrief(i: { memberProjections: string[]; memberOutcomes?: ToolOutcome[][] }): Promise<InferenceResult> {
    return this.run(
      "summarizeChunkBrief",
      i,
      i.memberProjections.join(" | "),
      deterministicOutcomesSuffix(i.memberOutcomes),
    );
  }
}

export function createInferenceCallbacksDouble(): InferenceCallbacksDouble {
  return new InferenceCallbacksDouble();
}

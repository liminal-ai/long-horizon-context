/**
 * The tool batch of the current assistant message on the main thread, as the wire shows
 * it, so a mid-turn stop waits for a boundary at which every tool_use has its result.
 *
 * Measured on Claude Code 2.1.259 (scripts/midturn.ts): the CLI emits one `assistant`
 * wire message per content block of an API message, and starts a tool as soon as its
 * block has streamed, so at a PostToolUse the batch's later blocks may not have arrived
 * yet. The count is therefore a floor, best with partial messages on (content_block_start
 * precedes execution). The CLI itself finishes the batch before honouring a hook stop, so
 * an early stop lands on the same seam; the count keeps the sidecar from asking early.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type Block = Record<string, unknown>;

export class ToolBatch {
  #settled = new Map<string, boolean>();
  #messageId = "";

  get size(): number {
    return this.#settled.size;
  }

  has(id: string): boolean {
    return this.#settled.has(id);
  }

  unsettled(): string[] {
    return [...this.#settled.entries()].filter(([, settled]) => !settled).map(([id]) => id);
  }

  /** A tool's result is known (its PostToolUse or PostToolUseFailure fired, or its tool_result is on the wire). */
  settle(id: string): void {
    this.#settled.set(id, true);
  }

  clear(): void {
    this.#settled.clear();
    this.#messageId = "";
  }

  /** Feeds one main-thread wire message; returns the tool names of any tool_use first seen here. */
  observe(message: SDKMessage): string[] {
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id !== null) return [];
      const event = message.event as unknown as Block;
      if (event["type"] === "message_start") this.#start(String((event["message"] as Block | undefined)?.["id"] ?? ""));
      const block = event["type"] === "content_block_start" ? (event["content_block"] as Block | undefined) : undefined;
      return block !== undefined ? this.#add([block]) : [];
    }
    if (message.type === "assistant") {
      if (message.parent_tool_use_id !== null) return [];
      const inner = message.message as unknown as Block;
      const calls = (Array.isArray(inner["content"]) ? (inner["content"] as Block[]) : []).filter((b) => b["type"] === "tool_use");
      if (calls.length === 0) return [];
      this.#start(String(inner["id"] ?? ""));
      return this.#add(calls);
    }
    if (message.type === "user" && message.parent_tool_use_id === null) {
      const content = message.message.content;
      if (!Array.isArray(content)) return [];
      for (const block of content as unknown as Block[]) {
        if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string" && this.#settled.has(block["tool_use_id"])) this.#settled.set(block["tool_use_id"], true);
      }
    }
    return [];
  }

  /** A new API message starts a batch: the settled ids of the previous one leave. Blocks of the same message join it. */
  #start(messageId: string): void {
    if (messageId !== "" && messageId === this.#messageId) return;
    this.#messageId = messageId;
    for (const [id, settled] of [...this.#settled.entries()]) if (settled) this.#settled.delete(id);
  }

  #add(blocks: Block[]): string[] {
    const names: string[] = [];
    for (const block of blocks) {
      if (block["type"] !== "tool_use" || typeof block["id"] !== "string" || this.#settled.has(block["id"])) continue;
      this.#settled.set(block["id"], false);
      names.push(String(block["name"]));
    }
    return names;
  }
}

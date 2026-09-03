/**
 * One t3code thread as the sidecar runs it: an LHC thread and a succession of Claude
 * Agent SDK generations. Exactly one generation is live; it is the only thing the
 * user's prompts go to and the only source of forwarded messages.
 *
 * Capture precedes publication: every native message is recorded into LHC before it
 * is forwarded to the driver, and every prompt is recorded at the moment the SDK
 * pulls it (the model-visible seam).
 *
 * Generations change in two cases, both projections of the LHC served view into a
 * fresh native session id (the new id becomes the thread's current alias):
 *   - restart: `start` with `resume: <any alias of the thread>`;
 *   - compact: manual (`/compact` prompt) or auto (provider-reported context over the
 *     trigger at the end of a turn). `threadView.compact` installs the view, a
 *     continuation marker starts the next turn, and the old generation is closed once
 *     the new one exists.
 */
import {
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
  type UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import {
  COMPACT_CONTINUATION_MARKER_ACTION,
  COMPACT_CONTINUATION_MARKER_CAUSE,
  COMPACT_CONTINUATION_MARKER_KIND,
  compactContinuationMarkerIdempotencyKey,
  type Lhc,
  type MessageEventInput,
  type ThreadRef,
} from "lhc";
import { compactCommand, HARNESS, mapPrompt, mapSdkMessage } from "./capture/mapper.ts";
import { killInferenceChildren } from "./inference/claudeCli.ts";
import { bindSession, createLhc, createThread, resolveSession, threadRef } from "./lhcHome.ts";
import { projectView } from "./projection/project.ts";
import type { SidecarRequestMethod, WireOptions } from "./protocol.ts";

export interface SessionIO {
  emit(message: SDKMessage): void;
  request(method: SidecarRequestMethod, params: unknown, signal: AbortSignal): Promise<unknown>;
  /** The live generation's stream ended on its own: the session is over. */
  end(): void;
  /** Unrecoverable: report to the driver and stop. */
  fail(message: string): void;
  log(line: string): void;
}

/** Provider-reported context (input + cache) at which an automatic compact runs when no `autoCompactWindow` is configured. */
const DEFAULT_AUTO_COMPACT_TRIGGER = 150_000;
/** LHC-token size the rebuilt view aims for; the manual path aims lower when the thread is small. */
const DEFAULT_VIEW_TARGET_TOKENS = 60_000;
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.259";

interface QueuedPrompt {
  message: SDKUserMessage;
  before?: () => Promise<void>;
}

/** The prompt stream one generation reads. `before` runs after the SDK asks for the item and before it gets it. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #items: QueuedPrompt[] = [];
  #wake: (() => void) | null = null;
  #ended = false;

  push(item: QueuedPrompt): void {
    this.#items.push(item);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        if (next.before !== undefined) await next.before();
        yield next.message;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}

interface Generation {
  readonly sessionId: string;
  readonly query: Query;
  readonly input: InputQueue;
  superseded: boolean;
}

/**
 * Honest post-compact context estimate: the rebuilt view plus the overhead the provider adds on
 * top of it. With no overhead measured yet (nothing was sent before the compact) the view size is
 * all that is known.
 */
export function estimatePostTokens(viewTokens: number, overhead: number | null): number {
  return viewTokens + (overhead ?? 0);
}

export class ClaudeLhcSession {
  readonly #io: SessionIO;
  #base: Record<string, unknown> = {};
  #lhc!: Lhc;
  #thread!: ThreadRef;
  #threadId = "";
  #cwd = process.cwd();
  #claudeBin = "claude";
  #env: NodeJS.ProcessEnv = process.env;
  #gen: Generation | null = null;
  #turnOpen = false;
  #turnStartedAt: string | undefined;
  #lastContextTokens = 0;
  /** Provider input tokens beyond the LHC view (system prompt, tools, tokenizer drift), measured at the last swap. */
  #lastOverhead: number | null = null;
  #pendingApprovals = 0;
  #pendingCompact: "manual" | "auto" | null = null;
  #compacting = false;
  #model: string | undefined;
  #permissionMode: PermissionMode | undefined;
  #maxThinkingTokens: number | null | undefined;
  #claudeCodeVersion = FALLBACK_CLAUDE_CODE_VERSION;
  #autoCompactTrigger = DEFAULT_AUTO_COMPACT_TRIGGER;
  #viewTarget = DEFAULT_VIEW_TARGET_TOKENS;
  #closed = false;

  constructor(io: SessionIO) {
    this.#io = io;
  }

  get threadId(): string {
    return this.#threadId;
  }

  async start(wire: WireOptions): Promise<void> {
    const { resume, sessionId, canUseTool: _c, onUserDialog: _d, sessionStore: _s, settings, env, ...rest } = wire as Record<string, unknown>;
    const settingsRecord = typeof settings === "object" && settings !== null ? { ...(settings as Record<string, unknown>) } : {};
    if (typeof settingsRecord["autoCompactWindow"] === "number") this.#autoCompactTrigger = settingsRecord["autoCompactWindow"];
    delete settingsRecord["autoCompactWindow"]; // LHC owns compaction; the native meter setting never reaches the child
    this.#env = { ...((env as NodeJS.ProcessEnv | undefined) ?? process.env), DISABLE_AUTO_COMPACT: "1" };
    this.#base = { ...rest, ...(Object.keys(settingsRecord).length > 0 ? { settings: settingsRecord } : {}) };
    if (typeof rest["cwd"] === "string") this.#cwd = rest["cwd"];
    if (typeof rest["pathToClaudeCodeExecutable"] === "string") this.#claudeBin = rest["pathToClaudeCodeExecutable"];
    if (typeof rest["model"] === "string") this.#model = rest["model"];
    if (typeof rest["permissionMode"] === "string") this.#permissionMode = rest["permissionMode"] as PermissionMode;
    if (typeof rest["maxThinkingTokens"] === "number") this.#maxThinkingTokens = rest["maxThinkingTokens"];
    this.#lhc = createLhc({ claudeBin: this.#claudeBin, env: this.#env });

    if (typeof resume === "string" && resume !== "") {
      const threadId = await resolveSession(resume);
      if (threadId === null) throw new Error(`no LHC thread holds the Claude session ${resume}`);
      this.#threadId = threadId;
      this.#thread = threadRef(threadId);
      await this.#settleOpenTurn("session restarted");
      await this.#startProjectedGeneration();
      this.#io.log(`resumed thread ${threadId} via ${resume} as generation ${this.#gen?.sessionId}`);
      return;
    }

    const first = typeof sessionId === "string" && sessionId !== "" ? sessionId : randomUUID();
    this.#threadId = await createThread(this.#cwd);
    this.#thread = threadRef(this.#threadId);
    await bindSession(this.#threadId, first);
    this.#gen = this.#startGeneration(first, { sessionId: first });
    this.#io.log(`created thread ${this.#threadId} as generation ${first}`);
  }

  async pushUser(message: SDKUserMessage): Promise<void> {
    if (this.#closed) return;
    if (compactCommand(message) !== null) {
      if (this.#turnOpen || this.#compacting) this.#pendingCompact = "manual";
      else await this.#compact("manual");
      return;
    }
    const gen = this.#gen;
    if (gen === null) throw new Error("no live generation");
    const uuid = randomUUID();
    gen.input.push({
      message,
      before: async () => {
        const events = mapPrompt(message, uuid, this.#turnOpen);
        if (!this.#turnOpen && events.some((event) => event.eventKind === "user_prompt")) {
          this.#turnOpen = true;
          this.#turnStartedAt = new Date().toISOString();
        }
        await this.#intake(events);
      },
    });
  }

  async control(method: string, params: unknown): Promise<unknown> {
    const gen = this.#gen;
    if (gen === null) throw new Error("no live generation");
    const record = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "setModel": {
        const model = typeof record["model"] === "string" ? record["model"] : undefined;
        this.#model = model;
        await gen.query.setModel(model);
        return undefined;
      }
      case "setPermissionMode": {
        const mode = record["mode"] as PermissionMode;
        this.#permissionMode = mode;
        await gen.query.setPermissionMode(mode);
        return undefined;
      }
      case "setMaxThinkingTokens": {
        const value = record["maxThinkingTokens"];
        this.#maxThinkingTokens = typeof value === "number" ? value : null;
        await gen.query.setMaxThinkingTokens(this.#maxThinkingTokens);
        return undefined;
      }
      case "interrupt":
        await gen.query.interrupt();
        return undefined;
      default:
        throw new Error(`unknown control ${method}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const gen = this.#gen;
    this.#gen = null;
    if (gen !== null) {
      gen.superseded = true;
      gen.input.end();
      gen.query.close();
    }
    killInferenceChildren();
  }

  // ── generations ────────────────────────────────────────────────

  #startGeneration(sessionId: string, extra: Partial<Options>): Generation {
    const input = new InputQueue();
    const options: Options = {
      ...(this.#base as Options),
      ...(this.#model !== undefined ? { model: this.#model } : {}),
      ...(this.#permissionMode !== undefined ? { permissionMode: this.#permissionMode } : {}),
      ...(typeof this.#maxThinkingTokens === "number" ? { maxThinkingTokens: this.#maxThinkingTokens } : {}),
      env: this.#env,
      pathToClaudeCodeExecutable: this.#claudeBin,
      canUseTool: async (toolName, toolInput, callbackOptions) => {
        const { signal, ...rest } = callbackOptions;
        this.#pendingApprovals += 1;
        try {
          return (await this.#io.request("canUseTool", { toolName, input: toolInput, ...rest }, signal)) as PermissionResult;
        } finally {
          this.#pendingApprovals -= 1;
        }
      },
      onUserDialog: async (request, callbackOptions) =>
        (await this.#io.request("onUserDialog", { request }, callbackOptions.signal)) as UserDialogResult,
      ...extra,
    };
    const q = query({ prompt: input, options });
    const gen: Generation = { sessionId, query: q, input, superseded: false };
    void this.#pump(gen);
    return gen;
  }

  async #pump(gen: Generation): Promise<void> {
    try {
      for await (const message of gen.query) {
        if (gen.superseded) continue;
        await this.#onMessage(message);
      }
      if (!gen.superseded && !this.#closed && this.#gen === gen) {
        this.#io.log(`generation ${gen.sessionId} stream ended`);
        this.#io.end();
      }
    } catch (cause) {
      if (gen.superseded || this.#closed) return;
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (this.#turnOpen) {
        await this.#intake([{
          eventKind: "turn_end", idempotencyKey: `claude-lhc:${randomUUID()}:0:turn_end`, actor: "system", harness: HARNESS,
          payload: { outcome: "aborted", outcomeReason: reason.slice(0, 200), ...(this.#turnStartedAt ? { startedAt: this.#turnStartedAt } : {}), endedAt: new Date().toISOString() },
        }]).catch(() => undefined);
        this.#turnOpen = false;
      }
      this.#io.fail(`Claude runtime stream failed: ${reason}`);
    }
  }

  async #onMessage(message: SDKMessage): Promise<void> {
    if (message.type === "system" && message.subtype === "init") {
      this.#claudeCodeVersion = message.claude_code_version;
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null && !this.#turnOpen) {
      // Output without a prompt of ours (a task notification the CLI answered): the turn is open.
      this.#turnOpen = true;
      this.#turnStartedAt = new Date().toISOString();
    }
    const mapped = mapSdkMessage(message, this.#turnStartedAt);
    if (mapped.contextTokens !== undefined) this.#lastContextTokens = mapped.contextTokens;
    if (mapped.events.length > 0 && (this.#turnOpen || !mapped.turnEnd)) await this.#intake(mapped.events);
    this.#io.emit(message);
    if (mapped.turnEnd) {
      this.#turnOpen = false;
      this.#turnStartedAt = undefined;
      await this.#afterTurn();
    }
  }

  async #afterTurn(): Promise<void> {
    if (this.#compacting) return;
    if (this.#pendingCompact !== null) {
      const trigger = this.#pendingCompact;
      this.#pendingCompact = null;
      await this.#compact(trigger);
      return;
    }
    if (this.#lastContextTokens >= this.#autoCompactTrigger) await this.#compact("auto");
  }

  // ── LHC ────────────────────────────────────────────────────────

  async #intake(events: readonly MessageEventInput[]): Promise<void> {
    if (events.length === 0) return;
    const result = await this.#lhc.intakeStream.messageEvents(this.#thread, events);
    if (!result.ok) throw new Error(`LHC intake refused: ${result.error.code}: ${result.error.reason}`);
  }

  /** A restart over a turn the previous process never closed: close it as aborted so the view is coherent. */
  async #settleOpenTurn(reason: string): Promise<void> {
    const turns = await this.#lhc.turns.listTurns(this.#thread);
    if (!turns.ok) throw new Error(`LHC turns read failed: ${turns.error.reason}`);
    const open = turns.value.find((turn) => turn.status === "open");
    if (open === undefined || open.memberMessageIds.length === 0) return;
    await this.#intake([{
      eventKind: "turn_end", idempotencyKey: `claude-lhc:settle:${open.turnId}:turn_end`, actor: "system", harness: HARNESS,
      payload: { outcome: "aborted", outcomeReason: reason, endedAt: new Date().toISOString() },
    }]);
  }

  async #openTurnId(): Promise<string> {
    const turns = await this.#lhc.turns.listTurns(this.#thread);
    if (!turns.ok) throw new Error(`LHC turns read failed: ${turns.error.reason}`);
    const open = turns.value.find((turn) => turn.status === "open");
    if (open === undefined) throw new Error("LHC thread has no open turn");
    return open.turnId;
  }

  async #compact(trigger: "manual" | "auto"): Promise<void> {
    if (this.#gen === null || this.#compacting) return;
    this.#compacting = true;
    const startedAt = Date.now();
    const preTokens = this.#lastContextTokens;
    try {
      const status = await this.#lhc.threadView.status(this.#thread);
      const tail = status.ok ? status.value.tailTokens : 0;
      // The provider's context is the view plus a fixed overhead the view never sees (system
      // prompt, tool schemas, tokenizer drift). Measure it now, before the swap, so post_tokens
      // estimates what the next turn will actually read instead of reporting the bare view size.
      if (status.ok && preTokens > 0) {
        const stored = await this.#lhc.threadView.describe(this.#thread);
        const bandTokens = stored.ok && stored.value !== null ? stored.value.bands.reduce((sum, band) => sum + band.storedTokens, 0) : 0;
        this.#lastOverhead = Math.max(0, preTokens - (bandTokens + tail));
      }
      // Aim the view at half the live tail (capped at the configured target): the full band then
      // holds the newest ~15% and everything older lands in the stored bands.
      const lowerBound = Math.max(100, Math.min(this.#viewTarget, Math.floor(tail * 0.5)));
      const opts = { profile: "continuation", params: { lowerBound } };
      const preview = await this.#lhc.threadView.previewCompact(this.#thread, opts);
      if (!preview.ok) throw new Error(`compact preview error: ${preview.error.reason}`);
      if (preview.value.kind === "error") throw new Error(`compact blocked: ${preview.value.reason}`);
      const receipt = await this.#lhc.threadView.compact(this.#thread, opts);
      if (!receipt.ok) throw new Error(`compact error: ${receipt.error.reason}`);

      const continuationTurnId = await this.#openTurnId();
      await this.#intake([{
        eventKind: "compact_continuation_marker",
        idempotencyKey: compactContinuationMarkerIdempotencyKey(continuationTurnId),
        actor: "system",
        harness: HARNESS,
        payload: {
          kind: COMPACT_CONTINUATION_MARKER_KIND,
          continuationTurnId,
          cause: COMPACT_CONTINUATION_MARKER_CAUSE,
          action: COMPACT_CONTINUATION_MARKER_ACTION,
          newUserRequest: false,
          waitForUser: false,
        },
      }]);
      const postTokens = estimatePostTokens(receipt.value.totalTokens, this.#lastOverhead);
      const summary = `[lhc compact:${trigger}] provider context ${preTokens} tokens; rebuilt view ${receipt.value.totalTokens} tokens (target ${lowerBound}); overhead ${this.#lastOverhead ?? "unknown"}; estimated next context ${postTokens}; bands ${JSON.stringify(receipt.value.bands)}`;
      this.#io.log(summary);
      await this.#lhc.logging.write(this.#thread, { level: "info", message: summary }).catch(() => undefined);

      const next = await this.#startProjectedGeneration();
      this.#emitSynthetic({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger, pre_tokens: preTokens, post_tokens: postTokens, duration_ms: Date.now() - startedAt },
        uuid: randomUUID(),
        session_id: next.sessionId,
      } as unknown as SDKMessage);
      this.#lastContextTokens = 0;
      if (trigger === "manual") this.#emitSynthetic(this.#syntheticResult(next.sessionId, startedAt, ""));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.#io.log(`compact (${trigger}) failed: ${reason}`);
      await this.#lhc.logging.write(this.#thread, { level: "warning", message: `[lhc compact:${trigger}] failed: ${reason}` }).catch(() => undefined);
      if (trigger === "manual" && this.#gen !== null) {
        this.#emitSynthetic(this.#syntheticResult(this.#gen.sessionId, startedAt, `LHC compact failed: ${reason}`));
      }
    } finally {
      this.#compacting = false;
    }
  }

  /** Projects the served view into a fresh native session, binds it as the current alias, and routes to it. */
  async #startProjectedGeneration(): Promise<Generation> {
    const view = await this.#lhc.threadView.getSessionThreadView(this.#thread);
    if (!view.ok) throw new Error(`LHC view read failed: ${view.error.reason}`);
    const sessionId = randomUUID();
    const entries = projectView(view.value, {
      sessionId,
      cwd: this.#cwd,
      version: this.#claudeCodeVersion,
      permissionMode: this.#permissionMode ?? "default",
      model: this.#model ?? "claude-sonnet-5",
    });
    await bindSession(this.#threadId, sessionId);
    const store: SessionStore = {
      async append() {},
      async load(key) {
        return key.sessionId === sessionId && key.subpath === undefined ? (entries as never) : null;
      },
    };
    const next = this.#startGeneration(sessionId, { resume: sessionId, sessionStore: store });
    const old = this.#gen;
    this.#gen = next;
    if (old !== null) {
      old.superseded = true;
      old.input.end();
      old.query.close();
    }
    this.#io.log(`generation ${sessionId}: ${entries.length} projected lines from ${view.value.entries.length} served entries`);
    return next;
  }

  #emitSynthetic(message: SDKMessage): void {
    this.#io.emit(message);
  }

  #syntheticResult(sessionId: string, startedAt: number, resultText: string): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      duration_ms: Date.now() - startedAt,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 0,
      result: resultText,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    } as unknown as SDKMessage;
  }
}

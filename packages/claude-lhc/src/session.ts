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
  type CompactReceipt,
  type Lhc,
  type MessageEventInput,
  type ThreadRef,
  type TurnRecord,
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
/** LHC-token size the rebuilt view aims for, capped at a share of the auto-compact trigger so a compact clears the window. */
const DEFAULT_VIEW_TARGET_TOKENS = 60_000;
const VIEW_TARGET_TRIGGER_SHARE = 0.4;
/** Longest a compact waits for queued derivations, so bands assemble from renderings rather than truncated excerpts. */
const DERIVATION_WAIT_MS = 45_000;
/** A view that would evict recorded turns is retried larger, up to this multiple of the target. */
const MAX_VIEW_TARGET_MULTIPLE = 4;
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

  /** Ends the queue and hands back whatever the SDK never asked for. */
  drain(): QueuedPrompt[] {
    const leftover = this.#items.splice(0);
    this.end();
    return leftover;
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

/** The view size a compact aims for: a fixed target, never more than a share of the trigger it must clear. */
export function viewTargetFor(autoCompactTrigger: number): number {
  return Math.max(1, Math.min(DEFAULT_VIEW_TARGET_TOKENS, Math.floor(autoCompactTrigger * VIEW_TARGET_TRIGGER_SHARE)));
}

/**
 * Closed turns with recorded messages that a view no longer represents. The view's
 * coverage edge is the oldest message it still carries; a turn that closed at or before
 * that edge fell off the far side of the bands and the model would never see it again.
 * A thread that fits the full share has no bands, `coveredFrom` 0, and nothing evicted.
 */
export function evictedTurns(turns: readonly TurnRecord[], coveredFrom: number): string[] {
  return turns
    .filter((turn) => turn.status === "closed" && turn.memberMessageIds.length > 0)
    .filter((turn) => turn.closedAtEventOrder !== undefined && turn.closedAtEventOrder <= coveredFrom)
    .map((turn) => turn.turnId);
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
  #pendingApprovals = 0;
  #pendingCompact: "manual" | "auto" | null = null;
  #compacting = false;
  /** Prompts that arrived while a compact swap was running; replayed into the new generation. */
  #heldPrompts: SDKUserMessage[] = [];
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
    this.#viewTarget = viewTargetFor(this.#autoCompactTrigger);
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
    if (this.#compacting) {
      // The live generation is about to be superseded; queueing there would drop the prompt.
      this.#heldPrompts.push(message);
      this.#io.log(`holding a prompt during compact (${this.#heldPrompts.length} held)`);
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
    if (!mapped.turnEnd) {
      this.#io.emit(message);
      return;
    }
    this.#turnOpen = false;
    this.#turnStartedAt = undefined;
    // A compact due at this turn end runs before the turn's result goes out, so the driver
    // sees native order: status compacting, status cleared, compact_boundary, then the result.
    const trigger = this.#dueCompact();
    if (trigger === null) this.#io.emit(message);
    else await this.#compact(trigger, message);
  }

  #dueCompact(): "manual" | "auto" | null {
    if (this.#compacting) return null;
    if (this.#pendingCompact !== null) {
      const trigger = this.#pendingCompact;
      this.#pendingCompact = null;
      return trigger;
    }
    return this.#lastContextTokens >= this.#autoCompactTrigger ? "auto" : null;
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

  /**
   * Rebuilds the view and swaps generations. `heldResult` is the turn's own `result` when the
   * compact runs at a turn end: it is forwarded after the boundary, on the new session id.
   * Without one (a `/compact` sent between turns) a synthetic result closes the compact turn.
   */
  async #compact(trigger: "manual" | "auto", heldResult?: SDKMessage): Promise<void> {
    if (this.#gen === null || this.#compacting) {
      if (heldResult !== undefined) this.#io.emit(heldResult);
      return;
    }
    this.#compacting = true;
    const startedAt = Date.now();
    const preTokens = this.#lastContextTokens;
    const previous = this.#gen;
    this.#emitSynthetic(this.#syntheticStatus(previous.sessionId, "compacting"));
    try {
      await this.#awaitDerivations();
      // A compact never makes the model forget what the record still holds. The view aims at a
      // fixed target: a thread that fits the full share stays whole in the tail (no bands), a
      // larger one lands its older turns in bands. If the installed view still evicted turns
      // past the far edge of the bands, retry larger before accepting it.
      let lowerBound = this.#viewTarget;
      let receipt: CompactReceipt;
      for (;;) {
        const opts = { profile: "continuation", params: { lowerBound } };
        const preview = await this.#lhc.threadView.previewCompact(this.#thread, opts);
        if (!preview.ok) throw new Error(`compact preview error: ${preview.error.reason}`);
        if (preview.value.kind === "error") throw new Error(`compact blocked: ${preview.value.reason}`);
        const installed = await this.#lhc.threadView.compact(this.#thread, opts);
        if (!installed.ok) throw new Error(`compact error: ${installed.error.reason}`);
        receipt = installed.value;
        const turns = await this.#lhc.turns.listTurns(this.#thread);
        if (!turns.ok) throw new Error(`LHC turns read failed: ${turns.error.reason}`);
        const evicted = evictedTurns(turns.value, receipt.coveredFrom);
        if (evicted.length === 0) break;
        if (lowerBound >= this.#viewTarget * MAX_VIEW_TARGET_MULTIPLE) {
          const warning = `[lhc compact:${trigger}] view at ${lowerBound} tokens still drops turns ${evicted.join(", ")} past the band edge; they remain in the record only`;
          this.#io.log(warning);
          await this.#lhc.logging.write(this.#thread, { level: "warning", message: warning }).catch(() => undefined);
          break;
        }
        this.#io.log(`[lhc compact:${trigger}] view at ${lowerBound} tokens would drop turns ${evicted.join(", ")}; retrying at ${lowerBound * 2}`);
        lowerBound *= 2;
      }

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
      // post_tokens is the rebuilt view the model reads next, as stock reports its summary's
      // size alone; the next assistant usage makes the meter exact.
      const postTokens = receipt.totalTokens;
      const summary = `[lhc compact:${trigger}] provider context ${preTokens} tokens; rebuilt view ${receipt.totalTokens} tokens (target ${lowerBound}); compact point ${receipt.compactPoint}, covered from ${receipt.coveredFrom}; degraded ${receipt.degraded.length}, gaps ${receipt.gaps.length}; bands ${JSON.stringify(receipt.bands)}`;
      this.#io.log(summary);
      await this.#lhc.logging.write(this.#thread, { level: "info", message: summary }).catch(() => undefined);

      const next = await this.#startProjectedGeneration();
      this.#emitSynthetic(this.#syntheticStatus(previous.sessionId, null, { compact_result: "success" }));
      this.#emitSynthetic({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger, pre_tokens: preTokens, post_tokens: postTokens, duration_ms: Date.now() - startedAt },
        uuid: randomUUID(),
        session_id: next.sessionId,
      } as unknown as SDKMessage);
      this.#lastContextTokens = 0;
      if (heldResult !== undefined) this.#emitSynthetic({ ...heldResult, session_id: next.sessionId } as SDKMessage);
      else if (trigger === "manual") this.#emitSynthetic(this.#syntheticResult(next.sessionId, startedAt, ""));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.#io.log(`compact (${trigger}) failed: ${reason}`);
      await this.#lhc.logging.write(this.#thread, { level: "warning", message: `[lhc compact:${trigger}] failed: ${reason}` }).catch(() => undefined);
      this.#emitSynthetic(this.#syntheticStatus(previous.sessionId, null, { compact_result: "failed", compact_error: reason }));
      if (heldResult !== undefined) this.#io.emit(heldResult);
      else if (trigger === "manual") this.#emitSynthetic(this.#syntheticResult(previous.sessionId, startedAt, `LHC compact failed: ${reason}`));
    } finally {
      this.#compacting = false;
    }
    const held = this.#heldPrompts.splice(0);
    if (held.length > 0) this.#io.log(`replaying ${held.length} held prompt(s) into generation ${this.#gen?.sessionId}`);
    for (const message of held) await this.pushUser(message);
  }

  /** Lets queued derivations finish (bounded) so the bands are built from renderings, not the truncated excerpt fallback. */
  async #awaitDerivations(): Promise<void> {
    const deadline = Date.now() + DERIVATION_WAIT_MS;
    for (;;) {
      const status = await this.#lhc.threadView.status(this.#thread);
      if (!status.ok || status.value.derivation.pending === 0) return;
      if (Date.now() >= deadline) {
        this.#io.log(`compact: ${status.value.derivation.pending} derivations still pending after ${DERIVATION_WAIT_MS} ms; assembling from what is ready`);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
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
      for (const item of old.input.drain()) next.input.push(item);
      old.query.close();
    }
    this.#io.log(`generation ${sessionId}: ${entries.length} projected lines from ${view.value.entries.length} served entries`);
    return next;
  }

  #emitSynthetic(message: SDKMessage): void {
    this.#io.emit(message);
  }

  /** Native's `system/status` around a compaction: `compacting` at the start, `null` with the outcome at the end. */
  #syntheticStatus(sessionId: string, status: "compacting" | null, outcome: Record<string, unknown> = {}): SDKMessage {
    return {
      type: "system",
      subtype: "status",
      status,
      ...(this.#permissionMode !== undefined ? { permissionMode: this.#permissionMode } : {}),
      ...outcome,
      uuid: randomUUID(),
      session_id: sessionId,
    } as unknown as SDKMessage;
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

import { randomUUID } from "node:crypto";
import {
  type HookJSONOutput,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PostToolBatchHookInput,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type Query,
  query,
  renameSession,
  type SDKMessage,
  type SDKUserMessage,
  type UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  COMPACT_CONTINUATION_MARKER_ACTION,
  COMPACT_CONTINUATION_MARKER_CAUSE,
  COMPACT_CONTINUATION_MARKER_KIND,
  CONTEXT_COMPACT_CONTINUE_REASON,
  type CompactReceipt,
  compactContinuationMarkerIdempotencyKey,
  type Lhc,
  type MessageEventInput,
  type ThreadRef,
} from "lhc";
import { ToolBatch } from "./capture/batch.js";
import { compactCommand, HARNESS, mapPrompt, mapSdkMessage } from "./capture/mapper.js";
import {
  createSegmentFoldState,
  foldSegmentEvents,
  resetSegmentFold,
  segmentEndEvent,
  segmentThresholdTokens,
} from "./capture/segment-fold.js";
import {
  type CompactPolicy,
  capCompactPolicyToWindow,
  type ResolvedCompactPolicy,
  resumeCompactPolicy,
  storeCompactPolicy,
  windowFromUsage,
} from "./compactPolicy.js";
import { bindSession, createLhc, createThread, resolveSession, threadRef } from "./lhcHome.js";
import { writeProjectedSession } from "./nativeSessionFile.js";
import { projectView } from "./projection/project.js";
import { parseSidecarOptions, type SidecarRequestMethod, type WireOptions } from "./protocol.js";
import { createRetrievalServer, RETRIEVAL_SERVER_NAME, RETRIEVAL_TOOL_NAMES } from "./retrieval.js";
import { type RollbackAnchor, resolveRollbackAnchor } from "./rollbackAnchor.js";
import { abortSummaryWorkers } from "./summaryWorker.js";
import {
  formatTokenFamilyLog,
  isRealModelId,
  laterModelObservation,
  type ResolvedTokenFamily,
  seedTokenFamilyFromStartModel,
} from "./token-family.js";

export interface SessionIO {
  emit(message: SDKMessage): void;
  request(method: SidecarRequestMethod, params: unknown, signal: AbortSignal): Promise<unknown>;
  end(): void;
  fail(message: string): void;
  log(line: string): void;
}

export function claudeChildEnv(
  wireEnv: NodeJS.ProcessEnv | undefined,
  sidecarEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const threadId = sidecarEnv.T3CODE_THREAD_ID;
  return {
    ...(wireEnv ?? sidecarEnv),
    ...(threadId !== undefined && wireEnv?.T3CODE_THREAD_ID === undefined ? { T3CODE_THREAD_ID: threadId } : {}),
    DISABLE_AUTO_COMPACT: "1",
  };
}

export function nativeLhcTitle(threadId: string): string {
  return `[LHC] ${threadId}`;
}

async function labelNativeSession(sessionId: string, title: string, cwd: string, io: SessionIO): Promise<void> {
  try {
    await renameSession(sessionId, title, { dir: cwd });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    io.log(`native title ${JSON.stringify(title)} for ${sessionId} failed: ${detail}`);
  }
}

const CONTINUATION_FULL_SHARE_PERCENT = 30;
const DERIVATION_WAIT_MS = 45_000;
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.259";
const MID_TURN_STOP_REASON = "lhc mid-turn compact";
const HOOK_STOPPED = "hook_stopped";

type CompactTrigger = "manual" | "auto";
const stamp = (): string => new Date().toISOString().slice(11, 23);

interface QueuedPrompt {
  message: SDKUserMessage;
  before?: () => Promise<void>;
}

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

export function formatCompactRuntimeNote(args: {
  trigger: CompactTrigger;
  preTokens: number;
  totalTokens: number;
  lowerBound: number;
  compactPoint: number;
  coveredFrom: number;
  degradedCount: number;
  gapsCount: number;
  bands: unknown;
  family: ResolvedTokenFamily;
}): string {
  return `[lhc compact:${args.trigger}] provider context ${args.preTokens} tokens; rebuilt view ${args.totalTokens} tokens (target ${args.lowerBound}); compact point ${args.compactPoint}, covered from ${args.coveredFrom}; degraded ${args.degradedCount}, gaps ${args.gapsCount}; bands ${JSON.stringify(args.bands)}; family ${args.family.family} (${args.family.source})`;
}

export class ClaudeLhcSession {
  readonly #io: SessionIO;
  #base: Record<string, unknown> = {};
  #home = "";
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
  #pendingCompact: CompactTrigger | null = null;
  #compacting = false;
  #batch = new ToolBatch();
  #turnToolCalls = new Map<string, number>();
  #segmentFold = createSegmentFoldState();
  #stopping: CompactTrigger | null = null;
  #midTurnFailed = false;
  #swap: { stoppedAt: number; sessionId: string } | null = null;
  #heldPrompts: SDKUserMessage[] = [];
  #model: string | undefined;
  #permissionMode: PermissionMode | undefined;
  #maxThinkingTokens: number | null | undefined;
  #claudeCodeVersion = FALLBACK_CLAUDE_CODE_VERSION;
  #compactPolicy: ResolvedCompactPolicy = { stored: { trigger: 0, target: 0 }, window: null };
  #windowRead: Promise<void> = Promise.resolve();
  #windowReads = 0;
  #forceRebuildFailure = false;
  #tokenFamily: ResolvedTokenFamily = seedTokenFamilyFromStartModel("");
  #lastModelId: string | null = null;
  #closed = false;

  constructor(io: SessionIO) {
    this.#io = io;
  }

  get threadId(): string {
    return this.#threadId;
  }

  async start(wire: WireOptions): Promise<void> {
    const {
      resume,
      resumeSessionAt,
      sessionId,
      canUseTool: _c,
      onUserDialog: _d,
      sessionStore: _s,
      env,
      lhc,
      ...rest
    } = wire as Record<string, unknown>;
    const sidecarOptions = parseSidecarOptions(lhc);
    this.#home = sidecarOptions.home;
    this.#forceRebuildFailure = sidecarOptions.forceRebuildFailure === true;
    if (this.#forceRebuildFailure)
      this.#io.log("start option lhc.forceRebuildFailure: every compact rebuild will fail (proof mode)");
    this.#env = claudeChildEnv(env as NodeJS.ProcessEnv | undefined);
    this.#base = rest;
    if (typeof rest["cwd"] === "string") this.#cwd = rest["cwd"];
    if (typeof rest["pathToClaudeCodeExecutable"] === "string") this.#claudeBin = rest["pathToClaudeCodeExecutable"];
    if (typeof rest["model"] === "string") this.#model = rest["model"];
    if (typeof rest["permissionMode"] === "string") this.#permissionMode = rest["permissionMode"] as PermissionMode;
    if (typeof rest["maxThinkingTokens"] === "number") this.#maxThinkingTokens = rest["maxThinkingTokens"];
    this.#tokenFamily = seedTokenFamilyFromStartModel(rest["model"]);
    this.#lastModelId = isRealModelId(rest["model"]) ? rest["model"] : null;
    this.#io.log(formatTokenFamilyLog(this.#tokenFamily, rest["model"]));
    this.#lhc = createLhc({ claudeBin: this.#claudeBin, env: this.#env, tokenFamily: this.#tokenFamily.family });

    if (typeof resume === "string" && resume !== "") {
      const threadId = await resolveSession(resume, this.#home);
      if (threadId === null) throw new Error(`no LHC thread holds the Claude session ${resume}`);
      this.#threadId = threadId;
      this.#thread = threadRef(threadId, this.#home);
      const anchor =
        typeof resumeSessionAt === "string" && resumeSessionAt !== ""
          ? await this.#resolveAnchor(resumeSessionAt, resume)
          : null;
      const stored = await resumeCompactPolicy(this.#thread, sidecarOptions.compact, (line) => this.#io.log(line));
      this.#compactPolicy = { stored, window: null };
      await this.#settleOpenTurn("session restarted");
      const keptTail = anchor === null ? null : await this.#rollBack(anchor);
      if (keptTail !== null && keptTail >= this.#effectiveCompactPolicy().trigger)
        await this.#compactAtStart(keptTail, "after rollback");
      else await this.#startProjectedGeneration();
      await this.#windowRead;
      if (this.#pendingCompact !== null) {
        this.#pendingCompact = null;
        await this.#compactAtStart(this.#lastContextTokens, "before the first prompt");
      }
      this.#io.log(`resumed thread ${threadId} via ${resume} as generation ${this.#gen?.sessionId}`);
      return;
    }

    const compact = sidecarOptions.compact;
    if (compact === undefined) throw new Error("lhc.compact is required to create a thread");
    const first = typeof sessionId === "string" && sessionId !== "" ? sessionId : randomUUID();
    const holder = await resolveSession(first, this.#home);
    if (holder !== null)
      throw new Error(
        `Claude session ${first} already names LHC thread ${holder}; a fresh start needs a new session id`,
      );
    this.#threadId = await createThread(this.#cwd, this.#home);
    this.#thread = threadRef(this.#threadId, this.#home);
    this.#compactPolicy = { stored: await storeCompactPolicy(this.#thread, compact), window: null };
    await bindSession(this.#threadId, first, this.#home);
    this.#gen = this.#startGeneration(first, {
      sessionId: first,
      title: nativeLhcTitle(this.#threadId),
    });
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
      this.#heldPrompts.push(message);
      this.#io.log(`holding a prompt during compact (${this.#heldPrompts.length} held)`);
      return;
    }
    const gen = this.#gen;
    if (gen === null) throw new Error("no live generation");
    if (!this.#turnOpen && this.#pendingCompact !== null) {
      const trigger = this.#pendingCompact;
      this.#pendingCompact = null;
      this.#heldPrompts.push(message);
      await this.#compact(trigger);
      return;
    }
    // The CLI writes the prompt line under the host's uuid; capturing under it lets a rollback walk resolve it.
    const uuid = message.uuid ?? randomUUID();
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
        this.#observeLaterModel(model);
        await gen.query.setModel(model);
        this.#windowRead = this.#readWindow(gen);
        await this.#windowRead;
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
    this.#stopping = null;
    if (gen !== null) {
      gen.superseded = true;
      gen.input.end();
      gen.query.close();
    }
    abortSummaryWorkers();
  }

  #startGeneration(sessionId: string, extra: Partial<Options>): Generation {
    const input = new InputQueue();
    let gen: Generation | null = null;
    const options: Options = {
      ...(this.#base as Options),
      ...(this.#model !== undefined ? { model: this.#model } : {}),
      ...(this.#permissionMode !== undefined ? { permissionMode: this.#permissionMode } : {}),
      ...(typeof this.#maxThinkingTokens === "number" ? { maxThinkingTokens: this.#maxThinkingTokens } : {}),
      env: this.#env,
      pathToClaudeCodeExecutable: this.#claudeBin,
      mcpServers: {
        ...((this.#base as Options).mcpServers ?? {}),
        [RETRIEVAL_SERVER_NAME]: createRetrievalServer(this.#lhc, () => this.#thread),
      },
      allowedTools: [...((this.#base as Options).allowedTools ?? []), ...RETRIEVAL_TOOL_NAMES],
      canUseTool: async (toolName, toolInput, callbackOptions) => {
        if (RETRIEVAL_TOOL_NAMES.includes(toolName)) return { behavior: "allow", updatedInput: toolInput };
        const { signal, ...rest } = callbackOptions;
        return (await this.#io.request(
          "canUseTool",
          { toolName, input: toolInput, ...rest },
          signal,
        )) as PermissionResult;
      },
      onUserDialog: async (request, callbackOptions) =>
        (await this.#io.request("onUserDialog", { request }, callbackOptions.signal)) as UserDialogResult,
      hooks: {
        ...((this.#base as Options).hooks ?? {}),
        PostToolUse: [{ hooks: [async (hookInput) => this.#onPostToolUse(gen, hookInput as PostToolUseHookInput)] }],
        PostToolUseFailure: [
          { hooks: [async (hookInput) => this.#onPostToolUseFailure(gen, hookInput as PostToolUseFailureHookInput)] },
        ],
        PostToolBatch: [
          { hooks: [async (hookInput) => this.#onPostToolBatch(gen, hookInput as PostToolBatchHookInput)] },
        ],
      },
      ...extra,
    };
    const q = query({ prompt: input, options });
    gen = { sessionId, query: q, input, superseded: false };
    void this.#pump(gen);
    this.#windowRead = this.#readWindow(gen);
    return gen;
  }

  #effectiveCompactPolicy(): CompactPolicy {
    return capCompactPolicyToWindow(this.#compactPolicy);
  }

  async #readWindow(gen: Generation): Promise<void> {
    const read = ++this.#windowReads;
    const stale = (): boolean => read !== this.#windowReads || this.#closed;
    let rawMaxTokens: unknown;
    let totalTokens: unknown;
    try {
      ({ rawMaxTokens, totalTokens } = await gen.query.getContextUsage({ detail: "summary" }));
    } catch (cause) {
      if (!stale())
        this.#keepWindow(`context window read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    if (stale()) return;
    const window = windowFromUsage(rawMaxTokens);
    if (window === null) {
      const shown = typeof rawMaxTokens === "string" ? JSON.stringify(rawMaxTokens) : String(rawMaxTokens);
      this.#keepWindow(`context window read returned rawMaxTokens ${shown}, not a usable window`);
      return;
    }
    if (window !== this.#compactPolicy.window) {
      this.#compactPolicy = { ...this.#compactPolicy, window };
      this.#io.log(`context window ${window} for model ${this.#model ?? "(default)"}`);
      const { stored } = this.#compactPolicy;
      const { trigger, target } = this.#effectiveCompactPolicy();
      if (trigger !== stored.trigger || target !== stored.target)
        this.#io.log(`compact policy capped to window ${window}: trigger ${trigger} target ${target}`);
    }
    this.#queueCompactIfServedOver(totalTokens);
  }

  #queueCompactIfServedOver(totalTokens: unknown): void {
    if (typeof totalTokens !== "number" || !Number.isSafeInteger(totalTokens) || totalTokens < 0) return;
    this.#lastContextTokens = totalTokens;
    const { trigger } = this.#effectiveCompactPolicy();
    if (totalTokens < trigger || this.#pendingCompact !== null) return;
    this.#pendingCompact = "auto";
    this.#io.log(
      `served context ${totalTokens} tokens is at or past the compact trigger ${trigger}; compacting before the next prompt`,
    );
  }

  #keepWindow(reason: string): void {
    const { trigger, target } = this.#effectiveCompactPolicy();
    this.#io.log(`${reason}; compact policy stays trigger ${trigger} target ${target}`);
  }

  #midTurnDue(): CompactTrigger | null {
    if (this.#compacting || this.#stopping !== null || this.#closed || this.#midTurnFailed) return null;
    if (this.#pendingCompact !== null) return this.#pendingCompact;
    return this.#lastContextTokens >= this.#effectiveCompactPolicy().trigger ? "auto" : null;
  }

  #onPostToolUse(gen: Generation | null, hookInput: PostToolUseHookInput): HookJSONOutput {
    const proceed: HookJSONOutput = { continue: true };
    if (gen === null || gen.superseded || gen !== this.#gen || hookInput.agent_id !== undefined) return proceed;
    this.#batch.settle(hookInput.tool_use_id);
    const trigger = this.#midTurnDue();
    if (trigger === null) return proceed;
    const unsettled = this.#batch.unsettled();
    if (unsettled.length > 0) {
      this.#io.log(
        `${stamp()} compact (${trigger}) due mid-turn; PostToolUse ${hookInput.tool_name} ${hookInput.tool_use_id} is not a safe boundary: ${unsettled.length} of ${this.#batch.size} tool call(s) in the batch unsettled (${unsettled.join(", ")})`,
      );
      return proceed;
    }
    this.#stopping = trigger;
    this.#swap = { stoppedAt: Date.now(), sessionId: "" };
    if (this.#pendingCompact === trigger) this.#pendingCompact = null;
    this.#io.log(
      `${stamp()} compact (${trigger}) due mid-turn; stopping generation ${gen.sessionId} at the safe boundary after PostToolUse ${hookInput.tool_name} ${hookInput.tool_use_id} (batch of ${this.#batch.size} settled)`,
    );
    return { continue: false, suppressOutput: true, stopReason: MID_TURN_STOP_REASON };
  }

  #onPostToolBatch(gen: Generation | null, hookInput: PostToolBatchHookInput): HookJSONOutput {
    if (
      gen !== null &&
      gen === this.#gen &&
      hookInput.agent_id === undefined &&
      (this.#stopping !== null || this.#midTurnDue() !== null)
    ) {
      this.#io.log(
        `${stamp()} PostToolBatch: ${hookInput.tool_calls.length} tool call(s) ${hookInput.tool_calls.map((c) => c.tool_use_id).join(", ")}${this.#stopping !== null ? " (stop already requested)" : ""}`,
      );
    }
    return { continue: true };
  }

  #onPostToolUseFailure(gen: Generation | null, hookInput: PostToolUseFailureHookInput): HookJSONOutput {
    if (gen !== null && gen === this.#gen && hookInput.agent_id === undefined)
      this.#batch.settle(hookInput.tool_use_id);
    return { continue: true };
  }

  #trackTools(message: SDKMessage): void {
    for (const name of this.#batch.observe(message))
      this.#turnToolCalls.set(name, (this.#turnToolCalls.get(name) ?? 0) + 1);
  }

  #continuationNote(): SDKUserMessage {
    const total = [...this.#turnToolCalls.values()].reduce((a, b) => a + b, 0);
    const byName = [...this.#turnToolCalls.entries()].map(([name, n]) => `${name} ×${n}`).join(", ");
    const done =
      total === 0
        ? "the work already done in this turn is"
        : `the ${total} tool call${total === 1 ? "" : "s"} already made in this turn (${byName}) and their results are`;
    const body = `[runtime note] Context was compacted in the middle of this turn. The turn is still in progress: ${done} recorded above, up to the compact continuation marker. Continue the task from exactly that point. Do not repeat a completed step, do not start over, and do not wait for a new user message.`;
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: body }] },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage;
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
        await this.#intake([
          {
            eventKind: "turn_end",
            idempotencyKey: `claude-lhc:${randomUUID()}:0:turn_end`,
            actor: "system",
            harness: HARNESS,
            payload: {
              outcome: "aborted",
              outcomeReason: reason.slice(0, 200),
              ...(this.#turnStartedAt ? { startedAt: this.#turnStartedAt } : {}),
              endedAt: new Date().toISOString(),
            },
          },
        ]).catch(() => undefined);
        this.#turnOpen = false;
      }
      resetSegmentFold(this.#segmentFold);
      this.#io.fail(`Claude runtime stream failed: ${reason}`);
    }
  }

  async #onMessage(message: SDKMessage): Promise<void> {
    if (this.#swap !== null && this.#swap.sessionId !== "" && message.session_id === this.#swap.sessionId) {
      this.#io.log(
        `${stamp()} swap complete: first message (${message.type}${"subtype" in message ? `/${String(message.subtype)}` : ""}) of generation ${message.session_id} ${Date.now() - this.#swap.stoppedAt} ms after the hook stop`,
      );
      this.#swap = null;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.#claudeCodeVersion = message.claude_code_version;
      const pending = (message.mcp_servers ?? [])
        .filter((server) => server.status === "pending")
        .map((server) => server.name);
      if (pending.length > 0)
        this.#io.log(
          `init ${message.session_id}: ${message.tools.length} tool(s); ${pending.length} MCP server(s) still pending (${pending.join(", ")}), so usage reads low until they join the tool list`,
        );
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      const inner = (message as { message?: { model?: unknown } }).message;
      this.#observeLaterModel(inner?.model);
      if (!this.#turnOpen) {
        this.#turnOpen = true;
        this.#turnStartedAt = new Date().toISOString();
      }
    }
    this.#trackTools(message);
    if (this.#stopping !== null && (message.type === "user" || message.type === "result"))
      this.#io.log(
        `${stamp()} wire after stop: ${message.type}${message.type === "result" ? `/${message.subtype} terminal=${String((message as unknown as Record<string, unknown>)["terminal_reason"])}` : ""}`,
      );
    if (message.type === "result") {
      const stopped = (message as unknown as Record<string, unknown>)["terminal_reason"] === HOOK_STOPPED;
      const trigger = this.#stopping;
      this.#stopping = null;
      this.#batch.clear();
      if (trigger !== null && stopped) {
        await this.#compactMidTurn(trigger);
        return;
      }
      if (trigger !== null)
        this.#io.log(
          `mid-turn stop requested but the result came back ${message.subtype}/${String((message as unknown as Record<string, unknown>)["terminal_reason"])}; treating it as the turn end`,
        );
      this.#turnToolCalls.clear();
      this.#midTurnFailed = false;
    }
    const mapped = mapSdkMessage(message, this.#turnStartedAt);
    if (mapped.contextTokens !== undefined) this.#lastContextTokens = mapped.contextTokens;
    if (mapped.events.length > 0 && (this.#turnOpen || !mapped.turnEnd)) await this.#intake(mapped.events);
    if (mapped.turnEnd) resetSegmentFold(this.#segmentFold);
    else if (mapped.events.length > 0) await this.#maybeSegment(message, mapped.events);
    if (!mapped.turnEnd) {
      this.#io.emit(message);
      return;
    }
    this.#turnOpen = false;
    this.#turnStartedAt = undefined;
    const trigger = this.#dueCompact();
    if (trigger === null) this.#io.emit(message);
    else await this.#compact(trigger, message);
  }

  async #maybeSegment(message: SDKMessage, events: readonly MessageEventInput[]): Promise<void> {
    const candidate = foldSegmentEvents(this.#segmentFold, events);
    if (candidate === null || !this.#turnOpen || this.#compacting || this.#stopping !== null) return;
    const threshold = segmentThresholdTokens(this.#effectiveCompactPolicy().target, CONTINUATION_FULL_SHARE_PERCENT);
    const metadata = await this.#lhc.threadView.hostMetadata(this.#thread);
    if (!metadata.ok) {
      this.#io.log(`segment: host metadata ${metadata.error.code}: ${metadata.error.reason}`);
      return;
    }
    const tokens = metadata.value.activeTurn === null ? 0 : metadata.value.activeTurn.estimatedTokens;
    if (tokens < threshold) return;
    const wireUuid = (message as unknown as Record<string, unknown>)["uuid"];
    const lineUuid = typeof wireUuid === "string" && wireUuid !== "" ? wireUuid : `segment:${candidate.closedBy}`;
    await this.#intake([segmentEndEvent(lineUuid, this.#turnStartedAt)]);
    this.#turnStartedAt = new Date().toISOString();
    this.#io.log(
      `${stamp()} segment: canonical turn closed at ${tokens} tokens (threshold ${threshold}) after ${candidate.closedBy}`,
    );
  }

  #dueCompact(): "manual" | "auto" | null {
    if (this.#compacting) return null;
    if (this.#pendingCompact !== null) {
      const trigger = this.#pendingCompact;
      this.#pendingCompact = null;
      return trigger;
    }
    return this.#lastContextTokens >= this.#effectiveCompactPolicy().trigger ? "auto" : null;
  }

  async #intake(events: readonly MessageEventInput[]): Promise<void> {
    if (events.length === 0) return;
    const result = await this.#lhc.intakeStream.messageEvents(this.#thread, events);
    if (!result.ok) throw new Error(`LHC intake refused: ${result.error.code}: ${result.error.reason}`);
  }

  async #resolveAnchor(anchorId: string, resumed: string): Promise<RollbackAnchor> {
    const anchor = await resolveRollbackAnchor({
      lhc: this.#lhc,
      thread: this.#thread,
      anchor: anchorId,
      sessionId: resumed,
      cwd: this.#cwd,
      env: this.#env,
    });
    if (anchor === null) throw new Error(`rollback anchor ${anchorId} not found`);
    return anchor;
  }

  async #rollBack({ anchor, keepThroughEventOrder, via }: RollbackAnchor): Promise<number> {
    await this.#intake([
      {
        eventKind: "rollback",
        idempotencyKey: `claude-lhc:rollback:${randomUUID()}`,
        actor: "system",
        harness: HARNESS,
        payload: { keepThroughEventOrder, reason: `host resumeSessionAt ${anchor}` },
      },
    ]);
    const status = await this.#lhc.threadView.status(this.#thread);
    if (!status.ok) throw new Error(`LHC view status failed: ${status.error.reason}`);
    this.#io.log(
      `rollback to event ${keepThroughEventOrder} via ${via}${via === anchor ? "" : ` (nearest captured ancestor of ${anchor})`}; served tail ${status.value.tailTokens} tokens`,
    );
    return status.value.tailTokens;
  }

  async #compactAtStart(preTokens: number, when: string): Promise<void> {
    try {
      await this.#rebuild("auto", preTokens);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.#io.log(`compact ${when} failed: ${reason}; serving the uncompacted view`);
      await this.#lhc.logging
        .write(this.#thread, { level: "warning", message: `[lhc compact:auto] ${when} failed: ${reason}` })
        .catch(() => undefined);
      if (this.#gen === null) await this.#startProjectedGeneration();
    }
  }

  async #settleOpenTurn(reason: string): Promise<void> {
    const turns = await this.#lhc.turns.listTurns(this.#thread);
    if (!turns.ok) throw new Error(`LHC turns read failed: ${turns.error.reason}`);
    const open = turns.value.find((turn) => turn.status === "open");
    if (open === undefined || open.memberMessageIds.length === 0) return;
    await this.#intake([
      {
        eventKind: "turn_end",
        idempotencyKey: `claude-lhc:settle:${open.turnId}:turn_end`,
        actor: "system",
        harness: HARNESS,
        payload: { outcome: "aborted", outcomeReason: reason, endedAt: new Date().toISOString() },
      },
    ]);
  }

  async #openTurnId(): Promise<string> {
    const turns = await this.#lhc.turns.listTurns(this.#thread);
    if (!turns.ok) throw new Error(`LHC turns read failed: ${turns.error.reason}`);
    const open = turns.value.find((turn) => turn.status === "open");
    if (open === undefined) throw new Error("LHC thread has no open turn");
    return open.turnId;
  }

  async #compact(trigger: CompactTrigger, heldResult?: SDKMessage): Promise<void> {
    if (this.#gen === null || this.#compacting) {
      if (heldResult !== undefined) this.#io.emit(heldResult);
      return;
    }
    this.#compacting = true;
    const startedAt = Date.now();
    const preTokens = this.#lastContextTokens;
    const previous = this.#gen;
    this.#io.emit(this.#syntheticStatus(previous.sessionId, "compacting"));
    try {
      const { next, postTokens } = await this.#rebuild(trigger, preTokens);
      this.#io.emit(this.#syntheticStatus(previous.sessionId, null, { compact_result: "success" }));
      this.#io.emit(this.#compactBoundary(trigger, preTokens, postTokens, startedAt, next.sessionId));
      this.#lastContextTokens = 0;
      if (heldResult !== undefined) this.#io.emit({ ...heldResult, session_id: next.sessionId } as SDKMessage);
      else if (trigger === "manual") this.#io.emit(this.#syntheticResult(next.sessionId, startedAt, ""));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.#io.log(`compact (${trigger}) failed: ${reason}`);
      await this.#lhc.logging
        .write(this.#thread, { level: "warning", message: `[lhc compact:${trigger}] failed: ${reason}` })
        .catch(() => undefined);
      this.#io.emit(
        this.#syntheticStatus(previous.sessionId, null, { compact_result: "failed", compact_error: reason }),
      );
      if (heldResult !== undefined) this.#io.emit(heldResult);
      else if (trigger === "manual")
        this.#io.emit(this.#syntheticResult(previous.sessionId, startedAt, `LHC compact failed: ${reason}`));
    } finally {
      this.#compacting = false;
    }
    await this.#replayHeld();
  }

  async #compactMidTurn(trigger: CompactTrigger): Promise<void> {
    const previous = this.#gen;
    if (previous === null) return;
    this.#compacting = true;
    const startedAt = Date.now();
    const preTokens = this.#lastContextTokens;
    this.#io.emit(this.#syntheticStatus(previous.sessionId, "compacting"));
    let target: Generation = previous;
    try {
      const openTurn = await this.#openTurnId();
      await this.#intake([
        {
          eventKind: "turn_end",
          idempotencyKey: `claude-lhc:midturn:${openTurn}:turn_end`,
          actor: "system",
          harness: HARNESS,
          payload: {
            outcomeReason: CONTEXT_COMPACT_CONTINUE_REASON,
            ...(this.#turnStartedAt ? { startedAt: this.#turnStartedAt } : {}),
            endedAt: new Date().toISOString(),
          },
        },
      ]);
      const { next, postTokens } = await this.#rebuild(trigger, preTokens);
      target = next;
      this.#io.emit(this.#syntheticStatus(previous.sessionId, null, { compact_result: "success" }));
      this.#io.emit(this.#compactBoundary(trigger, preTokens, postTokens, startedAt, next.sessionId));
      this.#lastContextTokens = 0;
      if (this.#swap !== null) this.#swap.sessionId = next.sessionId;
      this.#io.log(
        `${stamp()} mid-turn compact (${trigger}) swapped ${previous.sessionId} → ${next.sessionId}; rebuild took ${Date.now() - startedAt} ms; continuing the turn there`,
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.#io.log(
        `mid-turn compact (${trigger}) failed: ${reason}; continuing the turn in generation ${previous.sessionId} uncompacted`,
      );
      await this.#lhc.logging
        .write(this.#thread, { level: "warning", message: `[lhc compact:${trigger}] mid-turn failed: ${reason}` })
        .catch(() => undefined);
      this.#io.emit(
        this.#syntheticStatus(previous.sessionId, null, { compact_result: "failed", compact_error: reason }),
      );
      this.#midTurnFailed = true;
      this.#swap = null;
    } finally {
      this.#compacting = false;
    }
    const note = this.#continuationNote();
    const uuid = randomUUID();
    target.input.push({ message: note, before: async () => this.#intake(mapPrompt(note, uuid, true)) });
    await this.#replayHeld();
  }

  async #replayHeld(): Promise<void> {
    const held = this.#heldPrompts.splice(0);
    if (held.length > 0)
      this.#io.log(`replaying ${held.length} held prompt(s) into generation ${this.#gen?.sessionId}`);
    for (const message of held) await this.pushUser(message);
  }

  #compactBoundary(
    trigger: CompactTrigger,
    preTokens: number,
    postTokens: number,
    startedAt: number,
    sessionId: string,
  ): SDKMessage {
    return {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger,
        pre_tokens: preTokens,
        post_tokens: postTokens,
        duration_ms: Date.now() - startedAt,
      },
      uuid: randomUUID(),
      session_id: sessionId,
    } as unknown as SDKMessage;
  }

  #observeLaterModel(modelId: unknown): void {
    const observed = laterModelObservation(this.#lastModelId, modelId, this.#tokenFamily);
    if (observed === null) return;
    this.#lastModelId = observed.modelId;
    this.#io.log(observed.log);
  }

  async #rebuild(trigger: CompactTrigger, preTokens: number): Promise<{ next: Generation; postTokens: number }> {
    if (this.#forceRebuildFailure)
      throw new Error("rebuild failure forced by the start option lhc.forceRebuildFailure");
    await this.#windowRead;
    await this.#awaitDerivations();
    const lowerBound = this.#effectiveCompactPolicy().target;
    const opts = { profile: "continuation", params: { lowerBound } };
    const preview = await this.#lhc.threadView.previewCompact(this.#thread, opts);
    if (!preview.ok) throw new Error(`compact preview error: ${preview.error.reason}`);
    if (preview.value.kind === "error") throw new Error(`compact blocked: ${preview.value.reason}`);
    const installed = await this.#lhc.threadView.compact(this.#thread, opts);
    if (!installed.ok) throw new Error(`compact error: ${installed.error.reason}`);
    const receipt: CompactReceipt = installed.value;

    const continuationTurnId = await this.#openTurnId();
    await this.#intake([
      {
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
      },
    ]);
    const postTokens = receipt.totalTokens;
    const summary = formatCompactRuntimeNote({
      trigger,
      preTokens,
      totalTokens: receipt.totalTokens,
      lowerBound,
      compactPoint: receipt.compactPoint,
      coveredFrom: receipt.coveredFrom,
      degradedCount: receipt.degraded.length,
      gapsCount: receipt.gaps.length,
      bands: receipt.bands,
      family: this.#tokenFamily,
    });
    this.#io.log(summary);
    await this.#lhc.logging.write(this.#thread, { level: "info", message: summary }).catch(() => undefined);

    const next = await this.#startProjectedGeneration();
    return { next, postTokens };
  }

  async #awaitDerivations(): Promise<void> {
    const deadline = Date.now() + DERIVATION_WAIT_MS;
    for (;;) {
      const status = await this.#lhc.threadView.status(this.#thread);
      if (!status.ok || status.value.derivation.pending === 0) return;
      if (Date.now() >= deadline) {
        this.#io.log(
          `compact: ${status.value.derivation.pending} derivations still pending after ${DERIVATION_WAIT_MS} ms; assembling from what is ready`,
        );
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  async #startProjectedGeneration(): Promise<Generation> {
    const view = await this.#lhc.threadView.getSessionThreadView(this.#thread);
    if (!view.ok) throw new Error(`LHC view read failed: ${view.error.reason}`);
    const sessionId = randomUUID();
    const cwd = this.#cwd;
    const entries = projectView(view.value, {
      sessionId,
      cwd,
      version: this.#claudeCodeVersion,
      permissionMode: this.#permissionMode ?? "default",
      model: this.#model ?? "claude-sonnet-5",
    });
    const title = nativeLhcTitle(this.#threadId);
    const dest = entries.length === 0 ? null : await writeProjectedSession({ sessionId, cwd, entries, env: this.#env });
    if (dest !== null) await labelNativeSession(sessionId, title, cwd, this.#io);
    await bindSession(this.#threadId, sessionId, this.#home);
    const next = this.#startGeneration(sessionId, dest === null ? { sessionId, title } : { resume: sessionId });
    const old = this.#gen;
    this.#gen = next;
    if (old !== null) {
      old.superseded = true;
      for (const item of old.input.drain()) next.input.push(item);
      old.query.close();
    }
    this.#io.log(
      `generation ${sessionId}: ${entries.length} projected lines from ${view.value.entries.length} served entries ${dest === null ? "(fresh native session)" : `at ${dest}`}`,
    );
    return next;
  }

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

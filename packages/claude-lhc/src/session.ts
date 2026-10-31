import { randomUUID } from "node:crypto";
import {
  type HookJSONOutput,
  type McpSdkServerConfigWithInstance,
  type McpSetServersResult,
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
import { type ControlCall, parseControl, ReplayLedger } from "./controls.js";
import { bindSession, createLhc, createThread, resolveSession, threadRef } from "./lhcHome.js";
import { writeProjectedSession } from "./nativeSessionFile.js";
import { FALLBACK_CLAUDE_CODE_VERSION, FALLBACK_PROJECTION_MODEL, projectView } from "./projection/project.js";
import { parseCompactPolicy, parseSidecarOptions, type SidecarRequestMethod, type WireOptions } from "./protocol.js";
import { createRetrievalServer, RETRIEVAL_SERVER_NAME, RETRIEVAL_TOOL_NAMES } from "./retrieval.js";
import { appendRollback, type RollbackAnchor, resolveRollbackAnchor } from "./rollbackAnchor.js";
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
const MID_TURN_STOP_REASON = "lhc mid-turn compact";
const HOOK_STOPPED = "hook_stopped";

type CompactTrigger = "manual" | "auto";
type QueuedInput = { kind: "prompt"; message: SDKUserMessage } | { kind: "compact" };
interface SentPrompt {
  message: SDKUserMessage;
  started: boolean;
}
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
  readonly retrieval: McpSdkServerConfigWithInstance;
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
  readonly #replay = new ReplayLedger();
  readonly #replaying = new Set<Promise<unknown>>();
  #turnOpen = false;
  #turnStartedAt: string | undefined;
  #lastContextTokens = 0;
  #autoCompactDue = false;
  #compacting = false;
  #batch = new ToolBatch();
  #turnToolCalls = new Map<string, number>();
  #segmentFold = createSegmentFoldState();
  #stopping: CompactTrigger | null = null;
  #midTurnFailed = false;
  #swap: { stoppedAt: number; sessionId: string } | null = null;
  readonly #inputs: QueuedInput[] = [];
  readonly #sent = new Map<string, SentPrompt>();
  #lifecycleSeen = false;
  #advancing = false;
  #inputEnded = false;
  #model: string | undefined;
  #permissionMode: PermissionMode | undefined;
  #maxThinkingTokens: number | null | undefined;
  #claudeCodeVersion = FALLBACK_CLAUDE_CODE_VERSION;
  #compactPolicy: ResolvedCompactPolicy = { stored: { trigger: 0, target: 0 }, window: null };
  #windowRead: Promise<number | null> = Promise.resolve(null);
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
      resumeDropsTurn,
      sessionId,
      canUseTool: _c,
      onUserDialog: _d,
      sessionStore: _s,
      env,
      lhc,
      ...rest
    } = wire as Record<string, unknown>;
    if (resumeDropsTurn !== undefined)
      throw new Error(
        "resumeDropsTurn is refused: claude-lhc rolls back in its own record, so send resumeSessionAt alone",
      );
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
      if (anchor !== null) await this.#rollBack(anchor);
      await this.#startProjectedGeneration();
      const served = this.#servedPastTrigger(await this.#windowRead);
      if (served !== null) await this.#compactBeforeFirstPrompt(served);
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
    this.#gen = await this.#startGeneration(first, {
      sessionId: first,
      title: nativeLhcTitle(this.#threadId),
    });
    this.#io.log(`created thread ${this.#threadId} as generation ${first}`);
  }

  async pushUser(message: SDKUserMessage): Promise<void> {
    if (this.#closed) return;
    if (compactCommand(message) !== null) this.#inputs.push({ kind: "compact" });
    else if (this.#inputs.length > 0 || this.#compacting || this.#stopping !== null || this.#autoCompactDue)
      this.#inputs.push({ kind: "prompt", message });
    else await this.#send(message);
    await this.#advance();
  }

  endInput(): void {
    this.#inputEnded = true;
    this.#endIfIdle();
  }

  #endIfIdle(): void {
    if (this.#inputEnded && this.#inputs.length === 0 && this.#sent.size === 0 && !this.#compacting && !this.#closed)
      this.#io.end();
  }

  // Hosts pair results with inputs in order, so a queued input starts only once every earlier one has its
  // result. A prompt sent while nothing is queued goes straight to the CLI, which may fold it into the running turn.
  async #advance(): Promise<void> {
    if (this.#advancing) return;
    this.#advancing = true;
    try {
      while (!this.#closed && this.#sent.size === 0 && !this.#compacting && this.#stopping === null) {
        const next = this.#inputs.shift();
        if (next === undefined) break;
        if (next.kind === "compact") await this.#compact("manual");
        else await this.#send(next.message);
      }
    } finally {
      this.#advancing = false;
    }
    this.#endIfIdle();
  }

  async #send(message: SDKUserMessage): Promise<void> {
    if (this.#autoCompactDue && !this.#turnOpen) {
      this.#autoCompactDue = false;
      await this.#compact("auto");
    }
    const gen = this.#gen;
    if (gen === null) throw new Error("no live generation");
    const promptUuid = message.uuid ?? randomUUID();
    this.#sent.set(promptUuid, { message: { ...message, uuid: promptUuid }, started: false });
    gen.input.push({
      message: { ...message, uuid: promptUuid },
      before: async () => {
        const events = mapPrompt(message, promptUuid, this.#turnOpen);
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
    const call = parseControl(method, params);
    if (call.kind === "sidecar") {
      await this.#setCompactPolicy(gen, call.args[0]);
      return undefined;
    }
    const value = await (call.kind === "forward-and-replay" ? this.#recorded(gen, call) : this.#invoke(gen, call));
    const [first] = call.args;
    switch (call.method) {
      case "setModel":
        this.#model = typeof first === "string" ? first : undefined;
        this.#observeLaterModel(first);
        break;
      case "setPermissionMode":
        this.#permissionMode = first as PermissionMode;
        break;
      case "setMaxThinkingTokens":
        this.#maxThinkingTokens = typeof first === "number" ? first : null;
        break;
    }
    if (call.method === "setModel" || (call.method === "applyFlagSettings" && Object.hasOwn(first as object, "model")))
      await this.#checkServedContext(gen);
    return value;
  }

  async #invoke(gen: Generation, { method, args }: ControlCall): Promise<unknown> {
    const sent =
      method === "setMcpServers" ? [{ ...(args[0] as object), [RETRIEVAL_SERVER_NAME]: gen.retrieval }] : args;
    return Reflect.apply(gen.query[method as keyof Query] as (...a: unknown[]) => unknown, gen.query, sent);
  }

  #recorded(gen: Generation, call: ControlCall): Promise<unknown> {
    const sent = this.#invoke(gen, call).then((value) => {
      this.#replay.record(call);
      return value;
    });
    this.#replaying.add(sent);
    return sent.finally(() => this.#replaying.delete(sent));
  }

  async #replayControls(gen: Generation): Promise<void> {
    const replayed: string[] = [];
    let seen = 0;
    for (;;) {
      await Promise.allSettled(this.#replaying);
      const calls = this.#replay.recordedAfter(seen);
      if (calls.length === 0) break;
      seen = this.#replay.seq;
      for (const call of calls) {
        replayed.push(call.method);
        try {
          const value = await this.#invoke(gen, call);
          const failed = call.method === "setMcpServers" ? Object.keys((value as McpSetServersResult).errors) : [];
          if (failed.length > 0)
            this.#io.log(`generation ${gen.sessionId}: replayed MCP server(s) failed: ${failed.join(", ")}`);
        } catch (cause) {
          this.#io.log(
            `generation ${gen.sessionId}: ${call.method} not replayed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }
    if (replayed.length > 0) this.#io.log(`generation ${gen.sessionId}: replayed ${replayed.join(", ")}`);
  }

  async #setCompactPolicy(gen: Generation, value: unknown): Promise<void> {
    const stored = await storeCompactPolicy(this.#thread, parseCompactPolicy(value, "setCompactPolicy params.policy"));
    this.#compactPolicy = { ...this.#compactPolicy, stored };
    this.#io.log(`compact policy set on thread: trigger ${stored.trigger} target ${stored.target}`);
    this.#logCappedPolicy();
    await this.#checkServedContext(gen);
  }

  async #checkServedContext(gen: Generation): Promise<void> {
    this.#windowRead = this.#readWindow(gen);
    const read = await this.#windowRead;
    if (read !== null) this.#autoCompactDue = false;
    const served = this.#servedPastTrigger(read);
    if (served !== null) {
      this.#lastContextTokens = served;
      this.#autoCompactDue = true;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const unsent = this.#inputs.filter((input) => input.kind === "prompt").length;
    if (unsent > 0) this.#io.log(`closing with ${unsent} held prompt(s) never sent`);
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

  async #startGeneration(sessionId: string, extra: Partial<Options>): Promise<Generation> {
    const input = new InputQueue();
    const retrieval = createRetrievalServer(this.#lhc, () => this.#thread);
    let gen: Generation | null = null;
    const options: Options = {
      ...(this.#base as Options),
      ...(this.#model !== undefined ? { model: this.#model } : {}),
      ...(this.#permissionMode !== undefined ? { permissionMode: this.#permissionMode } : {}),
      ...(typeof this.#maxThinkingTokens === "number" ? { maxThinkingTokens: this.#maxThinkingTokens } : {}),
      env: this.#env,
      pathToClaudeCodeExecutable: this.#claudeBin,
      mcpServers: { ...((this.#base as Options).mcpServers ?? {}), [RETRIEVAL_SERVER_NAME]: retrieval },
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
    gen = { sessionId, query: q, input, retrieval, superseded: false };
    void this.#pump(gen);
    await this.#replayControls(gen);
    this.#windowRead = this.#readWindow(gen);
    return gen;
  }

  #effectiveCompactPolicy(): CompactPolicy {
    return capCompactPolicyToWindow(this.#compactPolicy);
  }

  async #readWindow(gen: Generation): Promise<number | null> {
    const read = ++this.#windowReads;
    const stale = (): boolean => read !== this.#windowReads || this.#closed;
    let rawMaxTokens: unknown;
    let totalTokens: unknown;
    try {
      ({ rawMaxTokens, totalTokens } = await gen.query.getContextUsage({ detail: "summary" }));
    } catch (cause) {
      if (!stale())
        this.#keepWindow(`context window read failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
    if (stale()) return null;
    const window = windowFromUsage(rawMaxTokens);
    if (window === null) {
      const shown = typeof rawMaxTokens === "string" ? JSON.stringify(rawMaxTokens) : String(rawMaxTokens);
      this.#keepWindow(`context window read returned rawMaxTokens ${shown}, not a usable window`);
      return null;
    }
    if (window !== this.#compactPolicy.window) {
      this.#compactPolicy = { ...this.#compactPolicy, window };
      this.#io.log(`context window ${window} for model ${this.#model ?? "(default)"}`);
      this.#logCappedPolicy();
    }
    return typeof totalTokens === "number" && Number.isSafeInteger(totalTokens) && totalTokens >= 0
      ? totalTokens
      : null;
  }

  #logCappedPolicy(): void {
    const { stored, window } = this.#compactPolicy;
    const { trigger, target } = this.#effectiveCompactPolicy();
    if (trigger !== stored.trigger || target !== stored.target)
      this.#io.log(`compact policy capped to window ${window}: trigger ${trigger} target ${target}`);
  }

  #servedPastTrigger(served: number | null): number | null {
    const { trigger } = this.#effectiveCompactPolicy();
    if (served === null || served < trigger) return null;
    this.#io.log(
      `served context ${served} tokens is at or past the compact trigger ${trigger}; compacting before the next prompt`,
    );
    return served;
  }

  #keepWindow(reason: string): void {
    const { trigger, target } = this.#effectiveCompactPolicy();
    this.#io.log(`${reason}; compact policy stays trigger ${trigger} target ${target}`);
  }

  #midTurnDue(): CompactTrigger | null {
    if (this.#compacting || this.#stopping !== null || this.#closed || this.#midTurnFailed) return null;
    if (this.#autoCompactDue) return "auto";
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
    this.#autoCompactDue = false;
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
    if ((message as { type: string }).type === "command_lifecycle") {
      this.#onCommandLifecycle(message as unknown as { command_uuid: string; state: string });
      this.#io.emit(message);
      await this.#advance();
      return;
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
    for (const [uuid, sent] of this.#sent) if (sent.started || !this.#lifecycleSeen) this.#sent.delete(uuid);
    const trigger = this.#dueCompact();
    if (trigger === null) this.#io.emit(message);
    else await this.#compact(trigger, message);
    await this.#advance();
  }

  #onCommandLifecycle({ command_uuid, state }: { command_uuid: string; state: string }): void {
    this.#lifecycleSeen = true;
    const sent = this.#sent.get(command_uuid);
    if (sent === undefined) return;
    if (state === "started") sent.started = true;
    else if (state === "completed" || state === "cancelled") this.#sent.delete(command_uuid);
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

  #dueCompact(): "auto" | null {
    if (this.#compacting) return null;
    if (this.#autoCompactDue) {
      this.#autoCompactDue = false;
      return "auto";
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

  async #rollBack(rollback: RollbackAnchor): Promise<void> {
    const { anchor, keepThroughEventOrder, via } = rollback;
    const target = `rollback to event ${keepThroughEventOrder} via ${via}${via === anchor ? "" : ` (nearest captured ancestor of ${anchor})`}`;
    const recorded = await appendRollback(this.#lhc, this.#thread, rollback, `host resumeSessionAt ${anchor}`);
    this.#io.log(recorded ? target : `${target} skipped: the anchor is already the visible tail`);
  }

  async #compactBeforeFirstPrompt(served: number): Promise<void> {
    try {
      await this.#rebuild("auto", served);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.#io.log(`compact before the first prompt failed: ${reason}; serving the uncompacted view`);
      await this.#lhc.logging
        .write(this.#thread, {
          level: "warning",
          message: `[lhc compact:auto] before the first prompt failed: ${reason}`,
        })
        .catch(() => undefined);
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
    const uuid = randomUUID();
    const note = { ...this.#continuationNote(), uuid };
    for (const [id, sent] of this.#sent) if (sent.started || !this.#lifecycleSeen) this.#sent.delete(id);
    this.#sent.set(uuid, { message: note, started: false });
    target.input.push({ message: note, before: async () => this.#intake(mapPrompt(note, uuid, true)) });
  }

  #requeueUnstarted(moved: ReadonlySet<string | undefined>): void {
    if (!this.#lifecycleSeen) return;
    const unstarted = [...this.#sent].filter(([uuid, sent]) => !sent.started && !moved.has(uuid));
    if (unstarted.length === 0) return;
    for (const [uuid] of unstarted) this.#sent.delete(uuid);
    this.#inputs.unshift(...unstarted.map(([, sent]): QueuedInput => ({ kind: "prompt", message: sent.message })));
    this.#io.log(`requeued ${unstarted.length} prompt(s) the replaced generation had not started`);
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
    this.#autoCompactDue = false;
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
      model: this.#model ?? FALLBACK_PROJECTION_MODEL,
    });
    const title = nativeLhcTitle(this.#threadId);
    const dest = entries.length === 0 ? null : await writeProjectedSession({ sessionId, cwd, entries, env: this.#env });
    if (dest !== null) await labelNativeSession(sessionId, title, cwd, this.#io);
    await bindSession(this.#threadId, sessionId, this.#home);
    const next = await this.#startGeneration(sessionId, dest === null ? { sessionId, title } : { resume: sessionId });
    const old = this.#gen;
    this.#gen = next;
    if (old !== null) {
      old.superseded = true;
      const moved = old.input.drain();
      for (const item of moved) next.input.push(item);
      this.#requeueUnstarted(new Set(moved.map((item) => item.message.uuid)));
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

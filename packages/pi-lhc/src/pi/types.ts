// Local declarations of the PI extension surface the connector consumes.
//
// These mirror the current `@earendil-works/pi-coding-agent` extension API as
// verified from vendor/pi (v0.83.x). The public registration surface is
// `pi.on(...)`, and handlers receive `(event, ctx)`. This file is deliberately
// a local mirror — do not import from pi-coding-agent here. Only surfaces
// pi-lhc actually uses are declared; keep it minimal when re-syncing.

// ── Hook vocabulary ──────────────────────────────────────────────────

/** Hooks the connector knows about. */
export type PiHookName =
  | "session_start"
  | "message_end"
  | "turn_end"
  | "agent_end"
  | "agent_settled"
  | "model_select"
  | "thinking_level_select"
  | "session_before_fork"
  | "session_before_switch"
  | "session_before_compact"
  | "session_compact"
  | "session_before_tree"
  | "session_shutdown"
  | "context";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type SessionCompactReason = "manual" | "threshold" | "overflow";

export interface SessionStartEvent {
  type: "session_start";
  reason: SessionStartReason;
  previousSessionFile?: string;
}
export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}
/** PI fires one turn_end per agent STEP (turnIndex resets to 0 each run); the
 *  converter must not map it 1:1 to an LHC turn_end. */
export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}
export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}
/** Fired after an agent run has fully settled: PI's own retry, native
 *  threshold/overflow compaction, and queued continuations have all run.
 *  The safe boundary for connector-initiated compaction. */
export interface AgentSettledEvent {
  type: "agent_settled";
}
export interface ModelSelectEvent {
  type: "model_select";
  model: ModelDescriptor;
  previousModel?: ModelDescriptor;
  source?: string;
}
export interface ThinkingLevelSelectEvent {
  type: "thinking_level_select";
  level: string;
  previousLevel: string;
}
export interface SessionBeforeForkEvent {
  type: "session_before_fork";
  entryId: string;
  position: "before" | "at";
}
export interface SessionBeforeSwitchEvent {
  type: "session_before_switch";
  reason: "new" | "resume";
  targetSessionFile?: string;
}
export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: SessionShutdownReason;
  targetSessionFile?: string;
}
export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}

export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  settings: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
}

export interface CompactionResult<T = unknown> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Optional estimated tokens after compaction when PI reports it. */
  estimatedTokensAfter?: number;
  details?: T;
}

export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  reason: SessionCompactReason;
  willRetry: boolean;
  preparation: CompactionPreparation;
  branchEntries: readonly SessionEntry[];
  customInstructions?: string;
  signal: AbortSignal;
}

export interface SessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: CompactionResult;
}

/** Fired before /tree navigation (branch switch within the PI session tree).
 *  Mirrored minimally: the connector only cancels or passes through. */
export interface SessionBeforeTreeEvent {
  type: "session_before_tree";
  preparation: unknown;
  signal: AbortSignal;
}

export interface SessionBeforeTreeResult {
  cancel?: boolean;
}

export interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: SessionEntry;
  fromExtension: boolean;
  /** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery. */
  reason?: SessionCompactReason;
  /** True when the aborted turn is retried after this compaction (overflow recovery). */
  willRetry?: boolean;
}

/** Return shape PI's `context` hook expects when replacing messages. */
export interface ContextEventResult {
  messages?: AgentMessage[];
}

/** Maps each hook to the payload PI delivers with it. */
export interface PiHookEventMap {
  session_start: SessionStartEvent;
  message_end: MessageEndEvent;
  turn_end: TurnEndEvent;
  agent_end: AgentEndEvent;
  agent_settled: AgentSettledEvent;
  model_select: ModelSelectEvent;
  thinking_level_select: ThinkingLevelSelectEvent;
  session_before_fork: SessionBeforeForkEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_compact: SessionBeforeCompactEvent;
  session_compact: SessionCompactEvent;
  session_before_tree: SessionBeforeTreeEvent;
  session_shutdown: SessionShutdownEvent;
  context: ContextEvent;
}

/** Void-returning hooks (all except `session_before_compact`, `session_before_tree`, and `context`). */
export type PiVoidHookName = Exclude<PiHookName, "session_before_compact" | "session_before_tree" | "context">;

export type PiVoidHookHandler<N extends PiVoidHookName> = (
  event: PiHookEventMap[N],
  ctx: ExtensionContext,
) => void | Promise<void>;

/** A per-hook handler receives a FRESH `ctx` from PI on every call; the
 *  connector must never retain it across calls (PI replaces session objects on
 *  new/resume/fork and a stale reference throws). */
export type PiHookHandler<N extends PiHookName> = N extends "session_before_compact"
  ? (
      event: PiHookEventMap[N],
      ctx: ExtensionContext,
    ) => SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>
  : N extends PiVoidHookName
    ? PiVoidHookHandler<N>
    : never;

/** The `context` hook may return replacement messages; void/undefined keeps PI's input. */
export type PiContextHookHandler = (
  event: ContextEvent,
  ctx: ExtensionContext,
) => ContextEventResult | undefined | Promise<ContextEventResult | undefined>;

// ── Registration-time API (the `pi` object, ExtensionAPI) ────────────

// PI passes the raw text after the command name as ONE string (see pi's
// agent-session.ts command dispatch), not a pre-split argv.
export type PiCommandHandler = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;

export interface ReplacedSessionContext extends ExtensionCommandContext {
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
}

/** Mirror of PI's ToolDefinition (extensions/types.ts) — the fields we use.
 *  `parameters` is a TypeBox schema (plain JSON-schema object at runtime). */
export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}
export interface PiToolSpec {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<PiToolResult>;
}

/** The factory-time API. Hook registration and command/tool registration take
 *  `pi: ExtensionAPI`; per-hook handlers take the fresh `ctx`.
 *  `registerCommand`/`registerTool`/`appendEntry` are declared because PI
 *  exposes them, though this connector registers only hooks. */
export interface ExtensionAPI {
  on<N extends PiVoidHookName>(name: N, handler: PiVoidHookHandler<N>): void;
  on(name: "session_before_compact", handler: PiHookHandler<"session_before_compact">): void;
  on(
    name: "session_before_tree",
    handler: (event: SessionBeforeTreeEvent, ctx: ExtensionContext) => Promise<SessionBeforeTreeResult>,
  ): void;
  on(name: "context", handler: PiContextHookHandler): void;
  registerCommand(name: string, options: { handler: PiCommandHandler; description?: string }): void;
  registerTool(tool: PiToolSpec): void;
  appendEntry(customType: string, data: unknown): void;
  registerFlag(
    name: string,
    options: {
      description?: string;
      type: "boolean" | "string";
      default?: boolean | string;
    },
  ): void;
  getFlag(name: string): boolean | string | undefined;
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
  setModel(model: ModelHandle): Promise<boolean>;
}

// ── Per-hook context (the `ctx` object, ExtensionContext) ────────────

export interface ModelDescriptor {
  provider: string;
  id: string;
}

/** Host-owned handle the model registry returns; it carries auth/runtime detail
 *  PI owns. The connector treats provider/model as host routing keys. */
export interface ModelHandle extends ModelDescriptor {
  readonly [k: string]: unknown;
}

/** Header map may include null deletion markers (PI 0.84+ ProviderHeaders). */
export type ProviderHeaders = Record<string, string | null>;

export interface ModelRegistryAuthResolution {
  apiKey?: string;
  headers?: ProviderHeaders;
  /** Optional provider base URL override from resolved auth (e.g. custom gateway). */
  baseUrl?: string;
  env?: Record<string, string>;
}

export type ModelRegistryAuthResult = ({ ok: true } & ModelRegistryAuthResolution) | { ok: false; error: string };

export interface ModelRegistry {
  find(provider: string, model: string): ModelHandle | undefined;
  hasConfiguredAuth(model: ModelHandle | string): boolean;
  getApiKeyAndHeaders?(model: ModelHandle): Promise<ModelRegistryAuthResult>;
  getAvailable(): ModelHandle[];
}

export interface ExtensionUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select?(title: string, options: string[]): Promise<string | undefined>;
}

/** PI's estimate of the live session context for the active model. */
export interface ContextUsage {
  /** Estimated context tokens, or null if unknown (e.g. right after compaction). */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface CompactOptions {
  customInstructions?: string;
  onComplete?: (result: CompactionResult) => void;
  onError?: (error: Error) => void;
}

export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  message?: AgentMessage;
  data?: unknown;
  readonly [k: string]: unknown;
}

export interface SessionManager {
  getEntries(): SessionEntry[];
}

export interface ExtensionContext {
  modelRegistry: ModelRegistry;
  ui: ExtensionUI;
  /** Guard UI surfacing on this — the extension must work in rpc/json/print
   *  modes too; reporting guards on headless, not on ctx.ui. */
  hasUI: boolean;
  sessionManager: SessionManager;
  cwd: string;
  model?: ModelDescriptor;
  /** Optional in the mirror so test fixtures stay minimal; always present on
   *  real PI ≥ 0.83 contexts. */
  getContextUsage?(): ContextUsage | undefined;
  /** Trigger PI's compaction flow (fires session_before_compact) without
   *  awaiting completion. WARNING: this is PI's MANUAL compact path — it
   *  aborts any in-flight agent run first (agent-session.ts "Aborts current
   *  agent operation first"). Only call when the agent is idle. */
  compact?(options?: CompactOptions): void;
  /** True when user messages are queued to run after the current agent run. */
  hasPendingMessages?(): boolean;
}

/** Command handlers receive session-control methods on ctx. */
export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  newSession(options?: {
    setup?: (sessionManager: unknown) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;
}

// ── Message vocabulary (AgentMessage and its parts) ──────────────────

export interface TextPart {
  type: "text";
  text: string;
}
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
  /** Provider reasoning token, captured but not interpreted. */
  thinkingSignature?: string;
}
export interface ToolCallPart {
  type: "toolCall";
  /** Composite, stable across tool_execution_start → tool_result → message_end
   *  (research §5a): `call_<providerId>|fc_<internalId>`. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Provider reasoning token, captured but not interpreted. */
  thoughtSignature?: string;
}
/** Unsupported in the text-only intake schema — degrades to a runtime_note in
 *  the converter, never silently dropped. */
export interface ImagePart {
  type: "image";
  mimeType?: string;
  data?: string;
}
export interface FileRefPart {
  type: "fileRef";
  path: string;
}
export type ContentPart = TextPart | ThinkingPart | ToolCallPart | ImagePart | FileRefPart;

// Matches pi-ai `StopReason` (vendor/pi/packages/ai/src/types.ts).
export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** Provider-reported token usage for one model call. Mirrors pi-ai `Usage`
 *  (mandatory on real AssistantMessage). Captured verbatim as
 *  `assistant_text.payload.providerUsage` when a text vehicle exists. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `cacheWrite` written with 1h retention (Anthropic only). */
  cacheWrite1h?: number;
  /**
   * Reasoning/thinking tokens when the provider reports them — a subset of
   * `output`. Undefined when the provider does not expose a breakdown.
   */
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** @deprecated Use {@link Usage}. Kept as an alias for any residual readers. */
export type TokenUsage = Usage;

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
  /** Unix epoch ms — present on every PI message role. */
  timestamp: number;
}
/** Also the shape pi-ai's `complete()` returns (research §3); the model-call
 *  host maps it to text or a classified failure. */
export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  api?: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: unknown[];
  usage: Usage;
  stopReason: PiStopReason;
  errorMessage?: string;
  /** Unix epoch ms — present on every PI message role. */
  timestamp: number;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: ContentPart[];
  isError?: boolean;
  /** Unix epoch ms — present on every PI message role. */
  timestamp: number;
}
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

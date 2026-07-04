// Local declarations of the PI extension surface the connector consumes.
//
// These mirror the current `@earendil-works/pi-coding-agent` extension API as
// verified from repo-ref/pi. The original Epic 1 implementation targeted
// v0.79.2 research; PI's public registration surface is now `pi.on(...)`, and
// handlers receive `(event, ctx)`.
// wiring research (docs/specs/02-pi-lhc/notes/pi-ext-integration-research.md,
// headless + interactive recon, June 12 2026). The PI packages are not yet a
// build-time dependency of this workspace, so the connector declares the slice
// of their contract it touches and swaps to the real imports when the
// dependency lands. Keeping the surface here rather than scattered `any` means
// connector code gets real type-checking against the contract PI actually fires.

// ── Hook vocabulary ──────────────────────────────────────────────────

/** Hooks the connector knows about. */
export type PiHookName =
  | "session_start"
  | "message_end"
  | "turn_end"
  | "agent_end"
  | "model_select"
  | "thinking_level_select"
  | "session_before_fork"
  | "session_before_switch"
  | "session_before_compact"
  | "session_compact"
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

export interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: SessionEntry;
  fromExtension: boolean;
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
  model_select: ModelSelectEvent;
  thinking_level_select: ThinkingLevelSelectEvent;
  session_before_fork: SessionBeforeForkEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_compact: SessionBeforeCompactEvent;
  session_compact: SessionCompactEvent;
  session_shutdown: SessionShutdownEvent;
  context: ContextEvent;
}

/** Void-returning hooks (all except `session_before_compact` and `context`). */
export type PiVoidHookName = Exclude<PiHookName, "session_before_compact" | "context">;

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

export interface PiToolSpec {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  run: (input: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
}

/** The factory-time API. Hook registration and command/tool registration take
 *  `pi: ExtensionAPI`; per-hook handlers take the fresh `ctx`.
 *  `registerCommand`/`registerTool`/`appendEntry` are declared because PI
 *  exposes them, though this connector registers only hooks. */
export interface ExtensionAPI {
  on<N extends PiVoidHookName>(name: N, handler: PiVoidHookHandler<N>): void;
  on(name: "session_before_compact", handler: PiHookHandler<"session_before_compact">): void;
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

export interface ModelRegistryAuthResolution {
  apiKey?: string;
  headers?: Record<string, string>;
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

export type PiStopReason = "stop" | "aborted" | "length" | "toolUse" | (string & {});

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}
/** Also the shape pi-ai's `complete()` returns (research §3); the model-call
 *  host maps it to text or a classified failure. */
export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  stopReason?: PiStopReason;
  errorMessage?: string;
  usage?: TokenUsage;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  content: ContentPart[];
  isError?: boolean;
}
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

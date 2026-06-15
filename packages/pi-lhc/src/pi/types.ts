// Local declarations of the PI extension surface the connector consumes.
//
// These mirror `@earendil-works/pi-coding-agent` v0.79.2 as verified by the
// wiring research (docs/specs/02-pi-lhc/notes/pi-ext-integration-research.md,
// headless + interactive recon, June 12 2026). The PI packages are not yet a
// build-time dependency of this workspace, so the connector declares the slice
// of their contract it touches and swaps to the real imports when the
// dependency lands (Spec Deviation, recorded in the story payload). Keeping the
// surface here — rather than scattered `any` — means later stories get real
// type-checking against the contract PI actually fires.

// ── Hook vocabulary ──────────────────────────────────────────────────

/** Hooks the connector knows about. Epic 1 registers the observe-only rail;
 *  `context` is fired by PI but Epic 1 registers no handler for it — context
 *  serving is Epic 2. */
export type PiHookName =
  | "session_start"
  | "message_end"
  | "turn_end"
  | "agent_end"
  | "model_select"
  | "thinking_level_select"
  | "session_before_fork"
  | "session_before_switch"
  | "session_shutdown"
  | "context";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "shutdown" | "reload" | "new" | "resume";

export interface SessionStartEvent {
  reason: SessionStartReason;
  previousSessionFile?: string;
}
export interface MessageEndEvent {
  entryId?: string;
  position?: number;
  message: AgentMessage;
}
/** PI fires one turn_end per agent STEP (turnIndex resets to 0 each run); the
 *  converter must NOT map it 1:1 to an LHC turn_end (tech design Flow 2). */
export interface TurnEndEvent {
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
  stopReason?: PiStopReason;
}
export interface AgentEndEvent {
  messages: AgentMessage[];
}
export interface ModelSelectEvent {
  model: ModelDescriptor;
  previousModel?: ModelDescriptor;
  position?: number;
  source?: string;
}
export interface ThinkingLevelSelectEvent {
  level: string;
  previousLevel: string;
  position?: number;
}
export interface SessionBeforeForkEvent {
  entryId: string;
  position?: number;
}
export interface SessionBeforeSwitchEvent {
  intent: "new" | "resume";
}
export interface SessionShutdownEvent {
  reason: SessionShutdownReason;
  targetSessionFile?: string;
}
/** Declared for completeness; Epic 1 registers no handler (observe-only). */
export interface ContextEvent {
  messages: AgentMessage[];
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
  session_shutdown: SessionShutdownEvent;
  context: ContextEvent;
}

/** A per-hook handler receives a FRESH `ctx` from PI on every call; the
 *  connector must never retain it across calls (PI replaces session objects on
 *  new/resume/fork and a stale reference throws). Tech design Flow 1. */
export type PiHookHandler<N extends PiHookName> = (
  ctx: ExtensionContext,
  event: PiHookEventMap[N],
) => void | Promise<void>;

// ── Registration-time API (the `pi` object, ExtensionAPI) ────────────

export type PiCommandHandler = (args: string[], ctx: ExtensionContext) => void | Promise<void>;

export interface PiToolSpec {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  run: (input: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
}

/** The factory-time API. Hook registration and command/tool registration take
 *  `pi: ExtensionAPI`; per-hook handlers take the fresh `ctx` (tech design
 *  I-7). `registerCommand`/`registerTool`/`appendEntry` are declared because PI
 *  exposes them, but Epic 1 (observe-only) registers only hooks. */
export interface ExtensionAPI {
  registerHook<N extends PiHookName>(name: N, handler: PiHookHandler<N>): void;
  registerCommand(name: string, handler: PiCommandHandler): void;
  registerTool(tool: PiToolSpec): void;
  appendEntry(customType: string, data: unknown): void;
}

// ── Per-hook context (the `ctx` object, ExtensionContext) ────────────

export interface ModelDescriptor {
  provider: string;
  id: string;
}

/** Opaque handle the model registry returns; it carries auth/runtime detail PI
 *  owns. The connector treats provider/model as opaque routing keys. */
export interface ModelHandle extends ModelDescriptor {
  readonly [k: string]: unknown;
}

export interface ModelRegistry {
  find(provider: string, model: string): ModelHandle | undefined;
  hasConfiguredAuth(model: ModelHandle | string): boolean;
  getAvailable(): ModelHandle[];
}

export interface ExtensionUI {
  notify(message: string, options?: { level?: "info" | "warn" | "error" }): void;
  select?(title: string, options: readonly string[]): Promise<string | undefined>;
}

export interface SessionEntry {
  type: string;
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
   *  modes too (tech design I-9, reporting guards on headless not on ctx.ui). */
  hasUI: boolean;
  sessionManager: SessionManager;
  cwd: string;
}

// ── Message vocabulary (AgentMessage and its parts) ──────────────────

export interface TextPart {
  type: "text";
  text: string;
}
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
  /** Opaque provider reasoning token — captured, not interpreted; dropped in
   *  Epic 1 (tech design I-3). */
  thinkingSignature?: string;
}
export interface ToolCallPart {
  type: "toolCall";
  /** Composite, stable across tool_execution_start → tool_result → message_end
   *  (research §5a): `call_<providerId>|fc_<internalId>`. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque; captured, not interpreted (tech design I-3). */
  thoughtSignature?: string;
}
/** Unsupported in the text-only intake schema — degrades to a runtime_note in
 *  the converter (tech design I-6), never silently dropped. */
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
  content: ContentPart[];
}
/** Also the shape pi-ai's `complete()` returns (research §3); the model-call
 *  host maps it to text or a classified failure (Epic 1 Story 5). */
export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  stopReason?: PiStopReason;
  usage?: TokenUsage;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  content: ContentPart[];
  isError?: boolean;
}
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

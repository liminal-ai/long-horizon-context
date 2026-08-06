import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";

// Honcho memory provider for PI — v1, deliberately duplicating the Hermes
// honcho plugin's behavior (two-layer injection + 5 tools + dialogue-only
// turn sync) as a starting point. See plugins/memory/honcho in hermes-agent.
//
// What syncs to Honcho: user prompt + final assistant text per completed
// agent run. Tool calls, tool results, thinking, and system prompts never
// leave the machine. Aborted runs are skipped entirely.
//
// v1 omissions vs Hermes (deliberate): OAuth (API key only), gateway
// identity mapping, query rewrite, dialectic depth > 1, observation
// config, first-turn-only injection frequency.

// ── Config ───────────────────────────────────────────────────────────

export type RecallMode = "hybrid" | "context" | "tools";
export type SessionStrategy = "per-directory" | "per-repo" | "global";
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

export interface HonchoConfig {
	baseUrl: string;
	workspace: string;
	peerName: string;
	aiPeer: string;
	recallMode: RecallMode;
	sessionStrategy: SessionStrategy;
	sessions: Record<string, string>;
	contextCadence: number;
	dialecticCadence: number;
	dialecticReasoningLevel: ReasoningLevel;
	dialecticMaxChars: number;
	contextTokens: number;
	messageMaxChars: number;
	saveMessages: boolean;
	reasoningHeuristic: boolean;
	reasoningLevelCap: ReasoningLevel;
	firstTurnBaseWaitMs: number;
	firstTurnDialecticWaitMs: number;
}

const DEFAULT_CONFIG: HonchoConfig = {
	baseUrl: "https://api.honcho.dev",
	workspace: "pi",
	peerName: "user",
	aiPeer: "pi",
	recallMode: "hybrid",
	sessionStrategy: "per-directory",
	sessions: {},
	contextCadence: 1,
	dialecticCadence: 1,
	dialecticReasoningLevel: "low",
	dialecticMaxChars: 600,
	contextTokens: 2000,
	messageMaxChars: 25000,
	saveMessages: true,
	reasoningHeuristic: true,
	reasoningLevelCap: "high",
	firstTurnBaseWaitMs: 3000,
	firstTurnDialecticWaitMs: 2000,
};

const KNOWN_CONFIG_KEYS = new Set([
	"baseUrl",
	"workspace",
	"peerName",
	"aiPeer",
	"recallMode",
	"sessionStrategy",
	"sessions",
	"contextCadence",
	"dialecticCadence",
	"dialecticReasoningLevel",
	"dialecticMaxChars",
	"contextTokens",
	"messageMaxChars",
	"saveMessages",
	"reasoningHeuristic",
	"reasoningLevelCap",
	"firstTurnBaseWaitMs",
	"firstTurnDialecticWaitMs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadHonchoApiKey(agentDir = getAgentDir()): string | undefined {
	const authPath = join(agentDir, "auth.json");
	if (existsSync(authPath)) {
		try {
			const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
			if (isRecord(parsed) && isRecord(parsed.honcho)) {
				const key = parsed.honcho.key;
				if (typeof key === "string" && key.trim().length > 0) return key.trim();
			}
		} catch {
			// fall through to env
		}
	}
	const envKey = process.env.HONCHO_API_KEY;
	return envKey && envKey.trim().length > 0 ? envKey.trim() : undefined;
}

export function loadHonchoConfig(agentDir = getAgentDir()): { config: HonchoConfig; unknownKeys: string[] } {
	const configPath = join(agentDir, "extensions", "honcho-memory.json");
	const config = { ...DEFAULT_CONFIG, sessions: { ...DEFAULT_CONFIG.sessions } };
	const unknownKeys: string[] = [];
	if (!existsSync(configPath)) return { config, unknownKeys };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (err) {
		throw new Error(`honcho-memory.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!isRecord(parsed)) return { config, unknownKeys };
	for (const [key, value] of Object.entries(parsed)) {
		// The Hermes overseer profile shipped a silently ignored `workspace_id`
		// key for weeks; unknown keys here must be loud, never dropped.
		if (!KNOWN_CONFIG_KEYS.has(key)) {
			unknownKeys.push(key);
			continue;
		}
		(config as unknown as Record<string, unknown>)[key] = value;
	}
	// Test/integration runs can redirect all writes to a throwaway workspace
	// (e.g. lhc-test) without touching the daily-driver config file.
	const envWorkspace = process.env.HONCHO_WORKSPACE;
	if (envWorkspace && envWorkspace.trim().length > 0) config.workspace = envWorkspace.trim();
	return { config, unknownKeys };
}

// ── Honcho HTTP client (v3 REST, mirrors honcho-ai SDK routes) ───────

class HonchoHttpError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "HonchoHttpError";
	}
}

interface SessionContextResponse {
	summary?: { content?: string } | null;
	peer_representation?: string | null;
	peer_card?: string[] | null;
	messages?: Array<{ content?: string; peer_id?: string; created_at?: string }>;
}

export class HonchoClient {
	constructor(
		readonly baseUrl: string,
		readonly apiKey: string,
		readonly workspace: string,
	) {}

	private async request<T>(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		options: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<T> {
		const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
		for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new HonchoHttpError(`Honcho ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`, response.status);
		}
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	private get ws(): string {
		return `/v3/workspaces/${encodeURIComponent(this.workspace)}`;
	}

	async ensureWorkspace(): Promise<void> {
		await this.request("POST", "/v3/workspaces", { body: { id: this.workspace } });
	}

	async ensurePeer(peerId: string): Promise<void> {
		await this.request("POST", `${this.ws}/peers`, { body: { id: peerId } });
	}

	async ensureSession(sessionId: string): Promise<void> {
		await this.request("POST", `${this.ws}/sessions`, { body: { id: sessionId } });
	}

	async addMessages(sessionId: string, messages: Array<{ content: string; peer_id: string }>): Promise<void> {
		await this.request("POST", `${this.ws}/sessions/${encodeURIComponent(sessionId)}/messages`, {
			body: { messages },
		});
	}

	async sessionContext(
		sessionId: string,
		options: { tokens?: number; peerTarget?: string; peerPerspective?: string } = {},
	): Promise<SessionContextResponse> {
		const query: Record<string, string> = { summary: "true" };
		if (options.tokens !== undefined) query.tokens = String(options.tokens);
		if (options.peerTarget !== undefined) query.peer_target = options.peerTarget;
		if (options.peerPerspective !== undefined) query.peer_perspective = options.peerPerspective;
		return this.request("GET", `${this.ws}/sessions/${encodeURIComponent(sessionId)}/context`, { query });
	}

	async peerRepresentation(peerId: string, target?: string): Promise<string> {
		const body: Record<string, unknown> = {};
		if (target !== undefined) body.target = target;
		const data = await this.request<{ representation?: string }>(
			"POST",
			`${this.ws}/peers/${encodeURIComponent(peerId)}/representation`,
			{ body },
		);
		return data.representation ?? "";
	}

	async getPeerCard(peerId: string, target?: string): Promise<string[]> {
		const data = await this.request<{ peer_card?: string[] | null }>(
			"GET",
			`${this.ws}/peers/${encodeURIComponent(peerId)}/card`,
			{ query: target !== undefined ? { target } : undefined },
		);
		return data.peer_card ?? [];
	}

	async setPeerCard(peerId: string, card: string[], target?: string): Promise<string[]> {
		const data = await this.request<{ peer_card?: string[] | null }>(
			"PUT",
			`${this.ws}/peers/${encodeURIComponent(peerId)}/card`,
			{ body: { peer_card: card }, query: target !== undefined ? { target } : undefined },
		);
		return data.peer_card ?? [];
	}

	async peerChat(
		peerId: string,
		query: string,
		options: { target?: string; sessionId?: string; reasoningLevel?: ReasoningLevel } = {},
	): Promise<string> {
		const body: Record<string, unknown> = { query, stream: false };
		if (options.target !== undefined) body.target = options.target;
		if (options.sessionId !== undefined) body.session_id = options.sessionId;
		if (options.reasoningLevel !== undefined) body.reasoning_level = options.reasoningLevel;
		const data = await this.request<{ content?: string | null }>(
			"POST",
			`${this.ws}/peers/${encodeURIComponent(peerId)}/chat`,
			{ body, timeoutMs: 60000 },
		);
		return data.content ?? "";
	}

	async peerSearch(
		peerId: string,
		query: string,
		limit: number,
	): Promise<Array<{ content?: string; peer_id?: string; created_at?: string }>> {
		return this.request("POST", `${this.ws}/peers/${encodeURIComponent(peerId)}/search`, {
			body: { query, filters: null, limit },
		});
	}

	async createConclusion(observerId: string, observedId: string, content: string, sessionId?: string): Promise<void> {
		const conclusion: Record<string, unknown> = { observer_id: observerId, observed_id: observedId, content };
		if (sessionId !== undefined) conclusion.session_id = sessionId;
		await this.request("POST", `${this.ws}/conclusions`, { body: { conclusions: [conclusion] } });
	}

	async listConclusions(
		observerId: string,
		observedId: string,
		options: { query?: string; size?: number } = {},
	): Promise<Array<{ id?: string; content?: string; created_at?: string }>> {
		if (options.query) {
			const data = await this.request<{ items?: Array<{ id?: string; content?: string; created_at?: string }> } | Array<{ id?: string; content?: string; created_at?: string }>>(
				"POST",
				`${this.ws}/conclusions/query`,
				{ body: { query: options.query, filters: { observer_id: observerId, observed_id: observedId }, top_k: options.size ?? 20 } },
			);
			return Array.isArray(data) ? data : (data.items ?? []);
		}
		const data = await this.request<{ items?: Array<{ id?: string; content?: string; created_at?: string }> }>(
			"POST",
			`${this.ws}/conclusions/list`,
			{
				body: { filters: { observer_id: observerId, observed_id: observedId } },
				query: { page: "1", size: String(options.size ?? 20), reverse: "true" },
			},
		);
		return data.items ?? [];
	}

	async deleteConclusion(conclusionId: string): Promise<void> {
		await this.request("DELETE", `${this.ws}/conclusions/${encodeURIComponent(conclusionId)}`);
	}
}

// ── Context block assembly (mirrors Hermes labels and fencing) ───────

const MEMORY_FENCE_RE = /<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>\s*/gi;
const MEMORY_TAG_RE = /<\/?\s*memory-context\s*>/gi;

export function sanitizeMemoryContext(text: string): string {
	return text.replace(MEMORY_FENCE_RE, "").replace(MEMORY_TAG_RE, "").trim();
}

export function buildMemoryContextBlock(raw: string): string {
	const clean = sanitizeMemoryContext(raw);
	if (!clean) return "";
	return (
		"<memory-context>\n" +
		"[System note: The following is recalled memory context, " +
		"NOT new user input. Treat as authoritative reference data — " +
		"this is the agent's persistent memory and should inform all responses.]\n\n" +
		`${clean}\n` +
		"</memory-context>"
	);
}

interface BaseContextParts {
	summary?: string;
	representation?: string;
	card?: string;
	aiRepresentation?: string;
	aiCard?: string;
}

export function formatBaseContext(parts: BaseContextParts): string {
	const sections: string[] = [];
	if (parts.summary) sections.push(`## Session Summary\n${parts.summary}`);
	if (parts.representation) sections.push(`## User Representation\n${parts.representation}`);
	if (parts.card) sections.push(`## User Peer Card\n${parts.card}`);
	if (parts.aiRepresentation) sections.push(`## AI Self-Representation\n${parts.aiRepresentation}`);
	if (parts.aiCard) sections.push(`## AI Identity Card\n${parts.aiCard}`);
	return sections.join("\n\n");
}

export function truncateToBudget(text: string, tokens: number): string {
	const maxChars = tokens * 4;
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const lastSpace = cut.lastIndexOf(" ");
	return `${cut.slice(0, lastSpace > maxChars * 0.8 ? lastSpace : maxChars)}\n[memory context truncated to budget]`;
}

export function chunkMessage(content: string, limit: number): string[] {
	if (content.length <= limit) return [content];
	const chunks: string[] = [];
	let rest = content;
	while (rest.length > 0) {
		chunks.push(rest.slice(0, limit));
		rest = rest.slice(limit);
	}
	return chunks.map((chunk, i) => (i === 0 ? chunk : `[continued]\n${chunk}`));
}

const TRIVIAL_GREETINGS = new Set(["hi", "hello", "hey", "thanks", "thank you", "ok", "okay", "yes", "no", "sure"]);

export function isTrivialPrompt(text: string): boolean {
	const trimmed = text.trim().toLowerCase();
	if (trimmed.length === 0) return true;
	if (trimmed.startsWith("/")) return true;
	if (trimmed.length < 8 && TRIVIAL_GREETINGS.has(trimmed)) return true;
	return false;
}

const REASONING_ORDER: ReasoningLevel[] = ["minimal", "low", "medium", "high", "max"];

export function scaleReasoningLevel(base: ReasoningLevel, queryLength: number, cap: ReasoningLevel): ReasoningLevel {
	let idx = REASONING_ORDER.indexOf(base);
	if (queryLength >= 400) idx += 2;
	else if (queryLength >= 120) idx += 1;
	const capIdx = REASONING_ORDER.indexOf(cap);
	return REASONING_ORDER[Math.min(Math.max(idx, 0), capIdx)] ?? base;
}

const COLD_START_PROMPT =
	"Who is this person? What are their preferences, goals, and working style? " +
	"Focus on facts that would help an AI assistant be immediately useful.";
const WARM_SESSION_PROMPT =
	"Given what's been discussed in this session so far, what context about this user " +
	"is most relevant to the current conversation? Prioritize active context over biographical facts.";

export function sanitizeId(raw: string): string {
	const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned : "default";
}

export function resolveSessionName(config: HonchoConfig, cwd: string): string {
	const manual = config.sessions[cwd];
	if (manual) return manual;
	if (config.sessionStrategy === "global") return sanitizeId(config.workspace);
	if (config.sessionStrategy === "per-repo") {
		try {
			const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd,
				encoding: "utf8",
				timeout: 3000,
			}).trim();
			if (root) return sanitizeId(basename(root));
		} catch {
			// not a git repo — fall through to per-directory
		}
	}
	return sanitizeId(basename(cwd));
}

// ── Message extraction (dialogue only — prompts and final responses) ─

function textOfMessage(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

export function extractTurnDialogue(messages: readonly AgentMessage[]): { user: string; assistant: string } | undefined {
	let user = "";
	let assistant = "";
	for (const message of messages) {
		if (message.role === "user" && !user) user = textOfMessage(message);
		if (message.role === "assistant") {
			if ((message as { stopReason?: string }).stopReason === "aborted") return undefined;
			const text = textOfMessage(message);
			if (text) assistant = text;
		}
	}
	if (!user || !assistant) return undefined;
	return { user, assistant };
}

// ── The extension ────────────────────────────────────────────────────

interface HonchoState {
	client: HonchoClient;
	config: HonchoConfig;
	sessionName: string;
	initPromise: Promise<void>;
	initFailed: string | undefined;
	turnCount: number;
	baseContextCache: string | undefined;
	dialecticCache: string | undefined;
	lastContextTurn: number;
	lastDialecticTurn: number;
	basePending: Promise<void> | undefined;
	dialecticPending: Promise<void> | undefined;
	pendingSyncs: Set<Promise<void>>;
	/** Block frozen at run start. Refreshes landing mid-run must not swap the
	 *  injected bytes between tool-loop steps — that invalidates the provider
	 *  prefix cache from the injection point on every step. */
	runBlock: string | undefined;
}

function systemHeader(mode: RecallMode): string {
	if (mode === "context") {
		return (
			"# Honcho Memory\n" +
			"Active (context-injection mode). Relevant user context is automatically " +
			"injected before each turn. No memory tools are available — context is " +
			"managed automatically."
		);
	}
	if (mode === "tools") {
		return (
			"# Honcho Memory\n" +
			"Active (tools-only mode). Use honcho_profile for a quick factual snapshot, " +
			"honcho_search for raw excerpts, honcho_context for raw peer context, " +
			"honcho_reasoning for synthesized answers (pass reasoning_level " +
			"minimal/low/medium/high/max — you pick the depth per call), " +
			"honcho_conclude to save facts about the user. " +
			"No automatic context injection — you must use tools to access memory."
		);
	}
	return (
		"# Honcho Memory\n" +
		"Active (hybrid mode). Relevant context is auto-injected AND memory tools are available. " +
		"Use honcho_profile for a quick factual snapshot, " +
		"honcho_search for raw excerpts, honcho_context for raw peer context, " +
		"honcho_reasoning for synthesized answers (pass reasoning_level " +
		"minimal/low/medium/high/max — you pick the depth per call), " +
		"honcho_conclude to save facts about the user."
	);
}

export default function honchoMemoryExtension(pi: ExtensionAPI): void {
	let state: HonchoState | undefined;
	const apiKey = loadHonchoApiKey();

	function resolvePeerId(config: HonchoConfig, peer: "user" | "ai"): string {
		return peer === "ai" ? sanitizeId(config.aiPeer) : sanitizeId(config.peerName);
	}

	function refreshBase(s: HonchoState): Promise<void> {
		if (s.basePending) return s.basePending;
		s.basePending = (async () => {
			try {
				await s.initPromise;
				if (s.initFailed) return;
				const userPeer = resolvePeerId(s.config, "user");
				const aiPeer = resolvePeerId(s.config, "ai");
				const [sessionCtx, aiRep, aiCard] = await Promise.all([
					s.client.sessionContext(s.sessionName, {
						tokens: s.config.contextTokens,
						peerTarget: userPeer,
						peerPerspective: userPeer,
					}),
					s.client.peerRepresentation(aiPeer).catch(() => ""),
					s.client.getPeerCard(aiPeer).catch(() => [] as string[]),
				]);
				s.baseContextCache = formatBaseContext({
					summary: sessionCtx.summary?.content ?? undefined,
					representation: sessionCtx.peer_representation ?? undefined,
					card: sessionCtx.peer_card?.length ? sessionCtx.peer_card.join("\n") : undefined,
					aiRepresentation: aiRep || undefined,
					aiCard: aiCard.length ? aiCard.join("\n") : undefined,
				});
				s.lastContextTurn = s.turnCount;
			} catch (err) {
				console.error(`honcho-memory: base context refresh failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				s.basePending = undefined;
			}
		})();
		return s.basePending;
	}

	function refreshDialectic(s: HonchoState, userPrompt: string): Promise<void> {
		if (s.dialecticPending) return s.dialecticPending;
		s.dialecticPending = (async () => {
			try {
				await s.initPromise;
				if (s.initFailed) return;
				const isCold = !s.baseContextCache;
				const query = isCold ? COLD_START_PROMPT : WARM_SESSION_PROMPT;
				const level = s.config.reasoningHeuristic
					? scaleReasoningLevel(s.config.dialecticReasoningLevel, userPrompt.length, s.config.reasoningLevelCap)
					: s.config.dialecticReasoningLevel;
				const answer = await s.client.peerChat(resolvePeerId(s.config, "ai"), query, {
					target: resolvePeerId(s.config, "user"),
					sessionId: s.sessionName,
					reasoningLevel: level,
				});
				if (answer) {
					s.dialecticCache = answer.length > s.config.dialecticMaxChars ? `${answer.slice(0, s.config.dialecticMaxChars)}…` : answer;
					s.lastDialecticTurn = s.turnCount;
				}
			} catch (err) {
				console.error(`honcho-memory: dialectic refresh failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				s.dialecticPending = undefined;
			}
		})();
		return s.dialecticPending;
	}

	function injectedBlock(s: HonchoState): string {
		if (s.config.recallMode === "tools") return "";
		const parts = [s.baseContextCache, s.dialecticCache].filter((p): p is string => !!p);
		if (parts.length === 0) return "";
		return buildMemoryContextBlock(truncateToBudget(parts.join("\n\n"), s.config.contextTokens));
	}

	pi.on("session_start", async (_event, ctx) => {
		const { config, unknownKeys } = loadHonchoConfig();
		if (unknownKeys.length > 0) {
			const warning = `honcho-memory: unknown config keys ignored: ${unknownKeys.join(", ")} — check honcho-memory.json spelling`;
			console.error(warning);
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
		}
		if (!apiKey) {
			state = undefined;
			return;
		}
		const client = new HonchoClient(config.baseUrl, apiKey, sanitizeId(config.workspace));
		const sessionName = resolveSessionName(config, ctx.cwd);
		const s: HonchoState = {
			client,
			config,
			sessionName,
			initFailed: undefined,
			initPromise: Promise.resolve(),
			turnCount: 0,
			baseContextCache: undefined,
			dialecticCache: undefined,
			lastContextTurn: -1,
			lastDialecticTurn: -1,
			basePending: undefined,
			dialecticPending: undefined,
			pendingSyncs: new Set(),
			runBlock: undefined,
		};
		s.initPromise = (async () => {
			try {
				await client.ensureWorkspace();
				await Promise.all([client.ensurePeer(resolvePeerId(config, "user")), client.ensurePeer(resolvePeerId(config, "ai"))]);
				await client.ensureSession(sessionName);
			} catch (err) {
				s.initFailed = err instanceof Error ? err.message : String(err);
				console.error(`honcho-memory: init failed (memory disabled this session): ${s.initFailed}`);
				if (ctx.hasUI) ctx.ui.notify(`honcho-memory: init failed: ${s.initFailed}`, "warning");
			}
		})();
		state = s;
		void s.initPromise.then(() => {
			if (!s.initFailed && s.config.recallMode !== "tools") void refreshBase(s);
		});
	});

	pi.on("before_agent_start", async (event) => {
		const s = state;
		if (!s) return;
		s.turnCount += 1;
		const prompt = event.prompt ?? "";

		if (s.config.recallMode !== "tools" && !isTrivialPrompt(prompt)) {
			const contextDue = s.turnCount - s.lastContextTurn >= s.config.contextCadence;
			const dialecticDue = s.turnCount - s.lastDialecticTurn >= s.config.dialecticCadence;
			const basePromise = contextDue ? refreshBase(s) : undefined;
			const dialecticPromise = dialecticDue ? refreshDialectic(s, prompt) : undefined;
			// Only turn 1 waits (bounded); later turns serve the cached block
			// and let refreshes land in the background — Hermes semantics.
			if (s.turnCount === 1) {
				const waits: Promise<unknown>[] = [];
				if (basePromise) waits.push(Promise.race([basePromise, new Promise((r) => setTimeout(r, s.config.firstTurnBaseWaitMs))]));
				if (dialecticPromise)
					waits.push(Promise.race([dialecticPromise, new Promise((r) => setTimeout(r, s.config.firstTurnDialecticWaitMs))]));
				await Promise.all(waits);
			}
		}

		// Freeze the injected block for this run: identical bytes on every
		// LLM call within the run keep the provider prefix cache warm across
		// tool-loop steps. Refreshes that land mid-run serve the NEXT run.
		s.runBlock = injectedBlock(s);

		return { systemPrompt: `${event.systemPrompt}\n\n${systemHeader(s.config.recallMode)}` };
	});

	pi.on("context", async (event) => {
		const s = state;
		if (!s) return;
		const block = s.runBlock ?? "";
		if (!block) return;
		const messages = event.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "user") continue;
			const content = (message as { content: unknown }).content;
			if (typeof content === "string") {
				(message as { content: unknown }).content = `${block}\n\n${content}`;
			} else if (Array.isArray(content)) {
				content.unshift({ type: "text", text: block });
			}
			break;
		}
		return { messages };
	});

	pi.on("agent_end", async (event) => {
		const s = state;
		if (!s || !s.config.saveMessages) return;
		const dialogue = extractTurnDialogue(event.messages);
		if (!dialogue) return;
		const userText = sanitizeMemoryContext(dialogue.user);
		const assistantText = sanitizeMemoryContext(dialogue.assistant);
		if (!userText || !assistantText) return;
		const sync = (async () => {
			try {
				await s.initPromise;
				if (s.initFailed) return;
				const payload = [
					...chunkMessage(userText, s.config.messageMaxChars).map((content) => ({
						content,
						peer_id: resolvePeerId(s.config, "user"),
					})),
					...chunkMessage(assistantText, s.config.messageMaxChars).map((content) => ({
						content,
						peer_id: resolvePeerId(s.config, "ai"),
					})),
				];
				await s.client.addMessages(s.sessionName, payload);
			} catch (err) {
				console.error(`honcho-memory: turn sync failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		s.pendingSyncs.add(sync);
		void sync.finally(() => s.pendingSyncs.delete(sync));
	});

	pi.on("session_shutdown", async () => {
		const s = state;
		if (!s || s.pendingSyncs.size === 0) return;
		// Join in-flight turn syncs so print/headless exits don't drop the last
		// turn; capped so a hung network call can't block quit.
		await Promise.race([Promise.allSettled([...s.pendingSyncs]), new Promise((r) => setTimeout(r, 5000))]);
	});

	pi.registerCommand("honcho-status", {
		description: "Show Honcho memory status (config, session, connectivity)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!apiKey) {
				ctx.ui.notify("honcho-memory: no API key (auth.json 'honcho' entry or HONCHO_API_KEY)", "warning");
				return;
			}
			const s = state;
			if (!s) {
				ctx.ui.notify("honcho-memory: not initialized for this session", "warning");
				return;
			}
			await s.initPromise;
			const status = s.initFailed
				? `init FAILED: ${s.initFailed}`
				: `connected — workspace=${s.client.workspace} session=${s.sessionName} ` +
					`user=${resolvePeerId(s.config, "user")} ai=${resolvePeerId(s.config, "ai")} ` +
					`mode=${s.config.recallMode} turns=${s.turnCount} ` +
					`base=${s.baseContextCache ? `${s.baseContextCache.length} chars` : "empty"} ` +
					`dialectic=${s.dialecticCache ? `${s.dialecticCache.length} chars` : "empty"}`;
			ctx.ui.notify(`honcho-memory: ${status}`, s.initFailed ? "error" : "info");
		},
	});

	// ── Tools (hidden in context-only mode, like Hermes) ────────────
	const { config: startupConfig } = loadHonchoConfig();
	if (!apiKey || startupConfig.recallMode === "context") return;

	const peerParam = Type.Optional(StringEnum(["user", "ai"] as const, { description: "Which peer to target (default: user)" }));

	function requireState(): HonchoState {
		if (!state) throw new Error("Honcho memory is not initialized (no API key or session not started)");
		return state;
	}

	pi.registerTool({
		name: "honcho_profile",
		label: "Honcho Profile",
		description:
			"Read or write a peer's CARD — a short, curated list of standing facts about that peer " +
			"(name, role, preferences, communication style, recurring patterns). This is the cheapest, " +
			"fastest Honcho call: no query, no LLM, just the current card. Pass `card` to overwrite it; " +
			"omit `card` to read.",
		parameters: Type.Object({
			peer: peerParam,
			card: Type.Optional(Type.Array(Type.String(), { description: "Replace the card with these fact lines" })),
		}),
		async execute(_toolCallId, params) {
			const s = requireState();
			await s.initPromise;
			if (s.initFailed) throw new Error(`Honcho unavailable: ${s.initFailed}`);
			const peerId = resolvePeerId(s.config, params.peer ?? "user");
			if (params.card !== undefined) {
				const updated = await s.client.setPeerCard(peerId, params.card);
				return {
					content: [{ type: "text", text: `Card updated for ${peerId}:\n${updated.join("\n")}` }],
					details: { peer: peerId, card: updated },
				};
			}
			const card = await s.client.getPeerCard(peerId);
			return {
				content: [
					{
						type: "text",
						text: card.length ? `Card for ${peerId}:\n${card.join("\n")}` : `No card yet for ${peerId} (accumulates as Honcho observes messages).`,
					},
				],
				details: { peer: peerId, card },
			};
		},
	});

	pi.registerTool({
		name: "honcho_search",
		label: "Honcho Search",
		description:
			"Hybrid (semantic + keyword) search over a peer's actual message history across ALL past " +
			"sessions they took part in — not just the current one. Returns ranked raw message excerpts " +
			"(what was literally said), no LLM synthesis. Cheaper and faster than honcho_reasoning.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			peer: peerParam,
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max results (default 10)" })),
			max_tokens: Type.Optional(Type.Integer({ minimum: 100, maximum: 2000, description: "Output token cap (default 800)" })),
		}),
		async execute(_toolCallId, params) {
			const s = requireState();
			await s.initPromise;
			if (s.initFailed) throw new Error(`Honcho unavailable: ${s.initFailed}`);
			const peerId = resolvePeerId(s.config, params.peer ?? "user");
			const results = await s.client.peerSearch(peerId, params.query, params.limit ?? 10);
			if (results.length === 0) {
				return { content: [{ type: "text", text: `No messages matching "${params.query}" for ${peerId}.` }], details: { count: 0 } };
			}
			const formatted = results
				.map((r, i) => `[${i + 1}] (${r.peer_id ?? "?"} @ ${r.created_at ?? "?"})\n${(r.content ?? "").trim()}`)
				.join("\n\n");
			const capped = truncateToBudget(formatted, params.max_tokens ?? 800);
			return { content: [{ type: "text", text: capped }], details: { count: results.length } };
		},
	});

	pi.registerTool({
		name: "honcho_context",
		label: "Honcho Context",
		description:
			"Retrieve the standing SNAPSHOT Honcho holds for the current session — session summary, the " +
			"peer's representation, the peer card, and recent messages — in one call. No query, no LLM " +
			"synthesis (cheaper than honcho_reasoning). Use it to orient yourself on what Honcho currently knows.",
		parameters: Type.Object({ peer: peerParam }),
		async execute(_toolCallId, params) {
			const s = requireState();
			await s.initPromise;
			if (s.initFailed) throw new Error(`Honcho unavailable: ${s.initFailed}`);
			const peerId = resolvePeerId(s.config, params.peer ?? "user");
			const ctx = await s.client.sessionContext(s.sessionName, {
				tokens: s.config.contextTokens,
				peerTarget: peerId,
				peerPerspective: peerId,
			});
			const text = formatBaseContext({
				summary: ctx.summary?.content ?? undefined,
				representation: ctx.peer_representation ?? undefined,
				card: ctx.peer_card?.length ? ctx.peer_card.join("\n") : undefined,
			});
			return {
				content: [{ type: "text", text: text || `Honcho has no accumulated context yet for ${peerId} in session ${s.sessionName}.` }],
				details: { session: s.sessionName, peer: peerId },
			};
		},
	});

	pi.registerTool({
		name: "honcho_reasoning",
		label: "Honcho Reasoning",
		description:
			"Ask Honcho's dialectic agent a natural-language question about a peer and get back a " +
			"SYNTHESIZED answer. This is the only Honcho tool that runs an LLM: it agentically searches " +
			"both raw messages and derived conclusions, reasons over them, and writes a prose answer — " +
			"so it is the slowest and most expensive call (seconds + tokens). Reach for it for nuanced " +
			"questions; use honcho_profile / honcho_context for cheap lookups.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language question about the peer" }),
			peer: peerParam,
			reasoning_level: Type.Optional(
				StringEnum(["minimal", "low", "medium", "high", "max"] as const, { description: "Reasoning depth (default: config)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const s = requireState();
			await s.initPromise;
			if (s.initFailed) throw new Error(`Honcho unavailable: ${s.initFailed}`);
			const target = params.peer ?? "user";
			const answer = await s.client.peerChat(resolvePeerId(s.config, "ai"), params.query, {
				target: target === "user" ? resolvePeerId(s.config, "user") : undefined,
				sessionId: s.sessionName,
				reasoningLevel: params.reasoning_level ?? s.config.dialecticReasoningLevel,
			});
			return {
				content: [{ type: "text", text: answer || "Honcho's dialectic returned no answer (peer may have no accumulated history yet)." }],
				details: { peer: target },
			};
		},
	});

	pi.registerTool({
		name: "honcho_conclude",
		label: "Honcho Conclude",
		description:
			"Write, list/search, or delete persistent CONCLUSIONS — durable derived facts about a peer that " +
			"feed their long-term profile (card + representation). Use this to record something durable " +
			"you've learned (a stable preference, a correction, a standing constraint) so future sessions " +
			"carry it forward. Pass exactly one of `conclusion` (create), `list: true` (list; ids returned " +
			"are what `delete_id` needs), or `delete_id` (delete).",
		parameters: Type.Object({
			peer: peerParam,
			conclusion: Type.Optional(Type.String({ description: "Conclusion text to record" })),
			list: Type.Optional(Type.Boolean({ description: "List recent conclusions" })),
			search: Type.Optional(Type.String({ description: "With list: semantic query over conclusions" })),
			delete_id: Type.Optional(Type.String({ description: "Conclusion id to delete" })),
		}),
		async execute(_toolCallId, params) {
			const s = requireState();
			await s.initPromise;
			if (s.initFailed) throw new Error(`Honcho unavailable: ${s.initFailed}`);
			const observedId = resolvePeerId(s.config, params.peer ?? "user");
			const observerId = resolvePeerId(s.config, "ai");
			const actions = [params.conclusion !== undefined, params.list === true || params.search !== undefined, params.delete_id !== undefined];
			if (actions.filter(Boolean).length !== 1) {
				throw new Error("Pass exactly one of: conclusion, list (optionally with search), delete_id");
			}
			if (params.conclusion !== undefined) {
				await s.client.createConclusion(observerId, observedId, params.conclusion, s.sessionName);
				return { content: [{ type: "text", text: `Conclusion recorded about ${observedId}: ${params.conclusion}` }], details: { count: 1 } };
			}
			if (params.delete_id !== undefined) {
				await s.client.deleteConclusion(params.delete_id);
				return { content: [{ type: "text", text: `Conclusion ${params.delete_id} deleted.` }], details: { count: 1 } };
			}
			const items = await s.client.listConclusions(observerId, observedId, { query: params.search, size: 20 });
			if (items.length === 0) {
				return { content: [{ type: "text", text: `No conclusions recorded about ${observedId} yet.` }], details: { count: 0 } };
			}
			const formatted = items.map((c) => `- [${c.id ?? "?"}] ${c.content ?? ""}`).join("\n");
			return { content: [{ type: "text", text: `Conclusions about ${observedId}:\n${formatted}` }], details: { count: items.length } };
		},
	});
}

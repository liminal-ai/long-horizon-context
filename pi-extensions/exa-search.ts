import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const API_CONFIG = {
	BASE_URL: "https://api.exa.ai",
	DEFAULT_POLL_INTERVAL_MS: 4000,
	MIN_POLL_INTERVAL_MS: 1000,
	DEFAULT_WAIT_TIMEOUT_SECONDS: 45,
	MAX_WAIT_TIMEOUT_SECONDS: 50,
	ENDPOINTS: {
		SEARCH: "/search",
		CONTENTS: "/contents",
		RUNS: "/agent/runs",
		RUN_BY_ID: (id: string) => `/agent/runs/${encodeURIComponent(id)}`,
		RUN_CANCEL: (id: string) => `/agent/runs/${encodeURIComponent(id)}/cancel`,
	},
	DEFAULT_NUM_RESULTS: 10,
	DEFAULT_MAX_CHARACTERS: 3000,
} as const;

const EXA_API_KEYS_URL = "https://dashboard.exa.ai/api-keys";
const TRANSIENT_STATUS_CODES = new Set([500, 502, 503, 504]);
const MISSING_KEY_MESSAGE = `Exa API key not configured. Add an "exa" entry to auth.json in your PI agent directory (~/.pi-lhc/pi/agent under pi-lhc; ~/.pi/agent under plain pi) as { "type": "api-key", "key": "..." }. API keys are available at ${EXA_API_KEYS_URL}.`;

type AgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type AgentEffort = "low" | "medium" | "high" | "xhigh" | "auto";
type AgentDataSourceProvider =
	| "fiber_ai"
	| "financial_datasets"
	| "similar_web"
	| "baselayer"
	| "affiliate"
	| "particle_news"
	| "jinko";

type AgentRunInput = {
	query: string;
	systemPrompt?: string;
	input?: {
		data?: Array<Record<string, unknown>>;
		exclusion?: Array<Record<string, unknown>>;
	};
	outputSchema?: Record<string, unknown> | null;
	effort?: AgentEffort;
	flags?: string[];
	previousRunId?: string;
	dataSources?: Array<{ provider: AgentDataSourceProvider }>;
};

type AgentRun = {
	id: string;
	object: "agent_run";
	status: AgentStatus;
	stopReason: string | null;
	createdAt: string;
	completedAt: string | null;
	request: unknown;
	output: {
		text: string;
		structured: unknown | null;
		grounding: Array<{
			field: string;
			citations: Array<{ url: string; title?: string }>;
			confidence: string;
		}>;
	};
	usage?: Record<string, unknown>;
	costDollars?: Record<string, unknown>;
};

type ExaSearchRequest = {
	query: string;
	type: "auto" | "fast" | "instant";
	category?: "company" | "research paper" | "news" | "pdf" | "github" | "personal site" | "people" | "financial report";
	numResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	startPublishedDate?: string;
	endPublishedDate?: string;
	startCrawlDate?: string;
	endCrawlDate?: string;
	includeText?: string[];
	excludeText?: string[];
	userLocation?: string;
	moderation?: boolean;
	additionalQueries?: string[];
	contents: Record<string, unknown>;
};

type CrawlStatus = {
	id: string;
	status: string;
	error?: { tag: string; httpStatusCode?: number | null };
};

class ExaHttpError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		readonly timestamp?: string,
	) {
		super(message);
		this.name = "ExaHttpError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ExaToolConfig = {
	enableAdvancedSearch: boolean;
	enableAgentTools: boolean;
};

const DEFAULT_EXA_TOOL_CONFIG: ExaToolConfig = {
	enableAdvancedSearch: false,
	enableAgentTools: false,
};

export function loadExaApiKey(agentDir = getAgentDir()): string | undefined {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
		if (!isRecord(parsed)) return undefined;
		const exa = parsed.exa;
		if (!isRecord(exa)) return undefined;
		const apiKey = exa.key;
		return typeof apiKey === "string" && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function loadExaToolConfig(agentDir = getAgentDir()): ExaToolConfig {
	const configPath = join(agentDir, "extensions", "exa-search.json");
	if (!existsSync(configPath)) return { ...DEFAULT_EXA_TOOL_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
		if (!isRecord(parsed)) return { ...DEFAULT_EXA_TOOL_CONFIG };
		return {
			enableAdvancedSearch: parsed.enableAdvancedSearch === true,
			enableAgentTools: parsed.enableAgentTools === true,
		};
	} catch {
		return { ...DEFAULT_EXA_TOOL_CONFIG };
	}
}

function missingKeyResult(): AgentToolResult {
	return {
		content: [{ type: "text", text: MISSING_KEY_MESSAGE }],
		isError: true,
	};
}

function integrationHeaders(tool: string): Record<string, string> {
	return { "x-exa-integration": tool };
}

function buildHeaders(apiKey: string, tool: string): Record<string, string> {
	return {
		accept: "application/json",
		"content-type": "application/json",
		"x-api-key": apiKey,
		...integrationHeaders(tool),
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (!(error instanceof ExaHttpError) || !TRANSIENT_STATUS_CODES.has(error.statusCode) || attempt === maxRetries) {
				throw error;
			}
			await delay(1000 * 2 ** attempt);
		}
	}
	throw lastError;
}

async function exaRequest<T>(
	apiKey: string,
	endpoint: string,
	method: "GET" | "POST",
	body: unknown | undefined,
	tool: string,
): Promise<T> {
	const response = await fetch(`${API_CONFIG.BASE_URL}${endpoint}`, {
		method,
		headers: buildHeaders(apiKey, tool),
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	let data: unknown;
	try {
		data = text.length > 0 ? JSON.parse(text) : undefined;
	} catch {
		data = text;
	}

	if (!response.ok) {
		const message =
			isRecord(data) && typeof data.message === "string"
				? data.message
				: isRecord(data) && typeof data.error === "string"
					? data.error
					: text || response.statusText;
		const timestamp = isRecord(data) && typeof data.timestamp === "string" ? data.timestamp : undefined;
		throw new ExaHttpError(message, response.status, timestamp);
	}

	return data as T;
}

function formatToolError(error: unknown, toolName: string): AgentToolResult {
	if (error instanceof ExaHttpError) {
		const lines = [
			`${toolName} error (${error.statusCode}): ${error.message}`,
			...(error.timestamp ? [`Timestamp: ${error.timestamp}`] : []),
		];
		return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
	}
	return {
		content: [
			{
				type: "text",
				text: `${toolName} error: ${error instanceof Error ? error.message : String(error)}`,
			},
		],
		isError: true,
	};
}

function formatAgentToolError(error: unknown, toolName: string): AgentToolResult {
	if (error instanceof ExaHttpError) {
		const guidance = guidanceForStatus(error.statusCode);
		return {
			content: [
				{
					type: "text",
					text: [`${toolName} error (${error.statusCode}): ${error.message}`, guidance].filter(Boolean).join("\n\n"),
				},
			],
			isError: true,
		};
	}
	return formatToolError(error, toolName);
}

function guidanceForStatus(status: number): string {
	if (status === 400) {
		return "Check the run body and outputSchema. Use a top-level object schema, bound arrays with maxItems when possible, and use input.data for known rows.";
	}
	if (status === 401 || status === 403) {
		return `Authenticate with an Exa API key. API keys are available at ${EXA_API_KEYS_URL}.`;
	}
	if (status === 404) {
		return "Run not found or not visible to this API key. Verify the agent_run_... ID and account.";
	}
	if (status === 429) {
		return "Rate or concurrency limit reached. Wait for active runs to finish, poll existing run IDs, or cancel accidental duplicate runs.";
	}
	return "";
}

function jsonResult(value: unknown): AgentToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value == null || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

const SENSITIVE_RESPONSE_KEYS = new Set(["requestTags"]);

function stripSensitiveKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stripSensitiveKeys(item));
	if (!isRecord(value)) return value;
	const sanitized: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (SENSITIVE_RESPONSE_KEYS.has(key)) continue;
		sanitized[key] = stripSensitiveKeys(nestedValue);
	}
	return sanitized;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sanitized = value.filter((item): item is string => typeof item === "string");
	return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeNumberArray(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sanitized = value.filter((item): item is number => typeof item === "number");
	return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeObjectArray(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sanitized = value
		.map((item) => stripSensitiveKeys(item))
		.filter((item): item is Record<string, unknown> => isRecord(item));
	return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeExtras(value: unknown): { links?: string[]; imageLinks?: string[] } | undefined {
	if (!isRecord(value)) return undefined;
	const sanitized: { links?: string[]; imageLinks?: string[] } = {};
	const links = sanitizeStringArray(value.links);
	if (links) sanitized.links = links;
	const imageLinks = sanitizeStringArray(value.imageLinks);
	if (imageLinks) sanitized.imageLinks = imageLinks;
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeSearchResult(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	const sanitized: Record<string, unknown> = {};
	const stringFields = ["id", "url", "publishedDate", "author", "text", "summary", "image", "favicon"] as const;
	for (const field of stringFields) {
		if (typeof value[field] === "string") sanitized[field] = value[field];
	}
	if (typeof value.title === "string" || value.title === null) sanitized.title = value.title;
	if (typeof value.score === "number") sanitized.score = value.score;
	const highlights = sanitizeStringArray(value.highlights);
	if (highlights) sanitized.highlights = highlights;
	const highlightScores = sanitizeNumberArray(value.highlightScores);
	if (highlightScores) sanitized.highlightScores = highlightScores;
	const entities = sanitizeObjectArray(value.entities);
	if (entities) sanitized.entities = entities;
	const extras = sanitizeExtras(value.extras);
	if (extras) sanitized.extras = extras;
	if (Array.isArray(value.subpages)) {
		const subpages = value.subpages
			.map((subpage) => sanitizeSearchResult(subpage))
			.filter((subpage): subpage is Record<string, unknown> => subpage !== null);
		if (subpages.length > 0) sanitized.subpages = subpages;
	}
	return sanitized;
}

function sanitizeSearchResults(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sanitized = value
		.map((result) => sanitizeSearchResult(result))
		.filter((result): result is Record<string, unknown> => result !== null);
	return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeSearchOutput(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const sanitized: Record<string, unknown> = {};
	if ("content" in value) sanitized.content = stripSensitiveKeys(value.content);
	if (Array.isArray(value.grounding)) {
		const grounding = value.grounding
			.map((entry) => {
				if (!isRecord(entry)) return null;
				const citations = Array.isArray(entry.citations)
					? entry.citations
							.map((citation) => {
								if (!isRecord(citation)) return null;
								const { url, title } = citation;
								if (typeof url !== "string" || typeof title !== "string") return null;
								return { url, title };
							})
							.filter((citation): citation is { url: string; title: string } => citation !== null)
					: [];
				const result: Record<string, unknown> = { citations };
				if (typeof entry.field === "string") result.field = entry.field;
				if (typeof entry.confidence === "string") result.confidence = entry.confidence;
				return result;
			})
			.filter((entry): entry is Record<string, unknown> => entry !== null);
		if (grounding.length > 0) sanitized.grounding = grounding;
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeStatuses(value: unknown): Array<{ id: string; status: string; source: string }> | undefined {
	if (!Array.isArray(value)) return undefined;
	const sanitized = value
		.map((status) => {
			if (!isRecord(status)) return null;
			const { id, status: state, source } = status;
			if (typeof id !== "string" || typeof state !== "string" || typeof source !== "string") return null;
			return { id, status: state, source };
		})
		.filter((status): status is { id: string; status: string; source: string } => status !== null);
	return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeSearchResponse(response: unknown): Record<string, unknown> {
	if (!isRecord(response)) return {};
	const sanitized: Record<string, unknown> = {};
	if (typeof response.requestId === "string") sanitized.requestId = response.requestId;
	if (typeof response.autopromptString === "string") sanitized.autopromptString = response.autopromptString;
	if (typeof response.autoDate === "string") sanitized.autoDate = response.autoDate;
	if (typeof response.resolvedSearchType === "string") sanitized.resolvedSearchType = response.resolvedSearchType;
	if (typeof response.context === "string") sanitized.context = response.context;
	const output = sanitizeSearchOutput(response.output);
	if (output) sanitized.output = output;
	const statuses = sanitizeStatuses(response.statuses);
	if (statuses) sanitized.statuses = statuses;
	const results = sanitizeSearchResults(response.results);
	if (results) sanitized.results = results;
	if (typeof response.searchTime === "number") sanitized.searchTime = response.searchTime;
	const costDollars = stripSensitiveKeys(response.costDollars);
	if (isRecord(costDollars)) sanitized.costDollars = costDollars;
	return sanitized;
}

function sanitizeContentsResponse(response: unknown): Record<string, unknown> {
	return sanitizeSearchResponse(response);
}

function formatCrawlResults(results: Array<Record<string, unknown>>, errors: CrawlStatus[]): string {
	if (results.length === 0 && errors.length === 0) return "No content found.";
	const lines: string[] = [];
	for (const r of results) {
		lines.push(`# ${typeof r.title === "string" ? r.title : "(no title)"}`);
		lines.push(`URL: ${String(r.url ?? "")}`);
		if (typeof r.publishedDate === "string") lines.push(`Published: ${r.publishedDate.split("T")[0]}`);
		if (typeof r.author === "string") lines.push(`Author: ${r.author}`);
		lines.push("");
		if (typeof r.text === "string") lines.push(r.text);
		lines.push("");
	}
	for (const err of errors) {
		lines.push(`Error fetching ${err.id}: ${err.error?.tag ?? "unknown error"}`);
	}
	return lines.join("\n").trim();
}

function isTerminalStatus(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function nextActionForStatus(status: string, runId: string): string {
	if (status === "completed") {
		return `Call agent_get_run_output with runId "${runId}" to retrieve text, structured output, grounding, usage, and cost.`;
	}
	if (status === "failed") {
		return "The run failed. Create a corrected run if the issue is clear, or retry agent_get_run_output later if you are waiting on final state propagation.";
	}
	if (status === "cancelled") {
		return "The run was cancelled. Create a new run if the task still needs to be completed.";
	}
	return `Call agent_wait_for_run again with runId "${runId}".`;
}

async function waitForRun(params: {
	apiKey: string;
	runId: string;
	timeoutSeconds: number;
	pollIntervalMs: number;
}): Promise<{ run: AgentRun; terminal: boolean; timedOut: boolean }> {
	const deadline = Date.now() + params.timeoutSeconds * 1000;
	let lastRun = await exaRequest<AgentRun>(
		params.apiKey,
		API_CONFIG.ENDPOINTS.RUN_BY_ID(params.runId),
		"GET",
		undefined,
		"agent-mcp",
	);

	while (!isTerminalStatus(lastRun.status) && Date.now() < deadline) {
		const remainingMs = Math.max(0, deadline - Date.now());
		await delay(Math.min(params.pollIntervalMs, remainingMs));
		lastRun = await exaRequest<AgentRun>(
			params.apiKey,
			API_CONFIG.ENDPOINTS.RUN_BY_ID(params.runId),
			"GET",
			undefined,
			"agent-mcp",
		);
	}

	return {
		run: lastRun,
		terminal: isTerminalStatus(lastRun.status),
		timedOut: !isTerminalStatus(lastRun.status),
	};
}

function requireApiKey(_ctx: ExtensionContext): string | AgentToolResult {
	const apiKey = loadExaApiKey();
	if (!apiKey) return missingKeyResult();
	return apiKey;
}

function isMissingKeyResult(value: string | AgentToolResult): value is AgentToolResult {
	return typeof value !== "string";
}

const webSearchSchema = Type.Object({
	query: Type.String({
		description:
			"Natural language search query. Should be a semantically rich description of the ideal page, not just keywords. Optionally include category:<type> (company, people) to focus results — e.g. 'category:people John Doe software engineer'.",
	}),
	numResults: Type.Optional(
		Type.Number({ description: "Number of search results to return (default: 10)." }),
	),
});

const webFetchSchema = Type.Object({
	urls: Type.Array(Type.String(), {
		description: "URLs to read. Batch multiple URLs in one call.",
	}),
	maxCharacters: Type.Optional(
		Type.Number({ description: "Maximum characters to extract per page (default: 3000)" }),
	),
});

const searchTypeSchema = StringEnum(["auto", "fast", "instant"] as const, {
	description:
		"Search type - 'auto': high quality and works with all filters (recommended), 'fast': quick results, 'instant': fastest results",
});
const categorySchema = StringEnum(
	["company", "research paper", "news", "pdf", "github", "personal site", "people", "financial report"] as const,
	{ description: "Filter results to a specific category" },
);
const effortSchema = StringEnum(["low", "medium", "high", "xhigh", "auto"] as const, {
	description: "Agent effort: low, medium, high, xhigh, or auto. Defaults to auto.",
});
const dataSourceProviderSchema = StringEnum(
	["fiber_ai", "financial_datasets", "similar_web", "baselayer", "affiliate", "particle_news", "jinko"] as const,
	{ description: "Exa Connect provider to enable for the run." },
);

const webSearchAdvancedSchema = Type.Object({
	query: Type.String({ description: "Search query - can be a question, statement, or keywords" }),
	numResults: Type.Optional(Type.Number({ description: "Number of results (1-100, default: 10)" })),
	type: Type.Optional(searchTypeSchema),
	category: Type.Optional(categorySchema),
	includeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Only include results from these domains (e.g., ['arxiv.org', 'github.com'])" }),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Exclude results from these domains" }),
	),
	startPublishedDate: Type.Optional(
		Type.String({ description: "Only include results published after this date (ISO 8601: YYYY-MM-DD)" }),
	),
	endPublishedDate: Type.Optional(
		Type.String({ description: "Only include results published before this date (ISO 8601: YYYY-MM-DD)" }),
	),
	startCrawlDate: Type.Optional(
		Type.String({ description: "Only include results crawled after this date (ISO 8601: YYYY-MM-DD)" }),
	),
	endCrawlDate: Type.Optional(
		Type.String({ description: "Only include results crawled before this date (ISO 8601: YYYY-MM-DD)" }),
	),
	includeText: Type.Optional(
		Type.Array(Type.String(), { description: "Only include results containing ALL of these text strings" }),
	),
	excludeText: Type.Optional(
		Type.Array(Type.String(), { description: "Exclude results containing ANY of these text strings" }),
	),
	userLocation: Type.Optional(
		Type.String({ description: "ISO country code for geo-targeted results (e.g., 'US', 'GB', 'DE')" }),
	),
	moderation: Type.Optional(Type.Boolean({ description: "Filter out unsafe/inappropriate content" })),
	additionalQueries: Type.Optional(
		Type.Array(Type.String(), { description: "Additional query variations to expand search coverage" }),
	),
	textMaxCharacters: Type.Optional(
		Type.Number({ description: "Max characters for text extraction per result" }),
	),
	contextMaxCharacters: Type.Optional(
		Type.Number({ description: "Max characters for context string (not included by default)" }),
	),
	enableSummary: Type.Optional(Type.Boolean({ description: "Enable summary generation for results" })),
	summaryQuery: Type.Optional(Type.String({ description: "Focus query for summary generation" })),
	enableHighlights: Type.Optional(Type.Boolean({ description: "Enable highlights extraction" })),
	highlightsMaxCharacters: Type.Optional(
		Type.Number({
			description:
				"Maximum total characters across all highlights per URL. Preferred over highlightsNumSentences.",
		}),
	),
	highlightsNumSentences: Type.Optional(
		Type.Number({
			description: "Deprecated: mapped to ~1333 chars/sentence. Use highlightsMaxCharacters instead.",
		}),
	),
	highlightsPerUrl: Type.Optional(
		Type.Number({ description: "Deprecated: currently ignored server-side. Use highlightsMaxCharacters instead." }),
	),
	highlightsQuery: Type.Optional(Type.String({ description: "Query for highlight relevance" })),
	maxAgeHours: Type.Optional(
		Type.Number({
			description:
				"Maximum age of cached content in hours. 0 = always fetch fresh content, omit = use cached content with fresh fetch fallback",
		}),
	),
	livecrawlTimeout: Type.Optional(
		Type.Number({
			description: "Timeout in milliseconds for fetching fresh content when maxAgeHours triggers a live fetch",
		}),
	),
	subpages: Type.Optional(Type.Number({ description: "Number of subpages to crawl from each result (1-10)" })),
	subpageTarget: Type.Optional(
		Type.Array(Type.String(), { description: "Keywords to target when selecting subpages" }),
	),
});

const agentCreateRunSchema = Type.Object({
	query: Type.String({ description: "Natural-language research or enrichment objective." }),
	systemPrompt: Type.Optional(Type.String({ description: "Optional system-level guidance for the Agent." })),
	outputSchema: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Optional JSON Schema for output. Prefer a top-level object with bounded arrays and source/evidence fields.",
		}),
	),
	input: Type.Optional(
		Type.Object({
			data: Type.Optional(
				Type.Array(Type.Record(Type.String(), Type.Unknown()), {
					description: "Known rows/entities to enrich or process.",
				}),
			),
			exclusion: Type.Optional(
				Type.Array(Type.Record(Type.String(), Type.Unknown()), {
					description: "Entities, rows, or records Agent should avoid returning again.",
				}),
			),
		}),
	),
	dataSources: Type.Optional(
		Type.Array(
			Type.Object({
				provider: dataSourceProviderSchema,
			}),
			{
				maxItems: 5,
				description:
					"Optional Exa Connect providers to enable for this run. Usable self-serve providers: fiber_ai, financial_datasets, similar_web, baselayer, affiliate, particle_news, jinko.",
			},
		),
	),
	previousRunId: Type.Optional(Type.String({ description: "Completed prior agent_run_... ID to continue from." })),
	effort: Type.Optional(effortSchema),
});

const agentWaitForRunSchema = Type.Object({
	runId: Type.String({ description: "The agent_run_... ID returned by agent_create_run." }),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"Maximum time to wait in this MCP call. Default 45, max 50. Longer runs are handled by calling this tool again.",
		}),
	),
	pollIntervalMs: Type.Optional(
		Type.Number({ description: "Polling interval. Default 4000, min 1000." }),
	),
});

const agentGetRunOutputSchema = Type.Object({
	runId: Type.String({ description: "The completed agent_run_... ID." }),
	requireCompleted: Type.Optional(
		Type.Boolean({
			description: "If true, return a status response until the run is completed. Default true.",
		}),
	),
	includeText: Type.Optional(Type.Boolean({ description: "Include output.text. Default true." })),
	includeStructured: Type.Optional(Type.Boolean({ description: "Include output.structured. Default true." })),
	includeGrounding: Type.Optional(Type.Boolean({ description: "Include output.grounding citations. Default true." })),
	includeUsage: Type.Optional(Type.Boolean({ description: "Include usage and costDollars. Default true." })),
});

const agentCancelRunSchema = Type.Object({
	runId: Type.String({ description: "The agent_run_... ID to cancel." }),
});

export default function exaSearchExtension(pi: ExtensionAPI): void {
	const toolConfig = loadExaToolConfig();

	pi.registerTool({
		name: "web_search_exa",
		label: "Web Search (Exa)",
		description: `Search the web for any topic and get clean, ready-to-use content.

      Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.
      Returns: Clean text content from top search results.

      Query tips:
      describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".
      Use category:people / category:company to search through Linkedin profiles / companies respectively.
      If highlights are insufficient, follow up with web_fetch_exa on the best URLs.`,
		parameters: webSearchSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const apiKeyOrError = requireApiKey(ctx);
			if (isMissingKeyResult(apiKeyOrError)) return apiKeyOrError;
			const apiKey = apiKeyOrError;

			const categoryMatch = params.query.match(
				/\bcategory:(company|research\s*paper|news|personal\s*site|people)\b/i,
			);
			const category = categoryMatch
				? (categoryMatch[1].toLowerCase().replace(/\s+/g, " ") as ExaSearchRequest["category"])
				: undefined;
			const cleanedQuery = categoryMatch
				? params.query.replace(categoryMatch[0], "").replace(/\s+/g, " ").trim()
				: params.query;

			try {
				const searchRequest: ExaSearchRequest = {
					query: cleanedQuery,
					type: "auto",
					numResults: params.numResults ?? API_CONFIG.DEFAULT_NUM_RESULTS,
					...(category ? { category } : {}),
					contents: { highlights: true },
				};

				const response = await retryWithBackoff(() =>
					exaRequest<Record<string, unknown>>(
						apiKey,
						API_CONFIG.ENDPOINTS.SEARCH,
						"POST",
						searchRequest,
						"web-search-mcp",
					),
				);

				if (!response || !Array.isArray(response.results) || response.results.length === 0) {
					return { content: [{ type: "text", text: "No search results found. Please try a different query." }] };
				}

				const sanitized = sanitizeSearchResponse(response);
				const results = Array.isArray(sanitized.results) ? sanitized.results : [];
				const formattedResults = results
					.map((r) => {
						if (!isRecord(r)) return "";
						const lines = [
							`Title: ${typeof r.title === "string" ? r.title : "N/A"}`,
							`URL: ${String(r.url ?? "")}`,
							`Published: ${typeof r.publishedDate === "string" ? r.publishedDate : "N/A"}`,
							`Author: ${typeof r.author === "string" ? r.author : "N/A"}`,
						];
						if (Array.isArray(r.highlights) && r.highlights.length > 0) {
							lines.push(`Highlights:\n${r.highlights.filter((h): h is string => typeof h === "string").join("\n")}`);
						} else if (typeof r.text === "string") {
							lines.push(`Text: ${r.text}`);
						}
						return lines.join("\n");
					})
					.join("\n\n---\n\n");

				return { content: [{ type: "text", text: formattedResults }] };
			} catch (error) {
				return formatToolError(error, "web_search_exa");
			}
		},
	});

	pi.registerTool({
		name: "web_fetch_exa",
		label: "Web Crawling",
		description: `Read a webpage's full content as clean markdown. Use after web_search_exa when highlights are insufficient or to read any URL.

Best for: Extracting full content from known URLs. Batch multiple URLs in one call.
Returns: Clean text content and metadata from the page(s).`,
		parameters: webFetchSchema,
		prepareArguments(args) {
			if (!isRecord(args)) return args;
			let urls = args.urls;
			if (typeof urls === "string") {
				try {
					urls = JSON.parse(urls);
				} catch {
					urls = [urls];
				}
			}
			return { ...args, urls };
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const apiKeyOrError = requireApiKey(ctx);
			if (isMissingKeyResult(apiKeyOrError)) return apiKeyOrError;
			const apiKey = apiKeyOrError;

			try {
				const crawlRequest = {
					urls: params.urls,
					text: { maxCharacters: params.maxCharacters ?? API_CONFIG.DEFAULT_MAX_CHARACTERS },
				};

				const response = await retryWithBackoff(() =>
					exaRequest<Record<string, unknown>>(
						apiKey,
						API_CONFIG.ENDPOINTS.CONTENTS,
						"POST",
						crawlRequest,
						"crawling-mcp",
					),
				);

				const statuses: CrawlStatus[] = Array.isArray(response?.statuses)
					? response.statuses.filter((s): s is CrawlStatus => isRecord(s) && typeof s.id === "string")
					: [];
				const urlErrors = statuses.filter((s) => s.status === "error");

				if (!response || !Array.isArray(response.results) || response.results.length === 0) {
					if (urlErrors.length > 0) {
						const msg = urlErrors.map((e) => `${e.id}: ${e.error?.tag ?? "unknown error"}`).join("; ");
						return {
							content: [{ type: "text", text: `Error fetching URL(s): ${msg}` }],
							isError: true,
						};
					}
					return { content: [{ type: "text", text: "No content found for the provided URL(s)." }] };
				}

				const sanitized = sanitizeContentsResponse(response);
				const results = Array.isArray(sanitized.results)
					? sanitized.results.filter((r): r is Record<string, unknown> => isRecord(r))
					: [];
				const formattedText = formatCrawlResults(results, urlErrors);
				return { content: [{ type: "text", text: formattedText }] };
			} catch (error) {
				return formatToolError(error, "web_fetch_exa");
			}
		},
	});

	if (toolConfig.enableAdvancedSearch) {
		pi.registerTool({
		name: "web_search_advanced_exa",
		label: "Advanced Web Search (Exa)",
		description: `Advanced web search with full control over filters, domains, dates, and content options.

Best for: When you need specific filters like date ranges, domain restrictions, or category filters.
Not recommended for: Simple searches - use web_search_exa instead.
Returns: Search results with optional highlights, summaries, and subpage content.`,
		parameters: webSearchAdvancedSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const apiKeyOrError = requireApiKey(ctx);
			if (isMissingKeyResult(apiKeyOrError)) return apiKeyOrError;
			const apiKey = apiKeyOrError;

			try {
				const contents: Record<string, unknown> = {
					text: params.textMaxCharacters ? { maxCharacters: params.textMaxCharacters } : true,
					...(params.maxAgeHours !== undefined ? { maxAgeHours: params.maxAgeHours } : { livecrawl: "fallback" }),
					...(params.livecrawlTimeout ? { livecrawlTimeout: params.livecrawlTimeout } : {}),
				};

				if (params.contextMaxCharacters) {
					contents.context = { maxCharacters: params.contextMaxCharacters };
				}
				if (params.enableSummary) {
					contents.summary = params.summaryQuery ? { query: params.summaryQuery } : true;
				}
				if (params.enableHighlights) {
					contents.highlights = {
						maxCharacters: params.highlightsMaxCharacters,
						numSentences: params.highlightsNumSentences,
						highlightsPerUrl: params.highlightsPerUrl,
						query: params.highlightsQuery,
					};
				}
				if (params.subpages) contents.subpages = params.subpages;
				if (params.subpageTarget) contents.subpageTarget = params.subpageTarget;

				const searchRequest: ExaSearchRequest = {
					query: params.query,
					type: params.type ?? "auto",
					numResults: params.numResults ?? 10,
					contents,
				};

				if (params.category) searchRequest.category = params.category;
				if (params.includeDomains?.length) searchRequest.includeDomains = params.includeDomains;
				if (params.excludeDomains?.length) searchRequest.excludeDomains = params.excludeDomains;
				if (params.startPublishedDate) searchRequest.startPublishedDate = params.startPublishedDate;
				if (params.endPublishedDate) searchRequest.endPublishedDate = params.endPublishedDate;
				if (params.startCrawlDate) searchRequest.startCrawlDate = params.startCrawlDate;
				if (params.endCrawlDate) searchRequest.endCrawlDate = params.endCrawlDate;
				if (params.includeText?.length) searchRequest.includeText = params.includeText;
				if (params.excludeText?.length) searchRequest.excludeText = params.excludeText;
				if (params.userLocation) searchRequest.userLocation = params.userLocation;
				if (params.moderation !== undefined) searchRequest.moderation = params.moderation;
				if (params.additionalQueries?.length) searchRequest.additionalQueries = params.additionalQueries;

				const response = await retryWithBackoff(() =>
					exaRequest<Record<string, unknown>>(
						apiKey,
						API_CONFIG.ENDPOINTS.SEARCH,
						"POST",
						searchRequest,
						"web-search-advanced-mcp",
					),
				);

				if (!response) {
					return {
						content: [
							{
								type: "text",
								text: "No search results found. Please try a different query or adjust your filters.",
							},
						],
					};
				}

				const sanitized = sanitizeSearchResponse(response);
				return { content: [{ type: "text", text: JSON.stringify(sanitized) }] };
			} catch (error) {
				return formatToolError(error, "web_search_advanced_exa");
			}
		},
		});
	}

	if (toolConfig.enableAgentTools) {
		pi.registerTool({
		name: "agent_create_run",
		label: "Create Exa Agent Run",
		description:
			"Create an async Exa Agent run for multi-step research, list-building, enrichment, or structured output. Returns an agent_run_... ID immediately; poll with agent_wait_for_run before reading final output. Every run should include outputSchema when repeatable structured results are needed.",
		parameters: agentCreateRunSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const apiKeyOrError = requireApiKey(ctx);
			if (isMissingKeyResult(apiKeyOrError)) return apiKeyOrError;
			const apiKey = apiKeyOrError;

			try {
				const runInput: AgentRunInput = {
					query: params.query,
					...(params.systemPrompt != null ? { systemPrompt: params.systemPrompt } : {}),
					...(params.outputSchema != null ? { outputSchema: params.outputSchema } : {}),
					...(params.input != null ? { input: params.input } : {}),
					...(params.dataSources != null ? { dataSources: params.dataSources } : {}),
					...(params.previousRunId != null ? { previousRunId: params.previousRunId } : {}),
					effort: (params.effort ?? "auto") as AgentEffort,
				};

				const run = await exaRequest<AgentRun>(
					apiKey,
					API_CONFIG.ENDPOINTS.RUNS,
					"POST",
					runInput,
					"agent-mcp",
				);

				return jsonResult({
					success: true,
					id: run.id,
					status: run.status,
					createdAt: run.createdAt,
					previousRunId: params.previousRunId ?? null,
					nextAction: `Call agent_wait_for_run with runId "${run.id}".`,
					run,
				});
			} catch (error) {
				return formatAgentToolError(error, "agent_create_run");
			}
		},
	});

	pi.registerTool({
		name: "agent_wait_for_run",
		label: "Wait for Exa Agent Run",
		description:
			"Poll an Exa Agent run until it reaches completed/failed/cancelled or a bounded timeout. This is the ergonomic default after agent_create_run.",
		parameters: agentWaitForRunSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const apiKeyOrError = requireApiKey(ctx);
			if (isMissingKeyResult(apiKeyOrError)) return apiKeyOrError;
			const apiKey = apiKeyOrError;

			try {
				const boundedTimeoutSeconds = clampInteger(
					params.timeoutSeconds,
					API_CONFIG.DEFAULT_WAIT_TIMEOUT_SECONDS,
					1,
					API_CONFIG.MAX_WAIT_TIMEOUT_SECONDS,
				);
				const boundedPollIntervalMs = clampInteger(
					params.pollIntervalMs,
					API_CONFIG.DEFAULT_POLL_INTERVAL_MS,
					API_CONFIG.MIN_POLL_INTERVAL_MS,
					boundedTimeoutSeconds * 1000,
				);

				const result = await waitForRun({
					apiKey,
					runId: params.runId,
					timeoutSeconds: boundedTimeoutSeconds,
					pollIntervalMs: boundedPollIntervalMs,
				});

				return jsonResult({
					success: true,
					id: result.run.id,
					status: result.run.status,
					terminal: result.terminal,
					timedOut: result.timedOut,
					nextAction: result.timedOut
						? `Run is still ${result.run.status}. Call agent_wait_for_run again with runId "${params.runId}".`
						: nextActionForStatus(result.run.status, params.runId),
					run: result.run,
				});
			} catch (error) {
				return formatAgentToolError(error, "agent_wait_for_run");
			}
		},
	});

	pi.registerTool({
		name: "agent_get_run_output",
		label: "Get Exa Agent Run Output",
		description:
			"Retrieve completed Exa Agent output in a Claude-friendly shape: text, structured JSON, grounding, usage, and cost. Use after agent_wait_for_run reports completed.",
		parameters: agentGetRunOutputSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const apiKeyOrError = requireApiKey(ctx);
			if (isMissingKeyResult(apiKeyOrError)) return apiKeyOrError;
			const apiKey = apiKeyOrError;

			try {
				const run = await exaRequest<AgentRun>(
					apiKey,
					API_CONFIG.ENDPOINTS.RUN_BY_ID(params.runId),
					"GET",
					undefined,
					"agent-mcp",
				);

				const mustBeCompleted = params.requireCompleted ?? true;
				if (mustBeCompleted && run.status !== "completed") {
					return jsonResult({
						success: true,
						id: run.id,
						status: run.status,
						terminal: isTerminalStatus(run.status),
						outputReady: false,
						nextAction: isTerminalStatus(run.status)
							? "This run ended without completed output. Create a corrected run if the task still needs to be completed."
							: `Run is still ${run.status}. Call agent_wait_for_run with runId "${params.runId}".`,
					});
				}

				const output: Record<string, unknown> = {};
				if (params.includeText ?? true) output.text = run.output.text;
				if (params.includeStructured ?? true) output.structured = run.output.structured;
				if (params.includeGrounding ?? true) output.grounding = run.output.grounding;

				return jsonResult({
					success: true,
					id: run.id,
					status: run.status,
					outputReady: run.status === "completed",
					output,
					...(params.includeUsage ?? true ? { usage: run.usage, costDollars: run.costDollars } : {}),
					nextAction:
						"Validate coverage, deduplicate structured rows, inspect grounding, and continue with previousRunId if gaps remain.",
				});
			} catch (error) {
				return formatAgentToolError(error, "agent_get_run_output");
			}
		},
	});

	pi.registerTool({
		name: "agent_cancel_run",
		label: "Cancel Exa Agent Run",
		description:
			"Cancel a queued or running Exa Agent run. Use only when the user asks, the run is clearly wrong, or a duplicate run was accidentally created.",
		parameters: agentCancelRunSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const apiKeyOrError = requireApiKey(ctx);
			if (isMissingKeyResult(apiKeyOrError)) return apiKeyOrError;
			const apiKey = apiKeyOrError;

			try {
				const run = await exaRequest<AgentRun>(
					apiKey,
					API_CONFIG.ENDPOINTS.RUN_CANCEL(params.runId),
					"POST",
					undefined,
					"agent-mcp",
				);

				return jsonResult({
					success: true,
					id: run.id,
					status: run.status,
					nextAction: "Create a corrected run if the task still needs to be completed.",
					run,
				});
			} catch (error) {
				return formatAgentToolError(error, "agent_cancel_run");
			}
		},
		});
	}
}

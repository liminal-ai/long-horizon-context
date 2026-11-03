import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RETRIEVAL_MAX_IDS, type RetrievalOp, runRetrieval } from "claude-adapter";
import type { Lhc } from "lhc";
import type { CaptureEntry, CaptureReply } from "../../src/capture.ts";
import type { CompactAnswer, CompactRequest, RetrieveAnswer, RetrieveRequest } from "../../src/compact.ts";
import type { BridgeOutcome, BridgeRequest, BridgeResult } from "../../src/inference.ts";
import { answerCompact } from "./compact.ts";
import { HARNESS } from "./capture/map.ts";
import { type Binding, openRecording, type Recorder, type Recording } from "./capture/recorder.ts";
import type { Bridge } from "./inference-bridge.ts";

export type { Binding };
export type Policy = { window: number; trigger: number; target: number };
export type SidecarState = { binding: Binding | null; policy: Policy | null; recording: Recording | null };
export type SidecarDeps = { lhc: Lhc; bridge?: Bridge; home: string; ownerPid: number; log: (line: string) => void };

type Route = (body: unknown, state: SidecarState, deps: SidecarDeps) => unknown;

const isString = (value: unknown): value is string => typeof value === "string" && value !== "";
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

function parseBinding(body: unknown): Binding {
  const { sessionId, transcriptPath, source } = (body ?? {}) as Record<string, unknown>;
  if (!isString(sessionId) || !isString(transcriptPath) || !isString(source)) {
    throw new Error("bind needs sessionId, transcriptPath and source");
  }
  return { sessionId, transcriptPath, source };
}

function parsePolicy(body: unknown): Policy {
  const { window, trigger, target } = (body ?? {}) as Record<string, unknown>;
  if (!isCount(window) || !isCount(trigger) || !isCount(target)) {
    throw new Error("policy needs window, trigger and target");
  }
  return { window, trigger, target };
}

function parseEntries(body: unknown): CaptureEntry[] {
  const { entries } = (body ?? {}) as { entries?: unknown };
  if (!Array.isArray(entries)) throw new Error("capture needs entries");
  return entries as CaptureEntry[];
}

function parseCompact(body: unknown): CompactRequest {
  const { sessionId, trigger, target, guard } = (body ?? {}) as Record<string, unknown>;
  if (!isString(sessionId) || !isString(trigger) || !isCount(target)) throw new Error("compact needs sessionId, trigger and target");
  if (guard === undefined) return { sessionId, trigger, target };
  const { trigger: limit, fixed } = (guard ?? {}) as Record<string, unknown>;
  if (!isCount(limit) || typeof fixed !== "number" || !Number.isFinite(fixed) || fixed < 0) throw new Error("compact guard needs trigger and fixed token counts");
  return { sessionId, trigger, target, guard: { trigger: limit, fixed } };
}

const OPS: ReadonlySet<string> = new Set<RetrievalOp>(["get_turns", "get_messages"]);

function parseRetrieve(body: unknown): RetrieveRequest {
  const { sessionId, op, ids, fromToken } = (body ?? {}) as Record<string, unknown>;
  if (!isString(sessionId) || typeof op !== "string" || !OPS.has(op)) throw new Error("retrieve needs sessionId and op");
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RETRIEVAL_MAX_IDS || !ids.every(isString)) {
    throw new Error(`retrieve needs 1 to ${RETRIEVAL_MAX_IDS} ids`);
  }
  if (fromToken !== undefined && !(Number.isInteger(fromToken) && (fromToken as number) >= 0)) {
    throw new Error("fromToken must be a non-negative integer");
  }
  return { sessionId, op: op as RetrievalOp, ids, ...(fromToken === undefined ? {} : { fromToken: fromToken as number }) };
}

const REASONS: ReadonlySet<unknown> = new Set(["api-error", "empty-reply", "aborted"]);

function parseResult(body: unknown): BridgeResult {
  const { id, outcome } = (body ?? {}) as { id?: unknown; outcome?: Record<string, unknown> };
  const isValid =
    outcome?.isAnswered === true ? typeof outcome.text === "string" : outcome?.isAnswered === false && REASONS.has(outcome.reason);
  if (!isString(id) || !isValid) throw new Error("result needs an id and an outcome");
  return { id, outcome: outcome as BridgeOutcome };
}

function recorderFor(state: SidecarState, sessionId: string): Recorder | string {
  if (state.binding?.sessionId !== sessionId) return `the sidecar is bound to ${state.binding?.sessionId ?? "no session"}`;
  if (state.recording?.kind !== "recording") return state.recording?.notice ?? "the session is not recorded";
  return state.recording.recorder;
}

function describe(recording: Recording | null): unknown {
  if (recording === null) return null;
  return recording.kind === "recording"
    ? { kind: "recording", threadId: recording.recorder.thread.threadId }
    : recording;
}

export function stopRecording(state: SidecarState): void {
  if (state.recording?.kind === "recording") state.recording.recorder.release();
  state.recording = null;
}

const routes: Record<string, Route> = {
  "GET /health": (_body, state) => ({
    pid: process.pid,
    binding: state.binding,
    policy: state.policy,
    recording: describe(state.recording),
  }),
  "POST /bind": async (body, state, deps): Promise<unknown> => {
    const binding = parseBinding(body);
    const current = state.recording?.kind === "recording" ? state.recording.recorder : undefined;
    if (current?.binding.sessionId === binding.sessionId && current.binding.transcriptPath === binding.transcriptPath) {
      const recovered = await current.recover();
      state.binding = binding;
      deps.log(`bound session ${binding.sessionId} transcript ${binding.transcriptPath} source ${binding.source}`);
      deps.log(`still recording session ${binding.sessionId}, recovered ${recovered.recorded} of ${recovered.scanned} rows`);
      return binding;
    }
    stopRecording(state);
    state.binding = null;
    const recording = await openRecording(deps, binding);
    state.recording = recording;
    state.binding = binding;
    deps.log(`bound session ${binding.sessionId} transcript ${binding.transcriptPath} source ${binding.source}`);
    if (recording.kind === "refused") deps.log(`not recording: ${recording.notice}`);
    else void deps.lhc.work.drain(recording.recorder.thread);
    return { ...binding, ...(recording.kind === "refused" ? { notice: recording.notice } : {}) };
  },
  "POST /policy": (body, state, deps) => {
    state.policy = parsePolicy(body);
    deps.log(`policy window ${state.policy.window} trigger ${state.policy.trigger} target ${state.policy.target}`);
    return state.policy;
  },
  "POST /capture": async (body, state, deps): Promise<CaptureReply> => {
    const entries = parseEntries(body);
    const sessionId = state.binding?.sessionId;
    const foreign = entries.find((entry) => entry.sessionId !== sessionId);
    if (foreign !== undefined) throw new Error(`entries for session ${foreign.sessionId}, bound to ${sessionId}`);
    if (state.recording === null) throw new Error("no recording is open");
    if (state.recording.kind !== "recording" || entries.length === 0) return { recorded: 0 };
    const recorded = await state.recording.recorder.capture(entries);
    const lag = Math.max(...entries.map((entry) => Date.now() - entry.at));
    deps.log(`captured ${entries.length} entries recorded ${recorded} events lag ${lag}ms`);
    return { recorded };
  },
  "POST /compact": async (body, state, deps): Promise<CompactAnswer> => {
    const request = parseCompact(body);
    const recorder = recorderFor(state, request.sessionId);
    const answer: CompactAnswer =
      typeof recorder === "string"
        ? { kind: "native", reason: recorder }
        : await answerCompact(recorder, request, deps.log).catch(
            (error: unknown): CompactAnswer => ({ kind: "native", reason: String(error) }),
          );
    if (answer.kind === "native") deps.log(`compact ${request.trigger} answered native: ${answer.reason}`);
    return answer;
  },
  "POST /retrieve": async (body, state, deps): Promise<RetrieveAnswer> => {
    const request = parseRetrieve(body);
    const recorder = recorderFor(state, request.sessionId);
    if (typeof recorder === "string") return { text: `${request.op} unavailable: ${recorder}`, isError: true };
    const answer = await runRetrieval(HARNESS, deps.lhc, recorder.thread, request.op, request.ids, request.fromToken);
    deps.log(`${request.op} ${request.ids.join(",")} served ${answer.text.length} chars${answer.isError ? " error" : ""}`);
    return answer;
  },
};

const unorderedRoutes: Record<string, (body: unknown, bridge: Bridge | undefined) => unknown> = {
  "POST /inference/claim": (_body, bridge): { requests: BridgeRequest[] } => ({ requests: bridge?.claim() ?? [] }),
  "POST /inference/result": (body, bridge) => {
    bridge?.answer(parseResult(body));
    return {};
  },
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text === "" ? undefined : JSON.parse(text);
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export function createSidecarServer(deps: SidecarDeps): { server: Server; state: SidecarState } {
  const state: SidecarState = { binding: null, policy: null, recording: null };
  let inArrivalOrder: Promise<unknown> = Promise.resolve();
  const server = createServer((req, res) => {
    const unorderedRoute = unorderedRoutes[`${req.method} ${req.url}`];
    if (unorderedRoute !== undefined) {
      void readJson(req)
        .then((body) => reply(res, 200, unorderedRoute(body, deps.bridge)))
        .catch((error: unknown) => {
          deps.log(`refused ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
          reply(res, 400, { error: String(error) });
        });
      return;
    }
    const route = routes[`${req.method} ${req.url}`];
    if (route === undefined) return reply(res, 404, { error: `no route ${req.method} ${req.url}` });
    const body = readJson(req);
    inArrivalOrder = inArrivalOrder
      .then(async () => reply(res, 200, await route(await body, state, deps)))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.log(`refused ${req.method} ${req.url}: ${message}`);
        reply(res, 400, { error: message });
      });
  });
  return { server, state };
}

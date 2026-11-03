import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Lhc } from "lhc";
import type { CaptureEntry, CaptureReply } from "../../src/capture.ts";
import { type Binding, openRecording, type Recording } from "./capture/recorder.ts";

export type { Binding };
export type Policy = { window: number; trigger: number; target: number };
export type SidecarState = { binding: Binding | null; policy: Policy | null; recording: Recording | null };
export type SidecarDeps = { lhc: Lhc; home: string; ownerPid: number; log: (line: string) => void };

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
    state.binding = binding;
    deps.log(`bound session ${binding.sessionId} transcript ${binding.transcriptPath} source ${binding.source}`);
    const current = state.recording?.kind === "recording" ? state.recording.recorder : undefined;
    if (current?.binding.sessionId === binding.sessionId && current.binding.transcriptPath === binding.transcriptPath) {
      const recovered = await current.recover();
      deps.log(`still recording session ${binding.sessionId}, recovered ${recovered.recorded} of ${recovered.scanned} rows`);
      return binding;
    }
    stopRecording(state);
    state.recording = await openRecording(deps, binding);
    if (state.recording.kind === "refused") deps.log(`not recording: ${state.recording.notice}`);
    return { ...binding, ...(state.recording.kind === "refused" ? { notice: state.recording.notice } : {}) };
  },
  "POST /policy": (body, state, deps) => {
    state.policy = parsePolicy(body);
    deps.log(`policy window ${state.policy.window} trigger ${state.policy.trigger} target ${state.policy.target}`);
    return state.policy;
  },
  "POST /capture": async (body, state, deps): Promise<CaptureReply> => {
    const entries = parseEntries(body);
    const sessionId = state.binding?.sessionId;
    const own = entries.filter((entry) => entry.sessionId === sessionId);
    if (state.recording?.kind !== "recording" || own.length === 0) return { recorded: 0 };
    const recorded = await state.recording.recorder.capture(own);
    const lag = Math.max(...own.map((entry) => Date.now() - entry.at));
    deps.log(`captured ${own.length} entries recorded ${recorded} events lag ${lag}ms`);
    return { recorded };
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

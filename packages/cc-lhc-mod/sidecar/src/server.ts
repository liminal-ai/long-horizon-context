import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type Binding = { sessionId: string; transcriptPath: string; source: string };
export type Policy = { window: number; trigger: number; target: number };
export type SidecarState = { binding: Binding | null; policy: Policy | null };

type Route = (body: unknown, state: SidecarState, log: (line: string) => void) => unknown;

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

const routes: Record<string, Route> = {
  "GET /health": (_body, state) => ({ pid: process.pid, ...state }),
  "POST /bind": (body, state, log) => {
    state.binding = parseBinding(body);
    log(
      `bound session ${state.binding.sessionId} transcript ${state.binding.transcriptPath} source ${state.binding.source}`,
    );
    return state.binding;
  },
  "POST /policy": (body, state, log) => {
    state.policy = parsePolicy(body);
    log(`policy window ${state.policy.window} trigger ${state.policy.trigger} target ${state.policy.target}`);
    return state.policy;
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

export function createSidecarServer(log: (line: string) => void): Server {
  const state: SidecarState = { binding: null, policy: null };
  return createServer((req, res) => {
    const route = routes[`${req.method} ${req.url}`];
    if (route === undefined) return reply(res, 404, { error: `no route ${req.method} ${req.url}` });
    readJson(req)
      .then((body) => reply(res, 200, route(body, state, log)))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`refused ${req.method} ${req.url}: ${message}`);
        reply(res, 400, { error: message });
      });
  });
}

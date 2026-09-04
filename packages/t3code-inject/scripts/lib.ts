// Shared by the C1 proof scripts: auth from the injector's cache, throwaway
// project + thread on the target server, injector child processes, and a
// thread subscription that records the timeline (from the projection only).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OrchestrationThreadStreamItem, ServerProvider } from "@t3tools/contracts";
import { bearerIsValid, loadCachedAuth, webSocketUrl } from "../src/t3code/auth.ts";
import { connectRpc, type RpcSession } from "../src/t3code/rpc.ts";
import { fetchThread, now } from "../src/t3code/thread.ts";

export const BASE_URL = process.env.T3CODE_INJECT_BASE_URL ?? "http://127.0.0.1:3773";
export const HOME = process.env.T3CODE_INJECT_HOME ?? join(homedir(), ".t3code-inject");
export const BIN = join(import.meta.dirname, "..", "bin", "t3code-inject");
export const uuid = randomUUID;
export { fetchThread, now };

export async function connect(): Promise<{ rpc: RpcSession; bearer: string }> {
  const cached = loadCachedAuth(join(HOME, `auth-${BASE_URL.replace(/[^a-z0-9]+/gi, "_")}.json`), BASE_URL);
  if (!cached || !(await bearerIsValid(BASE_URL, cached.bearer)))
    throw new Error(`no valid cached bearer for ${BASE_URL}; run the injector once so it mints one`);
  return { rpc: await connectRpc(await webSocketUrl(BASE_URL, cached.bearer)), bearer: cached.bearer };
}

export async function pickModel(rpc: RpcSession, instanceId: string, model?: string): Promise<{ instanceId: string; model: string }> {
  const config = await rpc.getConfig();
  const found = (config.providers as ReadonlyArray<ServerProvider>).find((p) => p.instanceId === instanceId);
  if (!found) throw new Error(`provider '${instanceId}' not in server config (have: ${config.providers.map((p) => p.instanceId).join(", ")})`);
  if (!found.enabled || found.availability === "unavailable") throw new Error(`provider '${instanceId}' is disabled or unavailable`);
  const slug = model ?? found.models.find((m) => m.isDefault)?.slug ?? found.models[0]?.slug;
  if (!slug) throw new Error(`provider '${instanceId}' has no models`);
  return { instanceId, model: slug };
}

/** Throwaway project + thread. `files` are written into the workspace root. */
export async function createThread(input: {
  rpc: RpcSession;
  label: string;
  workspaceRoot: string;
  modelSelection: { instanceId: string; model: string };
  files?: Record<string, string>;
}): Promise<{ projectId: string; threadId: string }> {
  mkdirSync(input.workspaceRoot, { recursive: true });
  for (const [name, text] of Object.entries(input.files ?? {})) writeFileSync(join(input.workspaceRoot, name), text);
  const projectId = uuid();
  const threadId = uuid();
  await input.rpc.dispatch({
    type: "project.create", commandId: uuid(), projectId, title: `inject ${input.label} ${now()}`,
    workspaceRoot: input.workspaceRoot, createWorkspaceRootIfMissing: true, createdAt: now(),
  } as never);
  await input.rpc.dispatch({
    type: "thread.create", commandId: uuid(), threadId, projectId, title: `inject ${input.label}`,
    modelSelection: input.modelSelection, runtimeMode: "full-access", interactionMode: "default",
    branch: null, worktreePath: null, createdAt: now(),
  } as never);
  return { projectId, threadId };
}

export async function deleteProject(rpc: RpcSession, projectId: string): Promise<void> {
  await rpc.dispatch({ type: "project.delete", commandId: uuid(), projectId, force: true } as never);
}

export interface InjectRun {
  readonly label: string;
  readonly spawnedAt: string;
  readonly done: Promise<{ code: number | null; stdout: string; stderr: string; exitedAt: string }>;
}

/** One injector process, as the relay would run it: prompt last, env from the caller. */
export function inject(label: string, argv: string[], prompt: string, env: NodeJS.ProcessEnv = {}): InjectRun {
  const spawnedAt = now();
  const done = new Promise<{ code: number | null; stdout: string; stderr: string; exitedAt: string }>((resolve) => {
    execFile(
      BIN,
      ["--base-url", BASE_URL, "--home", HOME, ...argv, prompt],
      { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr, exitedAt: now() }),
    );
  });
  return { label, spawnedAt, done };
}

export interface TimelineEntry {
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

/** Records session status changes, user messages and tool activity for a thread. */
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  toolsCompleted = 0;
  sessionStatus: string | null = null;
  #waiters: Array<() => void> = [];
  onItem = (item: OrchestrationThreadStreamItem): void => {
    if (item.kind === "event") {
      const event = item.event;
      if (event.type === "thread.session-set") {
        const s = event.payload.session;
        if (s.status !== this.sessionStatus) this.push(event.occurredAt, "session", `${s.status} turn=${s.activeTurnId ?? "-"}`);
        this.sessionStatus = s.status;
      } else if (event.type === "thread.message-sent" && event.payload.role === "user") {
        this.push(event.payload.createdAt, "user", `turn=${event.payload.turnId ?? "-"} ${event.payload.text.split("\n").slice(0, 2).join(" | ")}`);
      } else if (event.type === "thread.activity-appended") {
        const a = event.payload.activity;
        if (a.kind === "tool.completed") this.toolsCompleted += 1;
        if (a.kind.startsWith("tool.")) this.push(a.createdAt, a.kind, `turn=${a.turnId ?? "-"} ${a.summary}`);
      }
    }
    for (const wake of this.#waiters.splice(0)) wake();
  };
  push(at: string, kind: string, detail: string): void {
    this.entries.push({ at, kind, detail });
  }
  async until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

export function writeRecord(dir: string, name: string, log: string[], data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.log`), `${log.join("\n")}\n`);
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

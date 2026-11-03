import type { EngineInterface, Register } from "claude-code";
import { modLogPath, socketPath } from "../../src/paths.ts";
import { computePolicy, type ResolvedSettings, resolveSettings } from "../../src/settings.ts";
import type { Binding } from "../types";

const LOAD_ID = Math.random().toString(36).slice(2, 10);

let options: Record<string, unknown> = {};
let settings: ResolvedSettings = resolveSettings(options);
let sidecar: Promise<string> | undefined;
let sidecarStarts = 0;
let boundSessionId: string | undefined;
let appliedModel: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
const logLines: string[] = [];
let logWrite: Promise<unknown> = Promise.resolve();

async function lhcHome($: EngineInterface): Promise<string> {
  return (await $.env.get("LHC_HOME")) ?? `${await $.env.get("HOME")}/.lhc`;
}

function log($: EngineInterface, line: string): void {
  $.ui.log(line, { to: "debug" });
  logLines.push(`${new Date().toISOString()} ${line}`);
  const text = `${logLines.join("\n")}\n`;
  logWrite = logWrite.then(async () => $.fs.write(modLogPath(await lhcHome($), LOAD_ID), text)).catch(() => {});
}

function runInBackground($: EngineInterface, what: string, task: () => Promise<unknown>): void {
  queue = queue.then(task).catch((error: unknown) => log($, `${what} failed: ${String(error)}`));
}

function startSidecar($: EngineInterface): Promise<string> {
  sidecar ??= new Promise<string>((resolve, reject) => {
    void (async () => {
      const home = await lhcHome($);
      const socket = socketPath(home, LOAD_ID);
      const child = $.process.spawn({
        argv: ["node", `${$.plugin.root}/sidecar/main.js`, "--home", home, "--id", LOAD_ID],
      });
      const isReplacement = sidecarStarts++ > 0;
      let pending = "";
      let isListening = false;
      try {
        for await (const piece of child) {
          pending += piece.text;
          if (!isListening && pending.includes(`listening ${socket}`)) {
            isListening = true;
            const replayed = isReplacement ? rebind($, socket) : Promise.resolve();
            void replayed
              .catch((error: unknown) => log($, `rebind failed: ${String(error)}`))
              .then(() => resolve(socket));
          }
          if (piece.stream === "stderr") log($, `sidecar stderr: ${piece.text.trim()}`);
        }
      } catch (error) {
        log($, `sidecar did not start: ${String(error)}`);
      }
      log($, "sidecar exited");
      sidecar = undefined;
      reject(new Error("sidecar exited"));
    })();
  });
  return sidecar;
}

async function rebind($: EngineInterface, socket: string): Promise<void> {
  const { value: binding } = await $.state.get({ plugin: "lhc", key: "binding" });
  if (binding === undefined || binding.sessionId !== boundSessionId) return;
  const replayed = { ...binding, source: "restart" };
  await $.http.fetch("http://sidecar/bind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(replayed),
    socketPath: socket,
  });
  log($, `bind session ${binding.sessionId} source restart`);
}

async function post($: EngineInterface, path: string, body: unknown): Promise<void> {
  const response = await $.http.fetch(`http://sidecar${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    socketPath: await startSidecar($),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status} ${response.text}`);
}

function bind($: EngineInterface, binding: Binding): void {
  boundSessionId = binding.sessionId;
  runInBackground($, "bind", async () => {
    await $.state.set({ plugin: "lhc", key: "binding" }, binding);
    await post($, "/bind", binding);
    log($, `bind session ${binding.sessionId} source ${binding.source}`);
  });
}

async function compactWindow($: EngineInterface): Promise<number> {
  const { context } = await $.session.usage({ breakdown: "summary" });
  return context.breakdown?.rawMaxTokens ?? context.window;
}

function applySettings($: EngineInterface, reason: string): void {
  runInBackground($, "applySettings", async () => {
    appliedModel = await $.session.model();
    const { policy, notices } = computePolicy(settings, await compactWindow($));
    for (const notice of notices) $.ui.log(`LHC settings: ${notice}`);
    const set = await $.env.set("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", String(policy.pct));
    if ("deny" in set) throw new Error(`env refused: ${set.deny}`);
    const clamp = policy.isClamped ? " clamped" : "";
    log(
      $,
      `${reason} window ${policy.window} trigger ${policy.trigger} target ${policy.target} pct ${policy.pct}${clamp}`,
    );
    await post($, "/policy", { window: policy.window, trigger: policy.trigger, target: policy.target });
  });
}

export const register: Register = (on, initial) => {
  options = { ...initial };
  settings = resolveSettings(options);

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    void startSidecar($).catch(() => {});
    const { value: binding } = await $.state.get({ plugin: "lhc", key: "binding" });
    if (binding !== undefined && boundSessionId === undefined && binding.sessionId === (await $.session.id())) {
      bind($, { ...binding, source: "reload" });
    }
    applySettings($, "start");
    return started;
  });

  on("classic.SessionStart", async ($, e, next) => {
    bind($, { sessionId: e.session_id, transcriptPath: e.transcript_path, source: e.source });
    applySettings($, "bind");
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined && appliedModel !== undefined && (await $.session.model()) !== appliedModel) {
      applySettings($, "model");
    }
    return next(e);
  });

  on("config.set", async ($, e, next) => {
    const written = await next(e);
    const field = e.key.startsWith("lhc.") ? e.key.slice("lhc.".length) : undefined;
    if (field !== undefined && "value" in written) {
      options = { ...options, [field]: written.value };
      settings = resolveSettings(options);
      applySettings($, "config");
    }
    return written;
  });
};

import type { EngineInterface } from "claude-code";
import { modLogPath, socketPath } from "../../src/paths.ts";
import type { Binding } from "../types";

const LOAD_ID = Math.random().toString(36).slice(2, 10);

let sidecar: Promise<string> | undefined;
let sidecarStarts = 0;
let boundSessionId: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
const logLines: string[] = [];
let logWrite: Promise<unknown> = Promise.resolve();

export const boundSession = (): string | undefined => boundSessionId;

async function lhcHome($: EngineInterface): Promise<string> {
  return (await $.env.get("LHC_HOME")) ?? `${await $.env.get("HOME")}/.lhc`;
}

export function log($: EngineInterface, line: string): void {
  $.ui.log(line, { to: "debug" });
  logLines.push(`${new Date().toISOString()} ${line}`);
  const text = `${logLines.join("\n")}\n`;
  logWrite = logWrite.then(async () => $.fs.write(modLogPath(await lhcHome($), LOAD_ID), text)).catch(() => {});
}

export function runInBackground($: EngineInterface, what: string, task: () => Promise<unknown>): void {
  queue = queue.then(task).catch((error: unknown) => log($, `${what} failed: ${String(error)}`));
}

export function startSidecar($: EngineInterface): Promise<string> {
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

export async function post($: EngineInterface, path: string, body: unknown): Promise<unknown> {
  const response = await $.http.fetch(`http://sidecar${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    socketPath: await startSidecar($),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status} ${response.text}`);
  return JSON.parse(response.text);
}

export function bind($: EngineInterface, binding: Binding): void {
  boundSessionId = binding.sessionId;
  runInBackground($, "bind", async () => {
    await $.state.set({ plugin: "lhc", key: "binding" }, binding);
    const { notice } = (await post($, "/bind", binding)) as { notice?: string };
    log($, `bind session ${binding.sessionId} source ${binding.source}`);
    if (notice !== undefined) $.ui.log(notice);
  });
}

import type { EngineInterface } from "claude-code";
import { modLogPath, socketPath } from "../../src/paths.ts";
import type { CaptureEntry } from "../../src/capture.ts";
import type { Binding } from "../types";

const LOAD_ID = Math.random().toString(36).slice(2, 10);

let sidecar: Promise<string> | undefined;
let sidecarStarts = 0;
let boundSessionId: string | undefined;
let sentBinding: Binding | undefined;
const outbox: Array<CaptureEntry | { kind: "bind"; binding: Binding }> = [];
let isFlushQueued = false;
let isRetryArmed = false;
let needsReplay = false;
let failures = 0;
let isStopped = false;
const MAX_BATCH = 200;
const RETRY_MS = 2000;
const MAX_FAILURES = 5;
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
            const replayed = isReplacement ? replayBind($, socket) : Promise.resolve(true);
            void replayed.then((isBound) => {
              needsReplay = !isBound;
              resolve(socket);
            });
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

/** Replays the last sent bind to a replacement sidecar; false leaves it to the outbox to retry. */
async function replayBind($: EngineInterface, socket: string): Promise<boolean> {
  if (sentBinding === undefined) return true;
  try {
    const response = await $.http.fetch("http://sidecar/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...sentBinding, source: "restart" }),
      socketPath: socket,
    });
    log($, `bind session ${sentBinding.sessionId} source restart answered ${response.status}`);
    return response.ok;
  } catch (error) {
    log($, `bind session ${sentBinding.sessionId} source restart failed: ${String(error)}`);
    return false;
  }
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

/**
 * Binds and captured entries leave in one ordered outbox. A bind is a barrier:
 * entries behind it go only after it, and an entry leaves only once the
 * sidecar has answered for it.
 */
export function bind($: EngineInterface, binding: Binding): void {
  boundSessionId = binding.sessionId;
  outbox.push({ kind: "bind", binding });
  flush($);
}

export function enqueue($: EngineInterface, entry: CaptureEntry): void {
  outbox.push(entry);
  flush($);
}

async function sendBind($: EngineInterface, binding: Binding): Promise<void> {
  await $.state.set({ plugin: "lhc", key: "binding" }, binding);
  const { notice } = (await post($, "/bind", binding)) as { notice?: string };
  sentBinding = binding;
  log($, `bind session ${binding.sessionId} source ${binding.source}`);
  if (notice !== undefined) $.ui.log(notice);
}

function flush($: EngineInterface): void {
  if (isFlushQueued) return;
  isFlushQueued = true;
  runInBackground($, "outbox", async () => {
    isFlushQueued = false;
    if (isStopped) return;
    try {
      for (let head = outbox[0]; head !== undefined; head = outbox[0]) {
        await startSidecar($);
        // A replacement sidecar whose replayed bind failed knows no session: replay it here first.
        if (needsReplay) {
          needsReplay = false;
          if (sentBinding !== undefined) outbox.unshift({ kind: "bind", binding: { ...sentBinding, source: "restart" } });
          continue;
        }
        if (head.kind === "bind") {
          await sendBind($, head.binding);
          outbox.shift();
          failures = 0;
          continue;
        }
        const barrier = outbox.findIndex((item) => item.kind === "bind");
        const batch = outbox.slice(0, Math.min(MAX_BATCH, barrier === -1 ? outbox.length : barrier)) as CaptureEntry[];
        await post($, "/capture", { entries: batch });
        outbox.splice(0, batch.length);
        failures = 0;
      }
    } catch (error) {
      failures += 1;
      if (failures >= MAX_FAILURES) {
        isStopped = true;
        $.ui.log(`LHC stopped recording this session after ${failures} failed sends to its sidecar: ${String(error)}`);
      } else if (!isRetryArmed) {
        isRetryArmed = true;
        void $.clock.sleep(RETRY_MS * failures).then(() => {
          isRetryArmed = false;
          flush($);
        });
      }
      throw error;
    }
  });
}

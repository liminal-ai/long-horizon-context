// t3code-inject: submit one prompt to a t3code thread and print the reply.
//
//   t3code-inject [--base-url URL] --thread ID [--priority] [--from SENDER]
//                 [--timeout MS] [--home DIR] [--json] "<prompt>" | -
//
// Normal priority queues per sender and waits for turn idle (see queue.ts).
// High priority sends now: busy thread = steer, idle = new turn.
// Env: T3CODE_INJECT_HOME (~/.t3code-inject), T3CODE_INJECT_BASE_URL,
// T3CODE_INJECT_CHECKOUT (/srv/work/t3code, for minting a pairing token),
// T3CODE_HOME (~/.t3code, the server's auth store), LHC_RELAY_JOB_CLASS,
// LHC_RELAY_SENDER (both set by the relay for a seat command).
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseIncoming, renderTurn, resolvePriority } from "./envelope.ts";
import { InjectQueue } from "./queue.ts";
import {
  bearerIsValid,
  exchangePairingToken,
  loadCachedAuth,
  mintPairingToken,
  saveCachedAuth,
  webSocketUrl,
} from "./t3code/auth.ts";
import { connectRpc } from "./t3code/rpc.ts";
import { ThreadTracker, now, sendTurn, turnReply, waitIdle } from "./t3code/thread.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "base-url": { type: "string", default: process.env.T3CODE_INJECT_BASE_URL ?? "http://127.0.0.1:3773" },
    thread: { type: "string" },
    priority: { type: "boolean", default: false },
    from: { type: "string" },
    timeout: { type: "string", default: "2400000" },
    home: { type: "string", default: process.env.T3CODE_INJECT_HOME ?? join(homedir(), ".t3code-inject") },
    json: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});
const log = (message: string): void => {
  process.stderr.write(`[t3code-inject ${now().slice(11, 23)}] ${message}\n`);
};
const verbose = (message: string): void => {
  if (args.verbose) log(message);
};
const fail = (message: string): never => {
  process.stderr.write(`t3code-inject: ${message}\n`);
  process.exit(1);
};

const threadId = args.thread ?? fail("--thread is required");
const rawPrompt = positionals.length === 1 && positionals[0] === "-" ? readFileSync(0, "utf8") : positionals.join(" ");
if (!rawPrompt.trim()) fail("prompt is required (last argument, or - for stdin)");
const baseUrl = args["base-url"]!.replace(/\/$/, "");
const timeoutMs = Number(args.timeout);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a positive number of ms");
const { sender, body } = parseIncoming(rawPrompt, { fromFlag: args.from ?? null, envSender: process.env.LHC_RELAY_SENDER ?? null });
const priority = resolvePriority(args.priority!, process.env.LHC_RELAY_JOB_CLASS);
const arrivedAt = now();
const deadline = Date.now() + timeoutMs;
const key = { server: baseUrl, threadId };

async function authenticate(): Promise<string> {
  mkdirSync(args.home!, { recursive: true, mode: 0o700 });
  const cachePath = join(args.home!, `auth-${baseUrl.replace(/[^a-z0-9]+/gi, "_")}.json`);
  const cached = loadCachedAuth(cachePath, baseUrl);
  if (cached && (await bearerIsValid(baseUrl, cached.bearer))) return cached.bearer;
  const checkout = process.env.T3CODE_INJECT_CHECKOUT ?? "/srv/work/t3code";
  const homeDir = process.env.T3CODE_HOME ?? join(homedir(), ".t3code");
  verbose(`no valid cached bearer; minting a pairing token via ${checkout} (T3CODE_HOME=${homeDir})`);
  const bearer = await exchangePairingToken(baseUrl, mintPairingToken({ checkout, homeDir, label: "t3code-inject" }));
  saveCachedAuth(cachePath, { httpBaseUrl: baseUrl, bearer, issuedAt: now() });
  return bearer;
}

function emit(reply: { text: string; mode: string; turnId: string | null }): void {
  if (reply.text.trim() === "") fail(`turn ${reply.turnId ?? "?"} produced no assistant text`);
  process.stdout.write(args.json ? `${JSON.stringify({ ...reply, sender, priority })}\n` : `${reply.text}\n`);
}

const opened = await (async () => {
  const bearer = await authenticate();
  const rpc = await connectRpc(await webSocketUrl(baseUrl, bearer));
  const tracker = new ThreadTracker();
  const unsubscribe = await rpc.subscribeThread(threadId, tracker.onItem, tracker.onEnd);
  await tracker.ready().catch(async (error: unknown) => {
    await rpc.close().catch(() => undefined);
    throw error;
  });
  return { bearer, rpc, tracker, unsubscribe };
})().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
const { bearer, rpc, tracker, unsubscribe } = opened;
const shutdown = async (): Promise<void> => {
  await unsubscribe().catch(() => undefined);
  await rpc.close().catch(() => undefined);
};

/** Send one rendered turn and wait for its reply. */
async function runTurn(text: string, afterSteer: boolean): Promise<{ text: string; mode: string; turnId: string }> {
  const { messageId, createdAt } = await sendTurn(rpc, threadId, text);
  verbose(`dispatched message ${messageId}`);
  const turnId = await tracker.waitForTurn(messageId, deadline - Date.now());
  const reply = await turnReply({ baseUrl, bearer, threadId, turnId, afterIso: afterSteer ? createdAt : null });
  if (reply.turnState !== null && reply.turnState !== "completed") throw new Error(`turn ${turnId} ended ${reply.turnState}`);
  return { text: reply.text, mode: reply.mode, turnId };
}

try {
  if (priority) {
    const midTurn = tracker.busy;
    log(`high priority from ${sender}: ${midTurn ? "thread busy, steering the running turn" : "thread idle, new turn"}`);
    const reply = await runTurn(renderTurn(sender, [{ body, arrivedAt }], { now: arrivedAt, midTurn }), midTurn);
    emit(reply);
  } else {
    const queue = new InjectQueue(join(args.home!, "queue.sqlite"));
    const id = queue.enqueue({ ...key, sender, body, arrivedAt, pid: process.pid });
    verbose(`queued ${id} from ${sender}`);
    for (;;) {
      const own = queue.get(id)!;
      if (own.state === "done") {
        emit({ text: own.reply ?? "", mode: "whole-turn", turnId: own.turn_id });
        break;
      }
      if (own.state === "failed") throw new Error(own.error ?? "message failed");
      if (Date.now() >= deadline) throw new Error("timed out waiting in the queue");
      if (!queue.claimDispatcher(key, process.pid, now())) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        for (const orphan of queue.failOrphans(key, now())) log(`failed orphaned message ${orphan}`);
        while (queue.get(id)!.state === "queued" && queue.hasQueued(key)) {
          await waitIdle({ tracker, baseUrl, bearer, threadId, deadline });
          const bundle = queue.takeBundle(key, process.pid, now());
          if (bundle.length === 0) break;
          const first = bundle[0]!;
          log(`dispatching ${bundle.length} message(s) from ${first.sender} as one turn`);
          try {
            const reply = await runTurn(
              renderTurn(first.sender, bundle.map((row) => ({ body: row.body, arrivedAt: row.arrived_at })), { now: now() }),
              false,
            );
            queue.settle(bundle.map((row) => row.id), { reply: reply.text, turnId: reply.turnId }, now());
          } catch (error) {
            queue.settle(bundle.map((row) => row.id), { error: error instanceof Error ? error.message : String(error) }, now());
          }
        }
      } finally {
        queue.releaseDispatcher(key, process.pid);
      }
    }
    queue.close();
  }
} catch (error) {
  await shutdown();
  fail(error instanceof Error ? error.message : String(error));
}
await shutdown();
process.exit(0);

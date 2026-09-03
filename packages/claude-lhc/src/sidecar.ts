/**
 * claude-lhc sidecar entry: JSONL frames on stdin/stdout (see protocol.ts), diagnostics
 * on stderr. Frames are handled strictly in arrival order.
 */
import { createInterface } from "node:readline";
import { decodeFrame, type DriverFrame, encodeFrame, type SidecarFrame, type SidecarRequestMethod } from "./protocol.ts";
import { ClaudeLhcSession, type SessionIO } from "./session.ts";

const write = (frame: SidecarFrame): void => {
  process.stdout.write(encodeFrame(frame));
};
const log = (line: string): void => {
  process.stderr.write(`[claude-lhc] ${line}\n`);
};

let nextRequestId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();

const io: SessionIO = {
  emit: (message) => write({ type: "msg", message }),
  request: (method: SidecarRequestMethod, params, signal) =>
    new Promise((resolve, reject) => {
      const id = ++nextRequestId;
      pending.set(id, { resolve, reject });
      write({ type: "req", id, method, params });
      signal.addEventListener("abort", () => {
        if (!pending.delete(id)) return;
        write({ type: "abort", id });
        reject(new Error("aborted"));
      }, { once: true });
    }),
  end: () => {
    void shutdown(0);
  },
  fail: (message) => {
    write({ type: "error", message });
    log(message);
    void shutdown(1);
  },
  log,
};

const session = new ClaudeLhcSession(io);
let queue: Promise<void> = Promise.resolve();
const serial = (work: () => Promise<void>): void => {
  queue = queue.then(work).catch((cause) => io.fail(cause instanceof Error ? cause.message : String(cause)));
};

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await session.close().catch(() => undefined);
  process.exit(code);
}

function handle(frame: DriverFrame): void {
  switch (frame.type) {
    case "start":
      serial(() => session.start(frame.options));
      return;
    case "user":
      serial(() => session.pushUser(frame.message));
      return;
    case "req":
      serial(async () => {
        try {
          const value = await session.control(frame.method, frame.params);
          write({ type: "res", id: frame.id, ok: true, value });
        } catch (cause) {
          write({ type: "res", id: frame.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
        }
      });
      return;
    case "res": {
      const waiter = pending.get(frame.id);
      if (waiter === undefined) return;
      pending.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.value);
      else waiter.reject(new Error(frame.error));
      return;
    }
    case "abort":
      return;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  let frame: DriverFrame | null;
  try {
    frame = decodeFrame<DriverFrame>(line);
  } catch (cause) {
    log(`unreadable frame: ${cause instanceof Error ? cause.message : String(cause)}`);
    return;
  }
  if (frame !== null) handle(frame);
});
lines.on("close", () => {
  serial(() => shutdown(0));
});
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", (cause) => io.fail(`sidecar crashed: ${cause.message}`));
process.on("unhandledRejection", (cause) => io.fail(`sidecar crashed: ${cause instanceof Error ? cause.message : String(cause)}`));

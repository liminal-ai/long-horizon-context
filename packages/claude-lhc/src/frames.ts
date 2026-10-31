import { type DriverFrame, decodeFrame, type SidecarFrame, type SidecarRequestMethod } from "./protocol.js";
import { ClaudeLhcSession, type SessionIO } from "./session.js";

export interface SidecarHost {
  write(frame: SidecarFrame): void;
  log(line: string): void;
  exit(code: number): Promise<void>;
}

export interface Sidecar {
  line(line: string): void;
  inputClosed(): void;
  shutdown(code: number): Promise<void>;
  fail(message: string): void;
}

export function createSidecar({ write, log, exit }: SidecarHost): Sidecar {
  let nextRequestId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();

  const io: SessionIO = {
    emit: (message) => write({ type: "msg", message }),
    request: (method: SidecarRequestMethod, params, signal) =>
      new Promise((resolve, reject) => {
        const id = ++nextRequestId;
        pending.set(id, { resolve, reject });
        write({ type: "req", id, method, params });
        signal.addEventListener(
          "abort",
          () => {
            if (!pending.delete(id)) return;
            write({ type: "abort", id });
            reject(new Error("aborted"));
          },
          { once: true },
        );
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
    await exit(code);
  }

  function handle(frame: DriverFrame): void {
    switch (frame.type) {
      case "start":
        serial(() => session.start(frame.options));
        return;
      case "user":
        serial(async () => session.acceptUser(frame.message));
        return;
      case "end":
        serial(async () => session.endInput());
        return;
      case "req":
        serial(async () => {
          try {
            const value = await session.control(frame.method, frame.params);
            write({ type: "res", id: frame.id, ok: true, value });
          } catch (cause) {
            write({
              type: "res",
              id: frame.id,
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
            });
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

  return {
    line(line) {
      let frame: DriverFrame | null;
      try {
        frame = decodeFrame<DriverFrame>(line);
      } catch (cause) {
        log(`unreadable frame: ${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }
      if (frame !== null) handle(frame);
    },
    inputClosed: () => serial(() => shutdown(0)),
    shutdown,
    fail: io.fail,
  };
}

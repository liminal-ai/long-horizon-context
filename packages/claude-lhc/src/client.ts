import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CONTROLS, type ControlMethod, type LhcControls } from "./controls.js";
import {
  type CanUseToolParams,
  type DriverFrame,
  decodeFrame,
  encodeFrame,
  type SidecarFrame,
  type SidecarOptions,
  type WireOptions,
} from "./protocol.js";

export interface SidecarCommand {
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export type LhcOptions = SidecarOptions & { spawn?: SidecarCommand };
export type LhcQueryOptions = Options & { lhc?: LhcOptions };
export type LhcQuery = Query & LhcControls;

const CLOSE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 5_000;

const CLIENT_OPTIONS = new Set(["abortController", "canUseTool", "onUserDialog", "stderr"]);
const DROPPED_OPTIONS = new Set([
  "hooks",
  "onElicitation",
  "sessionStore",
  "sessionStoreFlush",
  "spawnClaudeCodeProcess",
]);

export function defaultSidecarCommand(): SidecarCommand {
  return { command: process.execPath, args: [fileURLToPath(new URL("./sidecar.js", import.meta.url))] };
}

function toWireOptions(options: LhcQueryOptions, note: (line: string) => void): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (CLIENT_OPTIONS.has(key) || value === undefined) continue;
    if (DROPPED_OPTIONS.has(key) || typeof value === "function") {
      note(`options.${key} cannot cross to the sidecar and is ignored`);
      continue;
    }
    if (key === "lhc") {
      const { spawn: _spawn, ...lhc } = value as LhcOptions;
      wire[key] = lhc;
    } else if (key === "mcpServers") {
      wire[key] = wireMcpServers(value as NonNullable<Options["mcpServers"]>, note);
    } else {
      wire[key] = value;
    }
  }
  return wire;
}

function wireMcpServers(
  servers: NonNullable<Options["mcpServers"]>,
  note: (line: string) => void,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).filter(([name, server]) => {
      if (server.type !== "sdk") return true;
      note(`in-process MCP server ${name} cannot cross to the sidecar and is ignored`);
      return false;
    }),
  );
}

class MessageQueue {
  readonly #items: SDKMessage[] = [];
  #ended = false;
  #failure: Error | undefined;
  #wake: (() => void) | undefined;

  push(message: SDKMessage): void {
    if (this.#ended) return;
    this.#items.push(message);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  discard(): void {
    this.#items.length = 0;
    this.end();
  }

  fail(cause: Error): void {
    if (this.#ended) return;
    this.#failure = cause;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) {
        if (this.#failure !== undefined) throw this.#failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = undefined;
          resolve();
        };
      });
    }
  }
}

function controlParams(method: ControlMethod, args: readonly unknown[]): Record<string, unknown> {
  const row = CONTROLS[method];
  if (!("params" in row)) return {};
  return Object.fromEntries(
    row.params
      .map((param: string | { optional: string }, i) => [typeof param === "string" ? param : param.optional, args[i]])
      .filter(([, value]) => value !== undefined),
  );
}

/**
 * The Agent SDK's `query`, run through the claude-lhc sidecar. `options.lhc` is the sidecar's
 * LHC block; `options.lhc.spawn` replaces the default `node <this package>/dist/sidecar.js`.
 */
export function query({
  prompt,
  options = {},
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: LhcQueryOptions;
}): LhcQuery {
  const stderr = (line: string): void => options.stderr?.(`${line}\n`);
  const command = options.lhc?.spawn ?? defaultSidecarCommand();
  const messages = new MessageQueue();
  const pendingControls = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
  const inflightRequests = new Map<number, AbortController>();
  let nextControlId = 0;
  let closed = false;
  let stdinOpen = true;
  let unanswered = 0;
  let inputDone = false;

  const startFrame = encodeFrame({ type: "start", options: toWireOptions(options, stderr) as WireOptions });
  const child: ChildProcess = spawn(command.command, [...(command.args ?? [])], {
    stdio: ["pipe", "pipe", "pipe"],
    env: command.env ?? options.env ?? process.env,
    windowsHide: true,
  });

  const send = (frame: DriverFrame): void => {
    if (!stdinOpen || child.stdin === null || child.stdin.destroyed) throw new Error("claude-lhc sidecar is closed");
    child.stdin.write(encodeFrame(frame));
  };
  const endStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin?.end();
  };
  const failAll = (cause: Error): void => {
    for (const waiter of pendingControls.values()) waiter.reject(cause);
    pendingControls.clear();
    for (const controller of inflightRequests.values()) controller.abort();
    inflightRequests.clear();
  };

  child.on("error", (cause) => {
    stdinOpen = false;
    messages.fail(new Error(`claude-lhc sidecar failed to start (${command.command}): ${cause.message}`));
    failAll(cause);
  });
  child.on("exit", (code, signal) => {
    stdinOpen = false;
    if (closed || code === 0) messages.end();
    else messages.fail(new Error(`claude-lhc sidecar exited (code ${code ?? "null"}, signal ${signal ?? "none"})`));
    failAll(new Error("claude-lhc sidecar exited"));
  });
  child.stdin?.on("error", (cause) => stderr(`claude-lhc stdin: ${cause.message}`));
  if (child.stderr !== null) createInterface({ input: child.stderr }).on("line", stderr);

  const answerRequest = async (frame: Extract<SidecarFrame, { type: "req" }>): Promise<void> => {
    const controller = new AbortController();
    inflightRequests.set(frame.id, controller);
    try {
      let value: unknown;
      if (frame.method === "canUseTool") {
        if (options.canUseTool === undefined) throw new Error("canUseTool is not configured");
        const { toolName, input, ...rest } = frame.params as CanUseToolParams;
        value = await options.canUseTool(toolName, input, {
          ...(rest as Omit<Parameters<NonNullable<Options["canUseTool"]>>[2], "signal">),
          signal: controller.signal,
        });
      } else {
        if (options.onUserDialog === undefined) throw new Error("onUserDialog is not configured");
        const { request } = frame.params as { request: Parameters<NonNullable<Options["onUserDialog"]>>[0] };
        value = await options.onUserDialog(request, { requestId: String(frame.id), signal: controller.signal });
      }
      if (!controller.signal.aborted) send({ type: "res", id: frame.id, ok: true, value });
    } catch (cause) {
      if (!controller.signal.aborted)
        send({ type: "res", id: frame.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      inflightRequests.delete(frame.id);
    }
  };

  const onFrame = (frame: SidecarFrame): void => {
    switch (frame.type) {
      case "msg":
        if (frame.message.type === "result") {
          unanswered = Math.max(0, unanswered - 1);
          if (inputDone && unanswered === 0) endStdin();
        }
        messages.push(frame.message);
        return;
      case "req":
        void answerRequest(frame).catch(() => undefined);
        return;
      case "res": {
        const waiter = pendingControls.get(frame.id);
        if (waiter === undefined) return;
        pendingControls.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.value);
        else waiter.reject(new Error(frame.error));
        return;
      }
      case "abort":
        inflightRequests.get(frame.id)?.abort();
        return;
      case "error":
        messages.fail(new Error(frame.message));
        return;
    }
  };
  if (child.stdout !== null) {
    createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      let frame: SidecarFrame | null;
      try {
        frame = decodeFrame<SidecarFrame>(line);
      } catch (cause) {
        stderr(`claude-lhc unreadable frame: ${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }
      if (frame !== null) onFrame(frame);
    });
  }

  const control = (method: ControlMethod, args: readonly unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || !stdinOpen) {
        reject(new Error("claude-lhc sidecar is closed"));
        return;
      }
      const id = ++nextControlId;
      pendingControls.set(id, { resolve, reject });
      try {
        send({ type: "req", id, method, params: controlParams(method, args) });
      } catch (cause) {
        pendingControls.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });

  const pushUser = (message: SDKUserMessage): void => {
    if (closed) throw new Error("claude-lhc sidecar is closed");
    unanswered += 1;
    send({ type: "user", message });
  };

  const streamInput = async (stream: AsyncIterable<SDKUserMessage>): Promise<void> => {
    for await (const message of stream) {
      if (closed) return;
      pushUser(message);
    }
  };

  const endInput = (): void => {
    inputDone = true;
    if (unanswered === 0) endStdin();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    endStdin();
    const term = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }, CLOSE_GRACE_MS).unref();
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CLOSE_GRACE_MS + KILL_GRACE_MS).unref();
    child.once("exit", () => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    messages.discard();
  };

  options.abortController?.signal.addEventListener("abort", close, { once: true });
  if (options.abortController?.signal.aborted) close();
  else {
    child.stdin?.write(startFrame);
    if (typeof prompt === "string") {
      pushUser({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
      endInput();
    } else {
      streamInput(prompt).then(endInput, (cause) => {
        messages.fail(cause instanceof Error ? cause : new Error(String(cause)));
        close();
      });
    }
  }

  const controls = Object.fromEntries(
    (Object.keys(CONTROLS) as ControlMethod[])
      .filter((method) => CONTROLS[method].kind !== "transport")
      .map((method) => [method, (...args: unknown[]) => control(method, args)]),
  );
  const iterator = messages[Symbol.asyncIterator]();
  const handle = {
    ...controls,
    next: () => iterator.next(),
    return: async () => {
      close();
      return iterator.return();
    },
    throw: async (cause: unknown) => {
      close();
      return iterator.throw(cause);
    },
    [Symbol.asyncIterator]: () => handle,
    streamInput,
    close,
  };
  return handle as unknown as LhcQuery;
}

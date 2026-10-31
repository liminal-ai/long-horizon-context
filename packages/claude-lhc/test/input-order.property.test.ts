import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test, vi } from "vitest";
import { ClaudeLhcSession } from "../src/session.ts";

interface Turn {
  id: number;
  labels: string[];
  uuids: string[];
  stage: "begin" | "tool" | "stopped" | "finish";
  heavy: boolean;
  tool: boolean;
}

interface FakeCli {
  options: Options;
  sessionId: string;
  input: AsyncIterator<SDKUserMessage>;
  pulling: boolean;
  pulled: SDKUserMessage[];
  turn: Turn | null;
  closed: boolean;
  emit(message: SDKMessage): void;
}

const clis: FakeCli[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    renameSession: async () => {},
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const queued: SDKMessage[] = [];
      let wake: (() => void) | null = null;
      const cli: FakeCli = {
        options,
        sessionId: options.sessionId ?? options.resume ?? randomUUID(),
        input: prompt[Symbol.asyncIterator](),
        pulling: false,
        pulled: [],
        turn: null,
        closed: false,
        emit(message) {
          queued.push(message);
          wake?.();
        },
      };
      clis.push(cli);
      const base = {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<SDKMessage>> => {
            for (;;) {
              const message = queued.shift();
              if (message !== undefined) return { value: message, done: false };
              if (cli.closed) return { value: undefined, done: true };
              await new Promise<void>((resolve) => (wake = resolve));
            }
          },
        }),
        getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
        close: () => {
          cli.closed = true;
          wake?.();
        },
      };
      return new Proxy(base, {
        get: (target, key) => (key in target ? target[key as keyof typeof target] : async () => undefined),
      });
    },
  };
});

const CONTINUATION = "Context was compacted in the middle of this turn";
const COMPACT = { trigger: 50_000, target: 20_000 };
const RUNS = Number(process.env.INPUT_ORDER_RUNS ?? 60);

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const textOf = (message: SDKUserMessage): string => {
  const content = message.message.content;
  return typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
};

const assistant = (cli: FakeCli, content: unknown[], heavy: boolean): SDKMessage =>
  ({
    type: "assistant",
    uuid: randomUUID(),
    session_id: cli.sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg_${randomUUID()}`,
      model: "claude-sonnet-5",
      role: "assistant",
      content,
      usage: { input_tokens: heavy ? 60_000 : 1_000, output_tokens: 10 },
    },
  }) as unknown as SDKMessage;

const result = (cli: FakeCli, text: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: text,
    uuid: randomUUID(),
    session_id: cli.sessionId,
    ...extra,
  }) as unknown as SDKMessage;

const lifecycle = (cli: FakeCli, uuid: string | undefined, state: string): SDKMessage =>
  ({
    type: "command_lifecycle",
    command_uuid: uuid,
    state,
    uuid: randomUUID(),
    session_id: cli.sessionId,
  }) as unknown as SDKMessage;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Run {
  seed: number;
  inputs: string[];
  frames: SDKMessage[];
  ended: boolean;
  failed: string | null;
  actions: string[];
  problems: string[];
  promptsDuringCompact: number;
  midTurnStops: number;
  steersSent: number;
  steersFolded: number;
  dueWithQueued: number;
  severalHeldInOneCompact: number;
  pendingAutoSends: Array<{ input: number; sentAt: number }>;
  compactsBehindHeld: number;
  started: string[];
}

async function runOnce(seed: number): Promise<Run> {
  const random = prng(seed);
  const dir = mkdtempSync(join(tmpdir(), "claude-lhc-input-order-"));
  clis.length = 0;
  const inputs = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, i) =>
    random() < 0.35 ? "/compact" : `P${i}`,
  );
  const run: Run = {
    seed,
    inputs,
    frames: [],
    ended: false,
    failed: null,
    actions: [],
    problems: [],
    promptsDuringCompact: 0,
    midTurnStops: 0,
    steersSent: 0,
    steersFolded: 0,
    dueWithQueued: 0,
    severalHeldInOneCompact: 0,
    pendingAutoSends: [],
    compactsBehindHeld: 0,
    started: [],
  };
  const heavyRate = random() < 0.5 ? 0.6 : 0.2;
  const host = (["eager", "slow", "during compacts", "during turns"] as const)[Math.floor(random() * 4)];
  const statusAt = (): number[] =>
    run.frames.flatMap((m, i) => ((m as { subtype?: string }).subtype === "status" ? [i] : []));
  const compactingSince = (): number | null => {
    const last = statusAt().at(-1);
    return last !== undefined && (run.frames[last] as { status?: string }).status === "compacting" ? last : null;
  };
  const stops: number[] = [];
  const compactingMidTurn = (): boolean => {
    const since = compactingSince();
    if (since === null) return false;
    const before = statusAt().at(-2) ?? -1;
    return stops.some((at) => at > before && at <= since);
  };
  const lastIndex = (match: (m: SDKMessage) => boolean): number => {
    for (let i = run.frames.length - 1; i >= 0; i--) if (match(run.frames[i] as SDKMessage)) return i;
    return -1;
  };
  const autoCompactPending = (): boolean => {
    const reading = lastIndex((m) => m.type === "assistant");
    const usage = (run.frames[reading] as { message?: { usage?: { input_tokens: number } } } | undefined)?.message
      ?.usage;
    return (
      usage !== undefined &&
      usage.input_tokens >= COMPACT.trigger &&
      reading > lastIndex((m) => m.type === "system" && m.subtype === "compact_boundary")
    );
  };
  const heldBy = new Map<number, number>();
  const held = new Set<number>();
  const heldMidTurn = new Set<number>();
  const steerTurn = new Map<string, number>();
  let turns = 0;
  let stoppedLabels: string[] = [];
  let serial: Promise<void> = Promise.resolve();
  const frame = (work: () => Promise<void>): void => {
    serial = serial.then(work).catch((cause) => {
      run.failed ??= cause instanceof Error ? cause.message : String(cause);
    });
  };
  const session = new ClaudeLhcSession({
    emit: (message) => run.frames.push(message),
    request: async () => ({ behavior: "allow" }),
    end: () => {
      run.ended = true;
    },
    fail: (message) => {
      run.failed ??= message;
    },
    log: (line) => {
      if (process.env.INPUT_ORDER_DEBUG !== undefined) console.log(`[seed ${seed}] ${line.slice(0, 160)}`);
    },
  });
  await session.start({
    cwd: dir,
    model: "claude-sonnet-5",
    env: { CLAUDE_CONFIG_DIR: join(dir, "claude") },
    lhc: { home: join(dir, "lhc"), compact: COMPACT },
    sessionId: randomUUID(),
  });

  const live = (): FakeCli | undefined => clis.filter((cli) => !cli.closed).at(-1);
  let sent = 0;
  let endSent = false;

  const step = async (cli: FakeCli): Promise<void> => {
    if (cli.turn === null) {
      const next = cli.pulled.shift();
      if (next === undefined) return;
      const text = textOf(next);
      cli.emit(lifecycle(cli, next.uuid, "started"));
      trace(`cli ${clis.indexOf(cli)} starts ${text.slice(0, 30)}`);
      if (!text.includes(CONTINUATION)) run.started.push(text);
      cli.turn = {
        id: ++turns,
        labels: text.includes(CONTINUATION) ? stoppedLabels : [text],
        uuids: [next.uuid ?? ""],
        stage: "begin",
        heavy: random() < heavyRate,
        tool: random() < 0.6,
      };
    }
    const turn = cli.turn;
    if (turn.stage === "begin") {
      cli.emit(assistant(cli, [{ type: "text", text: `working on ${turn.labels.join("+")}` }], turn.heavy));
      turn.stage = turn.tool ? "tool" : "finish";
      return;
    }
    if (turn.stage === "tool") {
      const toolUseId = `toolu_${randomUUID()}`;
      cli.emit(assistant(cli, [{ type: "tool_use", id: toolUseId, name: "Read", input: {} }], turn.heavy));
      await settle();
      const hook = cli.options.hooks?.PostToolUse?.[0]?.hooks[0] as HookCallback;
      const answer = await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_input: {},
          tool_response: "",
          tool_use_id: toolUseId,
        } as never,
        toolUseId,
        { signal: new AbortController().signal },
      );
      if (turn.heavy && cli.pulled.length > 0) run.dueWithQueued += 1;
      if ((answer as { continue?: boolean }).continue === false) {
        stops.push(run.frames.length);
        stoppedLabels = turn.labels;
        run.midTurnStops += 1;
        turn.stage = "stopped";
        return;
      }
      // Like the CLI, it starts queued prompts with the tool result, after PostToolUse.
      if (random() < 0.5)
        for (const steer of cli.pulled.splice(0)) {
          cli.emit(lifecycle(cli, steer.uuid, "started"));
          run.started.push(textOf(steer));
          trace(`cli ${clis.indexOf(cli)} folds ${textOf(steer)}`);
          turn.labels.push(textOf(steer));
          turn.uuids.push(steer.uuid ?? "");
          if (steerTurn.get(textOf(steer)) === turn.id) run.steersFolded += 1;
        }
      turn.stage = random() < 0.5 ? "tool" : "finish";
      return;
    }
    if (turn.stage === "stopped") {
      if (random() < 0.7) return;
      cli.turn = null;
      cli.emit(result(cli, "", { terminal_reason: "hook_stopped" }));
      for (const uuid of turn.uuids) cli.emit(lifecycle(cli, uuid, "completed"));
      return;
    }
    cli.emit(assistant(cli, [{ type: "text", text: `answer:${turn.labels.join("+")}` }], turn.heavy));
    if (turn.heavy && cli.pulled.length > 0) run.dueWithQueued += 1;
    cli.turn = null;
    cli.emit(result(cli, `answer:${turn.labels.join("+")}`));
    for (const uuid of turn.uuids) cli.emit(lifecycle(cli, uuid, "completed"));
  };

  const trace = (what: string): void => {
    if (process.env.INPUT_ORDER_DEBUG !== undefined) console.log(`[seed ${seed}] ${what}`);
  };
  // A prompt is held when it is sent during a compact or behind a /compact that has no result yet. A
  // steer is any other prompt sent while a CLI turn runs.
  const sendOne = (): void => {
    const input = sent++;
    const text = inputs[input] as string;
    const since = compactingSince();
    const answered = answeredInputs(run.frames).length;
    const behind = inputs.slice(answered, input).includes("/compact");
    if (text === "/compact") {
      if ([...heldMidTurn].some((prompt) => prompt >= answered)) run.compactsBehindHeld += 1;
    } else if (since !== null) {
      held.add(input);
      run.promptsDuringCompact += 1;
      heldBy.set(input, since);
      if ([...heldBy.values()].filter((at) => at === since).length === 2) run.severalHeldInOneCompact += 1;
      if (compactingMidTurn()) heldMidTurn.add(input);
    } else if (behind) held.add(input);
    else if (live()?.turn != null) {
      run.steersSent += 1;
      steerTurn.set(text, live()?.turn?.id ?? 0);
      if (autoCompactPending()) run.pendingAutoSends.push({ input, sentAt: run.frames.length });
    }
    send(text);
  };
  // As the sidecar does, the frame starts the push and lets the next frame through.
  const send = (text: string): void => {
    frame(async () => {
      void session
        .pushUser({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })
        .catch((cause) => {
          run.failed ??= cause instanceof Error ? cause.message : String(cause);
        });
    });
  };

  const actions = (): Array<[string, () => Promise<void>]> => {
    const out: Array<[string, () => Promise<void>]> = [];
    const cli = live();
    const idle = cli === undefined || (cli.turn === null && cli.pulled.length === 0);
    const typing =
      host === "eager" ||
      (host === "slow" && random() < 0.4) ||
      (host === "during compacts" && (compactingSince() !== null || (idle && random() < 0.3))) ||
      (host === "during turns" &&
        (cli?.turn?.stage === "stopped" ||
          (cli?.turn != null && compactingSince() === null && random() < 0.25) ||
          (idle && (sent === 0 || random() < 0.05))));
    if (sent < inputs.length && typing) out.push(["send", async () => sendOne()]);
    const burst: [string, () => Promise<void>] = [
      "burst",
      async () => {
        for (let n = 2 + Math.floor(random() * 2); n > 0 && sent < inputs.length; n--) sendOne();
      },
    ];
    if (inputs.length - sent >= 2 && typing) out.push(burst);
    if (sent >= inputs.length && !endSent)
      out.push([
        "end",
        async () => {
          endSent = true;
          frame(async () => session.endInput());
        },
      ]);
    if (cli !== undefined && !cli.pulling)
      out.push([
        "pull",
        async () => {
          cli.pulling = true;
          void cli.input.next().then((next) => {
            if (!next.done) {
              const text = textOf(next.value);
              if (held.has(inputs.indexOf(text)) && (cli.turn !== null || cli.pulled.length > 0))
                run.problems.push(`${text}, held for a compact, reached a CLI that was still busy`);
              cli.pulled.push(next.value);
              cli.emit(lifecycle(cli, next.value.uuid, "queued"));
            }
            cli.pulling = false;
          });
        },
      ]);
    if (cli !== undefined && (cli.turn !== null || cli.pulled.length > 0)) out.push(["step", () => step(cli)]);
    return out;
  };

  try {
    let idle = 0;
    while (!run.ended && run.failed === null && idle < 150) {
      const pick = actions();
      if (pick.length === 0) {
        idle += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      const [name, act] = pick[Math.floor(random() * pick.length)] as [string, () => Promise<void>];
      const before = run.frames.length;
      run.actions.push(name);
      await act();
      await settle();
      if (name === "pull" && run.frames.length === before) {
        idle += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else idle = 0;
    }
    await serial;
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return run;
}

const boundaryTrigger = (message: SDKMessage): string | null =>
  message.type === "system" && message.subtype === "compact_boundary"
    ? (message as unknown as { compact_metadata: { trigger: string } }).compact_metadata.trigger
    : null;

// Each result answers its own input, or, for a steer the CLI folded into a running turn, shares that
// turn's result. Each answered input carries the index of the frame that answered it.
function answeredInputs(frames: readonly SDKMessage[]): Array<{ input: string; at: number }> {
  return frames.flatMap((message, at) => {
    if (message.type !== "result") return [];
    const text = String((message as unknown as { result: unknown }).result);
    return (text === "" ? ["/compact"] : text.replace(/^answer:/, "").split("+")).map((input) => ({ input, at }));
  });
}

// An answered prompt sent while an automatic compact was pending, whose answer came after an automatic swap.
const answeredAcrossAutoSwap = (run: Run): number => {
  const answers = answeredInputs(run.frames);
  return run.pendingAutoSends.filter(({ input, sentAt }) => {
    const answeredAt = answers[input]?.at ?? -1;
    return run.frames.some((m, i) => i >= sentAt && i < answeredAt && boundaryTrigger(m) === "auto");
  }).length;
};

function violations(run: Run): string[] {
  const out: string[] = [...run.problems];
  const answers = answeredInputs(run.frames);
  const answered = answers.map(({ input }) => input);
  const results = run.frames.flatMap((m) =>
    m.type === "result" ? [String((m as unknown as { result: unknown }).result)] : [],
  );
  run.frames.forEach((message, i) => {
    if (boundaryTrigger(message) !== "manual") return;
    const pending = answers.filter(({ at }) => at < i).length;
    if (run.inputs[pending] !== "/compact")
      out.push(`a /compact ran while input ${pending} (${run.inputs[pending]}) had no result`);
  });
  if (run.failed !== null) out.push(`sidecar failed: ${run.failed}`);
  if (!run.ended) out.push(`the session never ended after end (results ${JSON.stringify(results)})`);
  if (JSON.stringify(answered) !== JSON.stringify(run.inputs))
    out.push(`results ${JSON.stringify(results)} for inputs ${JSON.stringify(run.inputs)}`);
  const prompts = run.inputs.filter((input) => input !== "/compact");
  if (JSON.stringify(run.started) !== JSON.stringify(prompts))
    out.push(`the CLIs started ${JSON.stringify(run.started)}, not the send order ${JSON.stringify(prompts)}`);
  return out;
}

test("every input is answered in input order, a steer may share its turn's result, and a /compact runs only after every earlier input is answered", async () => {
  const savedNoInference = process.env.CLAUDE_LHC_NO_INFERENCE;
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
  const failures: Array<{ seed: number; inputs: string[]; problems: string[]; actions: string }> = [];
  const seen = {
    midTurnStops: 0,
    autoBoundaries: 0,
    manualBoundaries: 0,
    promptsDuringCompact: 0,
    steersSent: 0,
    steersFolded: 0,
    dueWithQueued: 0,
    severalHeldInOneCompact: 0,
    promptsAcrossPendingAutoSwap: 0,
    compactsBehindHeld: 0,
  };
  try {
    const base = Number(process.env.INPUT_ORDER_SEED ?? 1);
    for (let seed = base; seed < base + RUNS; seed++) {
      const run = await runOnce(seed);
      const problems = violations(run);
      const boundaries = run.frames.map(boundaryTrigger);
      seen.midTurnStops += run.midTurnStops;
      seen.autoBoundaries += boundaries.filter((t) => t === "auto").length;
      seen.manualBoundaries += boundaries.filter((t) => t === "manual").length;
      seen.promptsDuringCompact += run.promptsDuringCompact;
      seen.steersSent += run.steersSent;
      seen.steersFolded += run.steersFolded;
      seen.dueWithQueued += run.dueWithQueued;
      seen.severalHeldInOneCompact += run.severalHeldInOneCompact;
      seen.promptsAcrossPendingAutoSwap += answeredAcrossAutoSwap(run);
      seen.compactsBehindHeld += run.compactsBehindHeld;
      if (problems.length > 0) failures.push({ seed, inputs: run.inputs, problems, actions: run.actions.join(" ") });
    }
  } finally {
    if (savedNoInference === undefined) delete process.env.CLAUDE_LHC_NO_INFERENCE;
    else process.env.CLAUDE_LHC_NO_INFERENCE = savedNoInference;
  }
  if (process.env.INPUT_ORDER_REPORT !== undefined)
    writeFileSync(process.env.INPUT_ORDER_REPORT, `${JSON.stringify({ runs: RUNS, seen, failures }, null, 2)}\n`);
  expect(failures.slice(0, 5)).toEqual([]);
  expect(
    Object.values(seen).every((count) => count > 0),
    JSON.stringify(seen),
  ).toBe(true);
}, 600_000);

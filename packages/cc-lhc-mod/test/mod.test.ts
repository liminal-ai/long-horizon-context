import type { On, SessionContextBreakdown } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";

const HOME = "/lhc-test-home";
/** The mod log line applySettings writes once the override is set and the panel has the policy. */
const APPLIED = / window \d+ trigger \d+ target \d+ pct /;

type Post = { path: string; body: unknown; socketPath: string | undefined };

/** A person's prompt row, which the mod captures as one entry. */
const promptRow = ($: Engine, uuid: string) =>
  $.session.append({
    message: { type: "user", role: "user", content: [{ type: "text", text: uuid }] },
    door: "prompt",
    origin: { kind: "composer" },
    uuid,
  });
type Sent = { sessionId: string; uuid?: string; turnId?: string };
type Body = { sessionId: string; source: string; entries: Sent[] };

function engine(on: On, window: number, answers: Record<string, string> = {}) {
  const posts: Post[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const envSets: Array<{ name: string; value: string | undefined }> = [];
  let applies = 0;
  const applyWaiters = new Map<number, () => void>();
  const settingsApplied = (count = 1): Promise<void> =>
    new Promise((resolve) => {
      if (applies >= count) resolve();
      else applyWaiters.set(count, resolve);
    });

  on("env.get", (_, e) => ({ value: e.name === "LHC_HOME" ? HOME : undefined }));
  on("env.set", (_, e) => {
    envSets.push({ name: e.name, value: e.value });
    return { value: {} };
  });
  on("fs.write", () => ({ value: undefined }));
  on("ui.log", (_, e) => {
    if (e.to !== "debug") notices.push(e.text);
    if (APPLIED.test(e.text)) applyWaiters.get(++applies)?.();
    if (e.text === "sidecar exited") sidecarExited();
    return { value: undefined };
  });
  let statusShown: () => void = () => {};
  const shown = new Promise<void>((resolve) => {
    statusShown = resolve;
  });
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    statusShown();
    return { value: undefined };
  });
  on("session.id", () => ({ value: "session-1" }));
  on("session.model", () => ({ value: "claude-sonnet-5-5" }));
  on("session.usage", () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, breakdown: { rawMaxTokens: window } as SessionContextBreakdown },
      rateLimits: [],
    },
  }));
  let sidecarExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    sidecarExited = resolve;
  });
  let killFirstChild: () => void = () => {};
  const firstChildKilled = new Promise<void>((resolve) => {
    killFirstChild = resolve;
  });
  let spawns = 0;
  on("process.spawn", async function* (_, e) {
    const home = e.argv[e.argv.indexOf("--home") + 1];
    const id = e.argv[e.argv.indexOf("--id") + 1];
    const isFirst = spawns++ === 0;
    yield { stream: "stdout", text: `listening ${home}/run/${id}.sock\n` };
    await (isFirst ? firstChildKilled : new Promise(() => {}));
    return { value: { code: 0, signal: null } };
  });
  let openCapture: () => void = () => {};
  const captureOpen = new Promise<void>((resolve) => {
    openCapture = resolve;
  });
  const captureWaiters: Array<{ count: number; resolve: () => void }> = [];
  const capturedEntries = (): number =>
    posts.filter((post) => post.path === "/capture").flatMap((post) => (post.body as { entries: unknown[] }).entries)
      .length;
  const captured = (count: number): Promise<void> =>
    new Promise((resolve) => {
      if (capturedEntries() >= count) resolve();
      else captureWaiters.push({ count, resolve });
    });
  const bindWaiters: Array<{ count: number; resolve: () => void }> = [];
  const binds = (): number => posts.filter((post) => post.path === "/bind").length;
  const bound = (count: number): Promise<void> =>
    new Promise((resolve) => {
      if (binds() >= count) resolve();
      else bindWaiters.push({ count, resolve });
    });
  on("http.fetch", async (_, e) => {
    const path = new URL(e.url).pathname;
    if (path === "/capture") await captureOpen;
    posts.push({ path, body: JSON.parse(e.init?.body ?? "null"), socketPath: e.init?.socketPath });
    for (const waiter of captureWaiters) if (capturedEntries() >= waiter.count) waiter.resolve();
    for (const waiter of bindWaiters) if (binds() >= waiter.count) waiter.resolve();
    return { value: { status: 200, ok: true, headers: {}, text: answers[path] ?? "{}" } };
  });
  on("classic.SessionStart", () => ({}));

  return {
    posts,
    envSets,
    settingsApplied,
    killFirstChild,
    exited,
    openCapture,
    captured,
    bound,
    statuses,
    shown,
    notices,
  };
}

test("bind posts the session id and transcript path to the sidecar socket", async ($, on) => {
  const { posts, settingsApplied } = engine(on, 1_000_000);

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();

  const bind = posts.find((post) => post.path === "/bind");
  expect(bind?.body).toEqual({ sessionId: "session-1", transcriptPath: "/t/session-1.jsonl", source: "startup" });
  expect(bind?.socketPath).toMatch(/^\/lhc-test-home\/run\/[a-z0-9]+\.sock$/);
});

test("a bind shows the thread the session records to, and why it is not the one it had", async ($, on) => {
  const answer = { threadId: "th_new", how: "replaced", notice: "LHC thread th_old is not adopted." };
  const { statuses, notices, settingsApplied } = engine(on, 1_000_000, { "/bind": JSON.stringify(answer) });

  await $.classic.SessionStart({ source: "resume", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();

  expect(statuses).toEqual(["thread th_new (replaced)"]);
  expect(notices).toEqual(["LHC thread th_old is not adopted."]);
});

test("a fork shows its copied thread once its first rows are captured", async ($, on) => {
  const { statuses, shown, openCapture } = engine(on, 1_000_000, {
    "/capture": JSON.stringify({ recorded: 4, threadId: "th_fork", how: "forked" }),
  });

  await $.classic.SessionStart({ source: "fork", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  openCapture();
  const prompt = { type: "user" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };
  await $.session.append({ message: prompt, door: "prompt", origin: { kind: "composer" }, uuid: "row-1" });
  await shown;

  expect(statuses).toEqual(["thread th_fork (forked)"]);
});

test("applySettings sets the override for a 1M window", async ($, on) => {
  const { envSets, settingsApplied } = engine(on, 1_000_000);

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();

  expect(envSets).toEqual([{ name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "81.63265306122449" }]);
});

test(
  "applySettings follows the compact window and the user's settings",
  { options: { compactPercent: 40, lowerBound: 20_000 } },
  async ($, on) => {
    const { envSets, settingsApplied } = engine(on, 100_000);

    await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
    await settingsApplied();

    expect(envSets).toEqual([{ name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "50" }]);
  },
);

test("a replacement sidecar gets the session's binding before anything else", async ($, on) => {
  const { posts, settingsApplied, killFirstChild, exited, openCapture, bound } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  openCapture();

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  killFirstChild();
  await exited;
  await promptRow($, "row-2");
  await bound(2);

  const afterRestart = posts.slice(posts.findIndex((post) => post.path === "/bind") + 1);
  expect(afterRestart.map((post) => post.path)[0]).toBe("/bind");
  expect(afterRestart[0]?.body).toEqual({
    sessionId: "session-1",
    transcriptPath: "/t/session-1.jsonl",
    source: "restart",
  });
});

test("a replacement sidecar is rebound as a fork, so it still copies the source", async ($, on) => {
  const { posts, settingsApplied, killFirstChild, exited, openCapture, bound } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  openCapture();

  await $.classic.SessionStart({ source: "fork", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  killFirstChild();
  await exited;
  await promptRow($, "row-1");
  await bound(2);

  expect(posts.filter((post) => post.path === "/bind").map((post) => (post.body as Body).source)).toEqual([
    "fork",
    "fork",
  ]);
});

test("a fork whose thread is open is rebound as a plain restart, so its running turn survives", async ($, on) => {
  const { posts, settingsApplied, killFirstChild, exited, openCapture, bound, shown } = engine(on, 1_000_000, {
    "/capture": JSON.stringify({ recorded: 1, threadId: "th_fork", how: "forked" }),
  });
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  const stored: unknown[] = [];
  on("state.set", (_, e) => {
    stored.push((e as { value?: unknown }).value);
    return { value: { isSet: true, version: stored.length } };
  });
  openCapture();

  await $.classic.SessionStart({ source: "fork", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  const prompt = { type: "user" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };
  await $.session.append({ message: prompt, door: "prompt", origin: { kind: "composer" }, uuid: "row-1" });
  await shown;
  killFirstChild();
  await exited;
  await promptRow($, "row-2");
  await bound(2);

  expect(posts.filter((post) => post.path === "/bind").map((post) => (post.body as Body).source)).toEqual([
    "fork",
    "restart",
  ]);
  const bindings = stored.filter((value) => (value as { sessionId?: unknown }).sessionId !== undefined);
  expect(bindings.map((value) => (value as Body).source)).toEqual(["fork", "restart"]);
});

test("a command a plugin runs opens no turn, so the person's next prompt opens its own", async ($, on) => {
  const { posts, settingsApplied, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  const text = (value: string) => ({
    type: "user" as const,
    role: "user" as const,
    content: [{ type: "text" as const, text: value }],
  });
  // The LHC panel's /compact, as Claude Code 2.1.317 raises it: by the prompt door, from the plugin, run as an engine turn.
  await $.session.append({
    message: text("/compact"),
    door: "prompt",
    origin: { kind: "plugin", name: "lhc" },
    uuid: "row-compact",
  });
  await $.turn.start({ text: "/compact", turnId: "turn-2" });
  await $.session.append({
    message: text("next prompt"),
    door: "prompt",
    origin: { kind: "composer" },
    uuid: "row-next",
  });
  await $.turn.start({ text: "next prompt", turnId: "turn-3" });

  openCapture();
  await captured(3);
  const sent = posts
    .filter((post) => post.path === "/capture")
    .flatMap((post) => (post.body as { entries: Array<{ kind: string; uuid?: string; turnId?: string }> }).entries);
  expect(sent.map((entry) => `${entry.kind} ${entry.uuid ?? entry.turnId ?? ""}`)).toEqual([
    "row row-compact",
    "row row-next",
    "turn-start row-next",
  ]);
});

test("capture hooks queue rows and turn steps in order and never wait on the sidecar", async ($, on) => {
  const { posts, settingsApplied, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  const prompt = { type: "user" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };
  await $.session.append({ message: prompt, door: "prompt", origin: { kind: "composer" }, uuid: "row-1" });
  await $.turn.start({ text: "hi", turnId: "turn-1" });
  await $.session.append({
    message: prompt,
    door: "note",
    origin: { kind: "composer" },
    uuid: "row-2",
    agentId: "sub-1",
  });
  await $.turn.complete({ turnId: "turn-1", reason: "answer", answer: "", durationMs: 1, isAborted: false });
  expect(posts.filter((post) => post.path === "/capture")).toEqual([]);

  openCapture();
  await captured(3);
  const sent = posts
    .filter((post) => post.path === "/capture")
    .flatMap((post) => (post.body as { entries: Array<{ kind: string; uuid?: string; sessionId: string }> }).entries);
  expect(sent.map((entry) => `${entry.kind} ${entry.uuid ?? ""}`.trim())).toEqual([
    "row row-1",
    "turn-start",
    "turn-end",
  ]);
  expect(sent.every((entry) => entry.sessionId === "session-1")).toBe(true);
});

test("a new session's bind reaches the sidecar before any of that session's rows", async ($, on) => {
  const { posts, settingsApplied, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  await promptRow($, "turn-1");
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/session-2.jsonl" });
  await promptRow($, "turn-2");
  openCapture();
  await captured(2);

  const order = posts.map((post) =>
    post.path === "/bind"
      ? `bind ${(post.body as { sessionId: string }).sessionId}`
      : `capture ${(post.body as { entries: Array<{ sessionId: string }> }).entries.map((entry) => entry.sessionId).join(",")}`,
  );
  expect(order).toEqual(["bind session-1", "capture session-1", "bind session-2", "capture session-2"]);
});

test("an old-session flush queued behind a capture cannot pass the new session's bind", async ($, on) => {
  const { posts, settingsApplied, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  await promptRow($, "turn-1");
  await $.session.append({
    message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "old extra" }] },
    door: "response",
    origin: { kind: "model", model: "claude-opus-5-5" },
    uuid: "old-extra",
  });
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/session-2.jsonl" });
  await promptRow($, "turn-2");
  openCapture();
  await captured(3);
  await settingsApplied(2);
  const order = posts.map((p) =>
    p.path === "/bind"
      ? `bind ${(p.body as { sessionId: string }).sessionId}`
      : `capture ${(p.body as { entries: Array<{ sessionId: string }> }).entries.map((e) => e.sessionId).join(",")}`,
  );
  expect(order).toEqual([
    "bind session-1",
    "capture session-1",
    "capture session-1",
    "bind session-2",
    "capture session-2",
  ]);
});

function faultEngine(on: On, opts: { rejectRestart?: boolean; captures400?: number } = {}) {
  const requests: Array<{ path: string; body: Body; bound: string | undefined; status: number }> = [];
  const accepted: string[] = [];
  let current: string | undefined;
  let exits = 0;
  let sleeps = 0;
  let captureFailures = opts.captures400 ?? 0;
  let releaseCapture = () => {};
  const firstCaptureGate = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  let attempts = 0;
  const waiters: Array<{ test: () => boolean; resolve: () => void }> = [];
  const signal = () => {
    for (const w of waiters) if (w.test()) w.resolve();
  };
  const until = (test: () => boolean) =>
    test() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ test, resolve }));
  const kills: Array<() => void> = [];
  on("env.get", (_, e) => ({ value: e.name === "LHC_HOME" ? HOME : undefined }));
  on("env.set", () => ({ value: {} }));
  on("fs.write", () => ({ value: undefined }));
  const notices: string[] = [];
  let applies = 0;
  on("ui.log", (_, e) => {
    if (APPLIED.test(e.text)) {
      applies++;
      signal();
    }
    if (JSON.stringify(e).includes("sidecar exited")) {
      exits++;
      signal();
    }
    if (e.to !== "debug") {
      notices.push(e.text);
      signal();
    }
    return { value: undefined };
  });
  on("clock.sleep", () => (++sleeps <= 10 ? { value: undefined } : new Promise(() => {})));
  on("session.id", () => ({ value: "session-1" }));
  on("session.model", () => ({ value: "claude-sonnet-5-5" }));
  on("session.usage", () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, breakdown: { rawMaxTokens: 1_000_000 } as SessionContextBreakdown },
      rateLimits: [],
    },
  }));
  on("classic.SessionStart", () => ({}));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("process.spawn", async function* (_, e) {
    const home = e.argv[e.argv.indexOf("--home") + 1],
      id = e.argv[e.argv.indexOf("--id") + 1];
    const dead = new Promise<void>((resolve) => kills.push(resolve));
    current = undefined;
    yield { stream: "stdout", text: `listening ${home}/run/${id}.sock\n` };
    await dead;
    return { value: { code: 0, signal: null } };
  });
  on("http.fetch", async (_, e) => {
    const path = new URL(e.url).pathname,
      body = JSON.parse(e.init?.body ?? "null") as Body;
    let status = 200;
    if (path === "/capture") {
      attempts++;
      signal();
      if (attempts === 1) await firstCaptureGate;
      if (captureFailures-- > 0) status = 400;
      else if (body.entries.some((x) => x.sessionId !== current)) status = 400;
      if (status === 200) accepted.push(...body.entries.map((x) => `${x.sessionId}:${x.uuid ?? x.turnId}`));
    }
    if (path === "/bind") {
      if (body.source === "restart" && opts.rejectRestart) {
        status = 400;
        opts.rejectRestart = false;
      } else current = body.sessionId;
    }
    requests.push({ path, body, bound: current, status });
    signal();
    return {
      value: {
        status,
        ok: status === 200,
        headers: {},
        text: status === 200 ? "{}" : '{"error":"injected single failure"}',
      },
    };
  });
  return {
    requests,
    accepted,
    notices,
    until,
    releaseCapture,
    kill: async () => {
      const n = exits;
      kills.at(-1)?.();
      await until(() => exits > n);
    },
    attempts: () => attempts,
    applies: () => applies,
  };
}

test("round2: capture 400 retains the same entries and retries before clear and resume binds", async ($, on) => {
  const f = faultEngine(on, { captures400: 1 });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await f.until(() => f.applies() > 0);
  await promptRow($, "old");
  await f.until(() => f.attempts() === 1);
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/2" });
  await promptRow($, "new");
  await $.classic.SessionStart({ source: "resume", session_id: "session-1", transcript_path: "/t/1" });
  await promptRow($, "resume");
  f.releaseCapture();
  await f.until(() => f.accepted.length === 3);
  expect(f.accepted).toEqual(["session-1:old", "session-2:new", "session-1:resume"]);
  expect(f.requests.filter((r) => r.path === "/capture").map((r) => r.status)).toEqual([400, 200, 200, 200]);
});

test("round2: replacement during pending old capture rebinds old session before clear and resume", async ($, on) => {
  const f = faultEngine(on, { captures400: 1 });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await f.until(() => f.applies() > 0);
  await promptRow($, "old");
  await f.until(() => f.attempts() === 1);
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/2" });
  await promptRow($, "new");
  await $.classic.SessionStart({ source: "resume", session_id: "session-1", transcript_path: "/t/1" });
  await promptRow($, "resume");
  await f.kill();
  f.releaseCapture();
  await f.until(() => f.accepted.length === 3);
  const bindings = f.requests.filter((r) => r.path === "/bind").map((r) => `${r.body.sessionId}:${r.body.source}`);
  expect(bindings).toEqual(["session-1:startup", "session-1:restart", "session-2:clear", "session-1:resume"]);
  expect(f.accepted).toEqual(["session-1:old", "session-2:new", "session-1:resume"]);
  expect(
    f.requests
      .filter((r) => r.path === "/capture" && r.status === 200)
      .every((r) => r.body.entries.every((x) => x.sessionId === r.bound)),
  ).toBe(true);
});

test("round2: a rejected replacement bind must be retried before any capture is acknowledged", async ($, on) => {
  const f = faultEngine(on, { rejectRestart: true });
  f.releaseCapture();
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await f.until(() => f.applies() > 0);
  await f.kill();
  await promptRow($, "after-death");
  await f.until(() => f.requests.filter((r) => r.path === "/capture").length >= 3 || f.accepted.length === 1);

  expect(f.accepted).toEqual(["session-1:after-death"]);
});

test("round2: replacement replays last sent bind while a different clear bind is pending", async ($, on) => {
  const f = faultEngine(on, { captures400: 1 });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await f.until(() => f.applies() > 0);
  await promptRow($, "old");
  await f.until(() => f.attempts() === 1);
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/2" });
  await promptRow($, "new");
  await f.kill();
  f.releaseCapture();
  await f.until(() => f.accepted.length === 2 || f.requests.filter((r) => r.path === "/capture").length >= 3);
  expect(f.requests.filter((r) => r.path === "/bind").map((r) => `${r.body.sessionId}:${r.body.source}`)).toEqual([
    "session-1:startup",
    "session-1:restart",
    "session-2:clear",
  ]);
  expect(f.accepted).toEqual(["session-1:old", "session-2:new"]);
});

test("capture stops with one visible notice after repeated failed sends", async ($, on) => {
  const f = faultEngine(on, { captures400: 100 });
  f.releaseCapture();
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await promptRow($, "first");
  await f.until(() => f.notices.some((text) => text.includes("stopped recording")));
  await promptRow($, "second");

  expect(f.notices.filter((text) => text.includes("stopped recording"))).toHaveLength(1);
  expect(f.attempts()).toBe(5);
  expect(f.accepted).toEqual([]);
});

test("turn markers name the turn by the row that opened it, and a turn with none sends no markers", async ($, on) => {
  const { posts, settingsApplied, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  openCapture();

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settingsApplied();
  const prompt = { type: "user" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };
  await $.session.append({ message: prompt, door: "prompt", origin: { kind: "composer" }, uuid: "prompt-row" });
  await $.turn.start({ text: "hi", turnId: "engine-turn" });
  await $.turn.complete({ turnId: "engine-turn", reason: "answer", answer: "", durationMs: 1, isAborted: false });
  await $.turn.start({ text: "", turnId: "continuation" });
  await $.turn.complete({ turnId: "continuation", reason: "answer", answer: "", durationMs: 1, isAborted: false });
  await captured(3);

  const markers = posts
    .filter((post) => post.path === "/capture")
    .flatMap((post) => (post.body as { entries: Array<{ kind: string; turnId?: string }> }).entries)
    .filter((entry) => entry.kind !== "row")
    .map((entry) => `${entry.kind} ${entry.turnId}`);
  expect(markers).toEqual(["turn-start prompt-row", "turn-end prompt-row"]);
});

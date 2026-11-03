import type { On, SessionContextBreakdown } from "claude-code";
import { expect, test } from "claude-code/testing";

const HOME = "/lhc-test-home";

type Post = { path: string; body: unknown; socketPath: string | undefined };
type Sent = { sessionId: string; uuid?: string; turnId?: string };
type Body = { sessionId: string; source: string; entries: Sent[] };

function engine(on: On, window: number) {
  const posts: Post[] = [];
  const envSets: Array<{ name: string; value: string | undefined }> = [];
  const policyWaiters = new Map<number, () => void>();
  const sawPolicy = (count: number): void => policyWaiters.get(count)?.();
  const policyPosted = (count = 1): Promise<void> =>
    new Promise((resolve) => {
      if (posts.filter((post) => post.path === "/policy").length >= count) resolve();
      else policyWaiters.set(count, resolve);
    });

  on("env.get", (_, e) => ({ value: e.name === "LHC_HOME" ? HOME : undefined }));
  on("env.set", (_, e) => {
    envSets.push({ name: e.name, value: e.value });
    return { value: {} };
  });
  on("fs.write", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("session.id", () => ({ value: "session-1" }));
  let model = "claude-sonnet-5-5";
  const switchModel = (next: string): void => {
    model = next;
  };
  on("session.model", () => ({ value: model }));
  on("session.usage", () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, breakdown: { rawMaxTokens: window } as SessionContextBreakdown },
      rateLimits: [],
    },
  }));
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
  on("http.fetch", async (_, e) => {
    const path = new URL(e.url).pathname;
    if (path === "/capture") await captureOpen;
    posts.push({ path, body: JSON.parse(e.init?.body ?? "null"), socketPath: e.init?.socketPath });
    for (const waiter of captureWaiters) if (capturedEntries() >= waiter.count) waiter.resolve();
    if (path === "/policy") sawPolicy(posts.filter((post) => post.path === "/policy").length);
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  on("classic.SessionStart", () => ({}));

  return { posts, envSets, policyPosted, killFirstChild, switchModel, openCapture, captured };
}

test("bind posts the session id and transcript path to the sidecar socket", async ($, on) => {
  const { posts, policyPosted } = engine(on, 1_000_000);

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted();

  const bind = posts.find((post) => post.path === "/bind");
  expect(bind?.body).toEqual({ sessionId: "session-1", transcriptPath: "/t/session-1.jsonl", source: "startup" });
  expect(bind?.socketPath).toMatch(/^\/lhc-test-home\/run\/[a-z0-9]+\.sock$/);
});

test("applySettings sets the override for a 1M window", async ($, on) => {
  const { posts, envSets, policyPosted } = engine(on, 1_000_000);

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted();

  expect(envSets).toEqual([{ name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "81.63265306122449" }]);
  expect(posts.find((post) => post.path === "/policy")?.body).toEqual({
    window: 1_000_000,
    trigger: 800_000,
    target: 140_000,
  });
});

test(
  "applySettings follows the compact window and the user's settings",
  { options: { compactPercent: 40, lowerBound: 20_000 } },
  async ($, on) => {
    const { envSets, policyPosted } = engine(on, 100_000);

    await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
    await policyPosted();

    expect(envSets).toEqual([{ name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "50" }]);
  },
);

test("a replacement sidecar gets the session's binding before anything else", async ($, on) => {
  const { posts, policyPosted, killFirstChild, switchModel, openCapture } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  openCapture();

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted();
  killFirstChild();
  switchModel("claude-opus-5-5");
  await $.turn.start({ text: "next prompt", turnId: "turn-2" });
  await policyPosted(2);

  const afterRestart = posts
    .slice(posts.findIndex((post) => post.path === "/policy") + 1)
    .filter((post) => post.path !== "/capture");
  expect(afterRestart.map((post) => post.path)).toEqual(["/bind", "/policy"]);
  expect(afterRestart[0]?.body).toEqual({
    sessionId: "session-1",
    transcriptPath: "/t/session-1.jsonl",
    source: "restart",
  });
});

test("capture hooks queue rows and turn steps in order and never wait on the sidecar", async ($, on) => {
  const { posts, policyPosted, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted();
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
  const { posts, policyPosted, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted();
  await $.turn.start({ text: "hi", turnId: "turn-1" });
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/session-2.jsonl" });
  await $.turn.start({ text: "after clear", turnId: "turn-2" });
  openCapture();
  await captured(2);

  const order = posts
    .filter((post) => post.path !== "/policy")
    .map((post) =>
      post.path === "/bind"
        ? `bind ${(post.body as { sessionId: string }).sessionId}`
        : `capture ${(post.body as { entries: Array<{ sessionId: string }> }).entries.map((entry) => entry.sessionId).join(",")}`,
    );
  expect(order).toEqual(["bind session-1", "capture session-1", "bind session-2", "capture session-2"]);
});

test("an old-session flush queued behind a capture cannot pass the new session's bind", async ($, on) => {
  const { posts, policyPosted, openCapture, captured } = engine(on, 1_000_000);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted();
  await $.turn.start({ text: "first", turnId: "turn-1" });
  await $.session.append({
    message: { type: "assistant", role: "assistant", content: [{ type: "text", text: "old extra" }] },
    door: "response",
    origin: { kind: "model", model: "claude-opus-5-5" },
    uuid: "old-extra",
  });
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/session-2.jsonl" });
  await $.turn.start({ text: "new", turnId: "turn-2" });
  openCapture();
  await captured(3);
  await policyPosted(2);
  const order = posts
    .filter((p) => p.path !== "/policy")
    .map((p) =>
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
  on("ui.log", (_, e) => {
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
  };
}

test("round2: capture 400 retains the same entries and retries before clear and resume binds", async ($, on) => {
  const f = faultEngine(on, { captures400: 1 });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await f.until(() => f.requests.some((r) => r.path === "/policy"));
  await $.turn.start({ text: "old", turnId: "old" });
  await f.until(() => f.attempts() === 1);
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/2" });
  await $.turn.start({ text: "new", turnId: "new" });
  await $.classic.SessionStart({ source: "resume", session_id: "session-1", transcript_path: "/t/1" });
  await $.turn.start({ text: "resume", turnId: "resume" });
  f.releaseCapture();
  await f.until(() => f.accepted.length === 3);
  expect(f.accepted).toEqual(["session-1:old", "session-2:new", "session-1:resume"]);
  expect(f.requests.filter((r) => r.path === "/capture").map((r) => r.status)).toEqual([400, 200, 200, 200]);
});

test("round2: replacement during pending old capture rebinds old session before clear and resume", async ($, on) => {
  const f = faultEngine(on, { captures400: 1 });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await f.until(() => f.requests.some((r) => r.path === "/policy"));
  await $.turn.start({ text: "old", turnId: "old" });
  await f.until(() => f.attempts() === 1);
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/2" });
  await $.turn.start({ text: "new", turnId: "new" });
  await $.classic.SessionStart({ source: "resume", session_id: "session-1", transcript_path: "/t/1" });
  await $.turn.start({ text: "resume", turnId: "resume" });
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
  await f.until(() => f.requests.some((r) => r.path === "/policy"));
  await f.kill();
  await $.turn.start({ text: "after death", turnId: "after-death" });
  await f.until(() => f.requests.filter((r) => r.path === "/capture").length >= 3 || f.accepted.length === 1);

  expect(f.accepted).toEqual(["session-1:after-death"]);
});

test("round2: replacement replays last sent bind while a different clear bind is pending", async ($, on) => {
  const f = faultEngine(on, { captures400: 1 });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/1" });
  await f.until(() => f.requests.some((r) => r.path === "/policy"));
  await $.turn.start({ text: "old", turnId: "old" });
  await f.until(() => f.attempts() === 1);
  await $.classic.SessionStart({ source: "clear", session_id: "session-2", transcript_path: "/t/2" });
  await $.turn.start({ text: "new", turnId: "new" });
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
  await $.turn.start({ text: "first", turnId: "first" });
  await f.until(() => f.notices.some((text) => text.includes("stopped recording")));
  await $.turn.start({ text: "second", turnId: "second" });

  expect(f.notices.filter((text) => text.includes("stopped recording"))).toHaveLength(1);
  expect(f.attempts()).toBe(5);
  expect(f.accepted).toEqual([]);
});

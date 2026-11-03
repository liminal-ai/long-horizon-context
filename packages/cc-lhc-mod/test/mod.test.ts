import type { On, SessionContextBreakdown } from "claude-code";
import { expect, test } from "claude-code/testing";

const HOME = "/lhc-test-home";

type Post = { path: string; body: unknown; socketPath: string | undefined };

function engine(on: On, window: number) {
  const posts: Post[] = [];
  const envSets: Array<{ name: string; value: string | undefined }> = [];
  let sawPolicy: () => void = () => {};
  const policyPosted = new Promise<void>((resolve) => {
    sawPolicy = resolve;
  });

  on("env.get", (_, e) => ({ value: e.name === "LHC_HOME" ? HOME : undefined }));
  on("env.set", (_, e) => {
    envSets.push({ name: e.name, value: e.value });
    return { value: {} };
  });
  on("fs.write", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("session.id", () => ({ value: "session-1" }));
  on("session.model", () => ({ value: "claude-sonnet-5-5" }));
  on("session.usage", () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, breakdown: { rawMaxTokens: window } as SessionContextBreakdown },
      rateLimits: [],
    },
  }));
  on("process.spawn", async function* (_, e) {
    const home = e.argv[e.argv.indexOf("--home") + 1];
    const id = e.argv[e.argv.indexOf("--id") + 1];
    yield { stream: "stdout", text: `listening ${home}/run/${id}.sock\n` };
    await new Promise(() => {});
  });
  on("http.fetch", (_, e) => {
    const path = new URL(e.url).pathname;
    posts.push({ path, body: JSON.parse(e.init?.body ?? "null"), socketPath: e.init?.socketPath });
    if (path === "/policy") sawPolicy();
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  on("classic.SessionStart", () => ({}));

  return { posts, envSets, policyPosted };
}

test("bind posts the session id and transcript path to the sidecar socket", async ($, on) => {
  const { posts, policyPosted } = engine(on, 1_000_000);

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted;

  const bind = posts.find((post) => post.path === "/bind");
  expect(bind?.body).toEqual({ sessionId: "session-1", transcriptPath: "/t/session-1.jsonl", source: "startup" });
  expect(bind?.socketPath).toMatch(/^\/lhc-test-home\/run\/[a-z0-9]+\.sock$/);
});

test("applySettings sets the override for a 1M window", async ($, on) => {
  const { posts, envSets, policyPosted } = engine(on, 1_000_000);

  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await policyPosted;

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
    await policyPosted;

    expect(envSets).toEqual([{ name: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value: "50" }]);
  },
);

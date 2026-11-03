import type { On, SessionContextBreakdown } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const WINDOW = 1_000_000;
const VIEW = { kind: "view", isMidTurn: false, viewTokens: 120_000, messages: [{ role: "user", text: "the view", toolUses: [] }] };
const CONTEXT = 300_000;

type Post = { path: string; body: Record<string, unknown> };

const NOTHING_TO_PRUNE = { kind: "unchanged", reason: "no older tool output is left to shorten" };

type Answers = { compact?: Record<string, unknown>; prune?: Record<string, unknown>; idle?: Promise<void> };

function engine($: Engine, on: On, { compact = VIEW, prune = NOTHING_TO_PRUNE, idle }: Answers = {}) {
  const clock = mock.clock(on);
  const posts: Post[] = [];
  const envSets: string[] = [];
  const configSets: Array<{ key: string; value: unknown }> = [];
  const toasts: string[] = [];
  const applied: Array<Record<string, number>> = [];
  const policies = (): Array<Record<string, number>> => applied;
  const settled = async (count: number): Promise<void> => {
    await clock.settle();
    expect(policies()).toHaveLength(count);
  };

  on("env.get", (_, e) => ({ value: e.name === "LHC_HOME" ? "/lhc-test-home" : undefined }));
  on("env.set", (_, e) => {
    envSets.push(e.value ?? "");
    return { value: {} };
  });
  on("fs.write", () => ({ value: undefined }));
  on("ui.log", (_, e) => {
    const line = / window (\d+) trigger (\d+) target (\d+) pct /.exec(e.text);
    if (line !== null) applied.push({ window: Number(line[1]), trigger: Number(line[2]), target: Number(line[3]) });
    return { value: undefined };
  });
  on("ui.status", () => ({ value: undefined }));
  on("ui.toast", (_, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.panes", () => ({ value: [] }));
  on("session.id", () => ({ value: "session-1" }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  let context = CONTEXT;
  const setContext = (tokens: number): void => {
    context = tokens;
  };
  on("session.usage", () => ({
    value: {
      startedAt: 0,
      context: {
        window: WINDOW,
        tokens: context,
        breakdown: {
          rawMaxTokens: WINDOW,
          totalTokens: context,
          categories: [
            { name: "System prompt", kind: "used", tokens: 15_000 },
            { name: "Messages", kind: "used", tokens: context - 15_000 },
          ],
        } as SessionContextBreakdown,
      },
      rateLimits: [],
    },
  }));
  on("process.spawn", async function* (_, e) {
    const home = e.argv[e.argv.indexOf("--home") + 1];
    const id = e.argv[e.argv.indexOf("--id") + 1];
    yield { stream: "stdout", text: `listening ${home}/run/${id}.sock\n` };
    await new Promise(() => {});
    return { value: { code: 0, signal: null } };
  });
  const answered: string[] = [];
  on("http.fetch", async (_, e) => {
    const path = new URL(e.url).pathname;
    const body = JSON.parse(e.init?.body ?? "{}") as Record<string, unknown>;
    posts.push({ path, body });
    if (path === "/capture") await clock.sleep(50);
    answered.push(path);
    const answers: Record<string, unknown> = {
      "/bind": { threadId: "th_panel", how: "new" },
      "/health": { recording: { kind: "recording", threadId: "th_panel", how: "new" }, derivations: { ready: 7, pending: 2, failed: 1, blocked: 0 } },
      "/export": { path: "/lhc-test-home/exports/th_panel.json", turns: 3 },
      "/compact": body.op === "prune" ? prune : compact,
    };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers[path] ?? {}) } };
  });
  on("config.set", (_, e) => {
    configSets.push({ key: e.key, value: e.value });
    return { value: e.value };
  });
  const installs: number[] = [];
  // Core's /compact: queued until the session is idle, then it raises session.compact, which the mod answers.
  on("command.run", async (_, e) => {
    if (e.command !== "compact") return { text: `unknown command ${e.command}` };
    await idle;
    const result = await $.session.compact({ trigger: "manual", messages: [] });
    if (result.messages !== undefined) installs.push(result.messages.length);
    return { text: result.skip ?? "Compacted" };
  });
  on("classic.SessionStart", () => ({}));
  // Core's own summary, which a fallback hands to: it refuses a conversation this short.
  on("session.compact", () => ({ skip: "Not enough messages to compact." }));

  const compactOps = (): unknown[] => posts.filter((post) => post.path === "/compact").map((post) => post.body.op);
  return { posts, answered, envSets, configSets, toasts, policies, settled, clock, installs, compactOps, setContext };
}

const typed = { origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } } as const;
const lhc = (args = "") => ({ command: "lhc", args, ...typed });
const autoCompact = (value: boolean) => ({
  key: "autoCompact",
  value,
  previous: !value,
  provider: { plugin: "engine", tier: "core" },
  origin: { kind: "composer" },
}) as const;

const pane = (surface: "terminal" | "desktop") =>
  ({
    plugin: "lhc",
    component: "Pane",
    requestId: "lhc",
    surface,
    props: {
      title: "LHC",
      isFocused: true,
      bodyColumns: surface === "terminal" ? 52 : 120,
      placement: surface === "terminal" ? "dock" : "inline",
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const;

for (const surface of ["terminal", "desktop"] as const) {
  test(`the pane shows live numbers, and its buttons and fields act on ${surface}`, async ($, on) => {
    const { posts, envSets, configSets, policies, settled, clock } = engine($, on);
    await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
    await settled(1);
    await $.command.run(lhc());
    await clock.settle();
    expect(posts.some((post) => post.path === "/health")).toBe(true);

    const ui = await $.ui.mount(pane(surface));
    const shown = async (pattern: RegExp): Promise<string | undefined> => (await ui.find({ type: "Text", text: pattern }))?.text;
    expect(await shown(/of 800k trigger/)).toMatch(/300k of 800k trigger/);
    expect(await shown(/^\d+%$/)).toBe("38%");
    expect(await shown(/Compacts at/)).toMatch(/Compacts at 800k, back to 140k · 1M window/);
    expect(await shown(/ready/)).toMatch(/7 ready · 2 pending · 1 failed/);
    expect(await shown(/th_panel/)).toBe("th_panel");

    await ui.press({ key: "compact" });
    expect(posts.find((post) => post.path === "/compact")?.body).toMatchObject({ sessionId: "session-1", op: "compact", target: 140_000 });
    expect(await shown(/✓/)).toBe("✓ Compacted 300k to 135k.");
    expect(await shown(/by LHC/)).toBe("300k → 135k by LHC");
    expect(await shown(/of \d+k trigger/)).toMatch(/135k of 800k trigger/);

    await ui.press({ key: "prune" });
    expect(posts.filter((post) => post.path === "/compact").at(-1)?.body).toMatchObject({ op: "prune" });
    expect(await shown(/✓/)).toBe("✓ Nothing to prune: no older tool output is left to shorten.");
    expect(await shown(/by LHC/)).toBe("300k → 135k by LHC");

    await ui.press({ key: "export" });
    expect(posts.find((post) => post.path === "/export")?.body).toEqual({ sessionId: "session-1" });
    expect(await shown(/✓/)).toBe("✓ Exported 3 turns to /lhc-test-home/exports/th_panel.json");

    await ui.input({ key: "upperBound", text: "600k" });
    await settled(2);
    expect(policies().at(-1)).toEqual({ window: WINDOW, trigger: 600_000, target: 140_000 });
    expect(envSets.at(-1)).toBe("61.224489795918366");
    expect(await shown(/Compacts at/)).toMatch(/Compacts at 600k, back to 140k/);

    await ui.input({ key: "lowerBound", text: "100000" });
    await settled(3);
    expect(policies().at(-1)).toEqual({ window: WINDOW, trigger: 600_000, target: 100_000 });

    await ui.input({ key: "compactPercent", text: "50" });
    await settled(4);
    expect(policies().at(-1)).toEqual({ window: WINDOW, trigger: 500_000, target: 100_000 });
    expect(configSets).toEqual([
      { key: "lhc.upperBound", value: 600_000 },
      { key: "lhc.lowerBound", value: 100_000 },
      { key: "lhc.compactPercent", value: 50 },
    ]);

    await ui.input({ key: "upperBound", text: "800" });
    expect(await shown(/✗/)).toBe("✗ The upper bound is at least 10k tokens, not 800. For thousands, add k: 800k");
    await ui.input({ key: "upperBound", text: "lots" });
    expect(await shown(/✗/)).toBe('✗ The upper bound is a whole number of tokens such as 600000 or 600k, not "lots"');
    expect(policies()).toHaveLength(4);
    await ui.unmount();
  });
}

test("/lhc subcommands answer from the prompt", async ($, on) => {
  const { posts, configSets, policies, settled, clock } = engine($, on);
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);

  const status = (await $.command.run(lhc("status"))).text ?? "";
  expect(status).toContain("context 300k of 800k (38%) · thread th_panel (new)");
  expect(status).toContain("Derivations: 7 ready, 2 pending, 1 failed, 0 blocked.");
  expect((await $.command.run(lhc("compact"))).text).toBe("LHC compacts once this command ends.");
  await clock.advance(1);
  expect(posts.filter((post) => post.path === "/compact").map((post) => post.body.op)).toEqual(["compact"]);
  expect((await $.command.run(lhc("status"))).text).toContain("Last compact just now (manual): compacted 300k to 135k (settled).");
  expect((await $.command.run(lhc("export"))).text).toBe("Exported 3 turns to /lhc-test-home/exports/th_panel.json");
  expect((await $.command.run(lhc("bounds 150k 700k 85"))).text).toBe(
    "Saved lower bound 150k, upper bound 700k, compact percent 85%.",
  );
  await settled(2);
  expect(policies().at(-1)).toEqual({ window: WINDOW, trigger: 700_000, target: 150_000 });
  expect(configSets).toHaveLength(3);
  expect((await $.command.run(lhc("bounds 1"))).text).toMatch(/^Usage: \/lhc/);
});

test("turning off auto-compact warns that LHC stops compacting", async ($, on) => {
  const { toasts } = engine($, on);
  await $.config.set(autoCompact(false));
  expect(toasts).toEqual([expect.stringMatching(/^Auto-compact is off, so LHC stops compacting/)]);
  await $.config.set(autoCompact(true));
  expect(toasts).toHaveLength(1);
});

test("Prune pressed while Compact now still runs waits its turn and stays a prune", async ($, on) => {
  const { posts, policies, settled } = engine($, on);
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  await $.command.run(lhc());
  const ui = await $.ui.mount(pane("terminal"));
  await Promise.all([ui.press({ key: "compact" }), ui.press({ key: "prune" })]);
  expect(posts.filter((post) => post.path === "/compact").map((post) => post.body.op)).toEqual(["compact", "prune"]);
  expect((await ui.find({ type: "Text", text: /✓/ }))?.text).toBe("✓ Nothing to prune: no older tool output is left to shorten.");
  expect(policies()).toHaveLength(1);
  await ui.unmount();
});

test("a fallback that Claude Code refuses is reported as not compacted, not as a summary", async ($, on) => {
  const { settled } = engine($, on, { compact: { kind: "native", reason: "the sidecar is down" } });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  await $.command.run(lhc());
  const ui = await $.ui.mount(pane("desktop"));
  await ui.press({ key: "compact" });
  expect((await ui.find({ type: "Text", text: /✗/ }))?.text).toBe("✗ Not enough messages to compact.");
  expect((await ui.find({ type: "Text", text: /None since/ }))?.text).toBe("None since Claude Code started.");
  await ui.unmount();
});

test("export waits for queued capture, so the file holds the newest rows", async ($, on) => {
  const { answered, settled, clock } = engine($, on);
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  await $.command.run(lhc());
  const ui = await $.ui.mount(pane("terminal"));
  const prompt = { type: "user" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };
  await $.session.append({ message: prompt, door: "prompt", origin: { kind: "composer" }, uuid: "row-1" });
  const pressed = ui.press({ key: "export" });
  await clock.advance(100);
  await pressed;
  expect(answered.filter((path) => path === "/capture" || path === "/export")).toEqual(["/capture", "/export"]);
  await ui.unmount();
});

test("Prune pressed during a turn leaves that turn's auto-compact a compact, and prunes once the turn ends", async ($, on) => {
  let endTurn: () => void = () => {};
  const idle = new Promise<void>((resolve) => {
    endTurn = resolve;
  });
  const { settled, clock, compactOps } = engine($, on, { idle });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  await $.command.run(lhc());
  const ui = await $.ui.mount(pane("terminal"));
  const pressed = ui.press({ key: "prune" });
  await clock.settle();
  await $.session.compact({ trigger: "auto", messages: [] });
  expect(compactOps()).toEqual(["compact"]);
  endTurn();
  await clock.settle();
  await pressed;
  expect(compactOps()).toEqual(["compact", "prune"]);
  await ui.unmount();
});

test("a prune the sidecar answers with a view is installed and reported with its sizes", async ($, on) => {
  const nearTrigger = { kind: "view", isMidTurn: false, viewTokens: 190_000, messages: [{ role: "user", text: "pruned", toolUses: [] }] };
  const { settled, installs } = engine($, on, { prune: nearTrigger });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  await $.command.run(lhc("bounds 140k 200k 90"));
  await settled(2);
  await $.command.run(lhc());
  const ui = await $.ui.mount(pane("terminal"));
  await ui.press({ key: "prune" });
  expect(installs).toEqual([1]);
  expect((await ui.find({ type: "Text", text: /✓/ }))?.text).toBe("✓ Pruned 300k to 205k.");
  await ui.unmount();
});

test("a prune core refuses shows as not pruned, never as nothing to prune", async ($, on) => {
  const { settled, installs } = engine($, on, { prune: { kind: "native", reason: "core prune refused: storage_failure: disk full" } });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  await $.command.run(lhc());
  const ui = await $.ui.mount(pane("desktop"));
  await ui.press({ key: "prune" });
  expect(installs).toEqual([]);
  expect((await ui.find({ type: "Text", text: /✗/ }))?.text).toBe("✗ LHC did not prune: core prune refused: storage_failure: disk full.");
  await ui.unmount();
});

test("a refresh reads the context Claude Code counts now, not the last figure the pane drew", async ($, on) => {
  const { settled, setContext } = engine($, on);
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  expect((await $.command.run(lhc("status"))).text).toContain("context 300k of 800k (38%)");
  setContext(460_000);
  expect((await $.command.run(lhc("status"))).text).toContain("context 460k of 800k (57%)");
});

test("Prune sends the same no-reduction guard as a compaction, and a refused prune shows as not pruned", async ($, on) => {
  const refused = { kind: "native", reason: "its view of 190k plus 15k of fixed context would not get below the 200k trigger" };
  const { settled, installs, posts } = engine($, on, { prune: refused });
  await $.classic.SessionStart({ source: "startup", session_id: "session-1", transcript_path: "/t/session-1.jsonl" });
  await settled(1);
  await $.command.run(lhc());
  const ui = await $.ui.mount(pane("terminal"));
  await ui.press({ key: "prune" });
  expect(posts.find((post) => post.path === "/compact")?.body).toMatchObject({ op: "prune", guard: { trigger: 800_000, fixed: 15_000 } });
  expect(installs).toEqual([]);
  expect((await ui.find({ type: "Text", text: /✗/ }))?.text).toBe(`✗ LHC did not prune: ${refused.reason}.`);
  await ui.unmount();
});


import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ drain: vi.fn(), post: vi.fn(), policy: vi.fn(), log: vi.fn() }));
vi.mock("../../mod/hooks/sidecar.ts", () => ({
  boundSession: () => "s",
  drainOutbox: calls.drain,
  post: calls.post,
  log: calls.log,
}));
vi.mock("../../mod/hooks/policy.ts", () => ({ currentPolicy: calls.policy }));

import { registerCompact } from "../../mod/hooks/compact.ts";

type Handler = (
  engine: unknown,
  e: unknown,
  next: unknown,
) => Promise<{ tokensAfter?: number } & Record<string, unknown>>;
type On = Parameters<typeof registerCompact>[0];

beforeEach(() => {
  vi.clearAllMocks();
  calls.drain.mockResolvedValue(true);
});
function setup(fixed: number, trigger = 800000, target = 140000, view = 140000) {
  calls.policy.mockResolvedValue({ window: 1000000, trigger, target, pct: 81.63, isClamped: false });
  calls.post.mockResolvedValue({
    kind: "view",
    messages: [{ role: "user", text: "helpful view", toolUses: [] }],
    isMidTurn: false,
    viewTokens: view,
  });
  let handler: Handler = async () => ({});
  registerCompact(((_event: string, fn: Handler) => {
    handler = fn;
  }) as unknown as On);
  const engine = {
    session: {
      usage: vi.fn(async () => ({
        context: {
          tokens: 810000,
          breakdown: {
            totalTokens: 810000,
            categories: [
              { name: "System prompt", kind: "used", tokens: fixed / 3 },
              { name: "System tools", kind: "used", tokens: (fixed * 2) / 3 },
              { name: "Messages", kind: "used", tokens: 810000 - fixed },
              { name: "Free space", kind: "free", tokens: 100000 },
              { name: "Autocompact buffer", kind: "reserved", tokens: 20000 },
            ],
          },
        },
      })),
    },
    ui: { log: vi.fn(), status: vi.fn() },
  };
  const next = vi.fn(async () => ({ native: true }));
  return { handler, engine, next };
}
it.each([18000, 24000, 30000])("1M defaults accept helpful 140k view with %i fixed context", async (fixed) => {
  const h = setup(fixed);
  const r = await h.handler(h.engine, { trigger: "auto" }, h.next);
  expect(r.tokensAfter).toBe(140000);
  expect(h.next).not.toHaveBeenCalled();
  expect(calls.log.mock.calls.some((x) => x[1] === `fixed context ${fixed}`)).toBe(true);
});
it("the guard falls back when the view plus fixed context reaches trigger", async () => {
  const h = setup(24000, 800000, 140000, 776000);
  expect(await h.handler(h.engine, { trigger: "auto" }, h.next)).toEqual({ native: true });
  expect(h.next).toHaveBeenCalledOnce();
});
it("refusal never latches: the next helpful view is accepted", async () => {
  const h = setup(30000, 60000, 12000, 35000);
  for (let i = 0; i < 3; i++) expect(await h.handler(h.engine, { trigger: "auto" }, h.next)).toEqual({ native: true });
  calls.post.mockResolvedValue({
    kind: "view",
    messages: [{ role: "user", text: "smaller view", toolUses: [] }],
    isMidTurn: false,
    viewTokens: 12000,
  });
  expect((await h.handler(h.engine, { trigger: "auto" }, h.next)).tokensAfter).toBe(12000);
  expect(h.next).toHaveBeenCalledTimes(3);
});

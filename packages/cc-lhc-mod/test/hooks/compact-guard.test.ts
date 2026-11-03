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
it.each([18000, 24000, 30000])("sends the trigger and %i of fixed context for the sidecar's guard", async (fixed) => {
  const h = setup(fixed);
  const r = await h.handler(h.engine, { trigger: "auto" }, h.next);
  expect(r.tokensAfter).toBe(140000);
  expect(calls.post.mock.calls[0]?.[2]).toMatchObject({ guard: { trigger: 800000, fixed } });
  expect(calls.log.mock.calls.some((x) => x[1] === `fixed context ${fixed}`)).toBe(true);
});
it("a guard refusal from the sidecar falls back to native", async () => {
  const h = setup(24000);
  calls.post.mockResolvedValue({
    kind: "native",
    reason: "its view of 776k plus 24k of fixed context would not get below the 800k trigger",
  });
  expect(await h.handler(h.engine, { trigger: "auto" }, h.next)).toEqual({ native: true });
  expect(h.next).toHaveBeenCalledOnce();
});

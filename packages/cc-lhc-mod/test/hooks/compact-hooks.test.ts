import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  drain: vi.fn(),
  post: vi.fn(),
  policy: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../mod/hooks/sidecar.ts", () => ({
  boundSession: () => "session-a",
  drainOutbox: calls.drain,
  post: calls.post,
  log: calls.log,
}));
vi.mock("../../mod/hooks/policy.ts", () => ({ currentPolicy: calls.policy }));

import { checkPressureOnce, registerCompact } from "../../mod/hooks/compact.ts";

type Handler = (
  engine: unknown,
  e: unknown,
  next: unknown,
) => Promise<{ tokensAfter?: number } & Record<string, unknown>>;
type On = Parameters<typeof registerCompact>[0];
type Engine = Parameters<typeof checkPressureOnce>[0];

const policy = { window: 100_000, trigger: 30_000, target: 10_000, pct: 37.5, isClamped: false };
beforeEach(() => {
  vi.clearAllMocks();
  calls.drain.mockResolvedValue(true);
  calls.policy.mockResolvedValue(policy);
});
function hook() {
  let handler: Handler = async () => ({});
  registerCompact(((_event: string, fn: Handler) => {
    handler = fn;
  }) as unknown as On);
  const notices: string[] = [];
  const statuses: string[] = [];
  const engine = {
    session: { usage: vi.fn(async () => ({ context: { tokens: 32_000, breakdown: { totalTokens: 32_000 } } })) },
    ui: { log: (s: string) => notices.push(s), status: (s: string) => statuses.push(s) },
  };
  const next = vi.fn(async () => ({ native: true }));
  return { handler, engine, notices, statuses, next };
}
it("main compact drains before dispatch and returns built messages", async () => {
  const h = hook();
  const order: string[] = [];
  calls.drain.mockImplementation(async () => {
    order.push("drain");
    return true;
  });
  const messages = [{ role: "user", text: "request from record", toolUses: [] }];
  calls.post.mockImplementation(async () => {
    order.push("compact");
    return { kind: "view", messages, isMidTurn: true, viewTokens: 12_000 };
  });
  const result = await h.handler(h.engine, { trigger: "manual", instructions: "keep the plan" }, h.next);
  expect(order).toEqual(["drain", "compact"]);
  expect(result).toEqual({ messages, tokensBefore: 32_000, tokensAfter: 12_000 });
  expect(h.notices.some((s) => s.includes("not applied"))).toBe(true);
  expect(h.next).not.toHaveBeenCalled();
  await checkPressureOnce(h.engine as unknown as Engine, policy);
  expect(h.notices.some((s) => s.includes("right after compacting"))).toBe(true);
  const count = h.notices.length;
  await checkPressureOnce(h.engine as unknown as Engine, policy);
  expect(h.notices).toHaveLength(count);
});
it.each(["capture", "sidecar", "core"])("%s failure delegates to native with a notice", async (failure) => {
  const h = hook();
  if (failure === "capture") calls.drain.mockResolvedValue(false);
  if (failure === "sidecar") calls.post.mockRejectedValue(new Error("sidecar unavailable"));
  if (failure === "core") calls.post.mockResolvedValue({ kind: "native", reason: "core refused" });
  const event = { trigger: "auto" };
  expect(await h.handler(h.engine, event, h.next)).toEqual({ native: true });
  expect(h.next).toHaveBeenCalledWith(event);
  expect(h.notices.some((s) => s.includes("own summary runs instead"))).toBe(true);
});
it("precompute is skipped and subagent manual compaction passes through", async () => {
  const h = hook();
  expect(await h.handler(h.engine, { trigger: "precompute" }, h.next)).toHaveProperty("skip");
  const sub = { trigger: "manual", agentId: "sub-a" };
  expect(await h.handler(h.engine, sub, h.next)).toEqual({ native: true });
  expect(h.next).toHaveBeenCalledWith(sub);
  expect(calls.drain).not.toHaveBeenCalled();
  expect(calls.post).not.toHaveBeenCalled();
});

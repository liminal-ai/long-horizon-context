import { describe, expect, it, vi } from "vitest";

import {
  dispatchLhcCommand,
  PRUNE_USAGE_MESSAGE,
  UNKNOWN_COMMAND_MESSAGE,
} from "../../src/commands/dispatch.js";
import {
  buildCommandCtx,
  FakeSwapChildControl,
  startCapturedSession,
  tempEnv,
  writeBasicRollout,
} from "./helpers.js";

describe("dispatchLhcCommand", () => {
  it("returns help for bare /lhc and bare lhc", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const ctx = buildCommandCtx(session, swap, { swap: { child: swap, markSwapKill: () => {} } });
    const slash = await dispatchLhcCommand("/lhc", ctx);
    const bare = await dispatchLhcCommand("lhc", ctx);
    expect(slash.messages[0]).toContain("status —");
    expect(bare.messages[0]).toContain("status —");
    await session.stop();
  });

  it("rejects non-numeric prune args with a usage hint", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const prune = vi.spyOn(session.getCommandContext().sdk!.threadView, "prune");

    const result = await dispatchLhcCommand(
      "/lhc-prune abc",
      buildCommandCtx(session, swap, { swap: { child: swap, markSwapKill: () => {} } }),
    );

    expect(result.messages).toEqual([PRUNE_USAGE_MESSAGE]);
    expect(prune).not.toHaveBeenCalled();
    prune.mockRestore();
    await session.stop();
  });

  it("still reports unknown commands", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const ctx = buildCommandCtx(session, swap, { swap: { child: swap, markSwapKill: () => {} } });
    const result = await dispatchLhcCommand("/lhc-nope", ctx);
    expect(result.messages).toEqual([UNKNOWN_COMMAND_MESSAGE]);
    await session.stop();
  });
});

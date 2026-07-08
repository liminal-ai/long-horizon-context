import { afterEach, describe, expect, it } from "vitest";

import { formatReceiptLine } from "../../src/commands/context.js";
import { runStatusCommand } from "../../src/commands/status.js";
import { buildCommandCtx, FakeSwapChildControl, startCapturedSession, tempEnv, writeBasicRollout } from "./helpers.js";

const originalHome = process.env.CODEX_LHC_HOME;
const originalFakeHome = process.env.CODEX_LHC_FAKE_CODEX_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_LHC_HOME;
  else process.env.CODEX_LHC_HOME = originalHome;
  if (originalFakeHome === undefined) delete process.env.CODEX_LHC_FAKE_CODEX_HOME;
  else process.env.CODEX_LHC_FAKE_CODEX_HOME = originalFakeHome;
});

describe("runStatusCommand", () => {
  it("prints threadView.status and capture stats with the codex-lhc prefix", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const printed: string[] = [];

    const result = await runStatusCommand(
      buildCommandCtx(session, swap, {
        print: (line) => {
          printed.push(line);
        },
      }),
    );

    expect(result.messages[0]).toContain("tail=");
    expect(result.messages[0]).toContain("zone=");
    expect(result.messages[1]).toContain("codex-lhc-capture");
    expect(printed[0]?.startsWith(formatReceiptLine("tail="))).toBe(true);
    expect(printed.some((line) => line.includes("codex-lhc-capture"))).toBe(true);
    await session.stop();
  });

  it("stays available while a turn is open", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();

    const result = await runStatusCommand(
      buildCommandCtx(session, swap, {
        isTurnOpen: () => true,
      }),
    );

    expect(result.messages[0]).toContain("tail=");
    await session.stop();
  });
});

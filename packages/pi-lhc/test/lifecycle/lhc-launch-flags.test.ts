import { describe, expect, it } from "vitest";
import {
  getFlagFromValues,
  LHC_EXTENSION_FLAG_SPECS,
  LHC_FLAG_CONTINUE,
  LHC_FLAG_RESUME,
  LHC_FLAG_THREAD,
  readLhcLaunchFlags,
  registerLhcFlags,
} from "../../src/lifecycle/lhc-launch-flags.js";
import type { ExtensionAPI } from "../../src/pi/types.js";

describe("LHC launch flags", () => {
  it("readLhcLaunchFlags maps explicit extension flags to launch modes", () => {
    expect(readLhcLaunchFlags(getFlagFromValues({}))).toEqual({ ok: true, value: {} });
    expect(readLhcLaunchFlags(getFlagFromValues({ [LHC_FLAG_RESUME]: true }))).toEqual({
      ok: true,
      value: { resume: true },
    });
    expect(readLhcLaunchFlags(getFlagFromValues({ [LHC_FLAG_CONTINUE]: true }))).toEqual({
      ok: true,
      value: { continue: true },
    });
    expect(readLhcLaunchFlags(getFlagFromValues({ [LHC_FLAG_THREAD]: "th_abc" }))).toEqual({
      ok: true,
      value: { thread: "th_abc" },
    });
  });

  it("readLhcLaunchFlags fails loud when thread attach modes conflict", () => {
    const conflict = readLhcLaunchFlags(
      getFlagFromValues({
        [LHC_FLAG_THREAD]: "th_abc",
        [LHC_FLAG_RESUME]: true,
      }),
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("conflicting_lhc_launch_flags");
      expect(conflict.error.reason).toContain("--lhc-thread");
      expect(conflict.error.reason).toContain("--lhc-resume");
    }

    const triple = readLhcLaunchFlags(
      getFlagFromValues({
        [LHC_FLAG_THREAD]: "th_abc",
        [LHC_FLAG_CONTINUE]: true,
        [LHC_FLAG_RESUME]: true,
      }),
    );
    expect(triple.ok).toBe(false);
  });

  it("registerLhcFlags registers all extension flags on the PI extension API", () => {
    const registered: Array<{ name: string; options: { type: string; description?: string } }> = [];
    const pi = {
      registerFlag(name: string, options: { description?: string; type: "boolean" | "string" }) {
        registered.push({ name, options });
      },
    } as Pick<ExtensionAPI, "registerFlag">;

    registerLhcFlags(pi as ExtensionAPI);

    expect(registered.map((entry) => entry.name)).toEqual(LHC_EXTENSION_FLAG_SPECS.map((spec) => spec.name));
    expect(registered.find((entry) => entry.name === LHC_FLAG_THREAD)?.options.type).toBe("string");
    expect(registered.find((entry) => entry.name === LHC_FLAG_RESUME)?.options.type).toBe("boolean");
  });
});

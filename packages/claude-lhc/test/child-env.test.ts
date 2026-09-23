import { describe, expect, it } from "vitest";

import { claudeChildEnv } from "../src/session.js";

describe("claudeChildEnv", () => {
  it("carries the sidecar's T3CODE_THREAD_ID into a host-supplied env", () => {
    const env = claudeChildEnv({ PATH: "/bin" }, { T3CODE_THREAD_ID: "th-1", PATH: "/usr/bin" });
    expect(env).toEqual({ PATH: "/bin", T3CODE_THREAD_ID: "th-1", DISABLE_AUTO_COMPACT: "1" });
  });

  it("keeps a thread id the host passed explicitly", () => {
    const env = claudeChildEnv({ T3CODE_THREAD_ID: "th-host" }, { T3CODE_THREAD_ID: "th-1" });
    expect(env.T3CODE_THREAD_ID).toBe("th-host");
  });

  it("uses the sidecar env when the host passes none, and adds nothing when no thread id is set", () => {
    expect(claudeChildEnv(undefined, { T3CODE_THREAD_ID: "th-1", A: "1" })).toEqual({
      T3CODE_THREAD_ID: "th-1",
      A: "1",
      DISABLE_AUTO_COMPACT: "1",
    });
    expect(claudeChildEnv({ A: "1" }, {})).toEqual({ A: "1", DISABLE_AUTO_COMPACT: "1" });
  });
});

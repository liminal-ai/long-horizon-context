import { describe, expect, test } from "bun:test";
import { childEnv } from "../src/session.ts";

describe("childEnv", () => {
  test("carries the wire threadId as T3CODE_THREAD_ID and keeps the native meter off", () => {
    const env = childEnv({ PATH: "/bin" }, "af517f79-2ead-5d78-858d-6d059806fa1b");
    expect(env).toEqual({ PATH: "/bin", DISABLE_AUTO_COMPACT: "1", T3CODE_THREAD_ID: "af517f79-2ead-5d78-858d-6d059806fa1b" });
  });

  test("no thread id on the wire: nothing set, an inherited value is not overridden", () => {
    expect(childEnv({ PATH: "/bin" }, undefined)).toEqual({ PATH: "/bin", DISABLE_AUTO_COMPACT: "1" });
    expect(childEnv({ PATH: "/bin" }, "")).toEqual({ PATH: "/bin", DISABLE_AUTO_COMPACT: "1" });
    expect(childEnv({ T3CODE_THREAD_ID: "x" }, 7)["T3CODE_THREAD_ID"]).toBe("x");
  });
});

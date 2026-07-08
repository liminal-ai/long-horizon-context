import { describe, expect, it } from "vitest";

import {
  argvHasAutoCompactOverride,
  AUTO_COMPACT_FLAG,
  injectAutoCompactSuppression,
  prepareChildArgv,
} from "../../src/bin/prepare-child-argv.js";

describe("argvHasAutoCompactOverride", () => {
  it("detects -c key=value (separate args)", () => {
    expect(argvHasAutoCompactOverride(["exec", "-c", `${AUTO_COMPACT_FLAG}=500`])).toBe(true);
  });

  it("detects -ckey=value (attached)", () => {
    expect(argvHasAutoCompactOverride([`-c${AUTO_COMPACT_FLAG}=500`])).toBe(true);
  });

  it("detects --config key=value (separate args)", () => {
    expect(argvHasAutoCompactOverride(["exec", "--config", `${AUTO_COMPACT_FLAG}=500`])).toBe(true);
  });

  it("detects --config=key=value (attached)", () => {
    expect(argvHasAutoCompactOverride([`--config=${AUTO_COMPACT_FLAG}=500`])).toBe(true);
  });

  it("detects naked key=value token", () => {
    expect(argvHasAutoCompactOverride([`${AUTO_COMPACT_FLAG}=500`])).toBe(true);
  });

  it("returns false when no override is present", () => {
    expect(argvHasAutoCompactOverride(["exec", "-c", "sandbox_mode=read-only"])).toBe(false);
  });
});

describe("prepareChildArgv", () => {
  it("injects suppression when no override is present", () => {
    const prepared = prepareChildArgv(["exec", "run", "task"]);
    expect(prepared.argv).toEqual(injectAutoCompactSuppression(["exec", "run", "task"]));
  });

  it("skips injection when any override form is present", () => {
    const forms = [
      ["exec", "-c", `${AUTO_COMPACT_FLAG}=500`],
      [`-c${AUTO_COMPACT_FLAG}=500`],
      ["exec", "--config", `${AUTO_COMPACT_FLAG}=500`],
      [`--config=${AUTO_COMPACT_FLAG}=500`],
    ] as const;
    for (const argv of forms) {
      expect(prepareChildArgv([...argv]).argv).toEqual([...argv]);
    }
  });

  it("skips injection when --no-autocompact-suppression is set", () => {
    const prepared = prepareChildArgv(["--no-autocompact-suppression", "exec"]);
    expect(prepared.argv).toEqual(["exec"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  LaunchGrammarError,
  launchChildArgv,
  launchFormOf,
  launchPromptText,
  replacementChildArgv,
  resolveLaunchSession,
  splitLaunchArgv,
} from "../../src/intake/launch-session.js";

const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("resolveLaunchSession grammar", () => {
  it("fresh launch generates session id and injects --session-id", async () => {
    const plan = await resolveLaunchSession(["--model", "sonnet"]);
    expect(plan.expected.source).toBe("fresh");
    expect(plan.expected.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(plan.childArgv).toEqual(["--model", "sonnet", "--session-id", plan.expected.sessionId]);
  });

  it("explicit --resume <uuid> binds that id", async () => {
    const plan = await resolveLaunchSession(["--resume", UUID_A, "--verbose"]);
    expect(plan.expected).toEqual({ sessionId: UUID_A, source: "explicit_resume" });
    expect(plan.childArgv).toContain("--resume");
    expect(plan.childArgv).toContain(UUID_A);
  });

  it("bare --resume uses wrapper picker before launch", async () => {
    const plan = await resolveLaunchSession(["--resume"], {
      pickSessionId: async () => UUID_A,
      listCandidates: async () => [{ sessionId: UUID_A, label: UUID_A, mtimeMs: 1 }],
    });
    expect(plan.expected.source).toBe("wrapper_picker");
    expect(plan.expected.sessionId).toBe(UUID_A);
    expect(plan.childArgv).toEqual(["--resume", UUID_A]);
  });

  it("-c <prompt> is Claude continue, not bash script", async () => {
    const plan = await resolveLaunchSession(["-c", "please help with the build"], {
      discoverDeps: {
        projectsRoot: "/tmp/cc-lhc-launch-test-root",
        readdirFn: async () => [{ name: `${UUID_A}.jsonl`, isFile: () => true }],
        statFn: async () => ({ birthtimeMs: 1, mtimeMs: 10 }),
      },
      cwd: "/work/x",
    });
    expect(plan.expected.source).toBe("continue_resolved");
    expect(plan.expected.sessionId).toBe(UUID_A);
    expect(plan.childArgv).toContain("--resume");
    expect(plan.childArgv).toContain(UUID_A);
    expect(plan.childArgv).not.toContain("-c");
    expect(plan.childArgv).toContain("please help with the build");
  });

  it("continue with no prior session refuses instead of falling through to fresh", async () => {
    await expect(
      resolveLaunchSession(["--continue"], {
        cwd: "/work/empty",
        discoverDeps: {
          projectsRoot: "/tmp/does-not-exist-cc-lhc",
          readdirFn: async () => {
            throw Object.assign(new Error("enoent"), { code: "ENOENT" });
          },
        },
      }),
    ).rejects.toBeInstanceOf(LaunchGrammarError);
  });

  it("resume search term is refused (not treated as filename)", async () => {
    await expect(resolveLaunchSession(["--resume", "my old project"])).rejects.toThrow(/search term/);
  });

  it("user --session-id is explicit_new and never resumeSessionId", async () => {
    const plan = await resolveLaunchSession(["--session-id", UUID_B], {
      rolloutExistsFn: async () => false,
    });
    expect(plan.expected.source).toBe("explicit_new");
    expect(plan.expected.sessionId).toBe(UUID_B);
    expect(plan.childArgv).toEqual(["--session-id", UUID_B]);
  });

  it("refuses --session-id when rollout already exists", async () => {
    await expect(
      resolveLaunchSession(["--session-id", UUID_B], {
        rolloutExistsFn: async () => true,
      }),
    ).rejects.toThrow(/already has a rollout/);
  });

  it("rejects capture-enabled --fork-session before spawn (no target mutation)", async () => {
    let lookup = 0;
    await expect(
      resolveLaunchSession(["--resume", UUID_A, "--fork-session"], {
        listCandidates: async () => {
          lookup += 1;
          return [];
        },
        pickSessionId: async () => {
          lookup += 1;
          return UUID_A;
        },
      }),
    ).rejects.toThrow(/--fork-session is not supported/);
    expect(lookup).toBe(0);
  });

  it("refuses duplicate/conflicting selectors", async () => {
    await expect(resolveLaunchSession(["--resume", UUID_A, "--continue"])).rejects.toThrow(/cannot combine/);
    await expect(resolveLaunchSession(["--session-id", UUID_A, "--resume", UUID_B])).rejects.toThrow(
      /cannot combine/,
    );
    await expect(resolveLaunchSession(["--resume", UUID_A, "--resume", UUID_B])).rejects.toThrow(/duplicate/);
  });

  it("refuses unsupported session/cwd-changing flags with capture", async () => {
    await expect(resolveLaunchSession(["--teleport"])).rejects.toThrow(/unsupported session/);
    await expect(resolveLaunchSession(["--worktree", "feat"])).rejects.toThrow(/unsupported session/);
  });

  it("places normalized selectors before -- and preserves exact suffix order", async () => {
    const plan = await resolveLaunchSession(
      ["--model", "sonnet", "--", "--resume", "literal", "extra"],
      { rolloutExistsFn: async () => false },
    );
    expect(plan.expected.source).toBe("fresh");
    const sid = plan.expected.sessionId;
    expect(plan.childArgv).toEqual([
      "--model",
      "sonnet",
      "--session-id",
      sid,
      "--",
      "--resume",
      "literal",
      "extra",
    ]);
    // Selector must not appear after --
    const dd = plan.childArgv.indexOf("--");
    expect(plan.childArgv.indexOf("--session-id")).toBeLessThan(dd);
  });

  it("exact argv for explicit resume with -- suffix", async () => {
    const plan = await resolveLaunchSession(["--verbose", "--resume", UUID_A, "--", "pos"]);
    expect(plan.childArgv).toEqual(["--verbose", "--resume", UUID_A, "--", "pos"]);
  });

  it("exact argv for continue with -- suffix", async () => {
    const plan = await resolveLaunchSession(["-c", "prompt text", "--", "tail"], {
      cwd: "/work/x",
      discoverDeps: {
        projectsRoot: "/tmp/cc-lhc-launch-test-root",
        readdirFn: async () => [{ name: `${UUID_A}.jsonl`, isFile: () => true }],
        statFn: async () => ({ birthtimeMs: 1, mtimeMs: 10 }),
      },
    });
    expect(plan.childArgv).toEqual(["prompt text", "--resume", UUID_A, "--", "tail"]);
  });

  it("rejects fork with -- suffix without candidate lookup", async () => {
    let lookup = 0;
    await expect(
      resolveLaunchSession(["--resume", UUID_A, "--fork-session", "--", "keep"], {
        listCandidates: async () => {
          lookup += 1;
          return [];
        },
      }),
    ).rejects.toThrow(/--fork-session is not supported/);
    expect(lookup).toBe(0);
  });
});


describe("splitLaunchArgv (fixture: claude 2.1.226 --help arity table)", () => {
  it("the real supported launch form is inherited whole: --model --effort --name", () => {
    const split = splitLaunchArgv(["--model", "claude-fable-5", "--effort", "medium", "--name", "seat"], []);
    expect(split.options).toEqual(["--model", "claude-fable-5", "--effort", "medium", "--name", "seat"]);
    expect(split.promptTokens).toEqual([]);
    expect(split.droppedAmbiguousOptions).toEqual([]);
  });

  it("equals forms and zero-arity flags are inherited", () => {
    const split = splitLaunchArgv(["--model=opus", "--verbose", "--add-dir=/x", "--debug=api"], []);
    expect(split.options).toEqual(["--model=opus", "--verbose", "--add-dir=/x", "--debug=api"]);
    expect(split.droppedAmbiguousOptions).toEqual([]);
  });

  it("a positional prompt is the launch's own; a replacement never inherits it", () => {
    const split = splitLaunchArgv(["--verbose", "do this thing"], []);
    expect(split.promptTokens).toEqual(["do this thing"]);
    expect(split.options).toEqual(["--verbose"]);
    expect(replacementChildArgv(["--verbose", "do this thing"], [], "S")).toEqual([
      "--verbose",
      "--resume",
      "S",
    ]);
  });

  it("prompt tokens after -- are prompt, not options", () => {
    const split = splitLaunchArgv([], ["--", "do", "this"]);
    expect(split.promptTokens).toEqual(["do", "this"]);
    expect(replacementChildArgv([], ["--", "do", "this"], "S")).toEqual(["--resume", "S"]);
  });

  it("a variadic space form is dropped from a replacement: its value boundary is unprovable", () => {
    const split = splitLaunchArgv(["--add-dir", "/x"], []);
    expect(split.options).toEqual([]);
    expect(split.droppedAmbiguousOptions).toEqual(["--add-dir", "/x"]);
  });

  it("a prompt after a variadic list is dropped with the option it cannot be told from", () => {
    const split = splitLaunchArgv(["--verbose", "--add-dir", "/x", "do this"], []);
    expect(split.options).toEqual(["--verbose"]);
    expect(split.droppedAmbiguousOptions).toEqual(["--add-dir", "/x", "do this"]);
    expect(replacementChildArgv(["--verbose", "--add-dir", "/x", "do this"], [], "S")).toEqual([
      "--verbose",
      "--resume",
      "S",
    ]);
  });

  it("an optional-value space form is dropped with its bare token", () => {
    expect(splitLaunchArgv(["--debug", "filter"], []).droppedAmbiguousOptions).toEqual(["--debug", "filter"]);
  });

  it("an unknown option is dropped only when a bare token follows it", () => {
    expect(splitLaunchArgv(["--future-opt", "val"], []).droppedAmbiguousOptions).toEqual(["--future-opt", "val"]);
    expect(splitLaunchArgv(["--future-flag", "--verbose"], []).options).toEqual(["--future-flag", "--verbose"]);
  });
});

describe("launchFormOf", () => {
  it("-p and --print are one-shot seats; everything else is interactive", () => {
    expect(launchFormOf(["-p", "do this"])).toBe("one_shot");
    expect(launchFormOf(["--print"])).toBe("one_shot");
    expect(launchFormOf(["--model", "opus", "do this"])).toBe("interactive");
    expect(launchFormOf([])).toBe("interactive");
  });

  /**
   * The installed parser accepts an `=value` form on a declared boolean
   * (verified on 2.1.235: `claude --print=1 --version` and `claude -p=1
   * --version` both parse). That launch prints and exits like any other
   * one-shot, so classifying it as interactive would arm the child swap on a
   * seat that is about to end.
   */
  it("the equals form of the print flag is a one-shot as well", () => {
    expect(launchFormOf(["--print=1", "do this"])).toBe("one_shot");
    expect(launchFormOf(["-p=1", "do this"])).toBe("one_shot");
    expect(launchFormOf(["--printer", "x"])).toBe("interactive");
  });
});

describe("the print flag and a replacement child", () => {
  /**
   * `-p, --print` is zero-arity in the installed binary (2.1.235 `--help`,
   * matching the 2.1.226 arity fixture), so a print launch's prompt is the
   * positional token — the `=value` is not prompt text and is not estimated as
   * any. What the split owes is that no form of the flag reaches a replacement.
   */
  it("no form of the print flag is inherited, and the prompt stays positional", () => {
    for (const flag of ["-p", "--print", "-p=1", "--print=1"]) {
      const split = splitLaunchArgv([flag, "do this thing"], []);
      expect(split.options).toEqual([]);
      expect(split.promptTokens).toEqual(["do this thing"]);
      expect(replacementChildArgv([flag, "do this thing"], [], "S")).toEqual(["--resume", "S"]);
    }
  });

  it("the equals value is not counted as prompt text", () => {
    expect(launchPromptText(["--print=1"], [])).toBe("");
    expect(launchPromptText(["--print=1", "do this thing"], [])).toBe("do this thing");
  });

  it("this invocation's own argv keeps the flag exactly as written", () => {
    expect(launchChildArgv(["--print=1", "do this"], [], "S")).toEqual(["--print=1", "do this", "--resume", "S"]);
  });
});

describe("launchChildArgv", () => {
  it("carries this invocation's own argv, prompt included, onto the resolved session", () => {
    expect(launchChildArgv(["-p", "do this"], [], "S")).toEqual(["-p", "do this", "--resume", "S"]);
  });
});

describe("launchPromptText", () => {
  it("is the prompt as the child receives it", () => {
    expect(launchPromptText(["-p", "do this thing"], [])).toBe("do this thing");
    expect(launchPromptText(["--verbose"], [])).toBe("");
  });
});

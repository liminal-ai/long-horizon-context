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
    const split = splitLaunchArgv(["-p", "do this thing"], []);
    expect(split.promptTokens).toEqual(["do this thing"]);
    expect(split.options).toEqual(["-p"]);
    expect(replacementChildArgv(["-p", "do this thing"], [], "S")).toEqual(["-p", "--resume", "S"]);
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

import { describe, expect, it } from "vitest";

import { LaunchGrammarError, resolveLaunchSession, respawnArgvSafety } from "../../src/intake/launch-session.js";

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
    ).rejects.toThrow(/--fork-session is not supported with capture enabled/);
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
    ).rejects.toThrow(/--fork-session is not supported with capture enabled/);
    expect(lookup).toBe(0);
  });
});


describe("respawnArgvSafety (fixture: claude 2.1.226 --help arity table)", () => {
  it("keeps the real supported launch form handoff-safe: --model --effort --name", () => {
    expect(respawnArgvSafety(["--model", "claude-fable-5", "--effort", "medium", "--name", "seat"], [])).toEqual({
      safe: true,
    });
  });

  it("equals forms and zero-arity flags are safe", () => {
    expect(respawnArgvSafety(["--model=opus", "--verbose", "--add-dir=/x", "--debug=api"], [])).toEqual({
      safe: true,
    });
  });

  it("a positional prompt fails closed", () => {
    const r = respawnArgvSafety(["do this thing"], []);
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toMatch(/positional prompt/);
  });

  it("prompt tokens after -- fail closed", () => {
    const r = respawnArgvSafety([], ["--", "do", "this"]);
    expect(r.safe).toBe(false);
  });

  it("variadic space form with bare values fails closed (prompt boundary unprovable)", () => {
    const r = respawnArgvSafety(["--add-dir", "/x"], []);
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toMatch(/optional\/variadic/);
  });

  it("prompt after a variadic list fails closed", () => {
    const r = respawnArgvSafety(["--add-dir", "/x", "do this"], []);
    expect(r.safe).toBe(false);
  });

  it("optional-value space form with a bare token fails closed", () => {
    const r = respawnArgvSafety(["--debug", "filter"], []);
    expect(r.safe).toBe(false);
  });

  it("unknown option followed by a bare token fails closed; alone it is safe", () => {
    expect(respawnArgvSafety(["--future-opt", "val"], []).safe).toBe(false);
    expect(respawnArgvSafety(["--future-flag", "--verbose"], []).safe).toBe(true);
  });
});

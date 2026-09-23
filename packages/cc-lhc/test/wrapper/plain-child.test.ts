/**
 * One-shot plain child (gorilla F1+F8): Claude inherits the wrapper's stdio
 * byte-for-byte, exit codes and signals come back as the pty's did, and a
 * SIGKILLed wrapper never leaves the child running (setpriv PR_SET_PDEATHSIG on
 * Linux, a detached watchdog elsewhere).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { findSetpriv, spawnPlainChild, WATCHDOG_SOURCE } from "../../src/wrapper/plain-child.js";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "../../src/wrapper/plain-child.ts");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

type FakeChild = EventEmitter & { pid: number; kill: (s?: string) => boolean; unref: () => void };

function recordingSpawn(): {
  calls: { program: string; args: string[]; options: Record<string, unknown> }[];
  spawn: typeof spawn;
} {
  const calls: { program: string; args: string[]; options: Record<string, unknown> }[] = [];
  const fake = ((program: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ program, args, options });
    const child = new EventEmitter() as FakeChild;
    child.pid = 4000 + calls.length;
    child.kill = () => true;
    child.unref = () => {};
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { calls, spawn: fake };
}

/** A stand-in wrapper: spawns the child through spawnPlainChild, prints its pid, then idles. */
function writeParentScript(dir: string, childArgs: string[], mode: "default" | "watchdog"): string {
  const script = join(dir, `parent-${mode}.mts`);
  writeFileSync(
    script,
    // A file URL: Windows ESM rejects a bare absolute path as an import specifier.
    `import { spawnPlainChild } from ${JSON.stringify(pathToFileURL(MODULE).href)};
const h = spawnPlainChild(process.execPath, ${JSON.stringify(childArgs)}, {
  cwd: process.cwd(), env: process.env,
  ${mode === "watchdog" ? "setprivPath: null," : ""}
});
process.stderr.write("CHILD " + h.pid + "\\n");
h.onExit(({ exitCode }) => process.exit(exitCode));
`,
  );
  return script;
}

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});

describe("spawnPlainChild: launch shape", () => {
  it("Linux with setpriv: execs Claude through setpriv --pdeathsig HUP, stdio inherited, no watchdog", () => {
    const rec = recordingSpawn();
    const couplings: string[] = [];
    const handle = spawnPlainChild("claude", ["-p", "hi"], {
      cwd: "/tmp",
      env: {},
      platform: "linux",
      setprivPath: "/usr/bin/setpriv",
      spawn: rec.spawn,
      onCoupling: (c) => couplings.push(c),
    });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.program).toBe("/usr/bin/setpriv");
    expect(rec.calls[0]!.args).toEqual(["--pdeathsig", "HUP", "--", "claude", "-p", "hi"]);
    expect(rec.calls[0]!.options.stdio).toBe("inherit");
    expect(couplings).toEqual(["pdeathsig"]);
    expect(handle.pid).toBe(4001);
  });

  it.each(["darwin", "win32"] as const)("%s: spawns Claude directly plus a detached watchdog", (platform) => {
    const rec = recordingSpawn();
    const couplings: string[] = [];
    spawnPlainChild("claude", ["-p", "hi"], {
      cwd: "/tmp",
      env: {},
      platform,
      spawn: rec.spawn,
      wrapperPid: 777,
      onCoupling: (c) => couplings.push(c),
    });
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0]!.program).toBe("claude");
    expect(rec.calls[0]!.options.stdio).toBe("inherit");
    expect(rec.calls[1]!.program).toBe(process.execPath);
    expect(rec.calls[1]!.args).toEqual(["-e", WATCHDOG_SOURCE, "777", "4001"]);
    expect(rec.calls[1]!.options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(couplings).toEqual(["watchdog"]);
  });

  it("win32: kill() closes Claude's process tree with taskkill /T /F (no SIGHUP there)", () => {
    const rec = recordingSpawn();
    const handle = spawnPlainChild("claude", ["-p", "hi"], {
      cwd: "/tmp",
      env: {},
      platform: "win32",
      spawn: rec.spawn,
      wrapperPid: 777,
    });
    handle.kill();
    handle.kill("SIGTERM");
    const taskkills = rec.calls.filter((c) => c.program === "taskkill");
    expect(taskkills.map((c) => c.args)).toEqual([
      ["/PID", "4001", "/T", "/F"],
      ["/PID", "4001", "/T", "/F"],
    ]);
  });

  it("Linux without setpriv falls back to the watchdog", () => {
    const rec = recordingSpawn();
    spawnPlainChild("claude", [], { cwd: "/tmp", env: {}, platform: "linux", setprivPath: null, spawn: rec.spawn });
    expect(rec.calls.map((c) => c.program)).toEqual(["claude", process.execPath]);
  });
});

describe("spawnPlainChild: real processes", () => {
  it("reports the child's exit code and terminating signal like the pty did", async () => {
    const env = process.env as Record<string, string>;
    const exit7 = spawnPlainChild(process.execPath, ["-e", "process.exit(7)"], { cwd: tmpdir(), env });
    const code = await new Promise<{ exitCode: number; signal?: number }>((r) => exit7.onExit(r));
    expect(code).toEqual({ exitCode: 7 });

    const idle = spawnPlainChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: tmpdir(), env });
    const exited = new Promise<{ exitCode: number; signal?: number }>((r) => idle.onExit(r));
    idle.kill("SIGTERM");
    // Windows closes the tree with taskkill /F, which ends it with exit code 1 and no signal.
    if (process.platform === "win32") expect(await exited).toEqual({ exitCode: 1 });
    else expect((await exited).signal).toBe(15);
  });

  it("piped stdin reaches the child and its stdout comes back byte-for-byte (no CRLF, no escapes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plain-child-"));
    const script = writeParentScript(dir, ["-e", "process.stdin.pipe(process.stdout)"], "default");
    const input = "line one\nline two ✓ 日本\n";
    const result = spawnSync(process.execPath, [script], { input, encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(input);
  });

  const modes =
    findSetpriv() !== null && process.platform === "linux"
      ? (["default", "watchdog"] as const)
      : (["watchdog"] as const);
  it.each(modes)("a SIGKILLed wrapper leaves no child running (%s coupling)", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "plain-child-"));
    const script = writeParentScript(dir, ["-e", "setInterval(() => {}, 1000)"], mode);
    const parent = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
    spawned.push(parent);
    let err = "";
    parent.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
    });
    expect(await waitUntil(() => /CHILD \d+/.test(err), 10_000)).toBe(true);
    const childPid = Number(/CHILD (\d+)/.exec(err)![1]);
    expect(alive(childPid)).toBe(true);

    parent.kill("SIGKILL");
    expect(await waitUntil(() => !alive(childPid), 8_000)).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "the watchdog's Windows branch runs taskkill /T /F on the child once the wrapper is gone",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "plain-child-wd-"));
      // A stand-in taskkill on PATH that records its argv and kills the named pid.
      const log = join(dir, "taskkill.log");
      const fake = join(dir, "taskkill");
      writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nkill -9 "$2"\n`, { mode: 0o755 });
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      spawned.push(child);
      const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
      await new Promise((r) => gone.once("exit", r));
      const forced = `Object.defineProperty(process, "platform", { value: "win32" });\n${WATCHDOG_SOURCE}`;
      const watchdog = spawn(process.execPath, ["-e", forced, String(gone.pid), String(child.pid)], {
        stdio: "ignore",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      spawned.push(watchdog);
      expect(await waitUntil(() => !alive(child.pid!), 8_000)).toBe(true);
      expect(readFileSync(log, "utf8").trim()).toBe(`/PID ${child.pid} /T /F`);
    },
    20_000,
  );
});

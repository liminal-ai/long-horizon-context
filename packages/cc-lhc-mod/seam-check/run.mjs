#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePolicy, resolveSettings } from "../src/settings.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "dist", "plugin");
const claude = process.env.CLAUDE_BIN ?? "claude";
const model = process.env.SEAM_MODEL ?? "sonnet";
// Short and outside any repo: the socket path must fit in 107 bytes, and Claude loads CLAUDE.md above its cwd.
const scratch = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "verify-cc-lhc-mod", "scratch");
const PARENT_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_EFFORT",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];

let failures = 0;
const check = (seam, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${seam}: ${detail}`);
};

if (!existsSync(join(plugin, "hooks", "register.js"))) {
  console.error(`seam-check: no built plugin at ${plugin}; run pnpm --filter lhc build && pnpm --filter claude-adapter build && pnpm --filter cc-lhc-mod build`);
  process.exit(2);
}
console.log(`seam-check: ${execFileSync(claude, ["--version"], { encoding: "utf8" }).trim()} model ${model}`);

const validate = spawnSync(claude, ["plugin", "validate", plugin], { encoding: "utf8" });
check("validate", validate.status === 0, `claude plugin validate exit ${validate.status}`);

mkdirSync(scratch, { recursive: true });
const home = mkdtempSync(join(scratch, "seam-"));
const work = join(home, "work");
mkdirSync(work);
const lhcHome = join(home, "lhc");
console.log(`seam-check: scratch ${home}`);

let runs = 0;
function run(prompt, { args = [], env = {} } = {}) {
  const debugFile = join(home, `debug-${++runs}.log`);
  const before = new Set(existsSync(join(lhcHome, "logs")) ? readdirSync(join(lhcHome, "logs")) : []);
  const childEnv = { ...process.env, DISABLE_AUTOUPDATER: "1", LHC_HOME: lhcHome, ...env };
  for (const name of PARENT_SESSION_ENV) if (!(name in env)) delete childEnv[name];
  const result = spawnSync(
    claude,
    [
      "-p",
      "--plugin-dir",
      plugin,
      "--model",
      model,
      "--output-format",
      "json",
      "--debug-file",
      debugFile,
      ...args,
      prompt,
    ],
    { cwd: work, env: childEnv, encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) throw new Error(`claude -p exit ${result.status}: ${result.stderr}`);
  const logs = readdirSync(join(lhcHome, "logs")).filter((name) => !before.has(name));
  const read = (prefix) =>
    logs
      .filter((name) => name.startsWith(prefix))
      .map((name) => readFileSync(join(lhcHome, "logs", name), "utf8"))
      .join("");
  const sessionId = JSON.parse(result.stdout).session_id;
  const sidecarLog = read("sidecar-");
  const transcript = new RegExp(`bound session ${sessionId} transcript (\\S+)`).exec(sidecarLog)?.[1];
  console.log(`seam-check: run ${runs} session ${sessionId}`);
  return { sessionId, sidecarLog, transcript, modLog: read("mod-"), debug: readFileSync(debugFile, "utf8") };
}

const policyLine = (modLog) => {
  const match = / window (\d+) trigger (\d+) target (\d+) pct (\S+)/.exec(modLog);
  return match === null ? undefined : { window: +match[1], trigger: +match[2], target: +match[3], pct: match[4] };
};

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid) {
  for (let waited = 0; waited < 5000 && isAlive(pid); waited += 100) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
}

const checks = (debug) =>
  [...debug.matchAll(/^(\S+) \[DEBUG\] autocompact: tokens=\S+ level=(\w+) effectiveWindow=\d+/gm)].map((m) => ({
    at: m[1],
    level: m[2],
  }));

// The engine records its own count of the context it compacted as the boundary row's preTokens. An override that
// took holds when the run's first check was below the threshold (ok or warn), so a threshold under the starting
// context fails, and the first auto compact ran at or above the trigger and below the engine's default threshold.
// It catches an override that is missing, below the starting context, or at the default. A threshold a few thousand
// tokens off the trigger can pass: an early attempt may bail, and the logs redact check counts.
function firstCrossing(run, trigger, engineDefault) {
  const boundary = readFileSync(run.transcript, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .find((row) => row.subtype === "compact_boundary" && row.compactMetadata?.trigger === "auto");
  const pre = boundary?.compactMetadata?.preTokens;
  if (pre === undefined) return { ok: false, detail: "no auto compact_boundary row in the transcript" };
  const opening = checks(run.debug)[0]?.level;
  return {
    ok: opening !== undefined && opening !== "compact" && pre >= trigger && pre < engineDefault,
    detail: `first check ${opening}, first auto compact ran at ${pre} tokens (trigger ${trigger}, engine default ${engineDefault})`,
  };
}

const first = run("Reply with just: ok");
const bound = new RegExp(`bound session ${first.sessionId} transcript (\\S+) source startup`).exec(first.sidecarLog);
check("bind-startup", bound !== null, bound?.[0] ?? "no startup bind for the session in the sidecar log");
check(
  "bind-transcript",
  bound !== null && bound[1].endsWith(`/${first.sessionId}.jsonl`) && existsSync(bound[1]),
  `transcript ${bound?.[1]}`,
);
check("socket-dir", (statSync(join(lhcHome, "run")).mode & 0o777) === 0o700, "run directory is mode 0700");
const sidecarPid = Number(/listening \S+ pid (\d+)/.exec(first.sidecarLog)?.[1]);
check(
  "sidecar-exit",
  sidecarPid > 0 && (await gone(sidecarPid)),
  `sidecar pid ${sidecarPid} is gone within 5 s of claude exiting`,
);
const live = policyLine(first.modLog);
const expected = live && computePolicy(resolveSettings({}), live.window).policy;
check(
  "mod-computes-policy",
  live !== undefined &&
    live.trigger === expected.trigger &&
    live.target === expected.target &&
    live.pct === String(expected.pct),
  live === undefined
    ? "no policy line in the mod log"
    : `the mod's policy for window ${live.window} is the settings model's: trigger ${live.trigger} target ${live.target} pct ${live.pct} (the override seams prove the engine side)`,
);

const resumed = run("Reply with just: ok again", { args: ["--resume", first.sessionId] });
check(
  "bind-resume",
  resumed.sidecarLog.includes(`bound session ${first.sessionId} transcript ${bound?.[1]} source resume`),
  `resume bound ${first.sessionId}`,
);

// A 100k compact window gives effectiveWindow 80000 and an engine default trigger of 67000. The crossing run sets
// trigger 30000 and reads a file in chunks of about 6k tokens, so its context passes 30000 a few steps in.
const smallWindow = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" };
const words = ["amber", "birch", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper"];
const lines = Array.from({ length: 600 }, (_, l) => {
  const row = Array.from({ length: 8 }, (_, k) => `${words[(l * 7 + k * 3) % 10]}${(l * k) % 97}`);
  return `line ${l}: ${row.join(" ")}`;
});
writeFileSync(join(work, "f1.txt"), `${lines.join("\n")}\n`);
const crossing = run(
  "Read f1.txt in chunks of 150 lines (offset 1, 151, 301, 451), one Read call at a time, then reply DONE.",
  {
    env: smallWindow,
    args: [
      "--allowedTools",
      "Read",
      "--settings",
      JSON.stringify({ pluginConfigs: { "lhc@inline": { options: { upperBound: 30_000, lowerBound: 10_000 } } } }),
    ],
  },
);
const crossingPolicy = policyLine(crossing.modLog);
check(
  "settings-from-userConfig",
  crossingPolicy?.window === 100_000 &&
    crossingPolicy.trigger === 30_000 &&
    crossingPolicy.target === 10_000 &&
    crossingPolicy.pct === "37.5",
  `window ${crossingPolicy?.window} trigger ${crossingPolicy?.trigger} target ${crossingPolicy?.target} pct ${crossingPolicy?.pct}`,
);
check("output-reserve", /effectiveWindow=80000\b/.test(crossing.debug), "a 100k window gives effectiveWindow=80000");
const crossed = firstCrossing(crossing, 30_000, 67_000);
check("override-lowers-trigger", crossed.ok, `trigger 30000: ${crossed.detail}`);

const held = run("Reply with just: ok", { env: smallWindow });
const heldChecks = checks(held.debug);
check(
  "override-default-holds",
  policyLine(held.modLog)?.trigger === 67_000 &&
    heldChecks.length > 0 &&
    heldChecks.every((c) => c.level !== "compact"),
  `trigger 67000: ${heldChecks.length} checks, levels ${[...new Set(heldChecks.map((c) => c.level))].join(", ")}`,
);

if (failures === 0) rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? "seam-check: PASS" : `seam-check: FAIL (${failures} seams), logs kept in ${home}`);
process.exit(failures === 0 ? 0 : 1);

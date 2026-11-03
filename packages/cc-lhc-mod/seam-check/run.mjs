#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  console.error(`seam-check: no built plugin at ${plugin}; run pnpm --filter cc-lhc-mod build`);
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
  console.log(`seam-check: run ${runs} session ${sessionId}`);
  return { sessionId, sidecarLog: read("sidecar-"), modLog: read("mod-"), debug: readFileSync(debugFile, "utf8") };
}

const policyLine = (modLog) => {
  const match = / window (\d+) trigger (\d+) target (\d+) pct (\S+)/.exec(modLog);
  return match === null ? undefined : { window: +match[1], trigger: +match[2], target: +match[3], pct: match[4] };
};

const first = run("Reply with just: ok");
const bound = new RegExp(`bound session ${first.sessionId} transcript (\\S+) source startup`).exec(first.sidecarLog);
check("bind-startup", bound !== null, bound?.[0] ?? "no startup bind for the session in the sidecar log");
check(
  "bind-transcript",
  bound !== null && bound[1].endsWith(`/${first.sessionId}.jsonl`) && existsSync(bound[1]),
  `transcript ${bound?.[1]}`,
);
check("socket-dir", (statSync(join(lhcHome, "run")).mode & 0o777) === 0o700, "run directory is mode 0700");
check("sidecar-exit", first.sidecarLog.includes("exit SIGTERM"), "the sidecar left when claude exited");
const live = policyLine(first.modLog);
const expected = live && computePolicy(resolveSettings({}), live.window).policy;
check(
  "settings-applied",
  live !== undefined &&
    live.trigger === expected.trigger &&
    live.target === expected.target &&
    live.pct === String(expected.pct),
  live === undefined
    ? "no policy line in the mod log"
    : `window ${live.window} trigger ${live.trigger} target ${live.target} pct ${live.pct}`,
);

const resumed = run("Reply with just: ok again", { args: ["--resume", first.sessionId] });
check(
  "bind-resume",
  resumed.sidecarLog.includes(`bound session ${first.sessionId} transcript ${bound?.[1]} source resume`),
  `resume bound ${first.sessionId}`,
);

// A 100k compact window: the engine's effective window is 80000 and its default trigger 67000, above this
// prompt (~23k). A trigger the mod sets below the prompt makes the first check compact; the default does not.
const smallWindow = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" };
const low = run("Reply with just: ok", {
  env: smallWindow,
  args: [
    "--settings",
    JSON.stringify({ pluginConfigs: { "lhc@inline": { options: { upperBound: 1234, lowerBound: 1000 } } } }),
  ],
});
const lowPolicy = policyLine(low.modLog);
check(
  "settings-from-userConfig",
  lowPolicy?.window === 100_000 && lowPolicy.trigger === 1234 && lowPolicy.pct === "1.5425",
  `window ${lowPolicy?.window} trigger ${lowPolicy?.trigger} pct ${lowPolicy?.pct}`,
);
check("output-reserve", low.debug.includes("effectiveWindow=80000"), "a 100k window gives effectiveWindow=80000");
check(
  "override-lowers-trigger",
  /autocompact: tokens=\S+ level=compact effectiveWindow=80000/.test(low.debug) &&
    low.debug.includes("thresholdSource=env"),
  "trigger 1234 makes the first check compact",
);
const high = run("Reply with just: ok", { env: smallWindow });
check(
  "override-default-holds",
  /autocompact: tokens=\S+ level=ok effectiveWindow=80000/.test(high.debug) &&
    policyLine(high.modLog)?.trigger === 67_000,
  "trigger 67000 leaves the first check ok",
);

console.log(failures === 0 ? "seam-check: PASS" : `seam-check: FAIL (${failures} seams)`);
process.exit(failures === 0 ? 0 : 1);

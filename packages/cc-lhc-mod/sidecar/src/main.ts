import { appendFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type ModelCall,
  resolveTokenFamily,
} from "lhc";
import type { InferenceLane } from "../../src/inference.ts";
import { sidecarLogPath, socketPath } from "../../src/paths.ts";
import { BRIDGE_PROVIDER, type Bridge, createBridge, laneAssignments } from "./inference-bridge.ts";
import { createSidecarServer } from "./server.ts";

// Linux caps sun_path at 108 bytes including the terminator.
const MAX_SOCKET_PATH = 107;
const INFERENCE_TIMEOUT_MS = 90_000;

const { values } = parseArgs({
  options: { home: { type: "string" }, id: { type: "string" }, inference: { type: "string", default: "bridge" } },
});
const lane = values.inference;
if (values.home === undefined || values.id === undefined || (lane !== "bridge" && lane !== "sdk")) {
  console.error("usage: main.js --home <lhc home> --id <load id> [--inference bridge|sdk]");
  process.exit(2);
}
const socket = socketPath(values.home, values.id);
const logFile = sidecarLogPath(values.home, values.id);
if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
  console.error(`socket path ${socket} is longer than ${MAX_SOCKET_PATH} bytes; use a shorter LHC home`);
  process.exit(2);
}

mkdirSync(dirname(logFile), { recursive: true });
const log = (line: string): void => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
chmodSync(dirname(socket), 0o700);
rmSync(socket, { force: true });

async function createLhc(lane: InferenceLane): Promise<{ lhc: Lhc; bridge?: Bridge }> {
  const tokenFamily = resolveTokenFamily("", "anthropic").family;
  if (process.env.LHC_NO_INFERENCE === "1") {
    log("model lane deterministic");
    return { lhc: initLhc({ mode: "background", inferenceCallbacks: createDeterministicInferenceCallbacks(), tokenFamily }) };
  }
  let call: ModelCall;
  let provider: string;
  let bridge: Bridge | undefined;
  if (lane === "bridge") {
    bridge = createBridge(INFERENCE_TIMEOUT_MS, log);
    call = bridge.call;
    provider = BRIDGE_PROVIDER;
  } else {
    const sdk = await import("./inference-sdk.ts");
    call = sdk.createSdkModelCall(process.env.LHC_CLAUDE_BIN ?? "claude");
    provider = sdk.SDK_PROVIDER;
  }
  log(`model lane ${lane}`);
  const lanes = call;
  call = async (input) => {
    const started = Date.now();
    const result = await lanes(input);
    log(`model call ${lane} ${result.ok ? "ok" : result.kind} took ${Date.now() - started}ms`);
    return result;
  };
  const inference = { call, assignments: laneAssignments(provider), timeoutMs: INFERENCE_TIMEOUT_MS };
  const lhc = initLhc({ mode: "background", inference, tokenFamily });
  return { lhc, ...(bridge === undefined ? {} : { bridge }) };
}

const { server } = createSidecarServer({ ...(await createLhc(lane)), home: values.home, ownerPid: process.ppid, log });
const stop = (why: string): void => {
  // The lease stays: it belongs to the Claude process, which outlives a reloaded sidecar and is reclaimed once dead.
  log(`exit ${why}`);
  rmSync(socket, { force: true });
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop(signal));
// Claude Code kills the sidecar when the module unloads; a killed Claude cannot, and one dying can spawn a sidecar
// that is reparented before it starts. Only the spawning Claude reads stdout, so a write that fails means it is gone.
process.stdout.on("error", () => stop("orphaned"));
setInterval(() => process.stdout.write("\n"), 5000).unref();

server.listen(socket, () => {
  log(`listening ${socket} pid ${process.pid}`);
  console.log(`listening ${socket}`);
});

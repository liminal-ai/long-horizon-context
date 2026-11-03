import { appendFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { sidecarLogPath, socketPath } from "../../src/paths.ts";
import { createLhc } from "./inference-sdk.ts";
import { createSidecarServer, stopRecording } from "./server.ts";

// Linux caps sun_path at 108 bytes including the terminator.
const MAX_SOCKET_PATH = 107;

const { values } = parseArgs({ options: { home: { type: "string" }, id: { type: "string" } } });
if (values.home === undefined || values.id === undefined) {
  console.error("usage: main.js --home <lhc home> --id <load id>");
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

const parent = process.ppid;
const { server, state } = createSidecarServer({ lhc: createLhc(), home: values.home, ownerPid: parent, log });
const stop = (why: string): void => {
  log(`exit ${why}`);
  stopRecording(state);
  rmSync(socket, { force: true });
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop(signal));
// Claude Code kills the sidecar when the module unloads; a killed Claude cannot, so leave when orphaned.
setInterval(() => process.ppid !== parent && stop("orphaned"), 5000).unref();

server.listen(socket, () => {
  log(`listening ${socket} pid ${process.pid}`);
  console.log(`listening ${socket}`);
});

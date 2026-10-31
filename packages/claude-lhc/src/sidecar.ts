import { createInterface } from "node:readline";
import { createSidecar } from "./frames.js";
import { encodeFrame } from "./protocol.js";

const log = (line: string): void => {
  process.stderr.write(`[claude-lhc] ${line}\n`);
};

const sidecar = createSidecar({
  write: (frame) => {
    process.stdout.write(encodeFrame(frame));
  },
  log,
  exit: async (code) => {
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    process.exit(code);
  },
});

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => sidecar.line(line));
lines.on("close", () => sidecar.inputClosed());
process.on("SIGTERM", () => void sidecar.shutdown(0));
process.on("uncaughtException", (cause) => sidecar.fail(`sidecar crashed: ${cause.message}`));
process.on("unhandledRejection", (cause) =>
  sidecar.fail(`sidecar crashed: ${cause instanceof Error ? cause.message : String(cause)}`),
);

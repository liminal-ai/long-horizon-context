import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const tsxCliPath: string = createRequire(join(here, "../../../lhc/node_modules/tsx/package.json")).resolve(
  "tsx/cli",
);

export function tsxCommand(script: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [tsxCliPath, script] };
}

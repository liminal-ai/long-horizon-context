/**
 * Portable tsx invocation for tests that spawn TypeScript worker fixtures.
 *
 * `node_modules/.bin/tsx` is a POSIX shell script — spawning it directly
 * fails on native Windows. tsx is a devDependency of the lhc workspace
 * package, so resolve its real JS CLI entry through lhc's module scope and
 * run it under the current Node executable; identical behavior on Linux,
 * macOS, and Windows.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const tsxCliPath: string = createRequire(join(here, "../../../lhc/node_modules/tsx/package.json")).resolve(
  "tsx/cli",
);

/** spawn(command, [...args, script]) runs `script` under tsx portably. */
export function tsxCommand(script: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [tsxCliPath, script] };
}

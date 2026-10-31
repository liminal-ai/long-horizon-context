import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FORBIDDEN = /(?:\/node_modules\/(?:lhc|effect|js-tiktoken|@anthropic-ai\/claude-agent-sdk)\/|\/packages\/lhc\/)/;

async function bundledModules(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: PACKAGE,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs).map((input) => resolve(PACKAGE, input));
}

test("the client entry bundles with no module from lhc, effect, js-tiktoken or the Agent SDK", async () => {
  const modules = await bundledModules("src/client/index.ts");

  expect(modules.filter((path) => FORBIDDEN.test(path))).toEqual([]);
  expect(modules).toContain(resolve(PACKAGE, "src/client/operations.ts"));
});

test("the root entry pulls in the engine, so the check above can fail", async () => {
  const modules = await bundledModules("src/index.ts");

  expect(modules.some((path) => /\/packages\/lhc\//.test(path))).toBe(true);
  expect(modules.some((path) => /\/node_modules\/@anthropic-ai\/claude-agent-sdk\//.test(path))).toBe(true);
});

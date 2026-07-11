#!/usr/bin/env node
import { defaultNewThreadFilePath, defaultRegistryPath } from "./home.js";
import { runPiLhcLauncher } from "./launcher/run.js";

const exitCode = await runPiLhcLauncher(process.argv.slice(2), {
  newThreadFilePath: defaultNewThreadFilePath,
  registryPath: defaultRegistryPath(),
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  return 1;
});

process.exit(exitCode);

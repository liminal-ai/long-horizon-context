#!/usr/bin/env node
import { defaultNewThreadFilePath, defaultRegistryPath, ensurePiAgentDirEnv } from "./home.js";

// Set PI_CODING_AGENT_DIR before the launcher (and thus PI) modules load so
// every getAgentDir() call resolves under the pi-lhc home.
ensurePiAgentDirEnv();

const { runPiLhcLauncher } = await import("./launcher/run.js");

const exitCode = await runPiLhcLauncher(process.argv.slice(2), {
  newThreadFilePath: defaultNewThreadFilePath,
  registryPath: defaultRegistryPath(),
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  return 1;
});

process.exit(exitCode);

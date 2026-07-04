import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** cc-lhc home directory (`~/.cc-lhc`, overridable via `CC_LHC_HOME` for tests). */
export function ccLhcHome(): string {
  const override = process.env.CC_LHC_HOME;
  return override !== undefined && override !== "" ? override : join(homedir(), ".cc-lhc");
}

export function defaultRegistryPath(): string {
  return join(ccLhcHome(), "registry.sqlite");
}

export function defaultLineageDbPath(): string {
  return join(ccLhcHome(), "cc-lhc.sqlite");
}

export function defaultThreadFilePath(): string {
  const dir = join(ccLhcHome(), "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
}

export function captureThreadRef(threadId: string, registryPath: string = defaultRegistryPath()): {
  threadId: string;
  registryPath: string;
} {
  return { threadId, registryPath };
}

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** codex-lhc home directory (`~/.codex-lhc`, overridable via `CODEX_LHC_HOME` for tests). */
export function codexLhcHome(): string {
  const override = process.env.CODEX_LHC_HOME;
  return override !== undefined && override !== "" ? override : join(homedir(), ".codex-lhc");
}

export function defaultRegistryPath(): string {
  return join(codexLhcHome(), "registry.sqlite");
}

export function defaultLineageDbPath(): string {
  return join(codexLhcHome(), "codex-lhc.sqlite");
}

export function defaultThreadFilePath(): string {
  const dir = join(codexLhcHome(), "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
}

export function captureThreadRef(threadId: string, registryPath: string = defaultRegistryPath()): {
  threadId: string;
  registryPath: string;
} {
  return { threadId, registryPath };
}

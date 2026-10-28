import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Lhc, ThreadRef } from "lhc";

import { dumpRolloutLines, dumpSessionThreadView, parseRolloutContent } from "../verify/transcript-dump.js";
import type { DispatchOutcome, LhcCommandRuntime } from "./dispatch.js";

export async function runExportCommand(_commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  if (runtime.sdk === undefined || runtime.threadRef === undefined) return { messages: ["capture not ready"] };

  const sdk = runtime.sdk as Lhc;
  const threadRef = runtime.threadRef as ThreadRef;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const written: string[] = [];

  if (runtime.sourceRolloutPath !== undefined) {
    const rolloutDumpPath = join(runtime.cwd, `cc-lhc-rollout-${stamp}.txt`);
    const content = await readFile(runtime.sourceRolloutPath, "utf8");
    await writeFile(rolloutDumpPath, dumpRolloutLines(parseRolloutContent(content)), "utf8");
    written.push(rolloutDumpPath);
  }

  const view = await sdk.threadView.getSessionThreadView(threadRef);
  if (!view.ok) {
    return { messages: [...written.map((path) => `exported ${path}`), `view error: ${view.error.reason}`] };
  }
  const viewDumpPath = join(runtime.cwd, `cc-lhc-threadview-${stamp}.txt`);
  await writeFile(viewDumpPath, dumpSessionThreadView(view.value), "utf8");
  written.push(viewDumpPath);

  return { messages: written.map((path) => `exported ${path}`) };
}

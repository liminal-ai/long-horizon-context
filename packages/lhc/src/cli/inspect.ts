// `lhc inspect overview|view|health` (Epic 04 Story 2) per tech design
// §Placement: thin argv-to-SDK wrappers — no logic beyond arg mapping, so
// CLI parity with the SDK result is structural (same code path, same JSON).
import * as inspect from "../domains/inspect/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import { renderResult, type CliResult } from "./render.js";

export async function runInspectOverview(threadRef: ThreadRef): Promise<CliResult> {
  return renderResult(await inspect.overview(threadRef));
}

export async function runInspectHealth(threadRef: ThreadRef): Promise<CliResult> {
  return renderResult(await inspect.health(threadRef));
}

export async function runInspectView(threadRef: ThreadRef): Promise<CliResult> {
  return renderResult(await inspect.view(threadRef));
}

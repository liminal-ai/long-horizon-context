// Inspect is a pure consumer of other public surfaces: it imports no internals,
// owns no tables, calls no inference, and writes nothing. It reports repair
// targets without executing repair; mutations stay on the owning surfaces.
//
// `view` reports the stored snapshot from `threadView.describe` plus the
// serving cost measured from thread-view serving assembly, matching what agents
// receive by construction.
//
// Reads-only is structural: every operation runs in the touch-suppressed scope,
// so open announcements fired by composed surfaces cannot let background
// scheduling hang catch-up work or inference off an inspect read.

import type { HealthReport, InspectOverview, OpResult, ViewContentsReport } from "../shared-tech/index.js";
import type { ThreadRef } from "../threads/index.js";
import { composeHealth } from "./internal/health.js";
import { composeOverview } from "./internal/overview.js";
import { composeViewReport } from "./internal/view-report.js";

export type { HealthReport, InspectOverview, ViewContentsReport };

export async function overview(ref: ThreadRef): Promise<OpResult<InspectOverview>> {
  return composeOverview(ref);
}

export async function health(ref: ThreadRef): Promise<OpResult<HealthReport>> {
  return composeHealth(ref);
}

export async function view(ref: ThreadRef): Promise<OpResult<ViewContentsReport>> {
  return composeViewReport(ref);
}

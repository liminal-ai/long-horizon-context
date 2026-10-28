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

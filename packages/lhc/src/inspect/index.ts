// inspect surface (Epic 04): overview, view, health. The domain at the top
// of the graph — a pure consumer of five other surfaces, importing no
// internals, owning no tables, calling no inference, writing nothing. It
// reports repair targets without executing repair; mutations stay Feature 2
// behavior on the owning surfaces.
//
// Story 2 landed overview and health; Story 3 lands `view` — the stored
// snapshot from `threadView.describe` plus the serving cost measured from
// thread-view serving assembly (parity by construction, DD-4).
//
// Reads-only is structural, not disciplined (DD-6): every operation runs in
// the touch-suppressed scope, so the open announcements fired by the surfaces
// it composes can never let a background SDK's scheduler hang a first-touch
// catch-up drain — and the inference call that drain would make — off an
// inspect read.

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

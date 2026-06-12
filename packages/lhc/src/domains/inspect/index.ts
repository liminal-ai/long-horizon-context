// inspect surface (Epic 04): overview, view, health. The domain at the top
// of the graph — a pure consumer of five other surfaces, importing no
// internals, owning no tables, calling no provider, writing nothing. It
// reports repair targets without executing repair; mutations stay Feature 2
// behavior on the owning surfaces.
//
// Story 2 lands overview and health; `view` returns the structured
// not-implemented result until Story 3 lands the describe+pull report.
//
// Reads-only is structural, not disciplined (DD-6): every operation runs in
// the touch-suppressed scope, so the open announcements fired by the surfaces
// it composes can never let a background SDK's scheduler hang a first-touch
// catch-up drain — and the provider call that drain would make — off an
// inspect read.
import { runWithThreadTouchSuppressed } from "../../shared/context.js";
import type { OpResult } from "../../shared/errors.js";
import type {
  HealthReport,
  InspectOverview,
  ViewContentsReport,
} from "../../shared/inspect.js";
import type { ThreadRef } from "../threads/index.js";
import { composeHealth } from "./internal/health.js";
import { composeOverview } from "./internal/overview.js";

export type { HealthReport, InspectOverview, ViewContentsReport };

export async function overview(ref: ThreadRef): Promise<OpResult<InspectOverview>> {
  return runWithThreadTouchSuppressed(() => composeOverview(ref));
}

export async function health(ref: ThreadRef): Promise<OpResult<HealthReport>> {
  return runWithThreadTouchSuppressed(() => composeHealth(ref));
}

// Story 3 (view contents report): the surface-skeleton stub contract —
// machine-readable, never a throw (the Epic 03 precedent).
export async function view(_ref: ThreadRef): Promise<OpResult<ViewContentsReport>> {
  return {
    ok: false,
    error: {
      errorClass: "system_error",
      code: "not_implemented",
      reason: "inspect.view lands with Epic 04 Story 3 (view contents report)",
    },
  };
}

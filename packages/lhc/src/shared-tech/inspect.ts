// Inspect report shapes. Inspect is a pure consumer: these shapes carry other
// domains' surface output composed into counts and summaries; nothing here is
// re-derived or re-interpreted beyond the owners' reported states.
import type { Band } from "./view.js";

export interface InspectOverview {
  thread: { id: string; createdAt: string; metadata?: Record<string, string> };
  // span null means count 0: absent pieces report as zeros/nulls.
  events: { count: number; span: { first: number; last: number } | null };
  // Deleted messages appear only in `deleted`: excluded from visible, byKind,
  // and visibleTokens. Event counts above are unaffected because the record
  // retains everything.
  messages: {
    visible: number;
    byKind: Record<string, number>;
    deleted: number;
    visibleTokens: number;
  };
  turns: { open: number; closed: number };
  chunks: { count: number; unchunkedTurns: number };
  // Counts by operational state across both owners' report surfaces; ready
  // included, unlike ViewStatus, which reports situations only.
  derivation: {
    ready: number;
    pending: number;
    failed: number;
    blocked: number;
  };
  // Active-view summary, or null when never compacted.
  view: {
    viewId: string;
    createdAt: string;
    compactPoint: number;
    coveredFrom: number;
  } | null;
  visibility: { boundaryPosition: number; zoneTokens: number };
}

// View-contents report shape served by `inspect.view`.
export interface ViewContentsReport {
  meta: {
    viewId: string;
    createdAt: string;
    profile: string | null;
    config: { lowerBound: number; percentages: Record<string, number> };
    compactPoint: number;
    coveredFrom: number;
  } | null;
  bands: Array<{
    band: Band;
    entries: Array<{
      subjectKind: "chunk" | "turn";
      subjectId: string;
      derivationUsed: string;
      degraded: boolean;
    }>;
    storedTokens: number;
  }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  tail: { messageCount: number; tokens: number }; // as served
  // loadCost totals what model context serves now: band and tail tokens are
  // both measured over served messages with the shared estimator, so equality
  // with an independent context read is structural. The stored per-band counts
  // stay reported above; they price the snapshot bytes without the served
  // band-marker header, so they are describe's truth, not the serving cost.
  loadCost: { bandTokens: number; tailTokens: number; total: number }; // = model context
  // Provenance verbatim; null on a never-compacted thread because no compact
  // ever recorded what it saw, and inventing zeros would fabricate provenance.
  sourceState: { maxEventOrder: number; derivationCounts: Record<string, number> } | null;
}

export interface HealthReport {
  // Counts by owner, derivation kind, and operational state, assembled entirely
  // from the owners' report surfaces.
  owners: Array<{
    owner: "capture" | "messages" | "turns";
    kind: string;
    counts: {
      ready: number;
      pending: number;
      failed: number;
      blocked: number;
    };
  }>;
  // Actionable failure detail: enough to decide and target a requeue without
  // raw SQL.
  failures: Array<{
    owner: string;
    subjectKind: string;
    subjectId: string;
    derivationType: string;
    reason: string;
  }>;
  // What a requeue pass would touch: failed and not blocked, reported, never
  // executed.
  repairPreview: Array<{
    owner: string;
    subjectKind: string;
    subjectId: string;
    derivationType: string;
  }>;
  // Live queue visibility from the owners' queue detail, counted per report
  // entry so the section is consistent by construction with the pending state
  // counts in the same report.
  queue: { queued: number; claimed: number };
}

// Epic 04 shared vocabulary: the inspect domain's report shapes (tech design
// §Interface Definitions). Inspect is a pure consumer — these shapes carry
// other domains' surface output composed into counts and summaries; nothing
// here is re-derived or re-interpreted beyond the owners' reported states.
import type { Band } from "./view.js";

export interface InspectOverview {
  thread: { id: string; createdAt: string; metadata?: Record<string, string> };
  // span null ⇔ count 0 (AC-1.3: absent pieces report as zeros/nulls).
  events: { count: number; span: { first: number; last: number } | null };
  // Deleted contract (AC-1.2): deleted messages appear only in `deleted` —
  // excluded from visible, byKind, and visibleTokens; event counts above are
  // unaffected (the record retains everything).
  messages: {
    visible: number;
    byKind: Record<string, number>;
    deleted: number;
    visibleTokens: number;
  };
  turns: { open: number; closed: number };
  chunks: { count: number; unchunkedTurns: number };
  // Counts by operational state across both owners' report surfaces; ready
  // included (AC-1.1 — unlike ViewStatus, which reports situations only).
  derivation: {
    ready: number;
    pending: number;
    retrying: number;
    failed: number;
    blocked: number;
  };
  // Active-view summary, or null when never compacted (AC-1.1).
  view: {
    viewId: string;
    createdAt: string;
    compactPoint: number;
    coveredFrom: number;
  } | null;
  visibility: { boundaryPosition: number; zoneTokens: number };
}

// Story 3's shape, pinned with the domain so the inspect vocabulary lands
// whole (tech design §Interface Definitions); `inspect.view` serves it.
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
      formUsed: string;
      degraded: boolean;
    }>;
    storedTokens: number;
  }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  tail: { messageCount: number; tokens: number }; // as served (AC-2.2)
  // loadCost totals what pull serves NOW (AC-2.3): band and tail tokens are
  // both measured over pull's served messages with the shared estimator, so
  // equality with an independent pull is structural. The stored per-band
  // counts stay reported above (bands[].storedTokens, AC-2.1) — they price
  // the snapshot bytes without the served band-marker header, so they are
  // describe's truth, not the serving cost.
  loadCost: { bandTokens: number; tailTokens: number; total: number }; // = pull (AC-2.3)
  // Provenance verbatim (AC-2.5); null on a never-compacted thread — no
  // compact ever recorded what it saw, and inventing zeros would fabricate
  // provenance (AC-2.4's view-null shape extends here).
  sourceState: { maxEventOrder: number; formCounts: Record<string, number> } | null;
}

export interface HealthReport {
  // Counts by owner, form kind, and operational state (AC-4.1), assembled
  // entirely from the owners' report surfaces.
  owners: Array<{
    owner: "capture" | "messages" | "turns";
    kind: string;
    counts: {
      ready: number;
      pending: number;
      retrying: number;
      failed: number;
      blocked: number;
    };
  }>;
  // Actionable failure detail (AC-4.2): enough to decide and target a
  // requeue without raw SQL.
  failures: Array<{
    owner: string;
    subjectKind: string;
    subjectId: string;
    form: string;
    reason: string;
    attempts: number;
    lastError?: string;
  }>;
  // What a requeue pass would touch — failed and not blocked — reported,
  // never executed (AC-4.3).
  repairPreview: Array<{
    owner: string;
    subjectKind: string;
    subjectId: string;
    form: string;
  }>;
  // Live queue visibility from the owners' queue detail (AC-4.5), counted
  // per report entry so the section is consistent by construction with the
  // pending/retrying state counts in the same report.
  queue: { queued: number; claimed: number };
}

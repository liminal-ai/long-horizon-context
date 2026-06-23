// Shared thread-view vocabulary. Shared so CLI, SDK, and tests import one
// home; the thread-view domain owns behavior, this module owns only shapes.

export type Band = "brief" | "detailed" | "smooth";

export interface ViewProfile {
  name: string;
  // Target assembled size; whole-entry fills may land under or over because
  // the bound is a target, not a cap.
  lowerBound: number;
  // Band shares of the lower bound; must sum to 100.
  percentages: { full: number; smooth: number; detailed: number; brief: number };
}

// A user profile entry as configured: a full profile under a new name, or a
// field-wise override of a built-in merged by name. A partial entry
// whose name matches no built-in has nothing to merge over and is rejected at
// construction.
export interface ViewProfileOverride {
  name: string;
  lowerBound?: number;
  percentages?: Partial<ViewProfile["percentages"]>;
}

// Compact-time explicit parameters: field-wise overrides of the base profile,
// down to single band percentages — the same depth the CLI's per-band flags
// override at.
export interface ViewCompactParams {
  lowerBound?: number;
  percentages?: Partial<ViewProfile["percentages"]>;
}

// Visibility-boundary budgets: max > target, both positive. The floor budget is
// retired because the turn-end trigger and never-evicted newest closed turn
// provide that protection structurally.
export interface VisibilityBudgets {
  maxTokens: number;
  targetTokens: number;
}

// ── SDK assembly config ──────────────────────────────────────────
export interface SdkViewConfig {
  profiles?: ViewProfileOverride[]; // merged over built-ins by name
  visibility?: Partial<VisibilityBudgets>; // defaults: 64000 / 32000
  compactThreshold?: number; // status trigger; default 160000
}

// Every optional filled by initLhc's central defaults; profiles resolved
// to complete, validated entries keyed by name.
export interface ResolvedViewConfig {
  profiles: Readonly<Record<string, ViewProfile>>;
  visibility: VisibilityBudgets;
  compactThreshold: number;
}

// ── model-context / status shapes (the product crossing to the harness) ────
export interface LlmRequestContextPart {
  type: "text";
  text: string;
}

export interface LlmRequestContextMessage {
  role: "user" | "assistant";
  content: LlmRequestContextPart[];
}

export interface LlmRequestContext {
  threadId: string;
  messages: LlmRequestContextMessage[];
}

// The stored active view row as `threadView.describe` exposes it: snapshot
// fields verbatim — arrangement, gaps, config, source-state provenance, and
// per-band stored token counts — never recomputed, never repaired. Absent view
// means describe returns ok/null, mirroring status's never-compacted behavior.
export interface StoredView {
  viewId: string;
  createdAt: string;
  compactPoint: number;
  coveredFrom: number;
  // null when explicit params overrode a named base at compact (the stored
  // config carries the resolved truth either way).
  profileName: string | null;
  config: { lowerBound: number; percentages: Record<string, number> };
  // Every selected entry in served order, gap entries included (they are
  // arrangement rows too; `gaps` carries their reasons).
  arrangement: Array<{
    band: Band;
    subjectKind: "chunk" | "turn";
    subjectId: string;
    derivationUsed: string;
    degraded: boolean;
  }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  // What the compact saw, stored verbatim.
  sourceState: { maxEventOrder: number; derivationCounts: Record<string, number> };
  // Non-empty bands in gradient order with their stored token counts.
  bands: Array<{ band: Band; storedTokens: number }>;
}

export interface ViewStatus {
  tailTokens: number;
  threshold: number;
  compactRecommended: boolean;
  derivation: { pending: number; retrying: number; failed: number; blocked: number };
  view: { degraded: number; gaps: number; builtAt: string } | null;
  visibility: { boundaryPosition: number; zoneTokens: number; maxTokens: number };
}

// ── receipts ─────────────────────────────────────────────────────
export interface CompactReceipt {
  viewId: string;
  profile: string | null;
  config: ViewProfile["percentages"] & { lowerBound: number };
  bands: Record<Band, { entries: number; tokens: number }>;
  tailTokens: number;
  // The assembled view's actual total (band tokens + tail tokens) against
  // the configured lower bound — a target, not a cap: whole-entry fills may
  // land under it, indivisible entries over it.
  totalTokens: number;
  coveredFrom: number;
  compactPoint: number;
  degraded: Array<{ band: Band; subjectId: string; usedDerivation: string }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  warnings?: Array<{
    band: Band;
    subjectId: string;
    derivationType: "chunk_summary_detailed" | "chunk_summary_brief";
    reason: string;
  }>;
  // The embedded sweep's receipt: sweep runs first by default and its full
  // receipt embeds here; `sweep: false` records the skip. The receipt always
  // says whether sweep ran.
  sweep: SweepReceipt | { skipped: true };
}

export interface SweepReceipt {
  owners: Array<{
    owner: "messages" | "turns";
    kind: string;
    ready: number;
    inFlight: number;
    requeued: string[]; // subject ids
    blocked: Array<{ subjectId: string; reason: string }>;
    permanentFailed: Array<{ subjectId: string; reason: string }>;
  }>;
}

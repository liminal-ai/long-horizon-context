// Epic 03 shared vocabulary: the thread-view types (tech design §Interface
// Definitions). Shared so cli/sdk/tests import one home; the thread-view
// domain owns the behavior, this module owns only the shapes.

export type Band = "brief" | "detailed" | "smooth";

export interface ViewProfile {
  name: string;
  // Target assembled size; whole-entry fills may land under or over (epic
  // Data Contracts — the bound is a target, not a cap).
  lowerBound: number;
  // Band shares of the lower bound; must sum to 100 (AC-2.3).
  percentages: { full: number; smooth: number; detailed: number; brief: number };
}

// A user profile entry as configured: a full profile under a new name, or a
// field-wise override of a built-in (merged by name, AC-2.2). A partial entry
// whose name matches no built-in has nothing to merge over and is rejected at
// construction (FC-0.2's unknown-override violation).
export interface ViewProfileOverride {
  name: string;
  lowerBound?: number;
  percentages?: Partial<ViewProfile["percentages"]>;
}

// Visibility-boundary budgets (AC-4.x): max > target ≥ floor, all positive.
export interface VisibilityBudgets {
  maxTokens: number;
  targetTokens: number;
  floorTokens: number;
}

// ── SDK assembly config (validated at construction, throws on nonsense
// per the Epic 02 rule) ───────────────────────────────────────────
export interface SdkViewConfig {
  profiles?: ViewProfileOverride[]; // merged over built-ins by name
  visibility?: Partial<VisibilityBudgets>; // defaults: 32000 / 24000 / 8000
  compactThreshold?: number; // status trigger; default 160000
}

// Every optional filled by createSdk's central defaults; profiles resolved
// to complete, validated entries keyed by name.
export interface ResolvedViewConfig {
  profiles: Readonly<Record<string, ViewProfile>>;
  visibility: VisibilityBudgets;
  compactThreshold: number;
}

// ── pull / status shapes (the product crossing to the harness) ────
export interface ViewMessage {
  role: "user" | "assistant";
  content: string;
  band?: Band; // band absent ⇒ tail
}

export interface ViewMeta {
  compactPoint: number | null; // null ⇒ never compacted (AC-1.3)
  coveredFrom: number | null;
  boundaryPosition: number;
  gapCount: number;
  degradedCount: number;
  viewId: string | null;
  createdAt: string | null;
}

export interface PullResult {
  messages: ViewMessage[];
  meta: ViewMeta;
}

export interface ViewStatus {
  tailTokens: number;
  threshold: number;
  compactRecommended: boolean;
  derivation: { pending: number; retrying: number; failed: number; blocked: number };
  view: { degraded: number; gaps: number; builtAt: string } | null;
  visibility: { zoneTokens: number; maxTokens: number };
}

// ── receipts (AC-2.7, AC-3.x) ─────────────────────────────────────
export interface CompactReceipt {
  viewId: string;
  profile: string | null;
  config: ViewProfile["percentages"] & { lowerBound: number };
  bands: Record<Band, { entries: number; tokens: number }>;
  tailTokens: number;
  coveredFrom: number;
  compactPoint: number;
  degraded: Array<{ band: Band; subjectId: string; usedForm: string }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
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

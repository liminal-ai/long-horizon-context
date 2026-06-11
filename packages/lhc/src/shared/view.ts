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

// Compact-time explicit parameters (AC-2.2): field-wise overrides of the
// base profile, down to single band percentages — the same depth the CLI's
// per-band flags override at. A nested-partial deepening of the tech
// design's `Partial<ViewProfile>` sketch, which could not express a
// single-band override.
export interface ViewCompactParams {
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
//
// The pull's array shape (Story 1, load-bearing for Stories 2–5): band
// messages first — one `user` message per non-empty band, gradient order
// brief → detailed → smooth, marker header + snapshot bytes verbatim — then
// the tail in record order. Tail messages render by the message-kind mapping
// table (tech design §Tail message rendering), the contract every later
// story renders into:
//
//   | Message kind                       | Role      | Content shape |
//   |------------------------------------|-----------|---------------|
//   | user_prompt                        | user      | text verbatim |
//   | assistant_text                     | assistant | text verbatim |
//   | assistant_thinking                 | assistant | fenced: `[thinking]\n<text>\n[/thinking]` — included (the tail is full fidelity) |
//   | tool_call                          | assistant | `[tool call · <name>] <compact args>` — deterministic arg rendering, abbreviation rule for oversized args |
//   | tool_result (ahead of boundary)    | user      | `[tool result · <name>]\n<full content>` |
//   | tool_result (at-or-behind boundary)| user      | `[tool result · <name> · abridged]\n<summary or deterministic truncation>` (short-form ladder) |
//   | runtime_note                       | user      | `[runtime note] <text>` |
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
  // The assembled view's actual total (band tokens + tail tokens) against
  // the configured lower bound — a target, not a cap: whole-entry fills may
  // land under it, indivisible entries over it (AC-2.4; ruling 013).
  totalTokens: number;
  coveredFrom: number;
  compactPoint: number;
  degraded: Array<{ band: Band; subjectId: string; usedForm: string }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  // The embedded sweep's receipt (AC-3.6): the sweep runs first by default
  // and its full receipt embeds here; `sweep: false` records the skip — the
  // receipt always says whether the sweep ran (Story 3 closed Story 2's
  // "absent" placeholder).
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

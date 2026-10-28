import type { Band } from "./view.js";

export interface InspectOverview {
  thread: { id: string; createdAt: string; metadata?: Record<string, string> };
  events: { count: number; span: { first: number; last: number } | null };
  messages: {
    visible: number;
    byKind: Record<string, number>;
    deleted: number;
    visibleTokens: number;
  };
  turns: { open: number; closed: number };
  chunks: { count: number; unchunkedTurns: number };
  derivation: {
    ready: number;
    pending: number;
    failed: number;
    blocked: number;
  };
  view: {
    viewId: string;
    createdAt: string;
    compactPoint: number;
    coveredFrom: number;
  } | null;
  visibility: { boundaryPosition: number; zoneTokens: number };
}

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
  tail: { messageCount: number; tokens: number };
  loadCost: { bandTokens: number; tailTokens: number; total: number };
  sourceState: { maxEventOrder: number; derivationCounts: Record<string, number> } | null;
}

export interface HealthReport {
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
  failures: Array<{
    owner: string;
    subjectKind: string;
    subjectId: string;
    derivationType: string;
    reason: string;
  }>;
  repairPreview: Array<{
    owner: string;
    subjectKind: string;
    subjectId: string;
    derivationType: string;
  }>;
  queue: { queued: number; claimed: number };
}

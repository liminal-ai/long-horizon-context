export type WorkOwner = "messages" | "turns";
export type WorkKind = "prompt_smoothing" | "tool_result_summary" | "turn_derivation";
export type WorkSourceRef = { messageId: string } | { turnId: string };

export interface WorkItemRecord {
  workItemId: string;
  owner: WorkOwner;
  kind: WorkKind;
  sourceRef: WorkSourceRef;
  status: "queued"; // the only status this epic writes
  queuedAt: string;
}

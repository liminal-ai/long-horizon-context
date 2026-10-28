import type { DatabaseSync } from "node:sqlite";

export const STEP_BEARING_KINDS = new Set(["assistant_text", "assistant_thinking", "tool_call", "tool_result"]);

export interface StepMember {
  messageId: string;
  order: number;
  kind: string;
  stepIndex: number | null;
  toolCallId?: string;
}

export interface StepRange {
  index: number;
  firstMessageId: string;
  lastMessageId: string;
  firstOrder: number;
  lastOrder: number;
  complete: boolean;
}

export interface StepEdges {
  splittable: boolean;
  steps: StepRange[];
  complete: number;
  lastEdge: number | null;
}

export function readStepMembers(db: DatabaseSync, turnId: string): StepMember[] {
  const rows = db
    .prepare(
      `SELECT m.message_id, m.source_event_order, m.kind, m.step_index,
              json_extract(mb.content, '$.toolCallId') AS tool_call_id
       FROM message m
       LEFT JOIN message_block mb ON mb.message_id = m.message_id AND mb.block_index = 0
       WHERE m.turn_id = ? AND m.deleted_at IS NULL
       ORDER BY m.source_event_order`,
    )
    .all(turnId) as unknown as Array<{
    message_id: string;
    source_event_order: number | bigint;
    kind: string;
    step_index: number | bigint | null;
    tool_call_id: string | null;
  }>;
  return rows.map((row) => {
    const member: StepMember = {
      messageId: row.message_id,
      order: Number(row.source_event_order),
      kind: row.kind,
      stepIndex: row.step_index === null ? null : Number(row.step_index),
    };
    if ((row.kind === "tool_call" || row.kind === "tool_result") && typeof row.tool_call_id === "string") {
      member.toolCallId = row.tool_call_id;
    }
    return member;
  });
}

export function stepEdges(members: readonly StepMember[]): StepEdges {
  const steps: StepRange[] = [];
  let splittable = true;
  let previousIndex = -1;
  let openCalls = new Map<string, true>();
  let straddled = false;
  const callStep = new Map<string, number>();

  const closeStep = (): void => {
    const current = steps[steps.length - 1];
    if (current === undefined) return;
    current.complete = openCalls.size === 0 && !straddled;
  };

  for (const member of members) {
    if (!STEP_BEARING_KINDS.has(member.kind)) continue;
    if (member.stepIndex === null) {
      splittable = false;
      continue;
    }
    if (member.stepIndex !== previousIndex) {
      if (member.stepIndex !== previousIndex + 1) splittable = false;
      closeStep();
      steps.push({
        index: member.stepIndex,
        firstMessageId: member.messageId,
        lastMessageId: member.messageId,
        firstOrder: member.order,
        lastOrder: member.order,
        complete: false,
      });
      openCalls = new Map();
      straddled = false;
      previousIndex = member.stepIndex;
    }
    const current = steps[steps.length - 1];
    if (current !== undefined) {
      current.lastMessageId = member.messageId;
      current.lastOrder = member.order;
    }
    if (member.kind === "tool_call" && member.toolCallId !== undefined) {
      openCalls.set(member.toolCallId, true);
      callStep.set(member.toolCallId, member.stepIndex);
    }
    if (member.kind === "tool_result" && member.toolCallId !== undefined) {
      const issuedIn = callStep.get(member.toolCallId);
      if (issuedIn === member.stepIndex && openCalls.has(member.toolCallId)) {
        openCalls.delete(member.toolCallId);
      } else {
        straddled = true;
        splittable = false;
      }
    }
  }
  closeStep();

  let complete = 0;
  for (const step of steps) {
    if (!step.complete) break;
    complete += 1;
  }
  if (steps.length === 0) splittable = false;
  return {
    splittable,
    steps,
    complete,
    lastEdge: complete >= 2 ? complete - 1 : null,
  };
}

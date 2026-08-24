// Step edges over one turn's live members, from the host-supplied step index
// (schema v12). Pure: no DB, no inference. This is the one reader of step
// structure the walk and the host metadata surface consume; the record never
// infers a step, so a turn whose step-bearing members carry no index — or an
// inconsistent one — is simply not splittable.
//
// A step is complete when every tool_call it holds has its tool_result in the
// same step, after it. Steps count contiguously from the first: an incomplete
// step ends the complete prefix, and the newest admissible split edge is the
// edge preceding the newest complete step (the minimum verbatim tail always
// keeps the last complete step).

export const STEP_BEARING_KINDS = new Set(["assistant_text", "assistant_thinking", "tool_call", "tool_result"]);

export interface StepMember {
  messageId: string;
  kind: string;
  stepIndex: number | null;
  toolCallId?: string;
}

export interface StepRange {
  index: number;
  firstMessageId: string;
  lastMessageId: string;
  complete: boolean;
}

export interface StepEdges {
  // Whether the turn may be split at all: every step-bearing member carries an
  // index, indices are non-decreasing in message order, and no tool pair
  // straddles a step. False also for a turn with no steps.
  splittable: boolean;
  // Every step present, in order, whether or not the turn is splittable.
  steps: StepRange[];
  // Leading run of complete steps.
  complete: number;
  // Newest admissible k: the number of steps a part may cover — one fewer
  // than the complete prefix. Null when no step is complete.
  lastEdge: number | null;
}

export function stepEdges(members: readonly StepMember[]): StepEdges {
  const steps: StepRange[] = [];
  let splittable = true;
  let previousIndex = -1;
  // Per step: calls awaiting a result, and results seen without their call.
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
    if (member.stepIndex < previousIndex) splittable = false;
    if (member.stepIndex !== previousIndex) {
      closeStep();
      steps.push({
        index: member.stepIndex,
        firstMessageId: member.messageId,
        lastMessageId: member.messageId,
        complete: false,
      });
      openCalls = new Map();
      straddled = false;
      previousIndex = member.stepIndex;
    }
    const current = steps[steps.length - 1];
    if (current !== undefined) current.lastMessageId = member.messageId;
    if (member.kind === "tool_call" && member.toolCallId !== undefined) {
      openCalls.set(member.toolCallId, true);
      callStep.set(member.toolCallId, member.stepIndex);
    }
    if (member.kind === "tool_result" && member.toolCallId !== undefined) {
      const issuedIn = callStep.get(member.toolCallId);
      if (issuedIn === member.stepIndex && openCalls.has(member.toolCallId)) {
        openCalls.delete(member.toolCallId);
      } else {
        // Result before its call, in a different step, or with no call: the
        // pair does not sit whole inside one step.
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
    lastEdge: complete >= 1 ? complete - 1 : null,
  };
}

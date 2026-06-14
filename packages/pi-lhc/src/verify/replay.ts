import type { MessageEventInput, ThreadRef } from "lhc";
import type { AgentMessage } from "../pi/types.js";

// AC-6.1, AC-6.2. Replay a recorded corpus through the converter into a temp
// thread and compare read-back to the fixture expectation; the same corpus
// replayed twice yields identical read-back. Story 3.

/** A loaded corpus: synthetic PI source messages (the stand-in until M0
 *  delivers recordings) paired with the expected LHC intake events. Both
 *  `verify/replay` and the corpus fixtures consume this shape. */
export interface Corpus {
  name: string;
  source: AgentMessage[];
  expected: MessageEventInput[];
}

export interface ReplayResult {
  matches: boolean;
  diff?: string;
}

/** Fail-closed until Story 3 — `matches:false`, never a faked pass (story
 *  §Anti-Shim: no stub reports successful replay). */
export function replayCorpus(corpus: Corpus, threadRef: ThreadRef): Promise<ReplayResult> {
  return Promise.resolve({
    matches: false,
    diff: "verify.replayCorpus is not implemented yet (Epic 1 foundation stub)",
  });
}

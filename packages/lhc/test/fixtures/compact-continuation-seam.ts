// Epic compact-continuation test seams. Lives in fixtures/ — the one
// directory sanctioned to reach below the SDK surface (boundary check exempt).
//
// Production `runCompactContinuation` / public HostFacts reject testHooks.
// Tests inject faults only through this internal runner and seed helpers.

import type { CompactContinuationHostFacts } from "../../src/compact-continuation/index.js";
import {
  type CompactContinuationTestHooks,
  type CompactContinuationWriterOwnershipCheck,
  runCompactContinuationForTests as runCompactContinuationForTestsInner,
} from "../../src/compact-continuation/internal/run.js";
import type { ThreadRef } from "../../src/threads/index.js";
import { o200k, withEstimator } from "./tokens.js";

export type { CompactContinuationTestHooks };

export function runCompactContinuationForTests(
  ref: ThreadRef,
  facts: CompactContinuationHostFacts,
  clock?: () => Date,
  hooks?: CompactContinuationTestHooks,
  writerOwnershipCheck?: CompactContinuationWriterOwnershipCheck,
) {
  return withEstimator(o200k, () =>
    runCompactContinuationForTestsInner(ref, facts, clock, hooks, writerOwnershipCheck),
  );
}

export {
  forceClearWriter,
  seedWriterClaim,
} from "../../src/compact-continuation/internal/store.js";

// Epic compact-continuation test seams. Lives in fixtures/ — the one
// directory sanctioned to reach below the SDK surface (boundary check exempt).
//
// Production `runCompactContinuation` / public HostFacts reject testHooks.
// Tests inject faults only through this internal runner and seed helpers.

export {
  type CompactContinuationTestHooks,
  runCompactContinuationForTests,
} from "../../src/compact-continuation/internal/run.js";

export {
  forceClearWriter,
  seedWriterClaim,
} from "../../src/compact-continuation/internal/store.js";

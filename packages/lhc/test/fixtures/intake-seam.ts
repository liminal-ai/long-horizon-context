// Test seam re-export for the intake walk. Lives in fixtures/ — the one
// directory sanctioned to reach below the SDK surface (boundary check exempt).
// setIntakeWalkHook induces real mid-walk failures (closing the handle inside
// the transaction) for the atomicity architecture-risk tests; setIntakeClock
// pins recordedAt to a fixed instant so the SDK contract proof (TC-1.4) can
// read back every field — recordedAt included — for an exact match.
export {
  setIntakeClock,
  setIntakeWalkHook,
  type IntakeWalkHook,
} from "../../src/domains/intake-stream/internal/pipeline.js";

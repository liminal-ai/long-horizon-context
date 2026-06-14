import type { FormKind, ModelAssignment } from "lhc";
import { NotImplementedError } from "../shared/not-implemented.js";

// AC-5.4, AC-5.5. Load the seven assignments from config; LHC's createSdk also
// shape-validates all seven at construction and throws (the "fail loud" half).

/** Load + shape-validate; throw loud on missing/unknown/placeholder. Story 6.
 *  Throws until then — it must never return a placeholder map that masks a
 *  missing assignment (story §Anti-Shim). */
export function loadAssignments(config: unknown): Record<FormKind, ModelAssignment> {
  throw new NotImplementedError("inference.loadAssignments");
}

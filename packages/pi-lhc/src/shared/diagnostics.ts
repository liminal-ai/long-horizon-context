import type { FormKind } from "lhc";

/** The startup reachability probe's structured result (tech design Flow 5,
 *  AC-5.1–5.3): which assignment lanes PI cannot reach, each with the distinct
 *  fix (`unknown_model` → fix the assignment; `auth_not_configured` → log in /
 *  configure auth).
 *
 *  Its spec'd home is inference/startup-validation.ts, which re-exports it;
 *  defined here so the plain-data `SessionState.health` can reference it
 *  without a lifecycle→inference import edge (keeps the surface graph acyclic). */
export interface ValidationReport {
  unreachable: {
    kind: FormKind;
    provider: string;
    model: string;
    reason: "unknown_model" | "auth_not_configured";
    fix: string;
  }[];
}

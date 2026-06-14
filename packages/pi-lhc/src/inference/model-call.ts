import type { ModelCall, ModelCallFailureKind, ModelCallResult } from "lhc";
import type { ExtensionContext } from "../pi/types.js";
import { NotImplementedError } from "../shared/not-implemented.js";

// AC-4.1..4.4. The host function resolves (provider,model) via
// `ctx.modelRegistry.find` and completes via pi-ai's `complete()` (imported
// from `@earendil-works/pi-ai` in Story 5), returning text or a classified
// failure. Provider/model are opaque routing keys.

/** Build the host `ModelCall`. Fail-closed until Story 5: the returned function
 *  resolves to a transport failure (`other`), never `{ ok: true }` — so no
 *  derivation can land on a faked completion (story §Anti-Shim). */
export function createModelCall(ctx: ExtensionContext): ModelCall {
  return (): Promise<ModelCallResult> =>
    Promise.resolve({
      ok: false,
      kind: "other",
      message: "inference.createModelCall is not implemented yet (Epic 1 foundation stub)",
    });
}

/** Pure mapping of a PI/pi-ai failure shape to a `ModelCallFailureKind`
 *  (terminal: auth, invalid_request; retryable: rate_limit, timeout, network;
 *  thrown → other). Story 5. */
export function classifyFailure(err: unknown): ModelCallFailureKind {
  throw new NotImplementedError("inference.classifyFailure");
}

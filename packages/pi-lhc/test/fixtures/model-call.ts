// Deterministic ModelCall fakes — the inference edge (tech design §Fixture
// Contracts / Testing Strategy). These stand in for `ctx.modelRegistry` +
// pi-ai `complete`, so the inference tests (Story 5) control completion text
// and failure shapes without a live provider.
import type { ModelCall, ModelCallFailureKind, ModelCallResult } from "lhc";

/** Always resolves to text. */
export function fakeModelCallText(text: string): ModelCall {
  return () => Promise.resolve<ModelCallResult>({ ok: true, text });
}

/** Always resolves to a classified transport failure. */
export function fakeModelCallFailure(
  kind: ModelCallFailureKind,
  message = `injected ${kind}`,
): ModelCall {
  return () => Promise.resolve<ModelCallResult>({ ok: false, kind, message });
}

/** Routes each call by its `provider/model` key to a per-lane fake — the
 *  multi-lane substrate for AC-4.2. An unrouted key resolves to an
 *  `invalid_request` failure (never a silent success). */
export function fakeModelCallRouter(
  routes: Record<string, ModelCall>,
  fallback?: ModelCall,
): ModelCall {
  return (input) => {
    const key = `${input.provider}/${input.model}`;
    const route = routes[key] ?? fallback;
    if (route === undefined) {
      return Promise.resolve<ModelCallResult>({
        ok: false,
        kind: "invalid_request",
        message: `no fake route for ${key}`,
      });
    }
    return route(input);
  };
}

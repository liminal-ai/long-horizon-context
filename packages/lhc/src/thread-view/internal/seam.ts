// Test injection facility (Story 0, FC-0.6): one mechanism, two named
// points, pattern from Epic 02's intake walk hook. Production code carries
// the points as no-ops unless a test installs a hook:
//   - "post-commit-advance": fired by the boundary advance after intake's
//     commit flush, before the advance computes (TC-4.6's failure injection —
//     an installed hook that throws stands in for an advance failure);
//   - "compact-write": fired by compact between the sweep and the view-write
//     transaction (TC-2.4's crash injection — a throwing hook proves the
//     prior view survives an aborted write).
// Tests reach the setters through test/fixtures/view-seam.ts (the one
// directory sanctioned to import below the SDK surface); production code
// only ever fires.
export type ViewInjectionPoint = "post-commit-advance" | "compact-write";

export type ViewInjectionHook = () => void;

const hooks: Record<ViewInjectionPoint, ViewInjectionHook | null> = {
  "post-commit-advance": null,
  "compact-write": null,
};

export function setViewInjectionHook(
  point: ViewInjectionPoint,
  hook: ViewInjectionHook | null,
): void {
  hooks[point] = hook;
}

// The production-side call: a no-op when nothing is installed. An installed
// hook's throw propagates to the call site on purpose — that is the injected
// failure the call site must survive.
export function fireViewInjection(point: ViewInjectionPoint): void {
  hooks[point]?.();
}

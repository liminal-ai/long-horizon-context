// Test injection facility for compact's write path. Production code carries
// the point as a no-op unless a test installs a hook: "compact-write" fires
// between the sweep and the view-write transaction.
// Tests reach the setters through test/fixtures/view-seam.ts (the one
// directory sanctioned to import below the SDK surface); production code
// only ever fires.
export type ViewInjectionPoint = "compact-write";

export type ViewInjectionHook = () => void;

const hooks: Record<ViewInjectionPoint, ViewInjectionHook | null> = {
  "compact-write": null,
};

export function setViewInjectionHook(point: ViewInjectionPoint, hook: ViewInjectionHook | null): void {
  hooks[point] = hook;
}

// The production-side call: a no-op when nothing is installed. An installed
// hook's throw propagates to the call site on purpose — that is the injected
// failure the call site must survive.
export function fireViewInjection(point: ViewInjectionPoint): void {
  hooks[point]?.();
}

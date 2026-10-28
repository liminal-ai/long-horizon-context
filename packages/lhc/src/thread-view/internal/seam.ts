import type { DatabaseSync } from "node:sqlite";

export type ViewInjectionPoint = "compact-write" | "compact-install-before-validate";

export type ViewInjectionHook = (ctx?: { db: DatabaseSync }) => void;

const hooks: Record<ViewInjectionPoint, ViewInjectionHook | null> = {
  "compact-write": null,
  "compact-install-before-validate": null,
};

export function setViewInjectionHook(point: ViewInjectionPoint, hook: ViewInjectionHook | null): void {
  hooks[point] = hook;
}

export function fireViewInjection(point: ViewInjectionPoint, ctx?: { db: DatabaseSync }): void {
  hooks[point]?.(ctx);
}

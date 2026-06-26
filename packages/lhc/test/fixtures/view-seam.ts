// Epic 03 Story 0 view-domain test seams. Lives in fixtures/ — the one
// directory sanctioned to reach below the SDK surface (boundary check
// exempt).
//
// The injection facility (FC-0.6): re-export of the thread-view seam so
// tests install crash/failure hooks at compact's write path between sweep
// and view write (TC-2.4). Uninstalled, production fires are no-ops.
export {
  fireViewInjection,
  setViewInjectionHook,
  type ViewInjectionHook,
  type ViewInjectionPoint,
} from "../../src/thread-view/internal/seam.js";

import { DatabaseSync } from "node:sqlite";

// Sanctioned below-SDK write (same sanctioning as corrupt.ts): seeds the
// view_boundary row to an arbitrary position for mid-tail context reads.
// UPDATE-only on purpose: thread creation seeded the singleton row.
export function seedViewBoundary(filePath: string, position: number): void {
  const db = new DatabaseSync(filePath);
  try {
    const changed = db
      .prepare(`UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1`)
      .run(position, new Date().toISOString());
    if (Number(changed.changes) !== 1) {
      throw new Error(
        `fixture seedViewBoundary hit ${String(changed.changes)} rows; expected the thread-creation singleton`,
      );
    }
  } finally {
    db.close();
  }
}

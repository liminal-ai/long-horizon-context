// Epic 03 Story 0 view-domain test seams. Lives in fixtures/ — the one
// directory sanctioned to reach below the SDK surface (boundary check
// exempt).
//
// The injection facility (FC-0.6): re-export of the thread-view seam so
// tests install crash/failure hooks at the two named points — the
// post-commit advance (TC-4.6) and compact's write path between sweep and
// view write (TC-2.4). Uninstalled, production fires are no-ops.
export {
  fireViewInjection,
  setViewInjectionHook,
  type ViewInjectionHook,
  type ViewInjectionPoint,
} from "../../src/domains/thread-view/internal/seam.js";

import { DatabaseSync } from "node:sqlite";

// Sanctioned below-SDK write (same sanctioning as corrupt.ts): seeds the
// view_boundary row to an arbitrary position for TC-1.4's mid-tail pulls.
// Boundary *mechanics* — how the position legally moves — are Story 4's to
// prove; this helper only manufactures a position the pull must respect.
// UPDATE-only on purpose: migration v6 seeded the singleton row, mirroring
// the production advance's write shape.
export function seedViewBoundary(filePath: string, position: number): void {
  const db = new DatabaseSync(filePath);
  try {
    const changed = db
      .prepare(
        `UPDATE view_boundary SET position = ?, updated_at = ? WHERE thread_singleton = 1`,
      )
      .run(position, new Date().toISOString());
    if (Number(changed.changes) !== 1) {
      throw new Error(
        `fixture seedViewBoundary hit ${String(changed.changes)} rows; expected the migration-seeded singleton`,
      );
    }
  } finally {
    db.close();
  }
}

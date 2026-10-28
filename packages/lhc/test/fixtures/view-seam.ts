export {
  fireViewInjection,
  setViewInjectionHook,
  type ViewInjectionHook,
  type ViewInjectionPoint,
} from "../../src/thread-view/internal/seam.js";

import { DatabaseSync } from "node:sqlite";

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

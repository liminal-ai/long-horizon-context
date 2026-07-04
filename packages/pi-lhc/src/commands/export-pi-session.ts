import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "../pi/types.js";
import {
  exportTimestamp,
  piSessionEntriesToExportEntries,
  serializeExportEntries,
} from "../serving/export-serializer.js";

export const LHC_EXPORT_PI_SESSION_COMMAND = "lhc-export-pi-session";

export async function handleExportPiSession(ctx: ExtensionCommandContext): Promise<void> {
  const entries = piSessionEntriesToExportEntries(ctx.sessionManager.getEntries());
  const filename = `lhc-pi-session-${exportTimestamp()}.txt`;
  const filepath = join(ctx.cwd, filename);
  writeFileSync(filepath, serializeExportEntries(entries), "utf8");
  ctx.ui.notify(`pi-lhc: PI session written to ${filename}`, "info");
}

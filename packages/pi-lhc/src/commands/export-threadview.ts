import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadRef } from "lhc";
import type { ExtensionCommandContext } from "../pi/types.js";
import {
  exportTimestamp,
  llmRequestContextMessagesToExportEntries,
  serializeExportEntries,
} from "../serving/export-serializer.js";
import type { LhcInstance } from "../shared/instance.js";

export const LHC_EXPORT_THREADVIEW_COMMAND = "lhc-export-threadview";

export async function handleExportThreadview(
  ctx: ExtensionCommandContext,
  threadRef: ThreadRef | null,
  instance: LhcInstance | null,
): Promise<void> {
  if (threadRef === null || instance === null) {
    ctx.ui.notify("pi-lhc: no active LHC thread", "error");
    return;
  }

  const result = await instance.sdk.threadView.getLlmRequestContext(threadRef);
  if (!result.ok) {
    ctx.ui.notify(`pi-lhc: failed to read thread view — ${result.error.reason}`, "error");
    return;
  }

  const entries = llmRequestContextMessagesToExportEntries(result.value.messages);
  const filename = `lhc-threadview-${exportTimestamp()}.txt`;
  const filepath = join(ctx.cwd, filename);
  writeFileSync(filepath, serializeExportEntries(entries), "utf8");
  ctx.ui.notify(`pi-lhc: thread view written to ${filename}`, "info");
}

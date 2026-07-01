import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadRef } from "lhc";
import type { ExtensionCommandContext } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";

export const LHC_DUMP_VIEW_COMMAND = "lhc-dump-view";

function timestamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

export async function handleDumpView(
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

  const lines: string[] = [];
  for (const message of result.value.messages) {
    const text = message.content.map((part) => part.text).join("");
    lines.push(`[${message.role}]`);
    lines.push(text);
    lines.push("");
  }

  const filename = `lhc-view-${timestamp()}.txt`;
  const filepath = join(ctx.cwd, filename);
  writeFileSync(filepath, lines.join("\n"), "utf8");
  ctx.ui.notify(`pi-lhc: thread view written to ${filename}`, "info");
}

import type { ThreadRef } from "lhc";
import type { ExtensionContext } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";
import type { CompactCancelCode, CompactDiagnostic } from "./handler.js";

export function compactCancelLogMessage(diagnostic: CompactDiagnostic): string {
  return `pi-lhc compact cancelled (${diagnostic.code}): ${diagnostic.reason}`;
}

export function createCompactDiagnosticsBuffer(): {
  push(diagnostic: CompactDiagnostic): void;
  clear(): void;
  snapshot(): readonly CompactDiagnostic[];
  last(): CompactDiagnostic | null;
} {
  const entries: CompactDiagnostic[] = [];
  return {
    push(diagnostic) {
      entries.push(diagnostic);
    },
    clear() {
      entries.length = 0;
    },
    snapshot() {
      return [...entries];
    },
    last() {
      return entries.at(-1) ?? null;
    },
  };
}

/** Fail-soft warning log for every compact cancel that has an active thread. */
export async function writeCompactCancelLog(
  instance: LhcInstance | null,
  threadRef: ThreadRef | null,
  diagnostic: CompactDiagnostic,
): Promise<void> {
  if (instance === null || threadRef === null) return;
  await instance.sdk.logging.write(threadRef, {
    level: "warning",
    message: compactCancelLogMessage(diagnostic),
    reason: diagnostic.code,
  });
}

export async function recordCompactCancel(args: {
  diagnostic: CompactDiagnostic;
  buffer: ReturnType<typeof createCompactDiagnosticsBuffer>;
  instance: LhcInstance | null;
  threadRef: ThreadRef | null;
  ctx: ExtensionContext;
}): Promise<void> {
  args.buffer.push(args.diagnostic);
  await writeCompactCancelLog(args.instance, args.threadRef, args.diagnostic);
  if (args.ctx.hasUI) {
    args.ctx.ui.notify(compactCancelLogMessage(args.diagnostic), "warning");
  }
}

export type { CompactCancelCode, CompactDiagnostic };

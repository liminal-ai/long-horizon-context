/**
 * Operator CLI: `cc-lhc backfill-labels <thread-id-or-prefix> [--dry-run]`.
 *
 * Explicit selected-thread label backfill through the SDK's pure-composition
 * operation. Operator-facing and thread-addressed by design — this is not a
 * model-callable retrieval op and takes no descriptor binding. It never
 * touches canonical events; the only mutation is the stored turn_rendering
 * row's content and derived_at, and a dry run mutates nothing.
 */

import { createDeterministicInferenceCallbacks, initLhc, type Lhc } from "lhc";

import { defaultRegistryPath } from "../intake/paths.js";

export interface BackfillCliDeps {
  initSdk?: () => Lhc;
  registryPath?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function isBackfillLabelsArgv(argv: readonly string[]): boolean {
  return argv[0] === "backfill-labels";
}

const USAGE = "usage: cc-lhc backfill-labels <thread-id-or-prefix> [--dry-run]";

export async function runBackfillLabelsCli(
  argv: readonly string[],
  deps: BackfillCliDeps = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const rest = argv.slice(1);
  const dryRun = rest.includes("--dry-run");
  const positional = rest.filter((arg) => arg !== "--dry-run");
  const unknownFlag = positional.find((arg) => arg.startsWith("-"));
  if (unknownFlag !== undefined) {
    err(`unknown flag: ${unknownFlag}`);
    err(USAGE);
    return 2;
  }
  if (positional.length !== 1 || positional[0] === undefined || positional[0] === "") {
    err(USAGE);
    return 2;
  }
  const threadIdOrPrefix = positional[0];
  const registryPath = deps.registryPath ?? defaultRegistryPath();

  // Manual + deterministic: the backfill path never calls a model and must not
  // start background drains against the operator's thread.
  const sdk =
    deps.initSdk?.() ??
    initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });

  const resolved = await sdk.threads.resolve({ threadId: threadIdOrPrefix, registryPath });
  if (!resolved.ok) {
    err(`thread resolve failed: ${resolved.error.reason}`);
    return 2;
  }
  const threadId = resolved.value.threadId;

  const result = await sdk.turns.backfillRenderingLabels(
    { threadId, registryPath },
    { dryRun },
  );
  if (!result.ok) {
    err(`backfill failed: ${result.error.reason}`);
    return result.error.errorClass === "caller_error" ? 2 : 1;
  }
  const receipt = result.value;
  const mode = receipt.dryRun ? "would relabel" : "relabeled";
  out(`[cc-lhc] backfill-labels thread ${threadId}${receipt.dryRun ? " (dry run)" : ""}`);
  out(
    `[cc-lhc] turns examined ${receipt.turnsExamined} · ${mode} ${receipt.relabeled.length} · already labeled ${receipt.alreadyLabeled} · skipped ${receipt.skipped.length}`,
  );
  if (receipt.relabeled.length > 0) out(`[cc-lhc] ${mode}: ${receipt.relabeled.join(" ")}`);
  for (const skip of receipt.skipped) {
    out(`[cc-lhc] skipped ${skip.turnId}: ${skip.reason}`);
  }
  return 0;
}

import { type CompactPolicy, type ThreadRef, threads } from "lhc";

export type { CompactPolicy };

export interface ResolvedCompactPolicy {
  readonly stored: CompactPolicy;
  readonly window: number | null;
}

const TRIGGER_WINDOW_SHARE = 0.8;
const TARGET_TRIGGER_SHARE = 0.5;

export function capCompactPolicyToWindow({ stored, window }: ResolvedCompactPolicy): CompactPolicy {
  if (window === null) return stored;
  const maxTrigger = Math.floor(window * TRIGGER_WINDOW_SHARE);
  if (stored.trigger <= maxTrigger) return stored;
  return { trigger: maxTrigger, target: Math.min(stored.target, Math.floor(maxTrigger * TARGET_TRIGGER_SHARE)) };
}

export function windowFromUsage(rawMaxTokens: unknown): number | null {
  return typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : null;
}

export async function storeCompactPolicy(ref: ThreadRef, policy: CompactPolicy): Promise<CompactPolicy> {
  const stored = await threads.setCompactPolicy(ref, policy);
  if (!stored.ok) throw new Error(`LHC compact policy write failed: ${stored.error.code}: ${stored.error.reason}`);
  return stored.value;
}

export async function resumeCompactPolicy(
  ref: ThreadRef,
  host: CompactPolicy | undefined,
  log: (line: string) => void,
): Promise<CompactPolicy> {
  const read = await threads.getCompactPolicy(ref);
  if (!read.ok) throw new Error(`LHC compact policy read failed: ${read.error.reason}`);
  const stored = read.value;
  if (stored !== null) {
    if (host !== undefined && (host.trigger !== stored.trigger || host.target !== stored.target))
      log(`compact policy from thread: trigger ${stored.trigger} target ${stored.target}`);
    return stored;
  }
  if (host === undefined) {
    throw new Error("the resumed thread has no stored compact policy and the start sent no lhc.compact");
  }
  log(`compact policy stored on thread: trigger ${host.trigger} target ${host.target}`);
  return storeCompactPolicy(ref, host);
}

export type Settings = {
  lowerBound: number;
  upperBound: number;
  compactPercent: number;
};

export const DEFAULT_SETTINGS: Settings = { lowerBound: 140_000, upperBound: 800_000, compactPercent: 90 };

// Claude Code 2.1.317 fires auto-compact at min(floor(e * pct / 100), e - 13000), where
// e = window - min(maxOutput, 20000). Every model this host runs has maxOutput >= 20000.
const OUTPUT_RESERVE = 20_000;
const ENGINE_HEADROOM = 13_000;
const TARGET_WINDOW_SHARE = 0.4;

export type CompactPolicy = {
  window: number;
  trigger: number;
  target: number;
  pct: number;
  isClamped: boolean;
};

export type ResolvedSettings = { settings: Settings; notices: string[] };

/** A bound below this is a typo (`140` for `140k`) that would compact on every turn. */
export const MIN_BOUND = 10_000;

export const isBound = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= MIN_BOUND;

export const isPercent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100;

export function resolveSettings(options: Readonly<Record<string, unknown>>): ResolvedSettings {
  const notices: string[] = [];
  const pick = (key: keyof Settings, valid: (value: unknown) => value is number): number => {
    const value = options[key];
    if (value === undefined || valid(value)) return value ?? DEFAULT_SETTINGS[key];
    notices.push(`${key} ${JSON.stringify(value)} is invalid; using ${DEFAULT_SETTINGS[key]}`);
    return DEFAULT_SETTINGS[key];
  };
  return {
    settings: {
      lowerBound: pick("lowerBound", isBound),
      upperBound: pick("upperBound", isBound),
      compactPercent: pick("compactPercent", isPercent),
    },
    notices,
  };
}

function policyFor(settings: Settings, window: number): CompactPolicy {
  const effective = window - OUTPUT_RESERVE;
  const engineCap = effective - ENGINE_HEADROOM;
  const wanted = Math.min(settings.upperBound, Math.floor((settings.compactPercent * window) / 100));
  const trigger = Math.min(wanted, engineCap);
  const target = Math.min(settings.lowerBound, Math.floor(TARGET_WINDOW_SHARE * window), Math.floor(trigger / 2));
  return { window, trigger, target, pct: overrideFor(trigger, effective), isClamped: trigger < wanted };
}

// The engine floors e * pct / 100, so nudge pct up when float rounding would land one token short.
function overrideFor(trigger: number, effective: number): number {
  let pct = (100 * trigger) / effective;
  while (Math.floor((effective * pct) / 100) < trigger) pct += Number.EPSILON * pct;
  return pct;
}

export function computePolicy(
  resolved: ResolvedSettings,
  window: number,
): { policy: CompactPolicy; notices: string[] } {
  return { policy: policyFor(resolved.settings, window), notices: resolved.notices };
}

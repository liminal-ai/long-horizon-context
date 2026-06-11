// The named-provider registry (DD-11). SDK hosts inject a provider at
// createSdk; the CLI — which has no construction step — resolves one here
// from `--provider <name>` or LHC_PROVIDER. No default: a provider-needing
// command without a resolvable name fails with provider_not_configured,
// never a silent no-op.
import type { DerivationProvider } from "../shared/derivation.js";
import { createDeterministicProvider } from "./deterministic.js";

const REGISTRY: Record<string, () => DerivationProvider> = {
  deterministic: createDeterministicProvider,
};

export function resolveNamedProvider(name: string): DerivationProvider | undefined {
  return REGISTRY[name]?.();
}

export function registeredProviderNames(): string[] {
  return Object.keys(REGISTRY);
}

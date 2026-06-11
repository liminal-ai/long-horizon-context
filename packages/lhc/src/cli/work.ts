// `lhc work drain` — CLI parity for the drain operation (manual host mode's
// command surface). Provider resolution per DD-11: explicit `--provider` or
// LHC_PROVIDER, looked up in the named-provider registry; no default and no
// silent no-op — an unresolvable provider is a caller error naming both the
// flag and the env var. Report, requeue, and mutations (later stories) need
// no provider; only drain dispatches handlers.
import type { ThreadRef } from "../domains/threads/index.js";
import { registeredProviderNames, resolveNamedProvider } from "../providers/registry.js";
import { createSdk } from "../sdk.js";
import type { DerivationProvider } from "../shared/derivation.js";
import type { ErrorResult, OpResult } from "../shared/errors.js";
import { renderResult, type CliResult } from "./render.js";

function providerNotConfigured(reason: string): { ok: false; error: ErrorResult } {
  return {
    ok: false,
    error: { errorClass: "caller_error", code: "provider_not_configured", reason },
  };
}

export function resolveCliProvider(
  providerFlag: string | undefined,
): OpResult<DerivationProvider> {
  const name = providerFlag ?? process.env["LHC_PROVIDER"];
  if (name === undefined || name === "") {
    return providerNotConfigured(
      "work drain needs a derivation provider: pass --provider <name> or set LHC_PROVIDER",
    );
  }
  const provider = resolveNamedProvider(name);
  if (provider === undefined) {
    return providerNotConfigured(
      `no provider registered under "${name}" (--provider / LHC_PROVIDER); known: ${registeredProviderNames().join(", ")}`,
    );
  }
  return { ok: true, value: provider };
}

export async function runWorkDrain(
  threadRef: ThreadRef,
  flags: { provider?: string; maxItems?: number },
): Promise<CliResult> {
  const provider = resolveCliProvider(flags.provider);
  if (!provider.ok) return renderResult(provider);
  // The CLI is the manual host: it assembles the same SDK production hosts
  // do and drains through the same surface — no in-process shortcut.
  const sdk = createSdk({ provider: provider.value, mode: "manual" });
  return renderResult(
    await sdk.work.drain(
      threadRef,
      flags.maxItems !== undefined ? { maxItems: flags.maxItems } : undefined,
    ),
  );
}

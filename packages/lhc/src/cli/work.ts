// `lhc work drain` plus the per-owner report and requeue mirrors (Story 4)
// — work.ts owns the drain/report/requeue command surface per tech design
// §Placement. Provider resolution per DD-11: explicit `--provider` or
// LHC_PROVIDER, looked up in the named-provider registry; no default and no
// silent no-op — an unresolvable provider is a caller error naming both the
// flag and the env var. Report, requeue, and mutations need no provider;
// only drain dispatches handlers.
import * as messages from "../domains/messages/index.js";
import * as turns from "../domains/turns/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import { registeredProviderNames, resolveNamedProvider } from "../providers/registry.js";
import { createSdk } from "../sdk.js";
import type { DerivationProvider, FormKind } from "../shared/derivation.js";
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

// The report and requeue mirrors call the same domain operations the SDK
// surfaces expose — same validation, same result JSON (AC-4.3/AC-4.4 CLI
// parity). Form names pass through as given; an unknown form is refused by
// the operation's own mapping check, identically to an SDK caller.

export async function runMessagesReport(
  threadRef: ThreadRef,
  flags: { notReady?: boolean; messageId?: string },
): Promise<CliResult> {
  const opts: { notReady?: boolean; messageId?: string } = {};
  if (flags.notReady === true) opts.notReady = true;
  if (flags.messageId !== undefined) opts.messageId = flags.messageId;
  return renderResult(await messages.report(threadRef, opts));
}

export async function runMessagesRequeue(
  threadRef: ThreadRef,
  flags: { messageId: string; form: string },
): Promise<CliResult> {
  return renderResult(
    await messages.requeue(threadRef, {
      messageId: flags.messageId,
      form: flags.form as FormKind,
    }),
  );
}

export async function runTurnsReport(
  threadRef: ThreadRef,
  flags: { notReady?: boolean; turnId?: string; chunkId?: string },
): Promise<CliResult> {
  const opts: { notReady?: boolean; turnId?: string; chunkId?: string } = {};
  if (flags.notReady === true) opts.notReady = true;
  if (flags.turnId !== undefined) opts.turnId = flags.turnId;
  if (flags.chunkId !== undefined) opts.chunkId = flags.chunkId;
  return renderResult(await turns.report(threadRef, opts));
}

export async function runTurnsRequeue(
  threadRef: ThreadRef,
  flags: { subjectKind: "turn" | "chunk"; subjectId: string; form: string },
): Promise<CliResult> {
  return renderResult(
    await turns.requeue(threadRef, {
      subjectKind: flags.subjectKind,
      subjectId: flags.subjectId,
      form: flags.form as FormKind,
    }),
  );
}

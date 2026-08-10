/**
 * Shared identity stubs for runtime/wrapper/retrieval tests — platform
 * neutral. Deterministic identities come from the same synthetic generator
 * the CC_LHC_IDENTITY_ADDON stub addon uses, so in-process stubs and
 * production-default code paths (which load that stub through the loader env
 * seam) always agree, on Linux, macOS, and Windows alike. The real compiled
 * addon is exercised separately in test/runtime/native-identity.test.ts.
 */

import { createRequire } from "node:module";

import type {
  ProbeProcessIdentity,
  ProcessIdentity,
  ProcessLivenessResult,
} from "../../src/runtime/process-identity.js";

const requireCjs = createRequire(import.meta.url);
const stubAddon = requireCjs("../fixtures/stub-identity-addon.cjs") as {
  stubBootId: string;
  syntheticStarttime: (pid: number) => string;
  readProcessIdentity: (pid: number) => unknown;
};

/** The stub addon's constant bootId — used to prove the real addon is not masked. */
export const STUB_BOOT_ID: string = stubAddon.stubBootId;

/** Synthetic identity for an arbitrary pid — pure function, no platform state. */
export function syntheticIdentity(pid: number): ProcessIdentity {
  return { pid, bootId: stubAddon.stubBootId, starttime: stubAddon.syntheticStarttime(pid) };
}

export function selfIdentity(): ProcessIdentity {
  return syntheticIdentity(process.pid);
}

export function aliveResult(identity: ProcessIdentity): ProcessLivenessResult {
  return { ok: true, identity };
}

export function notFoundResult(pid: number): ProcessLivenessResult {
  return { ok: false, code: "not_found", message: `no process with pid ${pid}` };
}

export function indeterminateResult(message: string): ProcessLivenessResult {
  return { ok: false, code: "indeterminate", message };
}

/** Probe that proves `self` alive for its own pid and not_found for others. */
export function selfOnlyProbe(self: ProcessIdentity = selfIdentity()): ProbeProcessIdentity {
  return (pid) => (pid === self.pid ? aliveResult(self) : notFoundResult(pid));
}

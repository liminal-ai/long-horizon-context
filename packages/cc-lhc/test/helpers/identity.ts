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

export const STUB_BOOT_ID: string = stubAddon.stubBootId;

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

export function selfOnlyProbe(self: ProcessIdentity = selfIdentity()): ProbeProcessIdentity {
  return (pid) => (pid === self.pid ? aliveResult(self) : notFoundResult(pid));
}

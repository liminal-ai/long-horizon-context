/**
 * Production-default process-identity probe over the cc-lhc-native exact
 * reader (Linux, macOS, Windows).
 *
 * Mapping into the fail-closed liveness contract:
 *   ok                   → ok, projected to the stored pid+bootId+starttime
 *                          schema (unchanged since the Linux-only reader, so
 *                          existing descriptors and owner leases stay valid)
 *   not_found            → not_found (kernel-proven dead; reclaimable)
 *   invalid_pid, access_denied, native_error, unsupported_platform,
 *   addon_unavailable    → indeterminate (fail closed; never reclaim)
 *
 * addon_unavailable / unsupported_platform additionally carry remediation
 * text so wrapper startup on a supported platform with a missing or wrong
 * prebuild surfaces an actionable error instead of degrading to PID-only
 * liveness or the old Linux /proc reader.
 */

import {
  createExactIdentityReader,
  type ExactIdentityReader,
  type LoaderSeams,
  toPortableProcessIdentity,
} from "cc-lhc-native";

import type { ProbeProcessIdentity, ProcessLivenessResult } from "./process-identity.js";

const ADDON_REMEDIATION =
  "cc-lhc requires its native identity addon (cc-lhc-native) for exact process liveness " +
  "and will not fall back to PID-only checks. Reinstall cc-lhc so the release bundle's " +
  "prebuilds/<platform>-<arch>/cc_lhc_identity.node is present, or build it from source: " +
  "pnpm --filter cc-lhc-native run build:native && pnpm --filter cc-lhc-native run stage:prebuild";

/** Wrap any exact reader (real or injected) into the liveness-probe contract. */
export function probeFromExactReader(read: ExactIdentityReader): ProbeProcessIdentity {
  return (pid: number): ProcessLivenessResult => {
    const result = read(pid);
    if (result.ok) {
      return { ok: true, identity: toPortableProcessIdentity(result.identity) };
    }
    switch (result.code) {
      case "not_found":
        return { ok: false, code: "not_found", message: result.message };
      case "addon_unavailable":
      case "unsupported_platform":
        return {
          ok: false,
          code: "indeterminate",
          message: `${result.code}: ${result.message}. ${ADDON_REMEDIATION}`,
        };
      default:
        // invalid_pid, access_denied, native_error — uncertainty, fail closed.
        return { ok: false, code: "indeterminate", message: `${result.code}: ${result.message}` };
    }
  };
}

/**
 * Build a probe over a fresh native reader. Seams are for tests (fake
 * platform/root/env); production callers pass none.
 */
export function createNativeIdentityProbe(seams: LoaderSeams = {}): ProbeProcessIdentity {
  return probeFromExactReader(createExactIdentityReader(seams));
}

let defaultProbe: ProbeProcessIdentity | null = null;

/** Production-default probe: real platform, real manifest, real artifact. */
export const probeProcessIdentityNative: ProbeProcessIdentity = (pid) => {
  if (defaultProbe === null) {
    defaultProbe = createNativeIdentityProbe();
  }
  return defaultProbe(pid);
};

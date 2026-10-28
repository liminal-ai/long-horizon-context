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
  "pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native && " +
  "pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run stage:prebuild";

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
        return { ok: false, code: "indeterminate", message: `${result.code}: ${result.message}` };
    }
  };
}

export function createNativeIdentityProbe(seams: LoaderSeams = {}): ProbeProcessIdentity {
  return probeFromExactReader(createExactIdentityReader(seams));
}

let defaultProbe: ProbeProcessIdentity | null = null;

export const probeProcessIdentityNative: ProbeProcessIdentity = (pid) => {
  if (defaultProbe === null) {
    defaultProbe = createNativeIdentityProbe();
  }
  return defaultProbe(pid);
};

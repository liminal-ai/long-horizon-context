import type { OpResult } from "lhc";
import type { ExtensionAPI } from "../pi/types.js";
import type { LaunchFlags } from "./thread-resolution.js";

export const LHC_FLAG_THREAD = "lhc-thread";
export const LHC_FLAG_RESUME = "lhc-resume";
export const LHC_FLAG_CONTINUE = "lhc-continue";
export const LHC_FLAG_BAND_PERCENTAGES = "lhc-band-percentages";

export interface LhcFlagSpec {
  name: string;
  description: string;
  type: "boolean" | "string";
  default?: boolean | string;
}

/** Metadata for pi-lhc extension CLI flags (surfaced in PI help as `--<name>`). */
export const LHC_EXTENSION_FLAG_SPECS: readonly LhcFlagSpec[] = [
  {
    name: LHC_FLAG_THREAD,
    description: "Attach to an LHC thread by full or partial thread id",
    type: "string",
  },
  {
    name: LHC_FLAG_RESUME,
    description: "Resume an LHC thread via cwd-scoped picker",
    type: "boolean",
    default: false,
  },
  {
    name: LHC_FLAG_CONTINUE,
    description: "Continue the most recently created LHC thread",
    type: "boolean",
    default: false,
  },
  {
    name: LHC_FLAG_BAND_PERCENTAGES,
    description: "Session compact bands as full,smooth,detailed,brief percentages (default 25,25,25,25)",
    type: "string",
  },
];

export function registerLhcFlags(pi: ExtensionAPI): void {
  for (const spec of LHC_EXTENSION_FLAG_SPECS) {
    pi.registerFlag(spec.name, {
      description: spec.description,
      type: spec.type,
      ...(spec.default !== undefined ? { default: spec.default } : {}),
    });
  }
}

function threadAttachModes(launch: LaunchFlags): string[] {
  const modes: string[] = [];
  if (launch.thread !== undefined) modes.push("--lhc-thread");
  if (launch.resume === true) modes.push("--lhc-resume");
  if (launch.continue === true) modes.push("--lhc-continue");
  return modes;
}

/** Read explicit pi-lhc launch flags from PI's extension flag surface. */
export function readLhcLaunchFlags(getFlag: ExtensionAPI["getFlag"]): OpResult<LaunchFlags> {
  const launch: LaunchFlags = {};

  const thread = getFlag(LHC_FLAG_THREAD);
  if (typeof thread === "string" && thread !== "") {
    launch.thread = thread;
  }

  if (getFlag(LHC_FLAG_RESUME) === true) {
    launch.resume = true;
  }

  if (getFlag(LHC_FLAG_CONTINUE) === true) {
    launch.continue = true;
  }

  const attachModes = threadAttachModes(launch);
  if (attachModes.length > 1) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "conflicting_lhc_launch_flags",
        reason: `conflicting LHC launch flags: ${attachModes.join(", ")}`,
      },
    };
  }

  return { ok: true, value: launch };
}

/** Test seam: build a getFlag reader from explicit flag values. */
export function getFlagFromValues(
  values: Readonly<Partial<Record<string, boolean | string>>>,
): ExtensionAPI["getFlag"] {
  return (name: string) => values[name];
}

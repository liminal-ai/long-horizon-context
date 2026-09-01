/**
 * CC-LHC build identity (D13). `--lhc-version` must be truthful in three
 * layouts: assembled npm package, workspace dist build, and source runs
 * (tsx/vitest) where no stamped file exists. A missing stamp is reported as
 * such, never substituted with a guessed source SHA.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildIdentity {
  name: string;
  version: string;
  /** Git commit the build was stamped from; null when unstamped/unavailable. */
  sourceSha: string | null;
  /** True when the stamping tree had uncommitted changes. */
  sourceDirty: boolean;
  /** False for source runs without a stamped dist/build-identity.json. */
  stamped: boolean;
}

// src/version.ts and dist/version.js both sit one level under the package root.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readBuildIdentity(): BuildIdentity {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  const name = manifest.name ?? "cc-lhc";
  const version = manifest.version ?? "0.0.0";
  try {
    const stamped = JSON.parse(readFileSync(join(packageRoot, "dist", "build-identity.json"), "utf8")) as {
      name?: string;
      version?: string;
      sourceSha?: string | null;
      sourceDirty?: boolean;
    };
    return {
      name: stamped.name ?? name,
      version: stamped.version ?? version,
      sourceSha: typeof stamped.sourceSha === "string" ? stamped.sourceSha : null,
      sourceDirty: stamped.sourceDirty === true,
      stamped: true,
    };
  } catch {
    return { name, version, sourceSha: null, sourceDirty: false, stamped: false };
  }
}

export function formatLhcVersion(identity: BuildIdentity): string {
  const source = !identity.stamped
    ? "source: unstamped source run (no dist/build-identity.json)"
    : identity.sourceSha === null
      ? "source: unknown (stamped without git metadata)"
      : `source: ${identity.sourceSha}${identity.sourceDirty ? " (modified tree)" : ""}`;
  return `${identity.name} ${identity.version}\n${source}`;
}

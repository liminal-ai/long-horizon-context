/**
 * Addon artifact resolution and loading.
 *
 * Resolution order (first hit wins):
 *   1. CC_LHC_IDENTITY_ADDON env override — explicit path, development/test
 *      seam only; must exist or loading fails.
 *   2. prebuilds/<platform>-<arch>/<artifact> — the released path; artifacts
 *      are produced by the CI matrix, published as GitHub release assets, and
 *      installed here checksum-verified by .setup/scripts/fetch-prebuild.mjs
 *      (this package is private to the workspace, never an npm tarball), so
 *      end users never need a compiler toolchain.
 *   3. build/Release/<artifact> — the source-build/development path produced
 *      by the `build:native` package script (node-gyp; requires a local C
 *      toolchain).
 *
 * A platform/arch pair absent from targets.json fails explicitly with the
 * supported-target list before any filesystem probing. A supported target
 * with no artifact fails explicitly with both candidate paths. Loaded addons
 * are validated against the compiled-platform tag and contract version so a
 * wrong or stale artifact can never silently serve identities.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isSupportedTarget,
  loadTargetsManifest,
  TARGETS_MANIFEST_FILENAME,
  type TargetsManifest,
  targetKey,
} from "./targets.js";

export const IDENTITY_ADDON_ENV = "CC_LHC_IDENTITY_ADDON";
export const IDENTITY_CONTRACT_VERSION = 2;

export class UnsupportedPlatformTargetError extends Error {
  constructor(
    readonly platform: string,
    readonly arch: string,
    supported: string[],
  ) {
    super(
      `cc-lhc-native: no exact process-identity support for ${platform}-${arch}; ` +
        `supported targets: ${supported.join(", ")}`,
    );
    this.name = "UnsupportedPlatformTargetError";
  }
}

export class AddonArtifactMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddonArtifactMissingError";
  }
}

export class AddonContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AddonContractError";
  }
}

/** Shape the compiled addon must present after load. */
export interface NativeIdentityAddon {
  readonly platform: string;
  readonly identityContractVersion: number;
  readProcessIdentity(pid: number): unknown;
  readFileIdentity(path: string): unknown;
}

/** Deterministic seams; every field defaults to the production value. */
export interface LoaderSeams {
  platform?: string;
  arch?: string;
  packageRoot?: string;
  env?: Record<string, string | undefined>;
  manifest?: TargetsManifest;
  exists?: (path: string) => boolean;
  loadAddon?: (path: string) => unknown;
}

export type AddonSource = "env-override" | "prebuilt" | "source-build";

export interface ResolvedAddonArtifact {
  path: string;
  source: AddonSource;
}

export function defaultPackageRoot(): string {
  // loader runs from src/ (tests) or dist/ (built); both sit one level below
  // the package root where targets.json, prebuilds/, and build/ live.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function resolveAddonArtifact(seams: LoaderSeams = {}): ResolvedAddonArtifact {
  const platform = seams.platform ?? process.platform;
  const arch = seams.arch ?? process.arch;
  const root = seams.packageRoot ?? defaultPackageRoot();
  const env = seams.env ?? process.env;
  const exists = seams.exists ?? existsSync;
  const manifest = seams.manifest ?? loadTargetsManifest(join(root, TARGETS_MANIFEST_FILENAME));

  const override = env[IDENTITY_ADDON_ENV];
  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      throw new AddonArtifactMissingError(
        `cc-lhc-native: ${IDENTITY_ADDON_ENV} points to a missing addon: ${override}`,
      );
    }
    return { path: override, source: "env-override" };
  }

  if (!isSupportedTarget(manifest, platform, arch)) {
    throw new UnsupportedPlatformTargetError(platform, arch, manifest.targets.map(targetKey));
  }

  const prebuilt = join(root, "prebuilds", `${platform}-${arch}`, manifest.artifact);
  if (exists(prebuilt)) {
    return { path: prebuilt, source: "prebuilt" };
  }
  const sourceBuild = join(root, "build", "Release", manifest.artifact);
  if (exists(sourceBuild)) {
    return { path: sourceBuild, source: "source-build" };
  }
  throw new AddonArtifactMissingError(
    `cc-lhc-native: no addon artifact for supported target ${platform}-${arch}; ` +
      `expected prebuilt at ${prebuilt} or source build at ${sourceBuild} ` +
      `(development: pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native)`,
  );
}

export interface LoadedIdentityAddon {
  addon: NativeIdentityAddon;
  path: string;
  source: AddonSource;
}

function defaultLoadAddon(path: string): unknown {
  const requireAddon = createRequire(import.meta.url);
  return requireAddon(path);
}

export function loadIdentityAddon(seams: LoaderSeams = {}): LoadedIdentityAddon {
  const platform = seams.platform ?? process.platform;
  const resolved = resolveAddonArtifact(seams);
  const load = seams.loadAddon ?? defaultLoadAddon;
  let mod: unknown;
  try {
    mod = load(resolved.path);
  } catch (cause) {
    throw new AddonContractError(
      `cc-lhc-native: failed to load addon at ${resolved.path}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
  if (mod === null || typeof mod !== "object") {
    throw new AddonContractError(`cc-lhc-native: addon at ${resolved.path} did not export an object`);
  }
  const candidate = mod as Record<string, unknown>;
  if (typeof candidate.readProcessIdentity !== "function") {
    throw new AddonContractError(`cc-lhc-native: addon at ${resolved.path} does not export readProcessIdentity()`);
  }
  if (typeof candidate.readFileIdentity !== "function") {
    throw new AddonContractError(`cc-lhc-native: addon at ${resolved.path} does not export readFileIdentity()`);
  }
  if (candidate.identityContractVersion !== IDENTITY_CONTRACT_VERSION) {
    throw new AddonContractError(
      `cc-lhc-native: addon at ${resolved.path} has contract version ` +
        `${String(candidate.identityContractVersion)}, need ${IDENTITY_CONTRACT_VERSION}`,
    );
  }
  if (candidate.platform !== platform) {
    throw new AddonContractError(
      `cc-lhc-native: addon at ${resolved.path} was compiled for ` +
        `${String(candidate.platform)}, running on ${platform}`,
    );
  }
  return { addon: mod as unknown as NativeIdentityAddon, path: resolved.path, source: resolved.source };
}

export {
  createExactIdentityReader,
  type ExactIdentityReader,
  type ExactProcessIdentity,
  exactIdentitiesEqual,
  type IdentityFailureCode,
  type IdentityPlatform,
  normalizeNativeResult,
  type ReadIdentityResult,
  readExactProcessIdentity,
  toPortableProcessIdentity,
} from "./identity.js";
export {
  AddonArtifactMissingError,
  AddonContractError,
  type AddonSource,
  defaultPackageRoot,
  IDENTITY_ADDON_ENV,
  IDENTITY_CONTRACT_VERSION,
  type LoadedIdentityAddon,
  type LoaderSeams,
  loadIdentityAddon,
  type NativeIdentityAddon,
  type ResolvedAddonArtifact,
  resolveAddonArtifact,
  UnsupportedPlatformTargetError,
} from "./loader.js";
export {
  missingReleaseBundleFiles,
  prebuiltArtifactRelativePath,
  RELEASE_BUNDLE_STATIC_FILES,
  type ReleaseBundleCheckOptions,
} from "./release-bundle.js";
export {
  isSupportedTarget,
  loadTargetsManifest,
  type PrebuildTarget,
  parseTargetsManifest,
  TARGETS_MANIFEST_FILENAME,
  type TargetsManifest,
  targetKey,
} from "./targets.js";

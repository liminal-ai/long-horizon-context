// Release-source resolution and probe-report validation for
// fetch-prebuild.mjs, split out for unit tests
// (packages/cc-lhc-native/test/setup-scripts.test.ts). Asset naming and
// checksum verification live in the shared dist-free module
// packages/cc-lhc-native/scripts/asset-names.mjs; this file decides WHERE to
// download from and judges the subprocess load-probe of a downloaded addon.

export const PREBUILD_TAG_ENV = "CC_LHC_PREBUILD_TAG";
export const PREBUILD_BASE_URL_ENV = "CC_LHC_PREBUILD_BASE_URL";

/**
 * Decide the asset base URL. Precedence (most explicit wins):
 *   1. --base-url argv          (arbitrary mirror; must serve the assets flat)
 *   2. CC_LHC_PREBUILD_BASE_URL
 *   3. tag from --tag argv, else CC_LHC_PREBUILD_TAG, else config.tag
 *      -> https://github.com/<config.repo>/releases/download/<tag>
 *
 * Returns { ok: true, baseUrl, via } or { ok: false, error } with actionable
 * guidance. `config` is the parsed .setup/prebuild-release.json.
 */
export function resolveReleaseSource({ argvBaseUrl, argvTag, env = {}, config = {} }) {
  const explicitBase = argvBaseUrl ?? env[PREBUILD_BASE_URL_ENV];
  if (explicitBase !== undefined && explicitBase !== "") {
    return { ok: true, baseUrl: explicitBase.replace(/\/+$/, ""), via: argvBaseUrl ? "--base-url" : PREBUILD_BASE_URL_ENV };
  }
  const tag = argvTag ?? env[PREBUILD_TAG_ENV] ?? config.tag ?? null;
  if (typeof config.repo !== "string" || config.repo === "") {
    return { ok: false, error: "prebuild-release.json has no repo — cannot construct a release URL" };
  }
  if (tag === null || tag === "") {
    return {
      ok: false,
      error:
        "no release tag configured: pass --tag <tag> (or set " +
        `${PREBUILD_TAG_ENV}), or set "tag" in .setup/prebuild-release.json. ` +
        "No published release yet? Build from source instead: " +
        "pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native",
    };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) {
    return { ok: false, error: `malformed release tag: ${JSON.stringify(tag)}` };
  }
  return {
    ok: true,
    baseUrl: `https://github.com/${config.repo}/releases/download/${tag}`,
    via: argvTag ? "--tag" : env[PREBUILD_TAG_ENV] ? PREBUILD_TAG_ENV : "prebuild-release.json",
  };
}

/**
 * Judge the JSON report emitted by fetch-prebuild's subprocess load-probe of
 * a downloaded addon, BEFORE it may replace the installed one. Mirrors the
 * full portable-identity contract enforced by the loader
 * (packages/cc-lhc-native/src/identity.ts, file-identity.ts): identity
 * contract version 2, addon compiled for this platform, a complete identity
 * for the probing process — ok true, the exact probed pid echoed back, a
 * bootId of at least 8 characters, and a nonempty digits-only starttime
 * (≤ 20 digits) — and a complete file identity for the downloaded artifact
 * itself (ok true, digits-only volumeId, tagged fileId).
 * Returns { ok: true, probe } or { ok: false, reason }.
 */
export function validateProbeReport(report, platform) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, reason: `probe report is not an object: ${JSON.stringify(report)}` };
  }
  if (report.contract !== 2) {
    return { ok: false, reason: `contract version ${String(report.contract)}, need 2` };
  }
  if (report.platform !== platform) {
    return { ok: false, reason: `compiled for ${String(report.platform)}, running on ${platform}` };
  }
  const probe = report.probe;
  if (probe === null || typeof probe !== "object" || Array.isArray(probe) || probe.ok !== true) {
    return { ok: false, reason: `could not identify a live process: ${JSON.stringify(probe)}` };
  }
  if (!Number.isInteger(probe.pid) || probe.pid !== report.pid) {
    return {
      ok: false,
      reason: `echoed pid ${JSON.stringify(probe.pid)} does not match probed pid ${JSON.stringify(report.pid)}`,
    };
  }
  if (typeof probe.bootId !== "string" || probe.bootId.length < 8) {
    return { ok: false, reason: `invalid bootId ${JSON.stringify(probe.bootId)} (need ≥ 8 characters)` };
  }
  if (typeof probe.starttime !== "string" || !/^\d{1,20}$/.test(probe.starttime)) {
    return { ok: false, reason: `invalid starttime ${JSON.stringify(probe.starttime)} (need 1–20 digits)` };
  }
  const fileProbe = report.fileProbe;
  if (fileProbe === null || typeof fileProbe !== "object" || Array.isArray(fileProbe) || fileProbe.ok !== true) {
    return { ok: false, reason: `could not identify the downloaded file: ${JSON.stringify(fileProbe)}` };
  }
  if (typeof fileProbe.volumeId !== "string" || !/^\d{1,20}$/.test(fileProbe.volumeId)) {
    return { ok: false, reason: `file identity volumeId ${JSON.stringify(fileProbe.volumeId)} is not digits-only` };
  }
  if (typeof fileProbe.fileId !== "string" || !/^(?:ino:\d{1,20}|id128:[0-9a-f]{32}|index64:\d{1,20})$/.test(fileProbe.fileId)) {
    return { ok: false, reason: `file identity fileId ${JSON.stringify(fileProbe.fileId)} is not a tagged id` };
  }
  return { ok: true, probe };
}

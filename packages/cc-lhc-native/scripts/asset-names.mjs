// Release-asset naming and checksum contract shared by the CI aggregation
// step (scripts/assemble-release-bundle.mjs) and the standalone-setup
// downloader (.setup/scripts/fetch-prebuild.mjs). Deliberately dist-free and
// dependency-free so a fresh clone can run it before anything is built.
//
// Contract:
//   - one asset per prebuild target, named `<artifactBase>-<platform>-<arch>.node`
//     (e.g. cc_lhc_identity-linux-x64.node) so all six can coexist as flat
//     GitHub release assets;
//   - one `SHA256SUMS` file in sha256sum(1) format (`<hex>  <asset-name>`,
//     two-space separator) covering every asset.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CHECKSUMS_ASSET_NAME = "SHA256SUMS";

/** `cc_lhc_identity.node` + `linux-x64` -> `cc_lhc_identity-linux-x64.node`. */
export function assetNameForTarget(artifact, targetKey) {
  if (typeof artifact !== "string" || !artifact.endsWith(".node")) {
    throw new Error(`asset name: artifact must be a .node filename, got ${String(artifact)}`);
  }
  if (typeof targetKey !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(targetKey)) {
    throw new Error(`asset name: malformed target key ${String(targetKey)}`);
  }
  const base = artifact.slice(0, -".node".length);
  return `${base}-${targetKey}.node`;
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** One sha256sum(1) line: `<hex>  <name>`. */
export function checksumLine(hex, assetName) {
  return `${hex}  ${assetName}`;
}

/**
 * Parse SHA256SUMS text into a Map(assetName -> lowercase hex). Throws on any
 * malformed or duplicate line — a checksums file we cannot fully account for
 * must never be trusted partially.
 */
export function parseChecksums(text) {
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "" || line === undefined) continue;
    const match = /^([0-9a-fA-F]{64}) {2}(\S+)$/.exec(line);
    if (!match) {
      throw new Error(`SHA256SUMS line ${i + 1} is malformed: ${JSON.stringify(line)}`);
    }
    const [, hex, name] = match;
    if (entries.has(name)) {
      throw new Error(`SHA256SUMS lists ${name} twice`);
    }
    entries.set(name, hex.toLowerCase());
  }
  if (entries.size === 0) {
    throw new Error("SHA256SUMS is empty");
  }
  return entries;
}

/**
 * Verify a downloaded buffer against the checksum recorded for `assetName`.
 * Returns { ok: true } or { ok: false, reason } — callers must treat any
 * failure as fatal and discard the buffer.
 */
export function verifyAssetChecksum(entries, assetName, buffer) {
  const expected = entries.get(assetName);
  if (expected === undefined) {
    return { ok: false, reason: `SHA256SUMS has no entry for ${assetName}` };
  }
  const actual = sha256Hex(buffer);
  if (actual !== expected) {
    return { ok: false, reason: `${assetName} checksum mismatch: expected ${expected}, got ${actual}` };
  }
  return { ok: true };
}

/**
 * Minimal dist-free read of targets.json: enough validation to drive asset
 * naming and target lookup before anything is compiled. The strict parser
 * (src/targets.ts) still governs the loader and the release-bundle check.
 */
export function readTargetsManifestLite(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw?.artifact !== "string" || !raw.artifact.endsWith(".node")) {
    throw new Error(`${path}: artifact must be a .node filename`);
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error(`${path}: targets must be a non-empty array`);
  }
  const keys = [];
  for (const t of raw.targets) {
    if (typeof t?.platform !== "string" || typeof t?.arch !== "string") {
      throw new Error(`${path}: malformed target entry ${JSON.stringify(t)}`);
    }
    const key = `${t.platform}-${t.arch}`;
    if (keys.includes(key)) {
      throw new Error(`${path}: duplicate target ${key}`);
    }
    keys.push(key);
  }
  return { artifact: raw.artifact, targetKeys: keys };
}

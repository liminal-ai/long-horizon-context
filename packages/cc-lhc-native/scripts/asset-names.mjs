import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CHECKSUMS_ASSET_NAME = "SHA256SUMS";

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

export function checksumLine(hex, assetName) {
  return `${hex}  ${assetName}`;
}

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

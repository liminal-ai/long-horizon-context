/**
 * Prebuild target manifest (targets.json at the package root).
 *
 * Single source of truth for which platform/arch pairs ship prebuilt addon
 * artifacts. The loader consults it before touching the filesystem so an
 * unsupported target fails explicitly, and CI reads the same file to drive
 * the build matrix (jq-friendly plain JSON).
 */

import { readFileSync } from "node:fs";

export const TARGETS_MANIFEST_FILENAME = "targets.json";

const PLATFORMS: ReadonlySet<string> = new Set(["linux", "darwin", "win32"]);
const ARCHES: ReadonlySet<string> = new Set(["x64", "arm64"]);

export interface PrebuildTarget {
  platform: string;
  arch: string;
}

export interface TargetsManifest {
  name: string;
  napiVersion: number;
  /** Addon artifact filename, identical for every target. */
  artifact: string;
  targets: PrebuildTarget[];
}

export function targetKey(target: PrebuildTarget): string {
  return `${target.platform}-${target.arch}`;
}

export function isSupportedTarget(manifest: TargetsManifest, platform: string, arch: string): boolean {
  return manifest.targets.some((t) => t.platform === platform && t.arch === arch);
}

/** Strict parse; throws with a reason on any malformed manifest. */
export function parseTargetsManifest(raw: unknown): TargetsManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("targets manifest: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name === "") {
    throw new Error("targets manifest: name missing");
  }
  if (typeof obj.napiVersion !== "number" || !Number.isInteger(obj.napiVersion) || obj.napiVersion < 8) {
    throw new Error("targets manifest: napiVersion must be an integer >= 8");
  }
  if (typeof obj.artifact !== "string" || !obj.artifact.endsWith(".node")) {
    throw new Error("targets manifest: artifact must be a .node filename");
  }
  if (!Array.isArray(obj.targets) || obj.targets.length === 0) {
    throw new Error("targets manifest: targets must be a non-empty array");
  }
  const seen = new Set<string>();
  const targets: PrebuildTarget[] = [];
  for (const entry of obj.targets as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("targets manifest: target entry not an object");
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.platform !== "string" || !PLATFORMS.has(t.platform)) {
      throw new Error(`targets manifest: unknown platform ${String(t.platform)}`);
    }
    if (typeof t.arch !== "string" || !ARCHES.has(t.arch)) {
      throw new Error(`targets manifest: unknown arch ${String(t.arch)}`);
    }
    const key = `${t.platform}-${t.arch}`;
    if (seen.has(key)) {
      throw new Error(`targets manifest: duplicate target ${key}`);
    }
    seen.add(key);
    targets.push({ platform: t.platform, arch: t.arch });
  }
  return { name: obj.name, napiVersion: obj.napiVersion, artifact: obj.artifact, targets };
}

export function loadTargetsManifest(path: string): TargetsManifest {
  return parseTargetsManifest(JSON.parse(readFileSync(path, "utf8")));
}

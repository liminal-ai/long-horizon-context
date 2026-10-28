import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildIdentity {
  name: string;
  version: string;
  sourceSha: string | null;
  stamped: boolean;
}

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
    };
    return {
      name: stamped.name ?? name,
      version: stamped.version ?? version,
      sourceSha:
        typeof stamped.sourceSha === "string" && /^[0-9a-f]{40}$/.test(stamped.sourceSha) ? stamped.sourceSha : null,
      stamped: true,
    };
  } catch {
    return { name, version, sourceSha: null, stamped: false };
  }
}

export function formatLhcVersion(identity: BuildIdentity): string {
  const source = !identity.stamped
    ? "source: unstamped source run (no dist/build-identity.json)"
    : identity.sourceSha === null
      ? "source: unavailable (development build stamped without an accepted source SHA)"
      : `source: ${identity.sourceSha}`;
  return `${identity.name} ${identity.version}\n${source}`;
}

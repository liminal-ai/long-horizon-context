/**
 * CC-LHC build identity (D13): the one shape stamped into
 * dist/build-identity.json and the one rule that binds it.
 *
 * The source SHA is an explicit input from the build/assembly caller, never
 * read from the repository: an ordinary development build stamps
 * `sourceSha: null` (identity unavailable) and the accepted candidate is
 * stamped with its accepted SHA. No timestamps, fixed key order, so identical
 * inputs produce identical bytes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Parse `--source-sha <sha>` from argv; undefined when absent. Throws on a malformed value. */
export function sourceShaFromArgv(argv) {
  const index = argv.indexOf("--source-sha");
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--source-sha requires a value");
  if (!SOURCE_SHA_PATTERN.test(value)) {
    throw new Error(`--source-sha must be a full lowercase 40-hex commit SHA, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function buildIdentity({ name, version, sourceSha }) {
  if (typeof name !== "string" || name === "") throw new Error("build identity requires a package name");
  if (typeof version !== "string" || version === "") throw new Error("build identity requires a package version");
  if (sourceSha !== null && !SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("build identity sourceSha must be null or a full lowercase 40-hex commit SHA");
  }
  return { name, version, sourceSha };
}

export function writeBuildIdentity(outDir, identity) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "build-identity.json"), `${JSON.stringify(buildIdentity(identity), null, 2)}\n`);
}

/**
 * Bind a stamped identity to the manifest and to the caller's accepted
 * source SHA. A stamped SHA is valid only when it equals the accepted input;
 * with no accepted input only an unavailable (null) identity passes.
 * Returns the failures, empty when bound.
 */
export function verifyBuildIdentity(identity, manifest, acceptedSourceSha) {
  const failures = [];
  if (identity === null || typeof identity !== "object") return ["build identity is not an object"];
  if (identity.name !== manifest.name) failures.push("build identity name must match the manifest");
  if (identity.version !== manifest.version) failures.push("build identity version must match the manifest");
  if (!("sourceSha" in identity)) failures.push("build identity must declare sourceSha (a SHA or null)");
  else if (identity.sourceSha !== null && !SOURCE_SHA_PATTERN.test(identity.sourceSha)) {
    failures.push("build identity sourceSha must be null or a full lowercase 40-hex commit SHA");
  } else if (acceptedSourceSha === undefined) {
    if (identity.sourceSha !== null) {
      failures.push(
        "build identity carries a source SHA but no accepted --source-sha was supplied to bind it; " +
          "pass the accepted SHA or stamp an unavailable identity",
      );
    }
  } else if (identity.sourceSha !== acceptedSourceSha) {
    failures.push(
      `build identity source SHA ${String(identity.sourceSha)} does not equal the accepted --source-sha ${acceptedSourceSha}`,
    );
  }
  if ("sourceDirty" in identity) failures.push("build identity must not carry ambient repository state (sourceDirty)");
  return failures;
}

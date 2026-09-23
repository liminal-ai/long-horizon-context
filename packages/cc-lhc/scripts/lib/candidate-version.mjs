// The cc-lhc release version the build scripts assemble and check: --version
// when given, otherwise packages/cc-lhc/package.json (the one place a release
// bumps it). Shared so the assemblers and checks never disagree.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function packageVersion() {
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")).version;
}

export function candidateVersionFromArgv(argv) {
  const index = argv.indexOf("--version");
  let version;
  if (index < 0) {
    version = packageVersion();
  } else {
    version = argv[index + 1];
    if (version === undefined || version.startsWith("--")) throw new Error("--version requires a value");
  }
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid candidate version ${JSON.stringify(version)}`);
  return version;
}

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "targets.json"), "utf8"));
const platform = process.platform;
const arch = process.arch;

const supported = manifest.targets.some((t) => t.platform === platform && t.arch === arch);
if (!supported) {
  console.error(`cc-lhc-native: ${platform}-${arch} is not in targets.json; refusing to stage a prebuilt`);
  process.exit(1);
}

const built = join(root, "build", "Release", manifest.artifact);
if (!existsSync(built)) {
  console.error(`cc-lhc-native: missing ${built}; run build:native first`);
  process.exit(1);
}

const destDir = join(root, "prebuilds", `${platform}-${arch}`);
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, manifest.artifact);
copyFileSync(built, dest);
console.log(`cc-lhc-native: staged ${dest}`);

// Cross-platform clean (replaces `rm -rf`; must run under native Windows cmd).
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const dir of ["dist", "build"]) {
  rmSync(join(root, dir), { recursive: true, force: true });
}

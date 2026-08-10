// Cross-platform clean (replaces `rm -rf`; must run under native Windows cmd).
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

rmSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "dist"), { recursive: true, force: true });

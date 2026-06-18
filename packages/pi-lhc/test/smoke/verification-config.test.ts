import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as PackageJson;
}

describe("package verification config", () => {
  it("declares the standard package scripts", () => {
    const scripts = readPackageJson().scripts ?? {};
    for (const script of ["build", "typecheck", "lint", "test", "format"]) {
      expect(typeof scripts[script]).toBe("string");
    }
  });

  it("depends on the lhc workspace package", () => {
    const pkg = readPackageJson();
    expect(pkg.dependencies?.lhc).toBeDefined();
  });
});

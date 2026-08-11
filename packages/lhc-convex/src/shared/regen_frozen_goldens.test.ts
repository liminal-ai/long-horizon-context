// @vitest-environment node

// Golden regeneration harness — NOT part of the certification suite.
//
// Run with:  REGEN_FROZEN_GOLDENS=1 pnpm exec vitest run src/shared/regen_frozen_goldens.test.ts
//
// It refuses to run unless packages/lhc/src is byte-identical to the contract
// pin (CONTRACT_PIN in frozen_cases.ts), then executes the shared case tables
// through the PINNED frozen TypeScript implementations and writes
// src/shared/goldens/frozen/*.golden.json. Each golden stores, per case, the
// JSON.stringify of the frozen output — the differentials compare bytes.
//
// In normal runs the single test here is skipped; the gate script classifies
// it as an intentional infrastructure skip (not a TS-mirror skip).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CONTRACT_PIN,
  eventCases,
  threadRefCases,
  turnComposeFixture,
  VIEW_SELECT_CONFIG,
  viewSelectFixture,
} from "./frozen_cases.js";
import type { validateEvents, validateThreadRef } from "./intake_validate.js";
import type { composePreDetailedAssembly, composeRenderingInput } from "./turn_compose.js";
import type { selectArrangement } from "./view_select.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "goldens", "frozen");
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

function assertTreeAtPin(): void {
  // Both checks against the pin: tracked changes AND that HEAD's lhc tree is
  // the pin's lhc tree (catches a checkout of some other branch entirely).
  execFileSync("git", ["-C", REPO_ROOT, "diff", "--quiet", CONTRACT_PIN, "--", "packages/lhc/src"], {
    stdio: "pipe",
  });
}

function writeGolden(name: string, cases: Record<string, string>): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const body = {
    pin: CONTRACT_PIN,
    source: `packages/lhc (frozen contract) at ${CONTRACT_PIN.slice(0, 7)}`,
    generatedBy: "src/shared/regen_frozen_goldens.test.ts",
    cases,
  };
  writeFileSync(join(GOLDEN_DIR, `${name}.golden.json`), `${JSON.stringify(body, null, 2)}\n`);
}

describe.runIf(process.env["REGEN_FROZEN_GOLDENS"] === "1")("frozen golden regeneration", () => {
  test("regenerates all frozen goldens from the pinned contract", async () => {
    assertTreeAtPin();

    const selectModule = (await import(
      new URL("../../../lhc/src/thread-view/internal/select.ts", import.meta.url).href
    )) as { selectArrangement: typeof selectArrangement };
    writeGolden("view-select", {
      selectArrangement: JSON.stringify(selectModule.selectArrangement(viewSelectFixture(), VIEW_SELECT_CONFIG)),
    });

    const composeModule = (await import(
      new URL("../../../lhc/src/turns/internal/compose.ts", import.meta.url).href
    )) as {
      composeRenderingInput: typeof composeRenderingInput;
      composePreDetailedAssembly: typeof composePreDetailedAssembly;
    };
    const { messages, derivations } = turnComposeFixture();
    writeGolden("turn-compose", {
      composeRenderingInput: JSON.stringify(composeModule.composeRenderingInput(messages, derivations)),
      composePreDetailedAssembly: JSON.stringify(composeModule.composePreDetailedAssembly(messages, derivations)),
    });

    const validateModule = (await import(
      new URL("../../../lhc/src/intake-stream/internal/validate.ts", import.meta.url).href
    )) as { validateEvents: typeof validateEvents; validateThreadRef: typeof validateThreadRef };
    const validationCases: Record<string, string> = {};
    for (const c of eventCases()) {
      validationCases[`validateEvents: ${c.name}`] = JSON.stringify(validateModule.validateEvents(c.input));
    }
    for (const c of threadRefCases()) {
      validationCases[`validateThreadRef: ${c.name}`] = JSON.stringify(validateModule.validateThreadRef(c.input));
    }
    writeGolden("intake-validate", validationCases);

    expect(Object.keys(validationCases).length).toBeGreaterThan(0);
  });
});

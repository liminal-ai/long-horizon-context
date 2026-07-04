import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInterceptState } from "../../src/wrapper/intercept.js";
import { createInputDebugLogger, summarizeInterceptState } from "../../src/wrapper/input-debug.js";

describe("createInputDebugLogger", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    tempDir = undefined;
  });

  it("is inert when the env path is unset", () => {
    const logger = createInputDebugLogger(undefined);
    expect(() => logger(Buffer.from("x"), createInterceptState())).not.toThrow();
  });

  it("appends chunk hex and intercept state to the log file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cc-lhc-input-debug-"));
    const logPath = join(tempDir, "input.log");
    const state = { ...createInterceptState(), withholding: true, buffer: "/lhc" };
    const logger = createInputDebugLogger(logPath);
    logger(Buffer.from("/l"), state);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const contents = await readFile(logPath, "utf8");
    expect(contents).toContain("hex=2f 6c");
    expect(contents).toContain('printable="/l"');
    expect(contents).toContain(summarizeInterceptState(state));
  });
});

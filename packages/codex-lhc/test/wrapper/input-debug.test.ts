import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createInputDebugLogger, summarizeInputState } from "../../src/wrapper/input-debug.js";
import { createInputState } from "../../src/wrapper/modal.js";

describe("createInputDebugLogger", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    tempDir = undefined;
  });

  it("is inert when the env path is unset", () => {
    const logger = createInputDebugLogger(undefined);
    expect(() => logger(Buffer.from("x"), createInputState())).not.toThrow();
  });

  it("appends chunk hex and input state to the log file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cc-lhc-input-debug-"));
    const logPath = join(tempDir, "input.log");
    const state = { ...createInputState(), mode: "modal" as const, line: "sta" };
    const logger = createInputDebugLogger(logPath);
    logger(Buffer.from("/l"), state);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const contents = await readFile(logPath, "utf8");
    expect(contents).toContain("hex=2f 6c");
    expect(contents).toContain('printable="/l"');
    expect(contents).toContain(summarizeInputState(state));
    expect(contents).toContain("mode=modal");
  });
});

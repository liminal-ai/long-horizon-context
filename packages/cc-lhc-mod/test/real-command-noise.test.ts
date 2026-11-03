import { expect, it } from "vitest";
import { mapEntries, SETTLED } from "../sidecar/src/capture/map.ts";
import type { CaptureEntry } from "../src/capture.ts";

it("drops /clear's real output row, which Claude Code files as a system row", () => {
  const row: CaptureEntry = {
    kind: "row",
    uuid: "d35010e5-fe1c-49d1-a32c-cd77b237ff34",
    door: "command",
    origin: "engine",
    message: {
      type: "system",
      name: "local_command",
      role: "user",
      content: [{ type: "text", text: "<local-command-stdout></local-command-stdout>" }],
    },
    sessionId: "5743d058-d956-43d9-ba20-d840dc11d746",
    at: 0,
  };

  expect(mapEntries([row], SETTLED).events).toEqual([]);
});

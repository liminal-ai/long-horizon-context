import { createDeterministicInferenceCallbacks, initLhc, intakeStream } from "lhc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedPiSessionFromLhc } from "../../src/index.js";
import { type TempStore, tempStore } from "../fixtures/thread.js";
import { buildCompactLhcFixture } from "./lhc-thread-fixture.js";

const TARGET_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
};

let store: TempStore;
let fixture: Awaited<ReturnType<typeof buildCompactLhcFixture>>;

beforeAll(async () => {
  store = tempStore();
  fixture = await buildCompactLhcFixture(store);
  const compact = await fixture.sdk.threadView.compact({ filePath: fixture.filePath }, { params: TARGET_PARAMS });
  if (!compact.ok) throw new Error(compact.error.reason);
});
afterAll(() => {
  store.cleanup();
});

describe("resume after compact", () => {
  it("getSessionThreadView returns banded history plus tail", async () => {
    const view = await fixture.sdk.threadView.getSessionThreadView({ filePath: fixture.filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const bandLines = view.value.entries.filter(
      (entry) =>
        "role" in entry &&
        entry.role === "user" &&
        typeof entry.content === "string" &&
        entry.content.startsWith("[context · "),
    );
    expect(bandLines.length).toBeGreaterThan(0);
    expect(
      view.value.entries.some(
        (entry) =>
          "role" in entry &&
          entry.role === "user" &&
          typeof entry.content === "string" &&
          !entry.content.startsWith("[context · "),
      ),
    ).toBe(true);
  });

  it("reseeding PI session uses LHC thread-view, not PI native compaction", async () => {
    const sessionView = await fixture.sdk.threadView.getSessionThreadView({ filePath: fixture.filePath });
    expect(sessionView.ok).toBe(true);
    if (!sessionView.ok) return;

    const sessionManager = {
      messages: [] as unknown[],
      customEntries: [] as unknown[],
      appendMessage(message: unknown) {
        this.messages.push(message);
        return `pi_${this.messages.length}`;
      },
      appendModelChange() {
        return "mc1";
      },
      appendThinkingLevelChange() {
        return "tl1";
      },
      appendCustomEntry(_type: string, data: unknown) {
        this.customEntries.push(data);
        return "seed_map";
      },
    };

    const seeded = await seedPiSessionFromLhc(
      { sdk: fixture.sdk } as never,
      { filePath: fixture.filePath },
      sessionManager as never,
    );
    expect(seeded.ok).toBe(true);
    expect(sessionManager.messages.length).toBeGreaterThan(0);
    expect(sessionManager.customEntries.length).toBe(1);
    expect(
      sessionView.value.entries.some(
        (entry) => "role" in entry && typeof entry.content === "string" && entry.content.startsWith("[context · "),
      ),
    ).toBe(true);
  });

  it("durable events remain after compact", async () => {
    const events = await intakeStream.listEvents({ filePath: fixture.filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.length).toBeGreaterThan(0);
  });

  it("view snapshot survives reopen in a fresh SDK instance", async () => {
    const reopened = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const described = await reopened.threadView.describe({ filePath: fixture.filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value).not.toBeNull();
    if (described.value === null) return;
    expect(described.value.compactPoint).toBeGreaterThan(0);
  });
});

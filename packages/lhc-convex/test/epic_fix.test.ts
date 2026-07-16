// Epic Fix Batch 1: blank-path rejection (F-EPIC-001) and read-surface
// reference validation (F-EPIC-002) — the fail-closed thread-reference
// contract, exercised across every read surface.
//
// Substrate-only frozen assertions (documented n/a): the frozen leg checks
// `existsSync(store.registryPath) === false` after a blank-path rejection to
// prove the SQLite registry file was never opened. Convex has no registry
// file; "nothing created" is proven instead by listing the instance's threads
// and getting an empty array. The `resolveThreadRef` SDK helper is a
// Node-only export; its blank-ref contract is covered by newThread and the
// read surfaces, all of which route through the same `resolveThread`.
import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, ThreadRef } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
});

const READ_SURFACES: ReadonlyArray<{
  name: string;
  call: (ref: ThreadRef) => Promise<{ ok: boolean; error?: { errorClass: string; code: string } }>;
}> = [
  { name: "intakeStream.listEvents", call: (ref) => sdk.intakeStream.listEvents(ref) },
  { name: "messages.list", call: (ref) => sdk.messages.list(ref) },
  { name: "turns.listTurns", call: (ref) => sdk.turns.listTurns(ref) },
];

describe("F-EPIC-001 (SDK): blank file path is refused before any storage touch", () => {
  test("newThread({ filePath: '' }) → caller_error, nothing created", async () => {
    const result = await sdk.threads.newThread({ filePath: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_thread_ref");

    const listed = await sdk.threads.listThreads();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toEqual([]);
  });

  test("newThread with a whitespace-only path is refused the same way", async () => {
    const result = await sdk.threads.newThread({ filePath: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_thread_ref");

    const listed = await sdk.threads.listThreads();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toEqual([]);
  });

  test("a read surface with a blank path fails closed with caller_error/invalid_thread_ref", async () => {
    const result = await sdk.intakeStream.listEvents({ filePath: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("invalid_thread_ref");
  });
});

describe("F-EPIC-002 (SDK): read surfaces validate the thread reference", () => {
  for (const surface of READ_SURFACES) {
    test(`${surface.name}: empty path → caller_error (no storage open)`, async () => {
      const result = await surface.call({ filePath: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error?.errorClass).toBe("caller_error");
    });

    test(`${surface.name}: unknown id → thread_not_found`, async () => {
      const result = await surface.call({ threadId: "th_unknown" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error?.errorClass).toBe("caller_error");
      expect(result.error?.code).toBe("thread_not_found");
    });
  }
});

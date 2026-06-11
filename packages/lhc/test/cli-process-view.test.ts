// Epic 03 Story 5, process-boundary suite (TC-5.4 + the deferred legs three
// stories parked here): the five `lhc view *` commands proven through the
// spawned dist/cli.js binary — real argv, real exit codes, and NO provider
// env anywhere (no view operation needs one; the spawn env strips
// LHC_PROVIDER to make that structural on the CLI paths too).
//
// Legs carried for other owners (coverage debts):
//  - TC-3.3 CLI leg (Story 3): spawned sweep receipt = SDK schema and counts
//  - CLI-intake-advances-boundary (Story 4's named debt): spawned intake over
//    max → pull shows flips, status zone ≤ target — guards the seam-install
//    class (a createSdk-only advance install passes every in-process test
//    and fails exactly this)
//  - parity rows for all five operations + the profile-violation exit-nonzero
//    leg (epic-level NFR: claimed CLI surface = proven CLI surface)
// Runs under verify-all only (LHC_PROCESS_SUITE=1).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSdk,
  estimateTokens,
  type CompactReceipt,
  type Lhc,
  type OpResult,
  type SweepReceipt,
  type ViewMessage,
  type ViewStatus,
} from "../src/index.js";
import {
  assertPiSessionConformance,
  assertSweepReceiptShape,
  createProviderDouble,
  derivedThreadFixture,
  tempStore,
  type DerivedThreadFixture,
  type TempStore,
} from "./fixtures/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pkgRoot, "dist", "cli.js");

// Every spawn runs with LHC_PROVIDER stripped: the zero-provider rule on the
// CLI paths is enforced by the environment, not by discipline.
function runBinary(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, LHC_PROVIDER: undefined },
    ...(input !== undefined ? { input } : {}),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseResult<T>(stdout: string): OpResult<T> {
  return JSON.parse(stdout) as OpResult<T>;
}

function expectOk<T>(run: { status: number | null; stdout: string }): T {
  expect(run.status).toBe(0);
  const parsed = parseResult<T>(run.stdout);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

// Story 2's reference gradient config (all three bands non-empty on the
// fixture), spelled both ways: CLI band flags and SDK params.
const GRADIENT_FLAGS = [
  "--lower-bound", "400",
  "--full", "25",
  "--smooth", "16",
  "--detailed", "10",
  "--brief", "49",
];
const GRADIENT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
};

let store: TempStore;
// Twin fixture threads: mutating commands (sweep, compact) run via CLI on
// twinCli and via SDK on twinSdk in the same order, then receipts compare —
// the deterministic fixture makes the receipts equal when the surfaces are.
let twinCli: DerivedThreadFixture;
let twinSdk: DerivedThreadFixture;
// A default-config SDK for the read-side parity legs (its view config equals
// the CLI's built-in fallback: no overrides anywhere).
let reader: Lhc;

beforeAll(async () => {
  store = tempStore();
  twinCli = await derivedThreadFixture(store);
  twinSdk = await derivedThreadFixture(store);
  reader = createSdk({ provider: createProviderDouble(), mode: "manual" });
}, 120000);
afterAll(() => {
  store.cleanup();
});

describe("CLI parity: sweep (TC-3.3 CLI leg, AC-3.7) and compact receipts through the spawned binary", () => {
  it("spawned sweep receipt passes the shared SweepReceipt schema and equals the SDK twin's counts", async () => {
    const viaCli = expectOk<SweepReceipt>(
      runBinary(["view", "sweep", "--file-path", twinCli.filePath]),
    );
    expect(() => assertSweepReceiptShape(viaCli)).not.toThrow();

    const viaSdk = await twinSdk.sdk.threadView.sweep({ filePath: twinSdk.filePath });
    expect(viaSdk.ok).toBe(true);
    if (!viaSdk.ok) return;
    expect(viaCli).toEqual(viaSdk.value);
  });

  it("spawned compact with band-override flags returns the SDK twin's receipt, embedded sweep included", async () => {
    const viaCli = expectOk<CompactReceipt>(
      runBinary(["view", "compact", "--file-path", twinCli.filePath, ...GRADIENT_FLAGS]),
    );
    const viaSdk = await twinSdk.sdk.threadView.compact(
      { filePath: twinSdk.filePath },
      { params: GRADIENT_PARAMS },
    );
    expect(viaSdk.ok).toBe(true);
    if (!viaSdk.ok) return;
    expect(viaCli).toEqual(viaSdk.value);
    // Param overrides mean no named profile in the receipt; bands all landed.
    expect(viaCli.profile).toBeNull();
    expect(viaCli.bands.brief.entries).toBeGreaterThan(0);
    expect(viaCli.bands.detailed.entries).toBeGreaterThan(0);
    expect(viaCli.bands.smooth.entries).toBeGreaterThan(0);
  });

  it("profile violation exits nonzero naming the violated constraint (AC-2.3 at the process boundary)", () => {
    // --full 40 over the default continuation profile (30/30/20/20) merges
    // field-wise BEFORE validation: sum 110 fails the named check.
    const run = runBinary([
      "view", "compact", "--file-path", twinCli.filePath, "--full", "40",
    ]);
    expect(run.status).toBe(1);
    const parsed = parseResult<never>(run.stdout);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.errorClass).toBe("caller_error");
    expect(parsed.error.code).toBe("invalid_view_config");
    expect(parsed.error.reason).toContain("sum to 100");
    expect(parsed.error.reason).toContain("110");
  });
});

describe("TC-5.4 (AC-5.5) + read parity: pull, status, materialize through the spawned binary", () => {
  it("spawned pull emits the message array itself as JSON; spawned status matches; both equal the SDK's reads of the same thread", async () => {
    // twinCli was compacted by the spawned CLI above (suite order) — both
    // targets now read the same compacted thread. The pull contract
    // (AC-5.5/TC-5.4): stdout IS the message array, no OpResult wrapper.
    const pullRun = runBinary(["view", "pull", "--file-path", twinCli.filePath, "--json"]);
    expect(pullRun.status).toBe(0);
    const cliMessages = JSON.parse(pullRun.stdout) as ViewMessage[];
    expect(Array.isArray(cliMessages)).toBe(true);
    expect(cliMessages.length).toBeGreaterThan(0);
    const sdkPull = await reader.threadView.pull({ filePath: twinCli.filePath });
    expect(sdkPull.ok).toBe(true);
    if (!sdkPull.ok) return;
    expect(cliMessages).toEqual(sdkPull.value.messages);

    const cliStatus = expectOk<ViewStatus>(
      runBinary(["view", "status", "--file-path", twinCli.filePath, "--json"]),
    );
    const sdkStatus = await reader.threadView.status({ filePath: twinCli.filePath });
    expect(sdkStatus.ok).toBe(true);
    if (!sdkStatus.ok) return;
    expect(cliStatus).toEqual(sdkStatus.value);
  });

  it("spawned materialize prints the written path; the file parses, conforms, and is byte-identical to the SDK's", async () => {
    const cliOut = path.join(store.dir, "cli-materialized.jsonl");
    const sdkOut = path.join(store.dir, "sdk-materialized.jsonl");
    // The materialize contract (AC-5.5/TC-5.4): stdout IS the written path,
    // no OpResult wrapper.
    const run = runBinary([
      "view", "materialize", "--file-path", twinCli.filePath, "--out", cliOut,
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(cliOut);

    const written = readFileSync(cliOut, "utf8");
    expect(() => assertPiSessionConformance(written)).not.toThrow();

    const viaSdk = await reader.threadView.materialize(
      { filePath: twinCli.filePath },
      { path: sdkOut },
    );
    expect(viaSdk.ok).toBe(true);
    expect(readFileSync(sdkOut, "utf8")).toBe(written);
  });

  it("unknown --format exits nonzero naming the accepted values", () => {
    const run = runBinary([
      "view", "materialize",
      "--file-path", twinCli.filePath,
      "--out", path.join(store.dir, "never.jsonl"),
      "--format", "markdown",
    ]);
    expect(run.status).toBe(1);
    const parsed = parseResult<never>(run.stdout);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("unknown_format");
    expect(parsed.error.reason).toContain("pi-session");
  });

  it("a missing thread file exits nonzero with a structured error on every view command", () => {
    const missing = path.join(store.dir, "no-such-thread.sqlite");
    const legs: string[][] = [
      ["view", "pull", "--file-path", missing],
      ["view", "status", "--file-path", missing],
      ["view", "compact", "--file-path", missing],
      ["view", "sweep", "--file-path", missing],
      ["view", "materialize", "--file-path", missing, "--out", path.join(store.dir, "x.jsonl")],
    ];
    for (const args of legs) {
      const run = runBinary(args);
      expect(run.status).toBe(1);
      const parsed = parseResult<never>(run.stdout);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.errorClass).toBe("caller_error");
      expect(parsed.error.code).toBe("thread_not_found");
    }
  });
});

// Deterministic filler that costs at least `target` tokens by the stored
// estimator — the same js-tiktoken estimate intake stamps on the projected
// message, so the test's arithmetic is the advance's arithmetic.
function contentOfTokens(target: number, seed: string): string {
  const words: string[] = [];
  let i = 0;
  let text = "";
  while (estimateTokens(text) < target) {
    for (let k = 0; k < 200; k += 1) {
      words.push(`${seed}${i}`);
      i += 1;
    }
    text = words.join(" ");
  }
  return text;
}

describe("CLI intake advances the boundary (Story 4's debt; architecture-risk seam-install leg)", () => {
  it("spawned intake over max flips old tool results: pull shows short forms, status zone ≤ target", () => {
    const threadPath = path.join(store.dir, "cli-advance.sqlite");
    expectOk(runBinary(["threads", "new-thread", "--file-path", threadPath]));

    // Three tool results against the built-in budgets (32000/24000/8000):
    // A ≈20k and B ≈20k flip; C ≈10k clears the floor alone and stays full.
    const contentA = contentOfTokens(20000, "alpha");
    const contentB = contentOfTokens(20000, "beta");
    const contentC = contentOfTokens(10000, "gamma");
    const events = [
      { eventKind: "user_prompt", payload: { text: "survey the three areas" } },
      {
        eventKind: "tool_call",
        payload: { toolCallId: "adv-1", toolName: "read_a", arguments: { area: 1 } },
      },
      {
        eventKind: "tool_result",
        payload: { toolCallId: "adv-1", content: contentA, isError: false },
      },
      {
        eventKind: "tool_call",
        payload: { toolCallId: "adv-2", toolName: "read_b", arguments: { area: 2 } },
      },
      {
        eventKind: "tool_result",
        payload: { toolCallId: "adv-2", content: contentB, isError: false },
      },
      {
        eventKind: "tool_call",
        payload: { toolCallId: "adv-3", toolName: "read_c", arguments: { area: 3 } },
      },
      {
        eventKind: "tool_result",
        payload: { toolCallId: "adv-3", content: contentC, isError: false },
      },
      { eventKind: "assistant_text", payload: { text: "all three areas surveyed" } },
      { eventKind: "turn_end", payload: {} },
    ].map((event, index) => ({
      ...event,
      idempotencyKey: `cli-advance-${index}`,
      actor: "process-test",
      harness: "spawned-cli",
    }));

    // The intake itself is the spawned binary — the leg exists to prove the
    // advance seam is installed below the SDK assembly, where a
    // createSdk-only install would leave this thread permanently over max.
    const intake = runBinary(
      ["intake-stream", "message-events", "--file-path", threadPath],
      JSON.stringify(events),
    );
    expectOk(intake);

    // status: the advance ran at flush — the zone dropped to C alone,
    // at-or-under target.
    const status = expectOk<ViewStatus>(
      runBinary(["view", "status", "--file-path", threadPath]),
    );
    expect(status.visibility.maxTokens).toBe(32000);
    expect(status.visibility.zoneTokens).toBe(estimateTokens(contentC));
    expect(status.visibility.zoneTokens).toBeLessThanOrEqual(24000);

    // pull: A and B render short (at-or-behind the boundary), C stays full.
    // Stdout is the message array itself (the AC-5.5 contract).
    const pullRun = runBinary(["view", "pull", "--file-path", threadPath]);
    expect(pullRun.status).toBe(0);
    const pulledMessages = JSON.parse(pullRun.stdout) as ViewMessage[];
    const contentOf = (name: string): string => {
      const message = pulledMessages.find((m) =>
        m.content.startsWith(`[tool result · ${name}`),
      );
      if (message === undefined) throw new Error(`no tool result rendered for ${name}`);
      return message.content;
    };
    expect(contentOf("read_a").startsWith("[tool result · read_a · abridged]\n")).toBe(true);
    expect(contentOf("read_b").startsWith("[tool result · read_b · abridged]\n")).toBe(true);
    expect(contentOf("read_c").startsWith("[tool result · read_c]\n")).toBe(true);
    expect(contentOf("read_c")).toContain(contentC);
  }, 60000);
});

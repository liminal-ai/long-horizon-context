// `lhc view *` (Epic 03 Story 5): the five thread-view commands per the
// pinned grammar (tech design §External Contracts). Every command calls the
// thread-view domain surface directly — the same operations the SDK's
// threadView namespace wraps — so CLI and SDK results are identical by
// construction (the parity legs in cli-process-view.test.ts prove it at the
// process boundary). No provider is required by any view operation; calling
// the surface directly (the cli/work.ts report/requeue pattern) keeps that
// structural: there is no provider to configure on this path at all, and
// view config falls back to the built-in defaults inside the surface.
//
// Output (AC-5.5): `view pull` emits the message array itself as JSON on
// stdout — the array IS the product crossing this boundary, not an OpResult
// envelope around it — and `view materialize` prints the written path.
// status/compact/sweep print the SDK result as JSON (Epic 01/02 convention).
// Exit 0 on success, 1 on failure; every failure is the structured OpResult
// error JSON regardless of command. `--json` is accepted per the pinned
// grammar; JSON is already the only output shape, so the flag changes
// nothing.
import { parseArgs } from "node:util";
import * as threadView from "../domains/thread-view/index.js";
import type { ThreadRef } from "../domains/threads/index.js";
import type { ViewCompactParams } from "../shared/view.js";
import { renderCliError, renderResult, type CliResult } from "./render.js";

interface ViewFlags {
  threadId?: string;
  filePath?: string;
  registryPath?: string;
  json?: boolean;
  profile?: string;
  lowerBound?: string;
  full?: string;
  smooth?: string;
  detailed?: string;
  brief?: string;
  noSweep?: boolean;
  out?: string;
  format?: string;
}

type ParseResult = { ok: true; flags: ViewFlags } | { ok: false; unknownFlag: string };

// Strict parse, mirroring cli/index.ts: an unknown or misspelled flag is
// named back to the caller, never silently dropped.
function parseViewFlags(args: readonly string[]): ParseResult {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        "thread-id": { type: "string" },
        "file-path": { type: "string" },
        registry: { type: "string" },
        json: { type: "boolean" },
        profile: { type: "string" },
        "lower-bound": { type: "string" },
        full: { type: "string" },
        smooth: { type: "string" },
        detailed: { type: "string" },
        brief: { type: "string" },
        "no-sweep": { type: "boolean" },
        out: { type: "string" },
        format: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const named = /'([^']+)'/.exec(message);
    return { ok: false, unknownFlag: named?.[1] ?? message };
  }
  const flags: ViewFlags = {};
  if (typeof values["thread-id"] === "string") flags.threadId = values["thread-id"];
  if (typeof values["file-path"] === "string") flags.filePath = values["file-path"];
  if (typeof values.registry === "string") flags.registryPath = values.registry;
  if (values.json === true) flags.json = true;
  if (typeof values.profile === "string") flags.profile = values.profile;
  if (typeof values["lower-bound"] === "string") flags.lowerBound = values["lower-bound"];
  if (typeof values.full === "string") flags.full = values.full;
  if (typeof values.smooth === "string") flags.smooth = values.smooth;
  if (typeof values.detailed === "string") flags.detailed = values.detailed;
  if (typeof values.brief === "string") flags.brief = values.brief;
  if (values["no-sweep"] === true) flags.noSweep = true;
  if (typeof values.out === "string") flags.out = values.out;
  if (typeof values.format === "string") flags.format = values.format;
  return { ok: true, flags };
}

function threadRefFrom(flags: ViewFlags): ThreadRef {
  if (flags.threadId !== undefined) {
    return flags.registryPath !== undefined
      ? { threadId: flags.threadId, registryPath: flags.registryPath }
      : { threadId: flags.threadId };
  }
  return { filePath: flags.filePath ?? "" };
}

// Numeric band/bound flags must parse before they merge over the profile;
// what they MEAN (sum check, bound positivity) is the operation's own
// validation (AC-2.3) — the adapter refuses only non-numbers, naming the
// flag, the same altitude as the other adapters' usage errors.
function parseNumericFlag(
  raw: string,
  flag: string,
): { ok: true; value: number } | { ok: false; result: CliResult } {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      result: renderCliError(
        "caller_error",
        "missing_flag",
        `${flag} must be a number, got ${raw}`,
      ),
    };
  }
  return { ok: true, value };
}

export async function runViewCommand(
  command: string | undefined,
  args: readonly string[],
): Promise<CliResult> {
  const parsed = parseViewFlags(args);
  if (!parsed.ok) {
    return renderCliError(
      "caller_error",
      "unknown_flag",
      `unknown flag: ${parsed.unknownFlag}; run lhc --help`,
    );
  }
  const flags = parsed.flags;
  const name = command === undefined ? "view" : `view ${command}`;
  if (flags.threadId === undefined && flags.filePath === undefined) {
    return renderCliError(
      "caller_error",
      "missing_flag",
      `${name} requires --thread-id or --file-path`,
    );
  }
  const ref = threadRefFrom(flags);

  switch (command) {
    case "pull": {
      const result = await threadView.pull(ref);
      if (!result.ok) return renderResult(result);
      // The story contract (AC-5.5/TC-5.4): the message array on stdout,
      // not the OpResult wrapper.
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(result.value.messages, null, 2)}\n`,
        stderr: "",
      };
    }
    case "status":
      return renderResult(await threadView.status(ref));
    case "sweep":
      return renderResult(await threadView.sweep(ref));
    case "compact": {
      const opts: Parameters<typeof threadView.compact>[1] = {};
      if (flags.profile !== undefined) opts.profile = flags.profile;
      if (flags.noSweep === true) opts.sweep = false;
      // Band flags override the profile field-wise BEFORE validation
      // (AC-2.2): `--full 40` over a 30/30/20/20 profile fails the sum check
      // with the named violation — correct behavior, not adapter business.
      const params: ViewCompactParams = {};
      const percentages: NonNullable<ViewCompactParams["percentages"]> = {};
      const numeric: Array<[string | undefined, string, (n: number) => void]> = [
        [flags.lowerBound, "--lower-bound", (n) => (params.lowerBound = n)],
        [flags.full, "--full", (n) => (percentages.full = n)],
        [flags.smooth, "--smooth", (n) => (percentages.smooth = n)],
        [flags.detailed, "--detailed", (n) => (percentages.detailed = n)],
        [flags.brief, "--brief", (n) => (percentages.brief = n)],
      ];
      for (const [raw, flag, assign] of numeric) {
        if (raw === undefined) continue;
        const value = parseNumericFlag(raw, flag);
        if (!value.ok) return value.result;
        assign(value.value);
      }
      if (Object.keys(percentages).length > 0) params.percentages = percentages;
      if (Object.keys(params).length > 0) opts.params = params;
      return renderResult(await threadView.compact(ref, opts));
    }
    case "materialize": {
      if (flags.out === undefined) {
        return renderCliError(
          "caller_error",
          "missing_flag",
          "view materialize requires --out <path>",
        );
      }
      const opts: Parameters<typeof threadView.materialize>[1] = { path: flags.out };
      // Passed through as given: an unknown format is the operation's
      // caller_error naming the accepted values, identically to an SDK caller.
      if (flags.format !== undefined) {
        opts.format = flags.format as "pi-session";
      }
      const result = await threadView.materialize(ref, opts);
      if (!result.ok) return renderResult(result);
      // The story contract (AC-5.5/TC-5.4): print the written path itself.
      return { exitCode: 0, stdout: `${result.value.writtenPath}\n`, stderr: "" };
    }
    default:
      return renderCliError(
        "caller_error",
        "unknown_command",
        `unknown command: ${name}; run lhc --help`,
      );
  }
}

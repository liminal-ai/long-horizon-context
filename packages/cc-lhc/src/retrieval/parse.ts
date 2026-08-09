/**
 * Strict pre-SDK argv parser for model-callable retrieval.
 * Invalid syntax never reaches the SDK (zero impressions).
 */

import { retrieval } from "lhc";

const MAX_RETRIEVAL_IDS_PER_CALL = retrieval.MAX_RETRIEVAL_IDS_PER_CALL;
const RETRIEVAL_ID_PATTERN = retrieval.RETRIEVAL_ID_PATTERN;

export type RetrievalOp = "get-turns" | "get-messages";

export interface ParsedRetrievalRequest {
  op: RetrievalOp;
  /** Raw ids in request order (may include duplicates; service dedupes for budget). */
  ids: string[];
  /** Unique ids, first-occurrence order. */
  uniqueIds: string[];
  fromToken: number;
}

export type ParseResult =
  | { ok: true; request: ParsedRetrievalRequest }
  | { ok: false; reason: string; usage?: string };

const TURN_ID = /^t\d{1,12}$/;
const MESSAGE_ID = /^m\d{1,12}$/;

export function usageFor(op?: RetrievalOp): string {
  if (op === "get-messages") {
    return "usage: cc-lhc get-messages [--from <n>] <mID> [mID ...]";
  }
  if (op === "get-turns") {
    return "usage: cc-lhc get-turns [--from <n>] <tID> [tID ...]";
  }
  return "usage: cc-lhc get-turns|get-messages [--from <n>] <id> [id ...]";
}

function isNonNegIntString(s: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(s)) return false;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0;
}

/** Parse `get-turns|get-messages` argv (without the `cc-lhc` binary name). */
export function parseRetrievalArgv(argv: readonly string[]): ParseResult {
  if (argv.length === 0) {
    return { ok: false, reason: "missing operation", usage: usageFor() };
  }
  const opRaw = argv[0]!;
  if (opRaw !== "get-turns" && opRaw !== "get-messages") {
    return {
      ok: false,
      reason: `unknown operation ${JSON.stringify(opRaw)}`,
      usage: usageFor(),
    };
  }
  const op: RetrievalOp = opRaw;
  const idPattern = op === "get-turns" ? TURN_ID : MESSAGE_ID;
  const kind = op === "get-turns" ? "turn" : "message";

  let fromToken = 0;
  const ids: string[] = [];
  let i = 1;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--from") {
      const v = argv[i + 1];
      if (v === undefined) {
        return { ok: false, reason: "--from requires a non-negative integer", usage: usageFor(op) };
      }
      if (!isNonNegIntString(v)) {
        return {
          ok: false,
          reason: `--from must be a non-negative integer, got ${JSON.stringify(v)}`,
          usage: usageFor(op),
        };
      }
      fromToken = Number(v);
      i += 2;
      continue;
    }
    if (a.startsWith("--from=")) {
      const v = a.slice("--from=".length);
      if (!isNonNegIntString(v)) {
        return {
          ok: false,
          reason: `--from must be a non-negative integer, got ${JSON.stringify(v)}`,
          usage: usageFor(op),
        };
      }
      fromToken = Number(v);
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      return {
        ok: false,
        reason: `unknown flag ${JSON.stringify(a)}`,
        usage: usageFor(op),
      };
    }
    ids.push(a);
    i += 1;
  }

  if (ids.length === 0) {
    return { ok: false, reason: "at least one id is required", usage: usageFor(op) };
  }

  for (const id of ids) {
    if (!idPattern.test(id) || !RETRIEVAL_ID_PATTERN.test(id)) {
      return {
        ok: false,
        reason: `invalid ${kind} id ${JSON.stringify(id)} — expected e.g. ${
          kind === "turn" ? "t211" : "m3177"
        }`,
        usage: usageFor(op),
      };
    }
  }

  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length > MAX_RETRIEVAL_IDS_PER_CALL) {
    return {
      ok: false,
      reason: `too many ids — ${uniqueIds.length} unique requested, cap is ${MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request`,
      usage: usageFor(op),
    };
  }

  return {
    ok: true,
    request: { op, ids, uniqueIds, fromToken },
  };
}

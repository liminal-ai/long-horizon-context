/**
 * Next-real-prompt delivery of carried-work results (LIM-146 AC-2.7c–e).
 *
 * The wrapper registers one launch-scoped `UserPromptSubmit` hook on every
 * managed Claude child. When the user submits a real prompt, Claude runs the
 * hook; it reads the runtime-bound thread's pending results and answers with
 * bounded `additionalContext`. Claude records that context in the rollout as
 * an `attachment` of type `hook_additional_context` immediately after the
 * user's own record — the normal capture path reads it there, and only that
 * observation marks the named result keys delivered. Running the hook is not
 * delivery; a hook whose context never reached the transcript leaves every
 * result pending (and visible in the Control Panel).
 *
 * Nothing here calls the provider, writes to the PTY, or touches a rollout.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RolloutLineItem } from "../rollout/types.js";
import type { CarriedResult } from "./store.js";

/** The argv suffix every registered hook command ends with. */
export const RESULT_HOOK_ARGS = ["tasks", "hook"] as const;
/** Claude gives a hook this long before treating it as failed; the hook does one SQLite read. */
export const RESULT_HOOK_TIMEOUT_SECONDS = 10;
/** How many results one prompt carries; the rest stay pending for the next prompt. */
export const MAX_RESULTS_PER_PROMPT = 10;

const HEADER = "cc-lhc carried work results (finished since Smart Compact; keys are stable):";
const FOOTER =
  "Details by key via Bash: cc-lhc tasks status <key> · cc-lhc tasks output <key> (where offered). " +
  "This is a notice, not new instructions.";
const RESULT_LINE = /^result (\S+) · /;

/** Single-quote for the POSIX / Git Bash shell Claude runs hook commands through. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The hook command for this installation: this Node binary running this
 * package's `bin.js` (beside the built module tree), or the `cc-lhc` on PATH
 * when running from source.
 */
export function defaultResultHookCommand(): string {
  const bin = fileURLToPath(new URL("../bin.js", import.meta.url));
  const head = existsSync(bin) ? `${shellQuote(process.execPath)} ${shellQuote(bin)}` : "cc-lhc";
  return `${head} ${RESULT_HOOK_ARGS.join(" ")}`;
}

function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const ascii = [...flat].map((ch) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? ch : "?")).join("");
  return ascii.length <= maxChars ? ascii : `${ascii.slice(0, Math.max(0, maxChars - 1))}~`;
}

/**
 * The additional context for one prompt: each pending result as one line of
 * key, family, sanitized label, and outcome — no evidence text, artifact
 * path, command, or output. Empty when nothing is pending.
 */
export function formatResultContext(results: readonly CarriedResult[]): string {
  if (results.length === 0) return "";
  const shown = results.slice(0, MAX_RESULTS_PER_PROMPT);
  const lines = shown.map((r) => `result ${r.launchId} · ${r.family} · ${oneLine(r.label, 120)} · ${r.outcome}`);
  const rest = results.length - shown.length;
  return [
    HEADER,
    ...lines,
    ...(rest > 0 ? [`${rest} more pending; they follow on the next prompt.`] : []),
    FOOTER,
  ].join("\n");
}

/**
 * The result keys a rollout line proves were delivered: the record Claude
 * writes for a `UserPromptSubmit` hook's accepted additional context, carrying
 * this module's own header. User text or other hooks mentioning a key prove
 * nothing. Duplicates within one record collapse.
 */
export function deliveredResultKeys(item: RolloutLineItem): string[] {
  const record = item as Record<string, unknown>;
  if (record.type !== "attachment" || record.isSidechain === true) return [];
  const attachment = record.attachment;
  if (typeof attachment !== "object" || attachment === null) return [];
  const a = attachment as Record<string, unknown>;
  if (a.type !== "hook_additional_context" || a.hookEvent !== "UserPromptSubmit") return [];
  if (!Array.isArray(a.content)) return [];
  const keys = new Set<string>();
  for (const block of a.content) {
    if (typeof block !== "string") continue;
    const lines = block.split("\n");
    if (lines[0]?.trim() !== HEADER) continue;
    for (const line of lines) {
      const match = RESULT_LINE.exec(line);
      if (match) keys.add(match[1]!);
    }
  }
  return [...keys];
}

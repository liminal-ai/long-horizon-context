/**
 * Canonical product names for CC-LHC context mutation.
 *
 * CC-LHC's rebuild-and-replace behavior is Smart Compact. Claude Code's
 * built-in `/compact` (and its automatic counterpart) is Claude native Compact.
 * Bare "Compact" is reserved for those literal interfaces.
 */

export const SMART_COMPACT = "Smart Compact";
export const CLAUDE_NATIVE_COMPACT = "Claude native Compact";
/** Claude Code's automatic counterpart, the one cc-lhc turns off per managed child. */
export const CLAUDE_NATIVE_AUTO_COMPACT = "Claude native auto-compact";

/**
 * What cc-lhc did about Claude's automatic Compact for this launch — the one
 * fact Home, `/status`, and `/details` all project. `disabled`: the child runs
 * with DISABLE_AUTO_COMPACT=1. `passthrough`: the launch carried the user's own
 * `--autocompact`, so cc-lhc injected nothing and can observe nothing further.
 */
export type NativeAutoCompactState = "disabled" | "passthrough";

/** Home window-row segment: the shortest truthful spelling of the same fact. */
export function nativeAutoCompactHomeSegment(state: NativeAutoCompactState): string {
  return state === "disabled"
    ? `${CLAUDE_NATIVE_AUTO_COMPACT} off`
    : `${CLAUDE_NATIVE_AUTO_COMPACT} may run (--autocompact)`;
}

/** `/status` and `/details` line for the same fact. */
export function nativeAutoCompactStatusLine(state: NativeAutoCompactState): string {
  return state === "disabled" ? nativeCompactDisabledStatusLine() : nativeCompactPassthroughStatusLine();
}

/**
 * The Control Panel names an operation by the command that runs it. The
 * `*Summary` formatters below are read by the panel (Home's `last attempt`
 * notice), so they carry the command; the `*Log` formatters beside them keep
 * the product name for the wrapper log and durable records.
 */
const SMART_COMPACT_COMMAND = "/smart-compact";

export function formatOneShotStandDown(why: string, sessionId: string): string {
  return (
    `cc-lhc one-shot: ${why}; launching on ${sessionId} without ${SMART_COMPACT} — ` +
    `capture stays bound and the next invocation runs ${SMART_COMPACT}`
  );
}

export function formatOneShotMissingThread(): string {
  return `cc-lhc one-shot: ${SMART_COMPACT} without a bound thread; launching on the resumed session`;
}

export function formatOneShotCompactedBeforeLaunch(oldSessionId: string, newSessionId: string): string {
  return (
    `cc-lhc one-shot: ${SMART_COMPACT} ${oldSessionId} -> ${newSessionId} before launch; ` +
    "launching once with the original prompt"
  );
}

export function formatOneShotPreLaunchOutcome(kind: string, messages: string): string {
  return `cc-lhc one-shot pre-launch ${SMART_COMPACT} ${kind}: ${messages}`;
}

export function formatOneShotPreLaunchThrew(detail: string): string {
  return `cc-lhc one-shot pre-launch ${SMART_COMPACT} threw: ${detail}`;
}

/** Panel: Home `last attempt`. */
export function formatAutoDeferredSummary(reason: string, detail: string): string {
  return `${SMART_COMPACT_COMMAND} deferred: ${reason} (${detail})`;
}

/** Panel: Home `last attempt`. */
export function formatAutoNotRescheduledSummary(receiptId: string): string {
  return `${SMART_COMPACT_COMMAND} not re-scheduled: existing scheduled receipt ${receiptId} (restart/replay)`;
}

export function formatAutoInMemoryReceipt(receiptId: string): string {
  return (
    `cc-lhc governor: durable receipt unavailable; running ${SMART_COMPACT} against in-memory receipt ${receiptId} ` +
    `(restart recovery degraded for this attempt; the session still runs ${SMART_COMPACT})`
  );
}

/** Panel: Home `last attempt`. */
export function formatAutoSuspendedSummary(): string {
  return `${SMART_COMPACT_COMMAND} suspended: replacement incompatibility alarm`;
}

export function formatAutoThrew(detail: string): string {
  return `cc-lhc automatic ${SMART_COMPACT} operation threw: ${detail}`;
}

/**
 * Durable governor outcome detail (`mutation_deferred`), not panel copy: it is
 * attached to the receipt, so it keeps the product name and the internal guard
 * label. Home's notice for the same event is built separately and names the
 * command.
 */
export function formatAutoGuardBusyDetail(busyLabel: string): string {
  return `command guard busy (${busyLabel}); ${SMART_COMPACT} not started`;
}

export function formatAutoGuardBusyLog(busyLabel: string, receiptId: string): string {
  return `cc-lhc governor: ${SMART_COMPACT} deferred — command guard busy (${busyLabel}) [receipt ${receiptId}]`;
}

export function formatAutoMutationLog(kind: string, messages: string): string {
  return `cc-lhc automatic ${SMART_COMPACT} mutation ${kind}: ${messages}`;
}

/** Panel: Home `last attempt`. */
export function formatAutoMutationSummary(kind: string, detail: string): string {
  return `${SMART_COMPACT_COMMAND} ${kind}: ${detail}`;
}

export function formatCompactViewLine(viewId: string, tailTokens: number, totalTokens: number): string {
  return `${SMART_COMPACT} view=${viewId} tail=${tailTokens} total=${totalTokens}`;
}

export function formatCompactPreviewError(reason: string): string {
  return `${SMART_COMPACT} preview error: ${reason}`;
}

export function formatCompactBlocked(reason: string): string {
  return `${SMART_COMPACT} blocked: ${reason}`;
}

export function formatCompactSdkError(reason: string): string {
  return `${SMART_COMPACT} error: ${reason}`;
}

/** User-facing native-Compact observation on a managed session. */
export function nativeCompactAnomalyNotice(summaryPreview?: string): string {
  const preview = summaryPreview === undefined ? "" : ` — ${summaryPreview}`;
  return `ANOMALY: ${CLAUDE_NATIVE_COMPACT} ran on a managed session${preview}`;
}

/** Control Panel status projection while cc-lhc has disabled Claude's automatic Compact. */
export function nativeCompactDisabledStatusLine(): string {
  return `${CLAUDE_NATIVE_AUTO_COMPACT}: disabled for this child (DISABLE_AUTO_COMPACT=1) · manual /compact still available`;
}

/**
 * Home advisory when the launch carries the user's own `--autocompact`
 * (AC-1.7). "May" is the whole claim: the wrapper omitted its disable and can
 * observe nothing further, so it never says native Compact is on.
 */
export function nativeCompactAdvisoryLine(): string {
  return `${CLAUDE_NATIVE_COMPACT} may run before ${SMART_COMPACT} — explicit --autocompact on this launch (see /details)`;
}

/**
 * Details rows for the same advisory: the detected cause, what cc-lhc did
 * and did not do, what it cannot observe, and the supported way to remove the
 * override. `evidence` is the exact argv the wrapper detected.
 */
export function nativeCompactAdvisoryDetailsRows(evidence: string): { label: string; value: string }[] {
  return [
    { label: CLAUDE_NATIVE_COMPACT, value: `may run before ${SMART_COMPACT} — explicit --autocompact on this launch` },
    {
      label: "",
      value:
        `detected: launch argv carries \`${evidence}\` before the -- boundary; cc-lhc passed it through ` +
        "and did not set DISABLE_AUTO_COMPACT=1 for this child",
    },
    {
      label: "",
      value:
        `not observed: whether ${CLAUDE_NATIVE_COMPACT} is enabled — inherited environment and Claude ` +
        "settings govern that",
    },
    {
      label: "",
      value:
        "to restore: relaunch cc-lhc without --autocompact; cc-lhc then sets DISABLE_AUTO_COMPACT=1 for " +
        "the child (manual /compact stays available)",
    },
  ];
}

/** Control Panel status projection when the user supplied `--autocompact`. */
export function nativeCompactPassthroughStatusLine(): string {
  return (
    `${CLAUDE_NATIVE_AUTO_COMPACT}: may run — explicit --autocompact passed through; cc-lhc did not inject ` +
    "DISABLE_AUTO_COMPACT · inherited env/settings govern (see /details)"
  );
}

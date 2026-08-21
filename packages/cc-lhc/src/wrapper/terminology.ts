/**
 * Canonical product names for CC-LHC context mutation.
 *
 * CC-LHC's rebuild-and-replace behavior is Smart Compact. Claude Code's
 * built-in `/compact` (and its automatic counterpart) is Claude native Compact.
 * Bare "Compact" is reserved for those literal interfaces.
 */

export const SMART_COMPACT = "Smart Compact";
export const CLAUDE_NATIVE_COMPACT = "Claude native Compact";

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

export function formatAutoNotAuthorizedLog(why: string, liveCount: number): string {
  return `cc-lhc governor: ${SMART_COMPACT} not authorized — ${why}; ${liveCount} live background item(s) left running`;
}

export function formatAutoNotAuthorizedSummary(why: string): string {
  return `${SMART_COMPACT} not authorized: ${why}`;
}

export function formatAutoDeferredSummary(reason: string, detail: string): string {
  return `${SMART_COMPACT} deferred: ${reason} (${detail})`;
}

export function formatAutoNotRescheduledSummary(receiptId: string): string {
  return `${SMART_COMPACT} not re-scheduled: existing scheduled receipt ${receiptId} (restart/replay)`;
}

export function formatAutoInMemoryReceipt(receiptId: string): string {
  return (
    `cc-lhc governor: durable receipt unavailable; running ${SMART_COMPACT} against in-memory receipt ${receiptId} ` +
    `(restart recovery degraded for this attempt; the session still runs ${SMART_COMPACT})`
  );
}

export function formatAutoSuspendedSummary(): string {
  return `${SMART_COMPACT} suspended: replacement incompatibility alarm`;
}

export function formatAskingBeforeSmartCompact(count: number): string {
  return `cc-lhc governor: asking before ${SMART_COMPACT} kills ${count} live background item(s)`;
}

export function formatOperatorAuthorized(count: number): string {
  return `cc-lhc governor: operator authorized ${SMART_COMPACT} over ${count} live background item(s)`;
}

export function formatAutoThrew(detail: string): string {
  return `cc-lhc automatic ${SMART_COMPACT} operation threw: ${detail}`;
}

export function formatAutoGuardBusyDetail(busyLabel: string): string {
  return `command guard busy (${busyLabel}); ${SMART_COMPACT} not started`;
}

export function formatAutoGuardBusyLog(busyLabel: string, receiptId: string): string {
  return `cc-lhc governor: ${SMART_COMPACT} deferred — command guard busy (${busyLabel}) [receipt ${receiptId}]`;
}

export function formatAutoMutationLog(kind: string, messages: string): string {
  return `cc-lhc automatic ${SMART_COMPACT} mutation ${kind}: ${messages}`;
}

export function formatAutoMutationSummary(kind: string, detail: string): string {
  return `${SMART_COMPACT} ${kind}: ${detail}`;
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
  return `${CLAUDE_NATIVE_COMPACT}: disabled for this child (DISABLE_AUTO_COMPACT=1) · manual /compact still available`;
}

/** Control Panel status projection when the user supplied `--autocompact`. */
export function nativeCompactPassthroughStatusLine(): string {
  return (
    `${CLAUDE_NATIVE_COMPACT}: explicit --autocompact passed through; cc-lhc did not inject DISABLE_AUTO_COMPACT ` +
    "· inherited env/settings govern"
  );
}

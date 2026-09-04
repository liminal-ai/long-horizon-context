/**
 * Control Panel wording for strings the wrapper produces at runtime.
 *
 * The panel is a CLI: on its screens an operation is named by the command that
 * runs it, `/smart-compact` and `/smart-prune`, never by the product name or a
 * bare label. Some of those strings are built by formatters that also feed the
 * wrapper log and durable receipts, where the product terminology is correct
 * and must not change. This module is the seam between the two: run.ts sends
 * panel-bound text through here, and everything else keeps its own wording.
 */

/** The command that runs a Smart Compact, as the panel names it. */
export const PANEL_COMPACT_COMMAND = "/smart-compact";
/** The command that runs a Smart Prune, as the panel names it. */
export const PANEL_PRUNE_COMMAND = "/smart-prune";

/**
 * Operation identifiers the wrapper uses internally — governor receipt
 * operations and command-guard labels — mapped to the command a reader could
 * type. `auto_compact`, `auto-compact`, and `compact` are the same operation
 * from different origins; a manual command already arrives as its slash form.
 */
export function panelOperationName(operation: string): string {
  if (operation === "prune" || operation === "auto-prune" || operation === "auto_prune") return PANEL_PRUNE_COMMAND;
  if (operation === "compact" || operation === "auto-compact" || operation === "auto_compact") {
    return PANEL_COMPACT_COMMAND;
  }
  return operation;
}

/**
 * The Home notice and Details row for work in flight. The command guard holds
 * an internal label (`auto-compact` for the automatic path, the typed command
 * for a manual one); the panel shows the command either way.
 */
export function formatActiveOperation(label: string): string {
  return panelOperationName(label);
}

/** The Home notice row itself, so the wording and the prefix travel together. */
/** Home's retrieval row: shown only while retrieval is not ready. */
export function formatRetrievalStateRow(state: string): string {
  return `retrieval ${state}`;
}

export function formatActiveOperationRow(label: string): string {
  return `active operation: ${formatActiveOperation(label)}`;
}

/**
 * Rewrites, in order, the operation labels a shared formatter can emit. The
 * list is deliberately explicit: a blanket substitution would rename words
 * like "pruned tool results" that are prose rather than command names.
 */
const PANEL_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/\bSmart Compact\b/g, PANEL_COMPACT_COMMAND],
  [/\bSmart Prune\b/g, PANEL_PRUNE_COMMAND],
  // Receipt and error lines that open with the bare operation name.
  [/(^|\n)prune error:/g, `$1${PANEL_PRUNE_COMMAND} error:`],
  [/(^|\n)prune boundary\b/g, `$1${PANEL_PRUNE_COMMAND} boundary`],
];

/** One panel-bound string, with runtime operation labels named as commands. */
export function toPanelWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PANEL_REWRITES) out = out.replace(pattern, replacement);
  return out;
}

export interface LastActionFacts {
  /** Operation id as the governor records it: compact, auto_compact, or prune. */
  operation: string;
  origin: string;
  ago: string;
  triggerTokens?: string;
  zoneBefore?: string;
  zoneAfter?: string;
  viewTokens?: string;
}

/**
 * The Details `Last action` value. Panel-only: the same event is written to
 * the wrapper log and the durable receipt in product terminology.
 */
export function formatLastActionRow(facts: LastActionFacts): string {
  const parts = [`${panelOperationName(facts.operation)} ${facts.ago} (${facts.origin})`];
  if (facts.triggerTokens !== undefined) parts.push(`trigger ${facts.triggerTokens}`);
  if (facts.zoneBefore !== undefined && facts.zoneAfter !== undefined) {
    parts.push(`zone ${facts.zoneBefore} -> ${facts.zoneAfter}`);
  }
  if (facts.viewTokens !== undefined) parts.push(`view ${facts.viewTokens}`);
  return parts.join(" · ");
}

/**
 * The Home `last attempt` notice for a handoff that did not complete. Panel
 * only; the governor receipt and the log keep their own record.
 */
export function formatHandoffFailureSummary(
  operation: string,
  kind: "cancelled" | "nonviable",
  reason: string,
): string {
  const name = panelOperationName(operation);
  return kind === "cancelled" ? `${name} cancelled: ${reason}` : `${name} replacement not viable: ${reason}`;
}

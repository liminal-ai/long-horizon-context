export const PANEL_COMPACT_COMMAND = "/smart-compact";
export const PANEL_PRUNE_COMMAND = "/smart-prune";

export function panelOperationName(operation: string): string {
  if (operation === "prune" || operation === "auto-prune" || operation === "auto_prune") return PANEL_PRUNE_COMMAND;
  if (operation === "compact" || operation === "auto-compact" || operation === "auto_compact") {
    return PANEL_COMPACT_COMMAND;
  }
  return operation;
}

export function formatActiveOperation(label: string): string {
  return panelOperationName(label);
}

export function formatRetrievalStateRow(state: string): string {
  return `retrieval ${state}`;
}

export function formatActiveOperationRow(label: string): string {
  return `active operation: ${formatActiveOperation(label)}`;
}

const PANEL_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/\bSmart Compact\b/g, PANEL_COMPACT_COMMAND],
  [/\bSmart Prune\b/g, PANEL_PRUNE_COMMAND],
  [/(^|\n)prune error:/g, `$1${PANEL_PRUNE_COMMAND} error:`],
  [/(^|\n)prune boundary\b/g, `$1${PANEL_PRUNE_COMMAND} boundary`],
];

export function toPanelWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PANEL_REWRITES) out = out.replace(pattern, replacement);
  return out;
}

export interface LastActionFacts {
  operation: string;
  origin: string;
  ago: string;
  triggerTokens?: string;
  zoneBefore?: string;
  zoneAfter?: string;
  viewTokens?: string;
}

export function formatLastActionRow(facts: LastActionFacts): string {
  const parts = [`${panelOperationName(facts.operation)} ${facts.ago} (${facts.origin})`];
  if (facts.triggerTokens !== undefined) parts.push(`trigger ${facts.triggerTokens}`);
  if (facts.zoneBefore !== undefined && facts.zoneAfter !== undefined) {
    parts.push(`zone ${facts.zoneBefore} -> ${facts.zoneAfter}`);
  }
  if (facts.viewTokens !== undefined) parts.push(`view ${facts.viewTokens}`);
  return parts.join(" · ");
}

export function formatHandoffFailureSummary(
  operation: string,
  kind: "cancelled" | "nonviable",
  reason: string,
): string {
  const name = panelOperationName(operation);
  return kind === "cancelled" ? `${name} cancelled: ${reason}` : `${name} replacement not viable: ${reason}`;
}

export interface ToolResultTierConfig {
  smallTierTokens: number;
  smallTargetRatio: number;
  midTargetRatio: number;
}

export function toolResultTargetTokens(tokens: number, config: ToolResultTierConfig): number {
  const ratio = tokens <= config.smallTierTokens ? config.smallTargetRatio : config.midTargetRatio;
  return Math.max(1, Math.ceil(tokens * ratio));
}

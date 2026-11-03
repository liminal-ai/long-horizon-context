export type Binding = { sessionId: string; transcriptPath: string; source: string };

/** The opener waiting for its turn to start, and each open turn's name by engine turn id. */
export type TurnNames = { pending?: string; names: Record<string, string> };

declare module "claude-code" {
  interface PluginState {
    lhc: { binding: Binding; turns: TurnNames };
  }
}

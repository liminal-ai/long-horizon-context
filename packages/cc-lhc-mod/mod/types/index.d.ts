export type Binding = { sessionId: string; transcriptPath: string; source: string };

/** The opener waiting for its turn to start, and each open turn's name by engine turn id. */
export type TurnNames = { pending?: string; names: Record<string, string> };

export type PanelDerivations = { ready: number; pending: number; failed: number; blocked: number };

export type LastCompact = {
  at: number;
  op: "compact" | "prune";
  trigger: string;
  before?: number;
} & ({ by: "lhc"; after: number; isMidTurn: boolean } | { by: "native"; reason: string });

export type ActionKind = "compact" | "prune" | "export" | "settings";
export type Action = { kind: ActionKind; state: "running" | "done" | "failed"; text: string; at: number };

export type PanelState = {
  thread: { id: string; how: string } | null;
  settings: { lowerBound: number; upperBound: number; compactPercent: number } | null;
  policy: { window: number; trigger: number; target: number; pct: number; isClamped: boolean } | null;
  context: number | null;
  lastCompact: LastCompact | null;
  derivations: PanelDerivations | null;
  action: Action | null;
};

declare module "claude-code" {
  interface PluginState {
    lhc: { binding: Binding; turns: TurnNames; panel: { shape: string; value: PanelState } };
  }
}

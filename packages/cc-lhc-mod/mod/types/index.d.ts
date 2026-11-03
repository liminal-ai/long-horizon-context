export type Binding = { sessionId: string; transcriptPath: string; source: string };

declare module "claude-code" {
  interface PluginState {
    lhc: { binding: Binding };
  }
}

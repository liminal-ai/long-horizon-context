export interface InFlightCommand {
  /** Human-readable command label ("status", "prune 30000") for busy/late receipts. */
  label: string;
  startedAtMs: number;
}

/**
 * Single-flight guard over modal commands. It remembers WHAT is running and
 * since WHEN so a busy refusal can say "prune still running (41s)" instead of
 * a bare "busy" — after a detach, that named line is the only way the user
 * can tell a slow command from a dead one.
 */
export class CommandInFlightGuard {
  private inFlight: InFlightCommand | null = null;

  tryAcquire(label: string, nowMs: number): boolean {
    if (this.inFlight !== null) return false;
    this.inFlight = { label, startedAtMs: nowMs };
    return true;
  }

  current(): InFlightCommand | null {
    return this.inFlight;
  }

  release(): void {
    this.inFlight = null;
  }
}

export function formatBusyMessage(current: InFlightCommand, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - current.startedAtMs) / 1000));
  return `busy — ${current.label} still running (${seconds}s); its receipt will land here when it settles`;
}

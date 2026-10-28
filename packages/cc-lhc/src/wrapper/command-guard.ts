export interface InFlightCommand {
  label: string;
  startedAtMs: number;
}

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

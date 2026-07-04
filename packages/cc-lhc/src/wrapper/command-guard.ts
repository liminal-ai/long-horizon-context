export const COMMAND_BUSY_MESSAGE = "busy — command in progress";

export class CommandInFlightGuard {
  private inFlight = false;

  tryAcquire(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  release(): void {
    this.inFlight = false;
  }
}

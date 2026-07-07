/**
 * Holds pty output while the modal owns the screen. Claude keeps running the
 * whole time — its bytes are delayed, never dropped. A byte cap bounds the
 * hold: past it, onOverflow fires (run.ts cancels the modal, prints a notice,
 * and flushes) so a runaway stream can never grow the buffer unbounded.
 */
export class OutputHold {
  private chunks: string[] = [];
  private bytes = 0;
  private active = false;

  constructor(
    private readonly capBytes: number,
    private readonly write: (data: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  get holding(): boolean {
    return this.active;
  }

  hold(): void {
    this.active = true;
  }

  feed(data: string): void {
    if (!this.active) {
      this.write(data);
      return;
    }
    this.chunks.push(data);
    this.bytes += Buffer.byteLength(data);
    if (this.bytes > this.capBytes) this.onOverflow();
  }

  /** Release the hold and write everything held, in order. */
  flush(): void {
    this.active = false;
    if (this.chunks.length === 0) return;
    const held = this.chunks.join("");
    this.chunks = [];
    this.bytes = 0;
    this.write(held);
  }
}

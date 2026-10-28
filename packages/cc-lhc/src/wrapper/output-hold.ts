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

  flush(): void {
    this.active = false;
    if (this.chunks.length === 0) return;
    const held = this.chunks.join("");
    this.chunks = [];
    this.bytes = 0;
    this.write(held);
  }
}

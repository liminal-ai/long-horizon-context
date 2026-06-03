export class ThreadEventStoreError extends Error {
  readonly causeValue?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ThreadEventStoreError";
    this.causeValue = cause;
  }
}

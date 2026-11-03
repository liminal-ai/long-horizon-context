export function messageKeyPrefix(harness: string, uuid: string): string {
  return `${harness}:${uuid}:`;
}

export function idempotencyKey(harness: string, uuid: string, blockIndex: number, kind: string): string {
  return `${messageKeyPrefix(harness, uuid)}${blockIndex}:${kind}`;
}

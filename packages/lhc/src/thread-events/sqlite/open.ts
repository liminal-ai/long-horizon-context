export interface LhcSqliteHandle {
  readonly filename: string;
  close(): void;
}

export function openLhcSqlite(filename: string): LhcSqliteHandle {
  return {
    filename,
    close() {
      // Stub: future implementation will close a real SQLite handle.
    },
  };
}

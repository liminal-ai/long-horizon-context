import type { LhcSqliteHandle } from "./open.js";

export const LHC_THREAD_EVENTS_SCHEMA_VERSION = 1;

export function ensureLhcThreadEventsSchema(_db: LhcSqliteHandle): void {
  // Stub: future implementation will run DDL/migrations and compatibility checks.
}

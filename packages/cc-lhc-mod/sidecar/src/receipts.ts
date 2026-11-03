import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinedText } from "claude-adapter";
import type { BuiltMessage } from "../../src/compact.ts";
import type { Row } from "./capture/map.ts";
import { UNMARKED } from "./capture/transcript.ts";

/**
 * What a compact handed Claude Code to install. Claude Code appends each built
 * message back as a row with a fresh uuid, one row per message in order; those
 * rows are the projection, not new record. `claimed` holds the uuids matched so
 * far, so live capture and transcript recovery skip the same rows.
 */
export type Receipt = {
  sessionId: string;
  cursor: number;
  expected: string[];
  claimed: string[];
  /** Rows earlier receipts claimed, so a later recovery still knows them as installed. */
  earlier: string[];
};

type Shape = { role: string; text: string; toolIds: readonly string[] };

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

function fingerprint({ role, text, toolIds }: Shape): string {
  return `${role}:${toolIds.length > 0 ? toolIds.join(",") : digest(text)}`;
}

export function fingerprintOf(message: BuiltMessage): string {
  const ids = [...message.toolUses.map((use) => use.tool_use_id), ...(message.toolResults ?? []).map((r) => r.tool_use_id)];
  return fingerprint({ role: message.role, text: message.text, toolIds: ids });
}

function rowFingerprint(row: Row): string | undefined {
  const role = row.message.role;
  if (role === undefined) return undefined;
  const toolIds = row.message.content.flatMap((block) => {
    const { type, id, tool_use_id } = block as { type?: unknown; id?: unknown; tool_use_id?: unknown };
    if (type === "tool_use" && typeof id === "string") return [id];
    if (type === "tool_result" && typeof tool_use_id === "string") return [tool_use_id];
    return [];
  });
  return fingerprint({ role, text: joinedText(row.message.content), toolIds });
}

export function claim(receipt: Receipt, row: Row): Receipt | undefined {
  if (receipt.claimed.includes(row.uuid) || receipt.earlier.includes(row.uuid)) return receipt;
  const next = receipt.expected[receipt.claimed.length];
  // A prompt the person typed is never installed; only an unmarked recovered row may be.
  if (next === undefined || (row.door === "prompt" && row.origin !== UNMARKED) || rowFingerprint(row) !== next) {
    return undefined;
  }
  return { ...receipt, claimed: [...receipt.claimed, row.uuid] };
}

export class Receipts {
  readonly #path: string;
  #receipt: Receipt | undefined;

  constructor(home: string, sessionId: string) {
    mkdirSync(join(home, "receipts"), { recursive: true });
    this.#path = join(home, "receipts", `${sessionId}.json`);
    try {
      const read = JSON.parse(readFileSync(this.#path, "utf8")) as Receipt;
      this.#receipt = { ...read, earlier: read.earlier ?? [] };
    } catch {
      this.#receipt = undefined;
    }
  }

  get current(): Receipt | undefined {
    return this.#receipt;
  }

  /** Every row any receipt for this session has claimed. */
  #installed(): string[] {
    return [...(this.#receipt?.earlier ?? []), ...(this.#receipt?.claimed ?? [])];
  }

  isInstalled(uuid: string): boolean {
    return this.#installed().includes(uuid);
  }

  /** A new install to match, carrying the rows earlier installs claimed. */
  begin(next: { sessionId: string; cursor: number; expected: string[] }): void {
    this.persist({ ...next, claimed: [], earlier: this.#installed() });
  }

  persist(receipt: Receipt): void {
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(receipt));
    renameSync(`${this.#path}.tmp`, this.#path);
    this.#receipt = receipt;
  }

  /** A compact that answered native leaves no install to match; rows claimed so far stay known. */
  clear(): void {
    const receipt = this.#receipt;
    if (receipt !== undefined) this.persist({ ...receipt, expected: [], claimed: [], earlier: this.#installed() });
  }

  isProjection(row: Row): boolean {
    const receipt = this.#receipt;
    if (receipt === undefined) return false;
    const claimed = claim(receipt, row);
    if (claimed === undefined) return false;
    if (claimed !== receipt) this.persist(claimed);
    return true;
  }
}

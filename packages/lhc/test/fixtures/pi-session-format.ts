// PI session format conformance (TC-5.3/TC-5.5): the required shapes are
// DERIVED from the structure-trimmed real PI session fixture at runtime,
// never restated from the design — the fixture's job is to catch the design
// being wrong about PI, which a design-derived checker could not
// (provenance: pi-session-structure.provenance.md). Checks are
// structure-level: header line shape, entry shape, parentId chain, message
// encoding.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-session-structure.jsonl");

interface ParsedSession {
  header: Record<string, unknown>;
  entries: Array<Record<string, unknown>>;
}

function parseJsonl(text: string, label: string): ParsedSession {
  const lines = text.split("\n").filter((line) => line !== "");
  if (lines.length === 0) throw new Error(`${label}: empty file`);
  const parsed = lines.map((line, i) => {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${label} line ${i + 1}: not a JSON object`);
    }
    return value as Record<string, unknown>;
  });
  const [header, ...entries] = parsed;
  if (header === undefined) throw new Error(`${label}: no header line`);
  return { header, entries };
}

export function loadPiSessionFixture(): ParsedSession {
  return parseJsonl(readFileSync(fixturePath, "utf8"), "pi-session-structure fixture");
}

function keySet(value: Record<string, unknown>): string {
  return [...Object.keys(value)].sort().join(",");
}

function fail(where: string, expected: string, actual: unknown): never {
  throw new Error(`pi-session conformance violation at ${where}: expected ${expected}, got ${JSON.stringify(actual)}`);
}

// Validates a materialized file's structure against the real-PI fixture:
//  - header: same key set as the fixture's header, same value types,
//    type === "session"
//  - every entry: type === "message" with exactly the key set the fixture's
//    message entries carry ({type, id, parentId, timestamp, message})
//  - parentId chain: first entry null, every later entry chained to the
//    previous entry's id; ids unique
//  - message encoding: role + content present; content an array of text
//    blocks shaped like the fixture's ({type: "text", text: string})
export function assertPiSessionConformance(materializedText: string): void {
  const fixture = loadPiSessionFixture();
  const file = parseJsonl(materializedText, "materialized session");

  // Header shape derived from the fixture header.
  if (file.header["type"] !== "session") fail("header.type", '"session"', file.header["type"]);
  if (keySet(file.header) !== keySet(fixture.header)) {
    fail("header keys", keySet(fixture.header), keySet(file.header));
  }
  for (const [key, fixtureValue] of Object.entries(fixture.header)) {
    if (typeof file.header[key] !== typeof fixtureValue) {
      fail(`header.${key} type`, typeof fixtureValue, file.header[key]);
    }
  }

  // Entry shape derived from the fixture's message entries.
  const fixtureMessages = fixture.entries.filter((entry) => entry["type"] === "message");
  const referenceEntry = fixtureMessages[0];
  if (referenceEntry === undefined) {
    throw new Error("pi-session-structure fixture carries no message entries");
  }
  const referenceMessage = referenceEntry["message"] as Record<string, unknown>;
  const referenceBlocks = referenceMessage["content"];
  if (!Array.isArray(referenceBlocks) || referenceBlocks.length === 0) {
    throw new Error("pi-session-structure fixture message has no content blocks");
  }
  const referenceTextBlock = (referenceBlocks as Array<Record<string, unknown>>).find(
    (block) => block["type"] === "text",
  );
  if (referenceTextBlock === undefined) {
    throw new Error("pi-session-structure fixture message has no text block");
  }

  const seenIds = new Set<string>();
  let previousId: string | null = null;
  file.entries.forEach((entry, i) => {
    const where = `entry[${i}]`;
    if (entry["type"] !== "message") fail(`${where}.type`, '"message"', entry["type"]);
    if (keySet(entry) !== keySet(referenceEntry)) {
      fail(`${where} keys`, keySet(referenceEntry), keySet(entry));
    }
    if (typeof entry["id"] !== "string" || entry["id"] === "") {
      fail(`${where}.id`, "a non-empty string", entry["id"]);
    }
    if (typeof entry["timestamp"] !== "string" || entry["timestamp"] === "") {
      fail(`${where}.timestamp`, "a non-empty string", entry["timestamp"]);
    }
    if (entry["parentId"] !== previousId) {
      fail(`${where}.parentId (chain)`, JSON.stringify(previousId), entry["parentId"]);
    }
    if (seenIds.has(entry["id"])) fail(`${where}.id`, "a unique id", entry["id"]);
    seenIds.add(entry["id"]);
    previousId = entry["id"];

    const message = entry["message"];
    if (typeof message !== "object" || message === null) {
      fail(`${where}.message`, "an object", message);
    }
    const msg = message as Record<string, unknown>;
    if (typeof msg["role"] !== "string" || msg["role"] === "") {
      fail(`${where}.message.role`, "a non-empty string", msg["role"]);
    }
    const content = msg["content"];
    if (!Array.isArray(content) || content.length === 0) {
      fail(`${where}.message.content`, "a non-empty block array", content);
    }
    (content as unknown[]).forEach((block, j) => {
      if (typeof block !== "object" || block === null) {
        fail(`${where}.message.content[${j}]`, "an object", block);
      }
      const b = block as Record<string, unknown>;
      if (keySet(b) !== keySet(referenceTextBlock)) {
        fail(`${where}.message.content[${j}] keys`, keySet(referenceTextBlock), keySet(b));
      }
      if (b["type"] !== "text") {
        fail(`${where}.message.content[${j}].type`, '"text"', b["type"]);
      }
      if (typeof b["text"] !== "string") {
        fail(`${where}.message.content[${j}].text`, "a string", b["text"]);
      }
    });
  });
}

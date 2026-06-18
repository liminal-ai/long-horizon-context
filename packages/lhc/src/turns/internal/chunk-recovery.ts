import type { DatabaseSync } from "node:sqlite";

export type CompactChunkMaterial =
  | { kind: "ready"; content: string }
  | { kind: "concat"; content: string; reason: string }
  | { kind: "blocked"; reason: string };

function blockText(kind: string, content: Record<string, unknown>): string {
  switch (kind) {
    case "user_prompt":
    case "assistant_text":
    case "assistant_thinking":
    case "runtime_note": {
      const text = content["text"];
      return typeof text === "string" ? text : "";
    }
    case "model_change": {
      return `[model change] ${String(content["previousModel"] ?? "")} -> ${String(content["newModel"] ?? "")}`;
    }
    case "thinking_level_change": {
      return `[thinking level change] ${String(content["previousLevel"] ?? "")} -> ${String(content["newLevel"] ?? "")}`;
    }
    case "tool_call": {
      const name = typeof content["toolName"] === "string" ? content["toolName"] : "unknown_tool";
      return `[tool call · ${name}] ${JSON.stringify(content["arguments"] ?? {})}`;
    }
    case "tool_result": {
      const text = content["content"];
      return typeof text === "string" ? `[tool result]\n${text}` : "[tool result]";
    }
    default:
      return "";
  }
}

function storedMemberConcat(db: DatabaseSync, chunkId: string): CompactChunkMaterial {
  const chunk = db.prepare(`SELECT 1 FROM chunk WHERE chunk_id = ?`).get(chunkId);
  if (chunk === undefined) {
    return { kind: "blocked", reason: `canonical record corrupt: chunk ${chunkId} not found` };
  }

  const members = db
    .prepare(
      `SELECT cm.turn_id FROM chunk_member cm
       JOIN turns t ON t.turn_id = cm.turn_id AND t.deleted_at IS NULL
       WHERE cm.chunk_id = ? ORDER BY cm.member_idx`,
    )
    .all(chunkId) as unknown as Array<{ turn_id: string }>;
  if (members.length === 0) {
    return { kind: "blocked", reason: `canonical record corrupt: chunk ${chunkId} has no readable members` };
  }

  const messageStmt = db.prepare(
    `SELECT message_id, kind FROM message
     WHERE turn_id = ? AND deleted_at IS NULL ORDER BY source_event_order`,
  );
  const blockStmt = db.prepare(`SELECT content FROM message_block WHERE message_id = ? ORDER BY block_index`);
  const sections: string[] = [];
  for (const member of members) {
    const turn = db.prepare(`SELECT status, closed_at_event_order FROM turns WHERE turn_id = ?`).get(member.turn_id) as
      | { status: string; closed_at_event_order: number | bigint | null }
      | undefined;
    if (turn === undefined || turn.status !== "closed" || turn.closed_at_event_order === null) {
      return {
        kind: "blocked",
        reason: `canonical record corrupt: chunk ${chunkId} member ${member.turn_id} is unreadable`,
      };
    }
    const messages = messageStmt.all(member.turn_id) as unknown as Array<{
      message_id: string;
      kind: string;
    }>;
    const lines: string[] = [];
    for (const message of messages) {
      const blocks = blockStmt.all(message.message_id) as unknown as Array<{ content: string }>;
      const rendered = blocks
        .map((block) => blockText(message.kind, JSON.parse(block.content) as Record<string, unknown>))
        .filter((text) => text.length > 0);
      lines.push(...rendered);
    }
    sections.push(`§${member.turn_id}\n${lines.join("\n")}`);
  }

  return {
    kind: "concat",
    content: sections.join("\n\n"),
    reason: "not_ready",
  };
}

export function compactChunkMaterialFromStoredMembers(
  db: DatabaseSync,
  chunkId: string,
  derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
): CompactChunkMaterial {
  const row = db
    .prepare(
      `SELECT state, content, reason FROM derivation
       WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = ?`,
    )
    .get(chunkId, derivationType) as { state: string; content: string | null; reason: string | null } | undefined;
  if (row?.state === "ready" && row.content !== null) {
    return { kind: "ready", content: row.content };
  }
  if (row?.state === "blocked") {
    return {
      kind: "blocked",
      reason: row.reason ?? `${derivationType} for chunk ${chunkId} is blocked`,
    };
  }
  const fallback = storedMemberConcat(db, chunkId);
  if (fallback.kind !== "concat") return fallback;
  return {
    ...fallback,
    reason: row === undefined ? "missing_derivation" : row.state === "failed" ? "failed_floor" : "not_ready",
  };
}

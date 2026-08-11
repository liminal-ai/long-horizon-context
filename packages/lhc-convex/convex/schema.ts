import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const derivTarget = v.object({
  scope: v.union(v.literal("message"), v.literal("turn"), v.literal("chunk")),
  subject: v.string(),
  deriv: v.string(),
});

export default defineSchema({
  instances: defineTable({
    instance: v.string(),
    config: v.any(),
    modelCallHandle: v.string(),
  }).index("by_instance", ["instance"]),

  threads: defineTable({
    instance: v.string(),
    thread: v.string(),
    filePath: v.string(),
    title: v.optional(v.string()),
    cwd: v.optional(v.string()),
    createdAt: v.string(),
    nextEventOrder: v.number(),
    nextTurnOrder: v.number(),
    nextChunkOrder: v.number(),
    nextWorkSequence: v.number(),
    scheduledDrainId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_instance_and_thread", ["instance", "thread"])
    .index("by_instance_and_filePath", ["instance", "filePath"])
    .index("by_instance_and_cwd_and_createdAt", ["instance", "cwd", "createdAt"]),

  events: defineTable({
    instance: v.string(),
    thread: v.string(),
    eventOrder: v.number(),
    eventKind: v.string(),
    idemKey: v.string(),
    actor: v.string(),
    harness: v.string(),
    payload: v.any(),
    recordedAt: v.string(),
  })
    .index("by_instance_and_thread_and_eventOrder", ["instance", "thread", "eventOrder"])
    .index("by_instance_and_thread_and_idemKey", ["instance", "thread", "idemKey"]),

  turns: defineTable({
    instance: v.string(),
    thread: v.string(),
    turn: v.string(),
    turnOrder: v.number(),
    status: v.union(v.literal("open"), v.literal("closed")),
    openedAtEventOrder: v.number(),
    closedAtEventOrder: v.optional(v.number()),
    // Host-observed outcome/timing from turn_end (schema v5 / D1–D2). Absent
    // when unknown — pre-v5 docs, prompt-boundary closes, empty turn_end, or
    // hosts that omit the fields. status stays open|closed only.
    outcome: v.optional(v.union(v.literal("completed"), v.literal("aborted"))),
    outcomeReason: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    endedAt: v.optional(v.string()),
    deletedAt: v.optional(v.string()),
  })
    .index("by_instance_and_thread_and_turn", ["instance", "thread", "turn"])
    .index("by_instance_and_thread_and_deletedAt_and_turnOrder", ["instance", "thread", "deletedAt", "turnOrder"])
    .index("by_instance_and_thread_and_status", ["instance", "thread", "status"]),

  messages: defineTable({
    instance: v.string(),
    thread: v.string(),
    message: v.string(),
    sourceOrder: v.number(),
    kind: v.string(),
    tokenEstimate: v.number(),
    actor: v.string(),
    harness: v.string(),
    turn: v.string(),
    recordedAt: v.string(),
    // Verbatim provider usage JSON for assistant_text events that carried it
    // (schema v5 / D1, D3). Absent for every other kind and for pre-v5 docs.
    // Stored as host JSON verbatim — same precedent as event payload (v.any()).
    providerUsage: v.optional(v.any()),
    deletedAt: v.optional(v.string()),
  })
    .index("by_instance_and_thread_and_message", ["instance", "thread", "message"])
    .index("by_instance_and_thread_and_sourceOrder", ["instance", "thread", "sourceOrder"])
    .index("by_instance_and_thread_and_deletedAt_and_sourceOrder", ["instance", "thread", "deletedAt", "sourceOrder"])
    .index("by_instance_and_thread_and_turn_and_deletedAt_and_sourceOrder", [
      "instance",
      "thread",
      "turn",
      "deletedAt",
      "sourceOrder",
    ])
    .index("by_instance_and_thread_and_kind_and_deletedAt_and_sourceOrder", [
      "instance",
      "thread",
      "kind",
      "deletedAt",
      "sourceOrder",
    ]),

  messageBlocks: defineTable({
    instance: v.string(),
    thread: v.string(),
    message: v.string(),
    blockIndex: v.number(),
    blockType: v.string(),
    content: v.any(),
  }).index("by_instance_and_thread_and_message_and_blockIndex", ["instance", "thread", "message", "blockIndex"]),

  workItems: defineTable({
    instance: v.string(),
    thread: v.string(),
    workItem: v.string(),
    seq: v.number(),
    owner: v.union(v.literal("messages"), v.literal("turns")),
    kind: v.string(),
    sourceRef: v.any(),
    sourceVersion: v.number(),
    status: v.union(v.literal("queued"), v.literal("running")),
    queuedAt: v.string(),
    startedAt: v.optional(v.string()),
    derivs: v.array(derivTarget),
  })
    .index("by_instance_and_thread_and_workItem", ["instance", "thread", "workItem"])
    .index("by_instance_and_thread_and_status_and_seq", ["instance", "thread", "status", "seq"]),

  derivations: defineTable({
    instance: v.string(),
    thread: v.string(),
    scope: v.union(v.literal("message"), v.literal("turn"), v.literal("chunk")),
    subject: v.string(),
    deriv: v.string(),
    state: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed"), v.literal("blocked")),
    content: v.optional(v.string()),
    reason: v.optional(v.string()),
    metadata: v.optional(v.any()),
    sourceVersion: v.number(),
    gaps: v.optional(v.array(v.any())),
    derivedAt: v.optional(v.string()),
  })
    .index("by_instance_and_thread_and_scope_and_subject_and_deriv", [
      "instance",
      "thread",
      "scope",
      "subject",
      "deriv",
    ])
    .index("by_instance_and_thread_and_state", ["instance", "thread", "state"]),

  chunks: defineTable({
    instance: v.string(),
    thread: v.string(),
    chunk: v.string(),
    chunkOrder: v.number(),
    status: v.union(v.literal("open"), v.literal("closed")),
    accumulatedProjectedTokens: v.number(),
  })
    .index("by_instance_and_thread_and_chunk", ["instance", "thread", "chunk"])
    .index("by_instance_and_thread_and_chunkOrder", ["instance", "thread", "chunkOrder"])
    .index("by_instance_and_thread_and_status", ["instance", "thread", "status"]),

  chunkMembers: defineTable({
    instance: v.string(),
    thread: v.string(),
    chunk: v.string(),
    turn: v.string(),
    memberIdx: v.number(),
  })
    .index("by_instance_and_thread_and_chunk_and_memberIdx", ["instance", "thread", "chunk", "memberIdx"])
    .index("by_instance_and_thread_and_turn", ["instance", "thread", "turn"]),

  threadViews: defineTable({
    instance: v.string(),
    thread: v.string(),
    view: v.string(),
    createdAt: v.string(),
    compactPoint: v.number(),
    coveredFrom: v.number(),
    profileName: v.optional(v.string()),
    config: v.any(),
    arrangement: v.array(v.any()),
    gaps: v.array(v.any()),
    sourceState: v.any(),
  }).index("by_instance_and_thread", ["instance", "thread"]),

  threadViewBands: defineTable({
    instance: v.string(),
    thread: v.string(),
    view: v.string(),
    band: v.union(v.literal("brief"), v.literal("detailed"), v.literal("smooth")),
    renderedText: v.string(),
    tokenCount: v.number(),
  }).index("by_instance_and_thread_and_view_and_band", ["instance", "thread", "view", "band"]),

  viewBoundaries: defineTable({
    instance: v.string(),
    thread: v.string(),
    position: v.number(),
    updatedAt: v.string(),
  }).index("by_instance_and_thread", ["instance", "thread"]),

  // One row per id requested through retrieval (schema v6 analog): the
  // durable usage log later ranking work reads. Written in the retrieval
  // mutation; nothing on the serving path reads it. Additive table —
  // deploy-safe for existing instances.
  impressions: defineTable({
    instance: v.string(),
    thread: v.string(),
    seq: v.number(),
    callId: v.string(),
    surface: v.string(),
    entityKind: v.union(v.literal("turn"), v.literal("message")),
    entityId: v.string(),
    requestIdx: v.number(),
    served: v.boolean(),
    reason: v.optional(v.string()),
    tokens: v.optional(v.number()),
    recordedAt: v.string(),
  }).index("by_instance_and_thread_and_seq", ["instance", "thread", "seq"]),

  logs: defineTable({
    instance: v.string(),
    thread: v.string(),
    seq: v.number(),
    level: v.union(v.literal("info"), v.literal("warning"), v.literal("error")),
    message: v.string(),
    deriv: v.optional(v.string()),
    subject: v.optional(v.string()),
    reason: v.optional(v.string()),
    floorUsed: v.optional(v.string()),
    recordedAt: v.string(),
  })
    .index("by_instance_and_thread_and_seq", ["instance", "thread", "seq"])
    .index("by_instance_and_thread_and_level_and_seq", ["instance", "thread", "level", "seq"]),

  derivationLogs: defineTable({
    instance: v.string(),
    thread: v.string(),
    seq: v.number(),
    scope: v.union(v.literal("message"), v.literal("turn"), v.literal("chunk")),
    subject: v.string(),
    deriv: v.string(),
    eventKind: v.string(),
    payload: v.any(),
    recordedAt: v.string(),
  })
    .index("by_instance_and_thread_and_seq", ["instance", "thread", "seq"])
    .index("by_instance_and_thread_and_scope_and_subject_and_deriv_and_seq", [
      "instance",
      "thread",
      "scope",
      "subject",
      "deriv",
      "seq",
    ]),
});

import { v } from "convex/values";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { api } from "./_generated/api.js";
import { query } from "./_generated/server.js";

const refValidator = v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) });

type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };
type MessageRow = { kind: string; deleted?: boolean; tokenEstimate: number };
type TurnRow = { status: string; chunkId?: string };
type DerivationRow = {
  state: "ready" | "pending" | "failed" | "blocked";
  subjectKind: string;
  subjectId: string;
  derivationType: string;
  reason?: string;
};
type StoredViewRow = {
  viewId: string;
  createdAt: string;
  profileName: string | null;
  compactPoint: number;
  coveredFrom: number;
  config: { lowerBound: number; percentages: Record<string, number> };
  arrangement: Array<Record<string, unknown>>;
  gaps: Array<Record<string, unknown>>;
  bands: Array<{ band: string; storedTokens: number }>;
  sourceState: Record<string, unknown>;
};

export const overview = query({
  args: { instance: v.string(), ref: refValidator },
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const common = { instance: args.instance, ref: args.ref };
    const identity = (await ctx.runQuery(api.threads.info, common)) as Result<{ threadId: string; createdAt: string }>;
    if (!identity.ok) return identity;
    const events = (await ctx.runQuery(api.intake.listEvents, common)) as Result<Array<{ eventOrder: number }>>;
    if (!events.ok) return events;
    const messages = (await ctx.runQuery(api.records.listMessages, {
      ...common,
      options: { includeDeleted: true },
    })) as Result<MessageRow[]>;
    if (!messages.ok) return messages;
    const turns = (await ctx.runQuery(api.records.listTurns, common)) as Result<TurnRow[]>;
    if (!turns.ok) return turns;
    const chunks = (await ctx.runQuery(api.records.listChunks, common)) as Result<unknown[]>;
    if (!chunks.ok) return chunks;
    const messageDerivations = (await ctx.runQuery(api.records.reportDerivations, {
      ...common,
      scope: "message",
    })) as Result<DerivationRow[]>;
    if (!messageDerivations.ok) return messageDerivations;
    const turnDerivations = (await ctx.runQuery(api.records.reportDerivations, {
      ...common,
      scope: "turn",
    })) as Result<DerivationRow[]>;
    if (!turnDerivations.ok) return turnDerivations;
    const chunkDerivations = (await ctx.runQuery(api.records.reportDerivations, {
      ...common,
      scope: "chunk",
    })) as Result<DerivationRow[]>;
    if (!chunkDerivations.ok) return chunkDerivations;
    const status = (await ctx.runQuery(api.view.status, common)) as Result<{
      visibility: { boundaryPosition: number; zoneTokens: number };
    }>;
    if (!status.ok) return status;
    const described = (await ctx.runQuery(api.view.describe, common)) as Result<StoredViewRow | null>;
    if (!described.ok) return described;
    const visible = messages.value.filter((message) => message.deleted !== true);
    const byKind: Record<string, number> = {};
    for (const message of visible) byKind[String(message.kind)] = (byKind[String(message.kind)] ?? 0) + 1;
    const derivation = { ready: 0, pending: 0, failed: 0, blocked: 0 };
    for (const row of [...messageDerivations.value, ...turnDerivations.value, ...chunkDerivations.value]) {
      derivation[row.state as keyof typeof derivation] += 1;
    }
    const eventRows = events.value;
    const first = eventRows[0];
    const last = eventRows.at(-1);
    return {
      ok: true,
      value: {
        thread: { id: identity.value.threadId, createdAt: identity.value.createdAt },
        events: {
          count: eventRows.length,
          span: first === undefined || last === undefined ? null : { first: first.eventOrder, last: last.eventOrder },
        },
        messages: {
          visible: visible.length,
          byKind,
          deleted: messages.value.length - visible.length,
          visibleTokens: visible.reduce((sum, message) => sum + Number(message.tokenEstimate), 0),
        },
        turns: {
          open: turns.value.filter((turn) => turn.status === "open").length,
          closed: turns.value.filter((turn) => turn.status === "closed").length,
        },
        chunks: {
          count: chunks.value.length,
          unchunkedTurns: turns.value.filter((turn) => turn.status === "closed" && turn.chunkId === undefined).length,
        },
        derivation,
        view:
          described.value === null
            ? null
            : {
                viewId: described.value.viewId,
                createdAt: described.value.createdAt,
                compactPoint: described.value.compactPoint,
                coveredFrom: described.value.coveredFrom,
              },
        visibility: {
          boundaryPosition: status.value.visibility.boundaryPosition,
          zoneTokens: status.value.visibility.zoneTokens,
        },
      },
    };
  },
});

export const health = query({
  args: { instance: v.string(), ref: refValidator },
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const common = { instance: args.instance, ref: args.ref };
    const work = (await ctx.runQuery(api.work.status, common)) as Result<{ queued: number; running: number }>;
    if (!work.ok) return work;
    const reports: Array<{ owner: "messages" | "turns"; result: Result<DerivationRow[]> }> = [
      {
        owner: "messages",
        result: (await ctx.runQuery(api.records.reportDerivations, { ...common, scope: "message" })) as Result<
          DerivationRow[]
        >,
      },
      {
        owner: "turns",
        result: (await ctx.runQuery(api.records.reportDerivations, { ...common, scope: "turn" })) as Result<
          DerivationRow[]
        >,
      },
      {
        owner: "turns",
        result: (await ctx.runQuery(api.records.reportDerivations, { ...common, scope: "chunk" })) as Result<
          DerivationRow[]
        >,
      },
    ];
    const failed = reports.find((report) => !report.result.ok);
    if (failed !== undefined) return failed.result;
    type HealthGroup = {
      owner: "messages" | "turns";
      kind: string;
      counts: Record<DerivationRow["state"], number>;
    };
    const grouped = new Map<string, HealthGroup>();
    const failures: Array<Record<string, unknown>> = [];
    const repairPreview: Array<Record<string, unknown>> = [];
    for (const report of reports) {
      if (!report.result.ok) continue;
      for (const row of report.result.value) {
        const key = `${report.owner}:${row.derivationType}`;
        const group: HealthGroup = grouped.get(key) ?? {
          owner: report.owner,
          kind: row.derivationType,
          counts: { ready: 0, pending: 0, failed: 0, blocked: 0 },
        };
        group.counts[row.state] += 1;
        grouped.set(key, group);
        if (row.state === "failed" || row.state === "blocked") {
          failures.push({
            owner: report.owner,
            subjectKind: row.subjectKind,
            subjectId: row.subjectId,
            derivationType: row.derivationType,
            reason: row.reason ?? "",
          });
        }
        if (row.state === "failed") {
          repairPreview.push({
            owner: report.owner,
            subjectKind: row.subjectKind,
            subjectId: row.subjectId,
            derivationType: row.derivationType,
          });
        }
      }
    }
    const owners = [...grouped.values()].sort((a, b) =>
      a.owner === b.owner ? a.kind.localeCompare(b.kind) : a.owner.localeCompare(b.owner),
    );
    return {
      ok: true,
      value: { owners, failures, repairPreview, queue: { queued: work.value.queued, claimed: work.value.running } },
    };
  },
});

export const view = query({
  args: { instance: v.string(), ref: refValidator },
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const common = { instance: args.instance, ref: args.ref };
    const described = (await ctx.runQuery(api.view.describe, common)) as Result<StoredViewRow | null>;
    if (!described.ok) return described;
    const context = (await ctx.runQuery(api.view.getLlmRequestContext, common)) as Result<{
      messages: Array<{ content: Array<{ text: string }> }>;
    }>;
    if (!context.ok) return context;
    const stored = described.value;
    const bandCount = stored?.bands.length ?? 0;
    const bandMessages = context.value.messages.slice(0, bandCount);
    const tailMessages = context.value.messages.slice(bandCount);
    const tokens = (messages: Array<{ content: Array<{ text: string }> }>) =>
      messages.reduce((sum, message) => sum + estimateTokens(message.content.map((part) => part.text).join("")), 0);
    const bandTokens = tokens(bandMessages);
    const tailTokens = tokens(tailMessages);
    return {
      ok: true,
      value: {
        meta:
          stored === null
            ? null
            : {
                viewId: stored.viewId,
                createdAt: stored.createdAt,
                profile: stored.profileName,
                config: stored.config,
                compactPoint: stored.compactPoint,
                coveredFrom: stored.coveredFrom,
              },
        bands:
          stored === null
            ? []
            : (["brief", "detailed", "smooth"] as const).flatMap((band) => {
                const entries = stored.arrangement
                  .filter((entry) => entry["band"] === band)
                  .map((entry) => ({
                    subjectKind: entry["subjectKind"],
                    subjectId: entry["subjectId"],
                    derivationUsed: entry["derivationUsed"],
                    degraded: entry["degraded"],
                  }));
                const storedBand = stored.bands.find((row) => row.band === band);
                return entries.length === 0 && storedBand === undefined
                  ? []
                  : [{ band, entries, storedTokens: storedBand?.storedTokens ?? 0 }];
              }),
        gaps: stored?.gaps ?? [],
        tail: { messageCount: tailMessages.length, tokens: tailTokens },
        loadCost: { bandTokens, tailTokens, total: bandTokens + tailTokens },
        sourceState: stored?.sourceState ?? null,
      },
    };
  },
});

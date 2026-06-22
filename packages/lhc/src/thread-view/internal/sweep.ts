// thread-view internal: the readiness sweep (Story 3, Flow 3, AC-3.1–3.7).
// Thread-view's only writing interaction with other domains — and it writes
// nothing itself: derivation state is read exclusively through the owners'
// report surfaces, repair goes exclusively through the owners' repair
// surfaces (must-not-own: never a direct work_item or derivation touch).

import * as messagesDomain from "../../messages/index.js";
import type { DerivationReportEntry, OpResult, SweepReceipt } from "../../shared-tech/index.js";
import * as turnsDomain from "../../turns/index.js";

export type ReasonClass = "transient" | "permanent";

// The reason-code classification table (tech design §Spec Validation row 1):
// data, not branching logic — the single source for transient-vs-permanent.
// Keys are the reason class codes the production terminal-failure path
// persists as the prefix of a failed derivation's reason (`<code>: <detail>`,
// FC-0.4's distinguishable-on-read-back guarantee). Codes absent from the
// table classify PERMANENT — the conservative default: an unknown failure is
// reported in the receipt with its literal reason and never requeued, where
// the other default would re-spend on a permanent failure at every compact.
// Expanding the table is config-tier work later, not a redesign.
export const REASON_CLASS_TABLE: Readonly<Record<string, ReasonClass>> = {
  rate_limit: "transient",
  timeout: "transient",
  provider_unavailable: "transient",
  content_refusal: "permanent",
  validation: "permanent",
  unknown_work_kind: "permanent",
};

// Classification reads the persisted reason's class code (the token before
// the first ":"), never the prose after it (anti-shim: no string-matching on
// lastError prose). A missing or codeless reason is unclassified ⇒ permanent.
export function classifyFailureReason(reason: string | undefined): ReasonClass {
  const code = (reason ?? "").split(":", 1)[0]?.trim() ?? "";
  return REASON_CLASS_TABLE[code] ?? "permanent";
}

type Owner = "messages" | "turns";
type OwnerLine = SweepReceipt["owners"][number];

// One owner's repair scheduling, dispatched by the entry's own subject
// vocabulary: messages by messageId; turns by subjectKind turn|chunk. The
// owner writes pending derivation state and durable queue rows; sweep never
// claims work or calls providers. Shared turn sites are deduped by the sweep
// before calling the owner again.
async function repairThroughOwner(
  filePath: string,
  owner: Owner,
  entry: DerivationReportEntry,
): Promise<OpResult<"scheduled" | "in_flight">> {
  if (owner === "messages") {
    const scheduled = await messagesDomain.scheduleDerivationRepair({ filePath }, [entry.subjectId]);
    if (!scheduled.ok) return scheduled;
    const result = scheduled.value[0];
    if (result === undefined) {
      return {
        ok: false,
        error: {
          errorClass: "caller_error",
          code: "message_not_found",
          reason: `no message ${entry.subjectId} exists in this thread`,
        },
      };
    }
    if (result.outcome === "in_flight") return { ok: true, value: "in_flight" };
    if (result.outcome === "failed") {
      return {
        ok: false,
        error: result.error,
      };
    }
    if (result.outcome === "not_derivable") {
      return {
        ok: false,
        error: {
          errorClass: "state_corruption",
          code: "source_damaged",
          reason: `message ${entry.subjectId} has reported ${entry.derivationType} derivation state, but messages owner says it is not derivable`,
        },
      };
    }
    return { ok: true, value: "scheduled" };
  }
  const scheduled =
    entry.subjectKind === "chunk"
      ? entry.derivationType === "chunk_summary_brief"
        ? await turnsDomain.scheduleBriefChunkDerivationRepair({ filePath }, entry.subjectId)
        : await turnsDomain.scheduleDetailedChunkDerivationRepair({ filePath }, entry.subjectId)
      : await turnsDomain.scheduleTurnDerivationRepair({ filePath }, entry.subjectId);
  if (!scheduled.ok) return scheduled;
  if (scheduled.value.outcome === "failed") return { ok: false, error: scheduled.value.error };
  return { ok: true, value: scheduled.value.outcome };
}

function turnsRepairSite(entry: DerivationReportEntry): string {
  return entry.subjectKind === "chunk"
    ? `${entry.derivationType}:${entry.subjectId}`
    : `turn_derivation:${entry.subjectId}`;
}

// The sweep walk (Flow 3): `messages.report` + `turns.report` → bucket each
// derivation — ready / pending ⇒ in-flight / blocked / failed × classify — then
// repair the transient failures through their owners and assemble the
// receipt per owner and kind. Buckets come from the owners' report joins,
// not raw derivation states: "retrying" is a report-level distinction the sweep
// must not re-derive. Pending derivations with live queue rows are left in flight;
// pending derivations without live work are scheduled through their owner.
// Blocked and permanent-failed derivations are reported with reasons, never
// requeued.
export async function runSweep(filePath: string): Promise<OpResult<SweepReceipt>> {
  const messageReport = await messagesDomain.report({ filePath });
  if (!messageReport.ok) return messageReport;
  const turnReport = await turnsDomain.report({ filePath });
  if (!turnReport.ok) return turnReport;

  const lines = new Map<string, OwnerLine>();
  const lineFor = (owner: Owner, kind: string): OwnerLine => {
    const key = `${owner}/${kind}`;
    let line = lines.get(key);
    if (line === undefined) {
      line = { owner, kind, ready: 0, inFlight: 0, requeued: [], blocked: [], permanentFailed: [] };
      lines.set(key, line);
    }
    return line;
  };

  const walks: Array<{ owner: Owner; entries: readonly DerivationReportEntry[] }> = [
    { owner: "messages", entries: messageReport.value },
    { owner: "turns", entries: turnReport.value },
  ];
  const repairedTurnSites = new Map<string, "scheduled" | "in_flight">();
  for (const { owner, entries } of walks) {
    for (const entry of entries) {
      const line = lineFor(owner, entry.derivationType);
      switch (entry.state) {
        case "ready":
          line.ready += 1;
          break;
        case "pending":
          if (entry.queue !== undefined) {
            line.inFlight += 1;
            break;
          }
          if (owner === "turns") {
            const site = turnsRepairSite(entry);
            const previous = repairedTurnSites.get(site);
            if (previous === "scheduled") {
              line.inFlight += 1;
              break;
            }
            if (previous === "in_flight") {
              line.inFlight += 1;
              break;
            }
          }
          {
            const repaired = await repairThroughOwner(filePath, owner, entry);
            if (!repaired.ok) return repaired;
            if (repaired.value === "in_flight") {
              line.inFlight += 1;
              if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "in_flight");
              break;
            }
            if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "scheduled");
            line.requeued.push(entry.subjectId);
          }
          break;
        case "blocked":
          line.blocked.push({
            subjectId: entry.subjectId,
            reason: entry.reason ?? "blocked (no stored reason)",
          });
          break;
        case "failed": {
          const reason = entry.reason ?? "unclassified (no stored reason)";
          if (classifyFailureReason(entry.reason) === "permanent") {
            line.permanentFailed.push({ subjectId: entry.subjectId, reason });
            break;
          }
          if (owner === "turns") {
            const site = turnsRepairSite(entry);
            const previous = repairedTurnSites.get(site);
            if (previous === "scheduled") {
              line.inFlight += 1;
              break;
            }
            if (previous === "in_flight") {
              line.inFlight += 1;
              break;
            }
          }
          const repaired = await repairThroughOwner(filePath, owner, entry);
          if (!repaired.ok) return repaired;
          if (repaired.value === "in_flight") {
            line.inFlight += 1;
            if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "in_flight");
            break;
          }
          if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "scheduled");
          line.requeued.push(entry.subjectId);
          break;
        }
      }
    }
  }

  return { ok: true, value: { owners: [...lines.values()] } };
}

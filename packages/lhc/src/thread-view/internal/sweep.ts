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
// persists as the prefix of a failed form's reason (`<code>: <detail>`,
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

// One owner's repair, dispatched by the entry's own subject vocabulary:
// messages by messageId; turns by subjectKind turn|chunk. Owner derive calls
// are synchronous; shared turn sites are deduped by the sweep before calling
// the owner again.
async function repairThroughOwner(
  filePath: string,
  owner: Owner,
  entry: DerivationReportEntry,
): Promise<OpResult<"repaired">> {
  if (owner === "messages") {
    const derived = await messagesDomain.derive({ filePath }, [entry.subjectId]);
    if (!derived.ok) return derived;
    const result = derived.value[0];
    if (result === undefined || result.outcome === "failed") {
      return {
        ok: false,
        error: result?.error ?? {
          errorClass: "caller_error",
          code: "message_not_found",
          reason: `no message ${entry.subjectId} exists in this thread`,
        },
      };
    }
    return { ok: true, value: "repaired" };
  }
  const derived =
    entry.subjectKind === "chunk"
      ? entry.derivationType === "chunk_summary_brief"
        ? await turnsDomain.deriveBriefChunk({ filePath }, entry.subjectId)
        : await turnsDomain.deriveDetailedChunk({ filePath }, entry.subjectId)
      : await turnsDomain.deriveTurn({ filePath }, entry.subjectId);
  if (!derived.ok) return derived;
  if (derived.value.outcome === "failed") return { ok: false, error: derived.value.error };
  return { ok: true, value: "repaired" };
}

function turnsRepairSite(entry: DerivationReportEntry): string {
  return entry.subjectKind === "chunk"
    ? `${entry.derivationType}:${entry.subjectId}`
    : `turn_derivation:${entry.subjectId}`;
}

function repairFoundInFlight(result: OpResult<"repaired">): boolean {
  return (
    !result.ok &&
    (result.error.code === "derivation_work_in_flight" || result.error.code === "derivation_retry_scheduled")
  );
}

// The sweep walk (Flow 3): `messages.report` + `turns.report` → bucket each
// form — ready / pending ⇒ in-flight / blocked / failed × classify — then
// repair the transient failures through their owners and assemble the
// receipt per owner and kind. Buckets come from the owners' report joins,
// not raw form states: "retrying" is a report-level distinction the sweep
// must not re-derive. Pending forms are left alone (their work is already
// live); blocked and permanent-failed are reported with reasons, never
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
  const repairedTurnSites = new Map<string, "repaired" | "in_flight">();
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
            if (previous === "repaired") {
              line.ready += 1;
              break;
            }
            if (previous === "in_flight") {
              line.inFlight += 1;
              break;
            }
          }
          {
            const repaired = await repairThroughOwner(filePath, owner, entry);
            if (repairFoundInFlight(repaired)) {
              line.inFlight += 1;
              if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "in_flight");
              break;
            }
            if (!repaired.ok) return repaired;
            if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "repaired");
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
            if (previous === "repaired") {
              line.ready += 1;
              break;
            }
            if (previous === "in_flight") {
              line.inFlight += 1;
              break;
            }
          }
          const repaired = await repairThroughOwner(filePath, owner, entry);
          if (repairFoundInFlight(repaired)) {
            line.inFlight += 1;
            if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "in_flight");
            break;
          }
          if (!repaired.ok) return repaired;
          if (owner === "turns") repairedTurnSites.set(turnsRepairSite(entry), "repaired");
          line.requeued.push(entry.subjectId);
          break;
        }
      }
    }
  }

  return { ok: true, value: { owners: [...lines.values()] } };
}

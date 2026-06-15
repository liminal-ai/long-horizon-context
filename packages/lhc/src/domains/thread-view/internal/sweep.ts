// thread-view internal: the readiness sweep (Story 3, Flow 3, AC-3.1–3.7).
// Thread-view's only writing interaction with other domains — and it writes
// nothing itself: derivation state is read exclusively through the owners'
// report surfaces, repair goes exclusively through the owners' requeue
// surfaces (must-not-own: never a direct work_item or derivation touch).
// No derivation, no provider calls, and no waiting: a requeue returns when
// the queue row is written; background mode's drain heals it later. Any
// drainSettled/polling in this module is a contract violation (anti-shim;
// TC-3.1's elapsed bound is the tripwire).
import type { DerivationReportEntry } from "../../../shared/derivation.js";
import type { OpResult } from "../../../shared/errors.js";
import type { SweepReceipt } from "../../../shared/view.js";
import * as messagesDomain from "../../messages/index.js";
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

// One owner's requeue, dispatched by the entry's own subject vocabulary —
// the consumed Epic 02 contract (messages by messageId; turns by
// subjectKind turn|chunk). The owner's `already_queued` noop is what makes
// once-per-invocation requeue dedupe structural (AC-3.4): a second ask for
// work already live at the form's source version writes nothing.
function requeueThroughOwner(
  filePath: string,
  owner: Owner,
  entry: DerivationReportEntry,
): Promise<OpResult<{ workItemId: string } | { noop: "already_queued" }>> {
  if (owner === "messages") {
    return messagesDomain.requeue({ filePath }, { messageId: entry.subjectId, derivationType: entry.derivationType });
  }
  return turnsDomain.requeue(
    { filePath },
    {
      subjectKind: entry.subjectKind === "chunk" ? "chunk" : "turn",
      subjectId: entry.subjectId,
      derivationType: entry.derivationType,
    },
  );
}

// The sweep walk (Flow 3): `messages.report` + `turns.report` → bucket each
// form — ready / pending ⇒ in-flight / blocked / failed × classify — then
// requeue the transient failures through their owners and assemble the
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
  for (const { owner, entries } of walks) {
    for (const entry of entries) {
      const line = lineFor(owner, entry.derivationType);
      switch (entry.state) {
        case "ready":
          line.ready += 1;
          break;
        case "pending":
          // Queued or retrying — work is live; the sweep waits on nothing.
          line.inFlight += 1;
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
          const requeued = await requeueThroughOwner(filePath, owner, entry);
          if (!requeued.ok) return requeued;
          // already_queued counts as in-flight: a sibling form's requeue in
          // this same walk (a turn's two forms share one work item) or a
          // prior sweep already put the work live.
          if ("noop" in requeued.value) line.inFlight += 1;
          else line.requeued.push(entry.subjectId);
          break;
        }
      }
    }
  }

  return { ok: true, value: { owners: [...lines.values()] } };
}

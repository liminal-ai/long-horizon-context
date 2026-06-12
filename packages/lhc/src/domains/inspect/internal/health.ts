// Health composition (Flow 4): both owners' report surfaces joined into
// state counts, actionable failure detail, a repair preview, and live queue
// visibility. Assembled ENTIRELY from FormReportEntry rows — never a
// derived_form or work_item read (the must-not-own rule is this domain's
// whole contract) — and never executing what it previews (AC-4.3).
import type { FormReportEntry } from "../../../shared/derivation.js";
import type { OpResult } from "../../../shared/errors.js";
import type { HealthReport } from "../../../shared/inspect.js";
import * as messages from "../../messages/index.js";
import * as turns from "../../turns/index.js";
import type { ThreadRef } from "../../threads/index.js";

type Owner = "messages" | "turns";

function emptyCounts(): HealthReport["owners"][number]["counts"] {
  return { ready: 0, pending: 0, retrying: 0, failed: 0, blocked: 0 };
}

// Failure detail (AC-4.2): attempts and last error read from wherever the
// mechanics durably put them — retry exhaustion copies them onto the form's
// metadata before the queue row is deleted; a still-live item carries them
// on the queue join. Never synthesized.
function failureOf(
  owner: Owner,
  entry: FormReportEntry,
): HealthReport["failures"][number] {
  const failure: HealthReport["failures"][number] = {
    owner,
    subjectKind: entry.subjectKind,
    subjectId: entry.subjectId,
    form: entry.form,
    reason: entry.reason ?? "",
    attempts: entry.metadata?.attempts ?? entry.queue?.attempts ?? 0,
  };
  const lastError = entry.metadata?.lastError ?? entry.queue?.lastError;
  if (lastError !== undefined) failure.lastError = lastError;
  return failure;
}

export async function composeHealth(ref: ThreadRef): Promise<OpResult<HealthReport>> {
  const messageReport = await messages.report(ref);
  if (!messageReport.ok) return messageReport;
  const turnReport = await turns.report(ref);
  if (!turnReport.ok) return turnReport;

  const sources: ReadonlyArray<readonly [Owner, readonly FormReportEntry[]]> = [
    ["messages", messageReport.value],
    ["turns", turnReport.value],
  ];

  const countsByOwnerKind = new Map<string, HealthReport["owners"][number]>();
  const failures: HealthReport["failures"] = [];
  const repairPreview: HealthReport["repairPreview"] = [];
  const queue = { queued: 0, claimed: 0 };

  for (const [owner, entries] of sources) {
    for (const entry of entries) {
      const key = `${owner}:${entry.form}`;
      let row = countsByOwnerKind.get(key);
      if (row === undefined) {
        row = { owner, kind: entry.form, counts: emptyCounts() };
        countsByOwnerKind.set(key, row);
      }
      switch (entry.state) {
        case "ready":
          row.counts.ready += 1;
          break;
        case "pending":
          if ((entry.queue?.attempts ?? 0) > 0) row.counts.retrying += 1;
          else row.counts.pending += 1;
          break;
        case "failed":
          row.counts.failed += 1;
          failures.push(failureOf(owner, entry));
          // The preview is exactly the failed-and-not-blocked set: blocked is
          // a distinct state, so failed entries ARE the requeue targets.
          repairPreview.push({
            owner,
            subjectKind: entry.subjectKind,
            subjectId: entry.subjectId,
            form: entry.form,
          });
          break;
        case "blocked":
          row.counts.blocked += 1;
          failures.push(failureOf(owner, entry));
          break;
      }
      // Live queue visibility (AC-4.5), per report entry: every pending or
      // retrying entry rides a live item, so queued + claimed here equals
      // pending + retrying above by construction.
      if (entry.queue !== undefined) {
        if (entry.queue.status === "queued") queue.queued += 1;
        else queue.claimed += 1;
      }
    }
  }

  // Deterministic order: messages before turns, kinds alphabetical within
  // an owner — repeated reads with no writes between are deep-equal.
  const owners = [...countsByOwnerKind.values()].sort((a, b) =>
    a.owner === b.owner ? a.kind.localeCompare(b.kind) : a.owner.localeCompare(b.owner),
  );

  return { ok: true, value: { owners, failures, repairPreview, queue } };
}

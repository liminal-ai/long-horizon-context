// Health composition (Flow 4): owners' report surfaces joined into state
// counts, actionable failure detail, a repair preview, and live queue
// visibility. Message/turn derivation health comes from DerivationReportEntry rows;
// capture gaps come from durable source-event markers recorded by capture.

import * as intakeStream from "../../intake-stream/index.js";
import * as messages from "../../messages/index.js";
import type { DerivationReportEntry, HealthReport, OpResult } from "../../shared-tech/index.js";
import type { ThreadRef } from "../../threads/index.js";
import * as turns from "../../turns/index.js";

type Owner = "capture" | "messages" | "turns";

function emptyCounts(): HealthReport["owners"][number]["counts"] {
  return { ready: 0, pending: 0, retrying: 0, failed: 0, blocked: 0 };
}

function captureGapText(event: intakeStream.EventRecord): string | null {
  if (event.eventKind !== "runtime_note") return null;
  return event.payload.text.startsWith("capture gap:") ? event.payload.text : null;
}

// Failure detail (AC-4.2): attempts and last error read from wherever the
// mechanics durably put them — retry exhaustion copies them onto the form's
// metadata before the queue row is deleted; a still-live item carries them
// on the queue join. Never synthesized.
function failureOf(owner: Owner, entry: DerivationReportEntry): HealthReport["failures"][number] {
  const failure: HealthReport["failures"][number] = {
    owner,
    subjectKind: entry.subjectKind,
    subjectId: entry.subjectId,
    derivationType: entry.derivationType,
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
  const events = await intakeStream.listEvents(ref);
  if (!events.ok) return events;

  const sources: ReadonlyArray<readonly [Owner, readonly DerivationReportEntry[]]> = [
    ["messages", messageReport.value],
    ["turns", turnReport.value],
  ];

  const countsByOwnerKind = new Map<string, HealthReport["owners"][number]>();
  const failures: HealthReport["failures"] = [];
  const repairPreview: HealthReport["repairPreview"] = [];
  const queue = { queued: 0, claimed: 0 };

  const captureGaps = events.value
    .map((event) => ({ event, text: captureGapText(event) }))
    .filter((gap): gap is { event: intakeStream.EventRecord; text: string } => gap.text !== null);
  if (captureGaps.length > 0) {
    countsByOwnerKind.set("capture:capture_gap", {
      owner: "capture",
      kind: "capture_gap",
      counts: { ...emptyCounts(), failed: captureGaps.length },
    });
    for (const { event, text } of captureGaps) {
      failures.push({
        owner: "capture",
        subjectKind: "event",
        subjectId: String(event.eventOrder),
        derivationType: "capture_gap",
        reason: text,
        attempts: 0,
      });
    }
  }

  for (const [owner, entries] of sources) {
    for (const entry of entries) {
      const key = `${owner}:${entry.derivationType}`;
      let row = countsByOwnerKind.get(key);
      if (row === undefined) {
        row = { owner, kind: entry.derivationType, counts: emptyCounts() };
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
            derivationType: entry.derivationType,
          });
          break;
        case "blocked":
          row.counts.blocked += 1;
          failures.push(failureOf(owner, entry));
          break;
      }
      // Live queue visibility (AC-4.5), per report entry: every pending or
      // retrying entry rides a live item, so queued + claimed here equals
      // pending + retrying above by construction. Counts are per form-report
      // entry by ratified contract (Epic 04 fix-batch-001): one work item
      // (e.g. a turn_derivation) may back multiple form entries, so a raw
      // Work-item count would break that identity.
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

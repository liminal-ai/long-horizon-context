import * as intakeStream from "../../intake-stream/index.js";
import * as messages from "../../messages/index.js";
import type { DerivationReportEntry, HealthReport, OpResult } from "../../shared-tech/index.js";
import type { ThreadRef } from "../../threads/index.js";
import * as turns from "../../turns/index.js";

type Owner = "capture" | "messages" | "turns";

function emptyCounts(): HealthReport["owners"][number]["counts"] {
  return { ready: 0, pending: 0, failed: 0, blocked: 0 };
}

function captureGapText(event: intakeStream.EventRecord): string | null {
  if (event.eventKind !== "runtime_note") return null;
  return event.payload.text.startsWith("capture gap:") ? event.payload.text : null;
}

function failureOf(owner: Owner, entry: DerivationReportEntry): HealthReport["failures"][number] {
  return {
    owner,
    subjectKind: entry.subjectKind,
    subjectId: entry.subjectId,
    derivationType: entry.derivationType,
    reason: entry.reason ?? "",
  };
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
          row.counts.pending += 1;
          break;
        case "failed":
          row.counts.failed += 1;
          failures.push(failureOf(owner, entry));
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
      if (entry.queue !== undefined) {
        if (entry.queue.status === "queued") queue.queued += 1;
        else queue.claimed += 1;
      }
    }
  }

  const owners = [...countsByOwnerKind.values()].sort((a, b) =>
    a.owner === b.owner ? a.kind.localeCompare(b.kind) : a.owner.localeCompare(b.owner),
  );

  return { ok: true, value: { owners, failures, repairPreview, queue } };
}

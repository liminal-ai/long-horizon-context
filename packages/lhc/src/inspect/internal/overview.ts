// Overview composition (Flow 1): one read-only call assembling thread
// identity, record counts, derivation states, view summary, and visibility
// from the other domains' SURFACES — list reads counted here, never table
// reads (Spec Validation #2). Every thread shape falls out of this one
// composition path: absent pieces normalize to zeros/nulls, no
// shape-specific branch.
import type { DerivationReportEntry } from "../../shared-tech/derivation.js";
import type { OpResult } from "../../shared-tech/errors.js";
import type { InspectOverview } from "../../shared-tech/inspect.js";
import * as intakeStream from "../../intake-stream/index.js";
import * as messages from "../../messages/index.js";
import * as threads from "../../threads/index.js";
import * as threadView from "../../thread-view/index.js";
import * as turns from "../../turns/index.js";
import type { ThreadRef } from "../../threads/index.js";

// One report entry's operational bucket, matching the vocabulary status
// reads (shared/derivation.ts): pending with attempts spent is retrying.
// Unlike ViewStatus, overview counts ready too (AC-1.1).
export function bucketEntries(
  entries: readonly DerivationReportEntry[],
  counts: InspectOverview["derivation"],
): void {
  for (const entry of entries) {
    switch (entry.state) {
      case "ready":
        counts.ready += 1;
        break;
      case "pending":
        if ((entry.queue?.attempts ?? 0) > 0) counts.retrying += 1;
        else counts.pending += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
    }
  }
}

export async function composeOverview(ref: ThreadRef): Promise<OpResult<InspectOverview>> {
  // Thread identity from the threads surface: the file's own metadata header
  // serves any resolvable ref; a registry row (threadId refs) adds the title.
  const identity = await threads.info(ref);
  if (!identity.ok) return identity;
  const thread: InspectOverview["thread"] = {
    id: identity.value.threadId,
    createdAt: identity.value.createdAt,
  };
  if ("threadId" in ref) {
    const registered = await threads.resolve(ref);
    if (registered.ok && registered.value.title !== undefined) {
      thread.metadata = { title: registered.value.title };
    }
  }

  const events = await intakeStream.listEvents(ref);
  if (!events.ok) return events;
  const first = events.value[0];
  const last = events.value[events.value.length - 1];
  const eventSection: InspectOverview["events"] = {
    count: events.value.length,
    span:
      first === undefined || last === undefined
        ? null
        : { first: first.eventOrder, last: last.eventOrder },
  };

  // Deleted contract (AC-1.2): the audit listing carries everything; deleted
  // records count only in `deleted` — visible, byKind, and the token sum are
  // computed over the unflagged records alone.
  const listed = await messages.listMessages(ref, { includeDeleted: true });
  if (!listed.ok) return listed;
  const messageSection: InspectOverview["messages"] = {
    visible: 0,
    byKind: {},
    deleted: 0,
    visibleTokens: 0,
  };
  for (const record of listed.value) {
    if (record.deleted === true) {
      messageSection.deleted += 1;
      continue;
    }
    messageSection.visible += 1;
    messageSection.byKind[record.kind] = (messageSection.byKind[record.kind] ?? 0) + 1;
    messageSection.visibleTokens += record.tokenEstimate;
  }

  const turnList = await turns.listTurns(ref);
  if (!turnList.ok) return turnList;
  const open = turnList.value.filter((turn) => turn.status === "open").length;
  const closed = turnList.value.length - open;

  const chunkList = await turns.listChunks(ref);
  if (!chunkList.ok) return chunkList;
  // Closed-but-unchunked: closed turns whose derivation has not placed them
  // yet — stored placement read back, never recomputed.
  const unchunkedTurns = turnList.value.filter(
    (turn) => turn.status === "closed" && turn.chunkId === undefined,
  ).length;

  // Derivation counts across both owners' report surfaces (never a
  // derivation read), ready included.
  const messageReport = await messages.report(ref);
  if (!messageReport.ok) return messageReport;
  const turnReport = await turns.report(ref);
  if (!turnReport.ok) return turnReport;
  const derivation: InspectOverview["derivation"] = {
    ready: 0,
    pending: 0,
    retrying: 0,
    failed: 0,
    blocked: 0,
  };
  bucketEntries(messageReport.value, derivation);
  bucketEntries(turnReport.value, derivation);

  // View summary and visibility (DD-5): zone tokens from status; view
  // identity from describe — the stored snapshot fields verbatim (the Story 3
  // swap Story 2 tracked: pull's meta was the interim source). Boundary
  // position still rides pull's meta, the serving surface that exposes it.
  const status = await threadView.status(ref);
  if (!status.ok) return status;
  const pulled = await threadView.pull(ref);
  if (!pulled.ok) return pulled;
  const described = await threadView.describe(ref);
  if (!described.ok) return described;
  const stored = described.value;
  const view: InspectOverview["view"] =
    stored === null
      ? null
      : {
          viewId: stored.viewId,
          createdAt: stored.createdAt,
          compactPoint: stored.compactPoint,
          coveredFrom: stored.coveredFrom,
        };

  return {
    ok: true,
    value: {
      thread,
      events: eventSection,
      messages: messageSection,
      turns: { open, closed },
      chunks: { count: chunkList.value.length, unchunkedTurns },
      derivation,
      view,
      visibility: {
        boundaryPosition: pulled.value.meta.boundaryPosition,
        zoneTokens: status.value.visibility.zoneTokens,
      },
    },
  };
}

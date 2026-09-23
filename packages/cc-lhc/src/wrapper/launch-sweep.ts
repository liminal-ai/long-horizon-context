/**
 * Launch-time cleanup of what killed wrappers leave behind (F3):
 *   1. runtime descriptors whose owner is proven gone → deleted
 *   2. abandoned rebuilt transcripts → moved aside (never deleted)
 * Dead-owner leases are reported where they are reclaimed (thread-owner
 * onReclaim → launch-thread log). One summary line goes to the wrapper log.
 * Never throws; a failed step is logged and the launch continues.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { threads } from "lhc";

import { readPendingCurrentSession, rebuiltSessionRows } from "../intake/lineage-db.js";
import { claudeSessionAlias, claudeSessionIdFromAlias } from "../intake/thread-alias.js";
import { type AbandonedRebuildSweep, sweepAbandonedRebuilds } from "../rollout/abandoned-rebuilds.js";
import {
  type DescriptorIo,
  defaultDescriptorIo,
  type StaleDescriptorSweep,
  sweepStaleRuntimeDescriptors,
} from "../runtime/descriptor.js";
import type { ProbeProcessIdentity } from "../runtime/process-identity.js";
import { probeThreadOwner } from "../runtime/thread-owner.js";

export interface LaunchSweepInput {
  home: string;
  cwd: string;
  registryPath: string;
  lineageDbPath: string;
  /**
   * The thread whose lease this launch holds. Its owner probe reads this
   * launch itself, which is not an in-flight handoff: the lease is exclusive,
   * so no other process can be mid-swap on that thread, and its abandoned
   * rebuilds are this launch's to move aside. Other threads' owners are probed
   * as usual.
   */
  ownThreadId?: string;
  log: { info(message: string): void; warn(message: string): void };
  projectsRoot?: string;
  descriptorIo?: DescriptorIo;
  readIdentity?: ProbeProcessIdentity;
  nowMs?: number;
  minAgeMs?: number;
}

export interface LaunchSweepResult {
  descriptors: StaleDescriptorSweep;
  rebuilds: AbandonedRebuildSweep | { skipped: string };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function sweepRebuilds(
  input: LaunchSweepInput,
  descriptorSessionIds: ReadonlySet<string>,
): Promise<AbandonedRebuildSweep | { skipped: string }> {
  if (!existsSync(input.lineageDbPath)) return { skipped: "no lineage db" };
  // Without a registry no alias/current fact is provable.
  if (!existsSync(input.registryPath)) return { skipped: "no registry" };
  let rebuiltSessions: Array<{ sessionId: string; threadId: string }>;
  try {
    rebuiltSessions = rebuiltSessionRows(input.lineageDbPath);
  } catch (cause) {
    return { skipped: `lineage unreadable: ${detail(cause)}` };
  }
  const registryPath = input.registryPath;
  const readIdentity = input.readIdentity ?? input.descriptorIo?.readProcessIdentity;
  return sweepAbandonedRebuilds({
    home: input.home,
    projectsRoot: input.projectsRoot ?? join(homedir(), ".claude", "projects"),
    cwd: input.cwd,
    rebuiltSessions,
    facts: {
      nowMs: input.nowMs ?? Date.now(),
      ...(input.minAgeMs === undefined ? {} : { minAgeMs: input.minAgeMs }),
      descriptorSessionIds,
      ownerOf: (threadId) =>
        threadId === input.ownThreadId
          ? "none"
          : probeThreadOwner(threadId, {
              home: input.home,
              ...(readIdentity === undefined ? {} : { readIdentity }),
            }),
      aliasKnowledge: async (sessionId) => {
        const resolved = await threads.resolveAlias({ alias: claudeSessionAlias(sessionId), registryPath });
        if (resolved.ok) return "known";
        return resolved.error.code === "alias_not_found" ? "unknown" : "indeterminate";
      },
      currentSessionOf: async (threadId) => {
        const current = await threads.currentAlias({ threadId, registryPath });
        if (!current.ok) return { ok: false };
        const alias = current.value.currentAlias;
        return { ok: true, sessionId: alias === null ? null : claudeSessionIdFromAlias(alias) };
      },
      pendingCurrentSessionOf: (threadId) => {
        try {
          return { ok: true, sessionId: readPendingCurrentSession(input.lineageDbPath, threadId)?.sessionId ?? null };
        } catch {
          return { ok: false };
        }
      },
    },
  });
}

export async function runLaunchSweep(input: LaunchSweepInput): Promise<LaunchSweepResult | undefined> {
  try {
    const descriptors = sweepStaleRuntimeDescriptors(input.home, input.descriptorIo ?? defaultDescriptorIo());
    let rebuilds: AbandonedRebuildSweep | { skipped: string };
    try {
      rebuilds = await sweepRebuilds(input, descriptors.keptSessionIds);
    } catch (cause) {
      rebuilds = { skipped: `failed: ${detail(cause)}` };
    }
    for (const path of descriptors.failed) {
      input.log.warn(`cc-lhc launch sweep: stale runtime descriptor could not be removed: ${path}`);
    }
    if (!("skipped" in rebuilds)) {
      for (const moved of rebuilds.moved) {
        input.log.info(
          `cc-lhc launch sweep: moved abandoned rebuilt session ${moved.sessionId} ${moved.from} → ${moved.to}` +
            ` (sessions-index entries removed: ${String(moved.indexEntriesRemoved)})`,
        );
      }
      for (const failed of rebuilds.failed) {
        input.log.warn(`cc-lhc launch sweep: abandoned rebuilt session ${failed.sessionId} left: ${failed.reason}`);
      }
    }
    const rebuildSummary =
      "skipped" in rebuilds
        ? `rebuilds skipped (${rebuilds.skipped})`
        : `rebuilds moved ${String(rebuilds.moved.length)}, kept ${String(rebuilds.kept.length)}, ` +
          `failed ${String(rebuilds.failed.length)}`;
    input.log.info(
      `cc-lhc launch sweep: descriptors removed ${String(descriptors.removed.length)}, ` +
        `kept live ${String(descriptors.keptLive)}, kept indeterminate ${String(descriptors.keptIndeterminate)}, ` +
        `failed ${String(descriptors.failed.length)}; ${rebuildSummary}`,
    );
    return { descriptors, rebuilds };
  } catch (cause) {
    input.log.warn(`cc-lhc launch sweep failed: ${detail(cause)}`);
    return undefined;
  }
}

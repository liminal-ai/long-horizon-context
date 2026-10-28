import { createHash } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { probeProcessIdentityNative } from "../runtime/native-identity.js";
import type { ProbeProcessIdentity } from "../runtime/process-identity.js";
import { type AdapterContext, isRefusal, sameIdentity, statPathReal, verifyOutputFile } from "./adapters.js";
import { OUTPUT_MAX_BYTES_CEILING, ownedOutputOf } from "./manage.js";
import type { ContinuityStore, ResultArtifact } from "./store.js";

export const RESULT_COPY_MAX_BYTES = OUTPUT_MAX_BYTES_CEILING;

export type CleanupRefusal =
  | "no_durable_result"
  | "identity_missing"
  | "identity_changed"
  | "identity_unverifiable"
  | "copy_failed"
  | "result_update_failed"
  | "relaunch_process_live";

export interface CleanupPorts {
  platform?: NodeJS.Platform;
  statPath?: AdapterContext["statPath"];
  readFileIdentity?: AdapterContext["readFileIdentity"];
  copyBounded?: typeof copyBounded;
  probeIdentity?: ProbeProcessIdentity;
  log?: (message: string) => void;
}

export interface CleanupReport {
  threadId: string;
  removed: string[];
  retained: Array<{ launchId: string; reason: CleanupRefusal; detail: string }>;
  copied: Array<{ launchId: string; path: string; bytes: number; truncated: boolean }>;
  fencesRemoved: string[];
  preserved: string[];
  generationsRemoved: number;
}

export function resultCopyDir(continuityDir: string): string {
  return join(continuityDir, "results");
}

function copyName(launchId: string): string {
  const safe = launchId.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(launchId).digest("hex").slice(0, 8);
  return `${safe}.${digest}.output`;
}

export function resultCopyPath(continuityDir: string, launchId: string): string {
  return join(resultCopyDir(continuityDir), copyName(launchId));
}

export function copyBounded(source: string, target: string, maxBytes: number): { bytes: number; truncated: boolean } {
  mkdirSync(join(target, ".."), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  const src = openSync(source, "r");
  let out: number | null = null;
  try {
    const total = Number(fstatSync(src, { bigint: true }).size);
    const length = Math.min(total, maxBytes);
    out = openSync(temp, "wx", 0o600);
    fchmodSync(out, 0o600);
    const chunk = Buffer.alloc(Math.min(length, 64 * 1024) || 1);
    let copied = 0;
    while (copied < length) {
      const n = readSync(src, chunk, 0, Math.min(chunk.length, length - copied), copied);
      if (n === 0) break;
      let written = 0;
      while (written < n) written += writeSync(out, chunk, written, n - written);
      copied += n;
    }
    fsyncSync(out);
    closeSync(out);
    out = null;
    renameSync(temp, target);
    if (process.platform !== "win32") {
      // Windows exposes no directory fsync to Node (opening a directory for
      // read is refused), so the file's own fsync plus the NTFS rename is the
      // local durability this platform offers. POSIX keeps the directory
      // barrier unchanged.
      const dir = openSync(join(target, ".."), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    return { bytes: copied, truncated: total > copied };
  } catch (cause) {
    if (out !== null) closeSync(out);
    try {
      unlinkSync(temp);
    } catch {}
    throw cause;
  } finally {
    closeSync(src);
  }
}

function contextOf(ports: CleanupPorts): AdapterContext {
  return {
    platform: ports.platform ?? process.platform,
    sourceRolloutPath: undefined,
    statPath: ports.statPath ?? statPathReal,
    ...(ports.readFileIdentity === undefined ? {} : { readFileIdentity: ports.readFileIdentity }),
  };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function cleanupThread(
  store: ContinuityStore,
  threadId: string,
  continuityDir: string,
  ports: CleanupPorts = {},
): CleanupReport {
  const report: CleanupReport = {
    threadId,
    removed: [],
    retained: [],
    copied: [],
    fencesRemoved: [],
    preserved: [],
    generationsRemoved: 0,
  };
  const copy = ports.copyBounded ?? copyBounded;
  const context = contextOf(ports);
  const retain = (launchId: string, reason: CleanupRefusal, text: string): void => {
    report.retained.push({ launchId, reason, detail: text });
    ports.log?.(`cc-lhc continuity cleanup: retained ${launchId} (${reason}): ${text}`);
  };

  for (const item of store.listItems(threadId)) {
    if (item.state !== "terminal") {
      report.preserved.push(item.launchId);
      continue;
    }
    const proc = item.relaunch?.process;
    if (proc != null) {
      const probed = (ports.probeIdentity ?? probeProcessIdentityNative)(proc.pid);
      const gone = !probed.ok
        ? probed.code === "not_found"
        : probed.identity.bootId !== proc.bootId || probed.identity.starttime !== proc.starttime;
      if (!gone) {
        retain(item.launchId, "relaunch_process_live", `relaunched process pid ${proc.pid} is still running`);
        continue;
      }
    }
    if (item.generation > 0) {
      const result = store.getResult(threadId, item.launchId);
      if (result === null) {
        retain(item.launchId, "no_durable_result", "carried item has no durable result; tracking kept");
        continue;
      }
      const owned = result.artifact?.kind === "owned_copy" ? null : ownedOutputOf(item);
      if (owned !== null) {
        const current = verifyOutputFile(context, owned.path);
        if (isRefusal(current)) {
          const reason: CleanupRefusal =
            current.reason === "output_file_missing" ? "identity_missing" : "identity_unverifiable";
          retain(item.launchId, reason, `${owned.path}: ${current.reason}`);
          continue;
        }
        if (!sameIdentity(current, owned.identity)) {
          retain(item.launchId, "identity_changed", `${owned.path} is no longer the file this item wrote`);
          continue;
        }
        const target = resultCopyPath(continuityDir, item.launchId);
        let made: { bytes: number; truncated: boolean };
        try {
          made = copy(owned.path, target, RESULT_COPY_MAX_BYTES);
        } catch (cause) {
          retain(item.launchId, "copy_failed", `${owned.path} -> ${target}: ${detail(cause)}`);
          continue;
        }
        const artifact: Extract<ResultArtifact, { kind: "owned_copy" }> = {
          kind: "owned_copy",
          path: target,
          bytes: made.bytes,
          truncated: made.truncated,
        };
        let updated = false;
        try {
          updated = store.setResultArtifact({ threadId, launchId: item.launchId, artifact });
        } catch (cause) {
          retain(item.launchId, "result_update_failed", detail(cause));
        }
        if (!updated) {
          if (report.retained.at(-1)?.launchId !== item.launchId) {
            retain(item.launchId, "result_update_failed", "durable result did not accept the copy reference");
          }
          try {
            unlinkSync(target);
          } catch {}
          continue;
        }
        report.copied.push({ launchId: item.launchId, ...artifact });
        ports.log?.(
          `cc-lhc continuity cleanup: ${item.launchId} output preserved (${made.bytes} bytes${made.truncated ? ", truncated" : ""}) at ${target}`,
        );
        if (item.relaunch !== null && owned.path === item.relaunch.outputPath) {
          try {
            unlinkSync(owned.path);
            report.fencesRemoved.push(owned.path);
          } catch (cause) {
            ports.log?.(`cc-lhc continuity cleanup: fence ${owned.path} not removed: ${detail(cause)}`);
          }
        }
      }
    }
    if (store.deleteTerminalItem(threadId, item.launchId)) report.removed.push(item.launchId);
  }
  if (report.preserved.length === 0) report.generationsRemoved = store.removeObsoleteGenerations(threadId);
  ports.log?.(
    `cc-lhc continuity cleanup: thread ${threadId}: ${report.removed.length} finished item(s) removed, ` +
      `${report.retained.length} retained, ${report.preserved.length} still open, ${report.generationsRemoved} generation row(s) removed`,
  );
  return report;
}

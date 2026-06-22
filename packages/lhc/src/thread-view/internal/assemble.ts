import { readBoundaryPosition } from "./boundary.js";
import { type AssembledContextMessage, renderBandMessage, renderTailMessage, toolNamesByCallId } from "./render.js";
import { readTailMessages, readViewSnapshot, type ViewSnapshot } from "./snapshot.js";

export interface AssembledViewEntry {
  message: AssembledContextMessage;
  entryId: string;
  timestamp: string;
}

export interface AssembledView {
  entries: AssembledViewEntry[];
  snapshot: ViewSnapshot | null;
}

export function assembleView(db: Parameters<typeof readViewSnapshot>[0]): AssembledView {
  const snapshot = readViewSnapshot(db);
  const compactPoint = snapshot?.compactPoint ?? 0;
  const boundaryPosition = readBoundaryPosition(db);
  const tailRows = readTailMessages(db, compactPoint);
  const renderCtx = {
    boundaryPosition,
    toolNameByCallId: toolNamesByCallId(tailRows),
  };

  const entries: AssembledViewEntry[] = [];
  if (snapshot !== null) {
    for (const band of snapshot.bands) {
      entries.push({
        message: renderBandMessage(band.band, band.renderedText),
        entryId: `${snapshot.viewId}-${band.band}`,
        timestamp: snapshot.createdAt,
      });
    }
  }
  for (const row of tailRows) {
    entries.push({
      message: renderTailMessage(row, renderCtx),
      entryId: row.messageId,
      timestamp: row.recordedAt,
    });
  }

  return {
    entries,
    snapshot,
  };
}

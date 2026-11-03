import type { EngineInterface } from "claude-code";
import { EMPTY_PANEL, type PanelState, statusLine } from "../../src/panel.ts";

const PANEL = { plugin: "lhc", key: "panel" } as const;
// Bump the shape when PanelState changes: a reload then declines what the older code stored.
const SHAPE = "panel-1";
const MAX_WRITES = 5;

let shownStatus: string | undefined;

async function held($: EngineInterface): Promise<{ state: PanelState; version: number }> {
  const { value, version } = await $.state.get(PANEL);
  return { state: value?.shape === SHAPE ? value.value : EMPTY_PANEL, version };
}

export async function publishBestEffort($: EngineInterface, patch: Partial<PanelState>): Promise<void> {
  try {
    for (let write = 0; write < MAX_WRITES; write++) {
      const { state, version } = await held($);
      const next = { ...state, ...patch };
      if (!(await $.state.set(PANEL, { shape: SHAPE, value: next }, { ifVersion: version })).isSet) continue;
      const line = statusLine(next);
      if (line !== shownStatus) {
        shownStatus = line;
        $.ui.status(line);
      }
      return;
    }
    throw new Error(`another write won ${MAX_WRITES} times`);
  } catch (error) {
    $.ui.log(`LHC panel state not saved: ${String(error)}`, { to: "debug" });
  }
}

export async function readPanel($: EngineInterface): Promise<PanelState> {
  return (await held($)).state;
}

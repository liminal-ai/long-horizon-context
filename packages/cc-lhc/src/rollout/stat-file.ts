import { stat } from "node:fs/promises";

export interface RolloutStat {
  size: number;
  mtimeMs: number;
}

export async function statRolloutFile(path: string): Promise<RolloutStat | null> {
  try {
    const fileStat = await stat(path);
    return { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
  } catch {
    return null;
  }
}

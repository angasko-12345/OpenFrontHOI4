// Types for gs-metrics.mjs (plain ESM so node can run gs-balance.mjs as is).

export interface MetricRow {
  smallID: number;
  pers: string;
  tiles: number;
  troops?: number;
  alive: boolean;
  deathTick?: number | null;
}
export interface MetricFrame {
  tick: number;
  rows: MetricRow[];
}
export interface LeaderPoint {
  tick: number;
  leader: number | null;
  share: number;
}
export interface Survival {
  n: number;
  aliveFraction: number | null;
  meanDeathTick: number | null;
}
export interface RunSummary {
  frames: number;
  midTick: number | null;
  endTick: number | null;
  landShareMid: Record<string, number> | null;
  landShareEnd: Record<string, number> | null;
  medianRankMid: Record<string, number | null> | null;
  medianRankEnd: Record<string, number | null> | null;
  survival: Record<string, Survival>;
  leaderSeries: LeaderPoint[];
  peakLeaderShare: number | null;
  snowballTick: number | null;
  leadChanges: number;
  snowballIndex: number | null;
}

export const PERSONALITIES: string[];
export const MID_TICK: number;
export function frameAtOrBefore(
  frames: MetricFrame[],
  tick: number,
): MetricFrame | null;
export function lastFrame(frames: MetricFrame[]): MetricFrame | null;
export function landShareByPersonality(
  frame: MetricFrame,
  pers?: string[],
): Record<string, number>;
export function ranks(frame: MetricFrame): Map<number, number>;
export function medianRankByPersonality(
  frame: MetricFrame,
  pers?: string[],
): Record<string, number | null>;
export function survivalByPersonality(
  frames: MetricFrame[],
  pers?: string[],
): Record<string, Survival>;
export function leaderSeries(frames: MetricFrame[]): LeaderPoint[];
export function leadChanges(series: LeaderPoint[]): number;
export function snowballTick(
  series: LeaderPoint[],
  threshold?: number,
): number | null;
export function snowballIndex(
  series: LeaderPoint[],
  after?: number,
): number | null;
export function summarizeRun(
  frames: MetricFrame[],
  opts?: { personalities?: string[]; midTick?: number },
): RunSummary;
export function meanSE(values: (number | null | undefined)[]): {
  mean: number | null;
  se: number | null;
  n: number;
};

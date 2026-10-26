import {
  frameAtOrBefore,
  landShareByPersonality,
  leadChanges,
  leaderSeries,
  meanSE,
  medianRankByPersonality,
  ranks,
  snowballIndex,
  snowballTick,
  summarizeRun,
  survivalByPersonality,
} from "../scripts/gs-metrics.mjs";

type Pers = "industrialist" | "militarist" | "defender";
interface Row {
  smallID: number;
  pers: Pers;
  tiles: number;
  troops: number;
  alive: boolean;
  deathTick: number | null;
}
interface Frame {
  tick: number;
  rows: Row[];
}

const PERS: Pers[] = ["industrialist", "militarist", "defender"];
// smallID -> personality for the hand-built nations.
const PERS_OF: Record<number, Pers> = {
  1: "industrialist",
  2: "militarist",
  3: "defender",
  4: "industrialist",
  5: "militarist",
  6: "defender",
};

/** tiles[i] is nation i+1's land; 0 means dead, with deathTick from `died`. */
function frame(
  tick: number,
  tiles: number[],
  died: Record<number, number> = {},
): Frame {
  return {
    tick,
    rows: tiles.map((t, i) => ({
      smallID: i + 1,
      pers: PERS_OF[i + 1],
      tiles: t,
      troops: t * 10,
      alive: t > 0,
      deathTick: died[i + 1] ?? null,
    })),
  };
}

describe("gs-metrics", () => {
  test("frameAtOrBefore picks the nearest frame at or before the tick", () => {
    const fs = [frame(600, [1]), frame(1200, [1]), frame(4200, [1])];
    expect(frameAtOrBefore(fs, 3600)!.tick).toBe(1200);
    expect(frameAtOrBefore(fs, 1200)!.tick).toBe(1200);
    expect(frameAtOrBefore(fs, 599)).toBeNull();
  });

  test("land share per personality ignores dead nations", () => {
    // ind: 40+10, mil: 30+0(dead), def: 20
    const f = frame(600, [40, 30, 20, 10, 0, 0]);
    const s = landShareByPersonality(f, PERS);
    expect(s.industrialist).toBeCloseTo(50);
    expect(s.militarist).toBeCloseTo(30);
    expect(s.defender).toBeCloseTo(20);
    expect(landShareByPersonality(frame(600, [0, 0]), PERS).militarist).toBe(0);
  });

  test("ranks: ties share the mean position, dead rank last", () => {
    const rk = ranks(frame(600, [50, 30, 30, 10, 0, 0]));
    expect(rk.get(1)).toBe(1);
    expect(rk.get(2)).toBe(2.5);
    expect(rk.get(3)).toBe(2.5);
    expect(rk.get(4)).toBe(4);
    expect(rk.get(5)).toBe(6);
    expect(rk.get(6)).toBe(6);
  });

  test("median rank per personality", () => {
    const m = medianRankByPersonality(frame(600, [50, 30, 30, 10, 0, 0]), PERS);
    expect(m.industrialist).toBe(2.5); // ranks 1 and 4
    expect(m.militarist).toBe(4.25); // 2.5 and 6 (dead)
    expect(m.defender).toBe(4.25); // 2.5 and 6 (dead)
  });

  test("survival: alive fraction and mean death tick", () => {
    const fs = [
      frame(600, [10, 10, 10, 10, 10, 10]),
      frame(1200, [20, 0, 10, 10, 0, 0], { 2: 900, 5: 1100, 6: 1150 }),
    ];
    const s = survivalByPersonality(fs, PERS);
    expect(s.industrialist).toEqual({
      n: 2,
      aliveFraction: 1,
      meanDeathTick: null,
    });
    expect(s.militarist.aliveFraction).toBe(0);
    expect(s.militarist.meanDeathTick).toBe(1000);
    expect(s.defender.aliveFraction).toBe(0.5);
    expect(s.defender.meanDeathTick).toBe(1150);
  });

  test("leader series, peak, snowball tick and lead changes", () => {
    const fs = [
      frame(600, [30, 20, 10]), // 1 leads, 50% (not past 50)
      frame(1200, [20, 30, 10]), // 2 leads
      frame(1800, [30, 30, 0]), // tie, incumbent 2 keeps it
      frame(2400, [70, 30, 0], { 3: 1700 }), // 1 leads, 70%
      frame(3000, [40, 60, 0], { 3: 1700 }), // 2 leads, 60%
    ];
    const s = leaderSeries(fs);
    expect(s.map((x) => x.leader)).toEqual([1, 2, 2, 1, 2]);
    expect(s[0].share).toBeCloseTo(50);
    expect(s[3].share).toBeCloseTo(70);
    expect(leadChanges(s)).toBe(3);
    expect(snowballTick(s)).toBe(2400);
    expect(summarizeRun(fs).peakLeaderShare).toBeCloseTo(70);
  });

  test("a tie with no incumbent goes to the lowest smallID", () => {
    const s = leaderSeries([frame(600, [0, 25, 25])]);
    expect(s[0].leader).toBe(2);
    expect(s[0].share).toBeCloseTo(50);
  });

  test("snowball index averages leader share after the mid tick", () => {
    const fs = [
      frame(3000, [90, 10]), // before: ignored
      frame(3600, [90, 10]), // at mid: ignored (strictly after)
      frame(4200, [60, 40]),
      frame(4800, [80, 20]),
    ];
    expect(snowballIndex(leaderSeries(fs))).toBeCloseTo(70);
    expect(snowballIndex(leaderSeries(fs.slice(0, 2)))).toBeNull();
  });

  test("a run that never snowballs", () => {
    const fs = [
      frame(600, [20, 20, 20, 20, 10, 10]),
      frame(3600, [25, 20, 20, 15, 10, 10]),
      frame(4200, [30, 25, 20, 15, 10, 0], { 6: 4000 }),
      frame(4800, [35, 30, 20, 15, 0, 0], { 5: 4500, 6: 4000 }),
    ];
    const r = summarizeRun(fs);
    expect(r.snowballTick).toBeNull();
    expect(r.leadChanges).toBe(0);
    expect(r.peakLeaderShare).toBeCloseTo(35);
    expect(r.snowballIndex).toBeCloseTo((30 + 35) / 2);
    expect(r.midTick).toBe(3600);
    expect(r.endTick).toBe(4800);
    expect(r.landShareMid!.industrialist).toBeCloseTo(40);
    expect(r.landShareEnd!.militarist).toBeCloseTo(30);
    expect(r.medianRankMid!.industrialist).toBe(2.5); // ranks 1 and 4
    expect(r.medianRankEnd!.militarist).toBe(4); // 2 and 6 (dead)
    expect(r.survival.militarist.aliveFraction).toBe(0.5);
    expect(r.survival.defender.meanDeathTick).toBe(4000);
  });

  test("meanSE skips nulls and uses the sample standard error", () => {
    expect(meanSE([null, null])).toEqual({ mean: null, se: null, n: 0 });
    expect(meanSE([5])).toEqual({ mean: 5, se: 0, n: 1 });
    const m = meanSE([1, 3, null]);
    expect(m.mean).toBe(2);
    expect(m.se).toBeCloseTo(1);
    expect(m.n).toBe(2);
  });
});

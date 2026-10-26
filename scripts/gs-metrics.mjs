// Pure metrics over one Grand Strategy playtest run (no IO).
//
// A run is the frame array written by tests/GrandStrategyPlaytest.test.ts:
//   [{ tick, rows: [{ smallID, pers, tiles, troops, alive, deathTick }] }]
// Every frame lists every nation, dead ones with tiles 0 and alive false.
// Shares are percentage points of all nation land in that frame (0-100).

export const PERSONALITIES = ["industrialist", "militarist", "defender"];
export const MID_TICK = 3600;

/** Last frame with tick <= `tick`, or null when every frame is later. */
export function frameAtOrBefore(frames, tick) {
  let best = null;
  for (const f of frames) {
    if (f.tick <= tick && (best === null || f.tick >= best.tick)) best = f;
  }
  return best;
}

export function lastFrame(frames) {
  return frames.length === 0 ? null : frames[frames.length - 1];
}

function totalTiles(frame) {
  return frame.rows.reduce((a, r) => a + (r.alive ? r.tiles : 0), 0);
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Each personality's share of nation land in one frame (points). */
export function landShareByPersonality(frame, pers = PERSONALITIES) {
  const total = totalTiles(frame);
  return Object.fromEntries(
    pers.map((p) => {
      const own = frame.rows
        .filter((r) => r.pers === p && r.alive)
        .reduce((a, r) => a + r.tiles, 0);
      return [p, total === 0 ? 0 : (100 * own) / total];
    }),
  );
}

/**
 * Rank of every nation by tiles in one frame, 1 = biggest. Alive nations
 * tied on tiles share the mean of the positions they span (1,2 tied -> 1.5).
 * Dead nations all rank last: the number of nations in the frame.
 * Returns Map<smallID, rank>.
 */
export function ranks(frame) {
  const n = frame.rows.length;
  const alive = frame.rows
    .filter((r) => r.alive)
    .sort((a, b) => b.tiles - a.tiles);
  const out = new Map();
  let i = 0;
  while (i < alive.length) {
    let j = i;
    while (j + 1 < alive.length && alive[j + 1].tiles === alive[i].tiles) j++;
    const rank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) out.set(alive[k].smallID, rank);
    i = j + 1;
  }
  for (const r of frame.rows) if (!r.alive) out.set(r.smallID, n);
  return out;
}

/** Median rank of each personality's nations in one frame (null if none). */
export function medianRankByPersonality(frame, pers = PERSONALITIES) {
  const rk = ranks(frame);
  return Object.fromEntries(
    pers.map((p) => [
      p,
      median(
        frame.rows.filter((r) => r.pers === p).map((r) => rk.get(r.smallID)),
      ),
    ]),
  );
}

/**
 * Per personality at the last frame: fraction alive (0-1) and the mean
 * death tick of its dead nations (null when none died or none is known).
 */
export function survivalByPersonality(frames, pers = PERSONALITIES) {
  const last = lastFrame(frames);
  return Object.fromEntries(
    pers.map((p) => {
      const rows = last ? last.rows.filter((r) => r.pers === p) : [];
      const ticks = rows
        .filter((r) => !r.alive && typeof r.deathTick === "number")
        .map((r) => r.deathTick);
      return [
        p,
        {
          n: rows.length,
          aliveFraction:
            rows.length === 0
              ? null
              : rows.filter((r) => r.alive).length / rows.length,
          meanDeathTick:
            ticks.length === 0
              ? null
              : ticks.reduce((a, b) => a + b, 0) / ticks.length,
        },
      ];
    }),
  );
}

/**
 * The top nation and its share of nation land in every frame. On a tie for
 * the top the previous leader keeps the lead if it is among the tied, else
 * the lowest smallID leads, so ties do not count as lead changes.
 */
export function leaderSeries(frames) {
  const out = [];
  let prev = null;
  for (const f of frames) {
    const total = totalTiles(f);
    const alive = f.rows.filter((r) => r.alive && r.tiles > 0);
    if (total === 0 || alive.length === 0) {
      out.push({ tick: f.tick, leader: null, share: 0 });
      continue;
    }
    const top = Math.max(...alive.map((r) => r.tiles));
    const tied = alive.filter((r) => r.tiles === top).map((r) => r.smallID);
    const leader = tied.includes(prev) ? prev : Math.min(...tied);
    out.push({ tick: f.tick, leader, share: (100 * top) / total });
    prev = leader;
  }
  return out;
}

/** Times the identity of the top nation changes between frames. */
export function leadChanges(series) {
  let n = 0;
  let prev = null;
  for (const s of series) {
    if (s.leader === null) continue;
    if (prev !== null && s.leader !== prev) n++;
    prev = s.leader;
  }
  return n;
}

/** First frame tick where the leader holds more than 50% (null if never). */
export function snowballTick(series, threshold = 50) {
  const hit = series.find((s) => s.share > threshold);
  return hit ? hit.tick : null;
}

/** Mean leader share over frames strictly after `after` (null if none). */
export function snowballIndex(series, after = MID_TICK) {
  const late = series.filter((s) => s.tick > after);
  if (late.length === 0) return null;
  return late.reduce((a, s) => a + s.share, 0) / late.length;
}

/** Every metric for one run. */
export function summarizeRun(frames, opts = {}) {
  const pers = opts.personalities ?? PERSONALITIES;
  const mid = opts.midTick ?? MID_TICK;
  const midF = frameAtOrBefore(frames, mid);
  const endF = lastFrame(frames);
  const series = leaderSeries(frames);
  return {
    frames: frames.length,
    midTick: midF ? midF.tick : null,
    endTick: endF ? endF.tick : null,
    landShareMid: midF ? landShareByPersonality(midF, pers) : null,
    landShareEnd: endF ? landShareByPersonality(endF, pers) : null,
    medianRankMid: midF ? medianRankByPersonality(midF, pers) : null,
    medianRankEnd: endF ? medianRankByPersonality(endF, pers) : null,
    survival: survivalByPersonality(frames, pers),
    leaderSeries: series,
    peakLeaderShare:
      series.length === 0 ? null : Math.max(...series.map((s) => s.share)),
    snowballTick: snowballTick(series),
    leadChanges: leadChanges(series),
    snowballIndex: snowballIndex(series, mid),
  };
}

/** Mean and standard error of the non-null numbers (null when empty). */
export function meanSE(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return { mean: null, se: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (v.length === 1) return { mean, se: 0, n: 1 };
  const sd = Math.sqrt(
    v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1),
  );
  return { mean, se: sd / Math.sqrt(v.length), n: v.length };
}

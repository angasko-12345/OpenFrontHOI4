#!/usr/bin/env node
// Grand Strategy balance harness (OpenFront x HOI4 fork).
//
// Runs the nations-only world playtest on N seeds, once with Grand Strategy
// on and once as real classic mode (control, config.grandStrategy = false),
// then compares the two per seed with the metrics in gs-metrics.mjs. Map and
// spawn luck cancel out; what is left is the effect of our rules.
//
//   node scripts/gs-balance.mjs [--seeds 20] [--ticks 7200] [--band 8]
//        [--snowball-target 10] [--out dir]
//
// Exit code 1 when any personality's average end land-share shift is outside
// +-band points, or, with --snowball-target T, when the GS-on mean snowball
// index is not at least T points below the control's.
// Results are cached per seed and mode in --out (v2_ files), so a rerun only
// fills gaps.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MID_TICK,
  PERSONALITIES,
  meanSE,
  summarizeRun,
} from "./gs-metrics.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map((a) => a.trim().split(/\s+/)),
);
const seeds = Number(args.seeds ?? 20);
const ticks = Number(args.ticks ?? 7200);
const band = Number(args.band ?? 8);
const snowTarget =
  args["snowball-target"] === undefined
    ? null
    : Number(args["snowball-target"]);
const out = resolve(args.out ?? "gs-balance-out");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PERS = PERSONALITIES;
const CACHE_VERSION = "v2";

mkdirSync(out, { recursive: true });

function run(seed, mode) {
  const file = join(out, `${CACHE_VERSION}_${mode}_${seed}.json`);
  if (existsSync(file)) return file;
  console.log(`running ${seed} GS ${mode}...`);
  const r = spawnSync(
    "npx",
    ["vitest", "--run", "tests/GrandStrategyPlaytest.test.ts"],
    {
      cwd: repo,
      stdio: ["ignore", "ignore", "inherit"],
      shell: process.platform === "win32",
      env: {
        ...process.env,
        PT_RUN: "1",
        PT_GS: mode,
        PT_SEED: seed,
        PT_TICKS: String(ticks),
        PT_OUT: file,
      },
    },
  );
  if (r.status !== 0 || !existsSync(file)) {
    console.error(`  failed (exit ${r.status}), skipping`);
    return null;
  }
  return file;
}

const load = (file) => summarizeRun(JSON.parse(readFileSync(file, "utf8")));
const f1 = (x) => (x === null || x === undefined ? "-" : x.toFixed(1));
const sign = (x) => (x === null ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}`);
const diff = (a, b) =>
  typeof a === "number" && typeof b === "number" ? a - b : null;
const fmt = ({ mean, se, n }, signed = false) =>
  mean === null
    ? "n/a (n=0)"
    : `${signed ? sign(mean) : f1(mean)} +-${se.toFixed(1)} (n=${n})`;

// Paired on-minus-off differences per personality, and per-mode game values.
const shift = {};
for (const k of ["shareMid", "shareEnd", "rankMid", "rankEnd", "survival"]) {
  shift[k] = Object.fromEntries(PERS.map((p) => [p, []]));
}
const game = {
  on: { idx: [], tick: [], never: 0, lead: [] },
  off: { idx: [], tick: [], never: 0, lead: [] },
};
const idxDiff = [];
let pairs = 0;

for (let i = 0; i < seeds; i++) {
  const seed = `GSBAL${String(i).padStart(3, "0")}`;
  const onFile = run(seed, "on");
  const offFile = run(seed, "off");
  if (onFile === null || offFile === null) continue;
  const a = load(onFile);
  const b = load(offFile);
  pairs++;
  for (const p of PERS) {
    shift.shareMid[p].push(diff(a.landShareMid?.[p], b.landShareMid?.[p]));
    shift.shareEnd[p].push(diff(a.landShareEnd?.[p], b.landShareEnd?.[p]));
    shift.rankMid[p].push(diff(a.medianRankMid?.[p], b.medianRankMid?.[p]));
    shift.rankEnd[p].push(diff(a.medianRankEnd?.[p], b.medianRankEnd?.[p]));
    const sa = a.survival[p].aliveFraction;
    const sb = b.survival[p].aliveFraction;
    shift.survival[p].push(diff(sa, sb) === null ? null : 100 * (sa - sb));
  }
  for (const [mode, r] of [
    ["on", a],
    ["off", b],
  ]) {
    game[mode].idx.push(r.snowballIndex);
    game[mode].lead.push(r.leadChanges);
    if (r.snowballTick === null) game[mode].never++;
    else game[mode].tick.push(r.snowballTick);
  }
  idxDiff.push(diff(a.snowballIndex, b.snowballIndex));

  const per = PERS.map(
    (p) =>
      `${p.slice(0, 4)} ${f1(a.landShareMid?.[p])}/${f1(b.landShareMid?.[p])}` +
      ` r${f1(a.medianRankEnd?.[p])}/${f1(b.medianRankEnd?.[p])}`,
  );
  console.log(
    `${seed} (on/off, end t${a.endTick}/${b.endTick}): share@${MID_TICK} & end rank: ${per.join(" | ")}` +
      ` || snowIdx ${f1(a.snowballIndex)}/${f1(b.snowballIndex)}` +
      ` peak ${f1(a.peakLeaderShare)}/${f1(b.peakLeaderShare)}` +
      ` snowTick ${a.snowballTick ?? "never"}/${b.snowballTick ?? "never"}` +
      ` leadChg ${a.leadChanges}/${b.leadChanges}`,
  );
}

if (pairs === 0) {
  console.error("no seed finished in both modes");
  process.exit(1);
}

let fail = false;
console.log(`\nPer personality, GS on minus control (mean +- s.e.):`);
for (const p of PERS) {
  console.log(`  ${p}`);
  console.log(
    `    land share @${MID_TICK}   ${fmt(meanSE(shift.shareMid[p]), true)} pts`,
  );
  const end = meanSE(shift.shareEnd[p]);
  const ok = end.mean === null || Math.abs(end.mean) <= band;
  if (!ok) fail = true;
  console.log(
    `    land share end    ${fmt(end, true)} pts  band +-${band} ${ok ? "PASS" : "FAIL"}`,
  );
  console.log(
    `    median rank @${MID_TICK}  ${fmt(meanSE(shift.rankMid[p]), true)} (negative = bigger)`,
  );
  console.log(`    median rank end   ${fmt(meanSE(shift.rankEnd[p]), true)}`);
  console.log(
    `    survival end      ${fmt(meanSE(shift.survival[p]), true)} pts alive`,
  );
}

console.log(`\nGame level (mean +- s.e.), on vs off over ${pairs} seed(s):`);
console.log(
  `  snowball index     on ${fmt(meanSE(game.on.idx))} | off ${fmt(meanSE(game.off.idx))} | on-off ${fmt(meanSE(idxDiff), true)}`,
);
console.log(
  `  snowball tick      on ${fmt(meanSE(game.on.tick))} never ${game.on.never} | off ${fmt(meanSE(game.off.tick))} never ${game.off.never}`,
);
console.log(
  `  lead changes       on ${fmt(meanSE(game.on.lead))} | off ${fmt(meanSE(game.off.lead))}`,
);
if (snowTarget !== null) {
  const on = meanSE(game.on.idx).mean;
  const off = meanSE(game.off.idx).mean;
  const drop = on === null || off === null ? null : off - on;
  const ok = drop !== null && drop >= snowTarget;
  if (!ok) fail = true;
  console.log(
    `  snowball target    off-on ${sign(drop)} pts, need >= ${snowTarget} ${ok ? "PASS" : "FAIL"}`,
  );
}
process.exit(fail ? 1 : 0);

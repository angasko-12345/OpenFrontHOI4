#!/usr/bin/env node
// Grand Strategy balance harness (OpenFront x HOI4 fork).
//
// Runs the nations-only world playtest on N seeds, once with Grand Strategy
// on and once with every GS effect neutralised (control), then reports each
// AI personality's share of nation land relative to its own control run.
// Map and spawn luck cancel out; what is left is the effect of our rules.
//
//   node scripts/gs-balance.mjs [--seeds 20] [--ticks 7200] [--band 8] [--out dir]
//
// Exit code 1 when any personality's average shift is outside +-band points.
// Results are cached per seed and mode in --out, so a rerun only fills gaps.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const out = args.out ?? "gs-balance-out";
const PERS = ["industrialist", "militarist", "defender"];

mkdirSync(out, { recursive: true });

function run(seed, mode) {
  const file = join(out, `${mode}_${seed}.json`);
  if (existsSync(file)) return file;
  console.log(`running ${seed} GS ${mode}...`);
  const r = spawnSync(
    "npx",
    ["vitest", "--run", "tests/GrandStrategyPlaytest.test.ts"],
    {
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

/** Each personality's share of all nation tiles at the last snapshot. */
function shares(file) {
  const frames = JSON.parse(readFileSync(file, "utf8"));
  const last = frames[frames.length - 1];
  const total = Math.max(
    1,
    last.rows.reduce((a, r) => a + r.tiles, 0),
  );
  return Object.fromEntries(
    PERS.map((p) => [
      p,
      (100 *
        last.rows
          .filter((r) => r.pers === p)
          .reduce((a, r) => a + r.tiles, 0)) /
        total,
    ]),
  );
}

const deltas = Object.fromEntries(PERS.map((p) => [p, []]));
for (let i = 0; i < seeds; i++) {
  const seed = `GSBAL${String(i).padStart(3, "0")}`;
  const on = run(seed, "on");
  const off = run(seed, "off");
  if (on === null || off === null) continue;
  const a = shares(on);
  const b = shares(off);
  const row = PERS.map((p) => {
    deltas[p].push(a[p] - b[p]);
    return `${p.slice(0, 4)} ${a[p].toFixed(1)} vs ${b[p].toFixed(1)}`;
  });
  console.log(`${seed}: ${row.join(" | ")}`);
}

let fail = false;
console.log(
  `\nAverage land-share shift, GS on minus control (band +-${band} pts):`,
);
for (const p of PERS) {
  const d = deltas[p];
  if (d.length === 0) continue;
  const mean = d.reduce((x, y) => x + y, 0) / d.length;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - mean) ** 2, 0) / d.length);
  const se = sd / Math.sqrt(d.length);
  const ok = Math.abs(mean) <= band;
  if (!ok) fail = true;
  console.log(
    `  ${p.padEnd(13)} ${mean >= 0 ? "+" : ""}${mean.toFixed(1)} pts (+-${se.toFixed(1)} s.e., n=${d.length}) ${ok ? "PASS" : "FAIL"}`,
  );
}
process.exit(fail ? 1 : 0);

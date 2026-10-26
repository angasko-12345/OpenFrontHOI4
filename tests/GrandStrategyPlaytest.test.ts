import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  aiPersonalityFor,
  equippedPermille,
} from "@openfront/engine-lib/game/GrandStrategy";
import { grandStrategyOf } from "@openfront/engine/execution/GrandStrategyExecution";
import { writeFileSync } from "node:fs";
import {
  createScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "./util/ScriptedGame";

// Opt-in balance playtest: PT_RUN=1 npx vitest --run tests/GrandStrategyPlaytest.test.ts
// Writes a frame of every nation (dead ones included) every PT_EVERY ticks
// (default 600) after the spawn phase to $PT_OUT. PT_SEED sets the game id
// (map seed). PT_GS=off is the control: real classic mode
// (config.grandStrategy = false), so no GrandStrategyExecution exists and
// every GS field in the rows is null. Nations keep their personality labels
// (aiPersonalityFor is pure), so any gap between labels in the control run
// is the map. Frames are read by scripts/gs-metrics.mjs.
test.skipIf(!process.env.PT_RUN)(
  "playtest: nations-only world match",
  { timeout: 1_100_000 },
  async () => {
    const gsOn = process.env.PT_GS !== "off";
    const start = scriptedGameStart({
      nations: 15,
      bots: 20,
      infiniteGold: false,
      doomsdayClock: { enabled: false, speed: "veryfast" },
      ...(gsOn ? {} : { grandStrategy: false }),
    } as never);
    start.players = [];
    if (process.env.PT_SEED) start.gameID = process.env.PT_SEED;
    const runner = await createScriptedRunner("world", start);
    const g = runner.game;

    const out: unknown[] = [];
    const END = Number(process.env.PT_TICKS ?? 9000);
    const EVERY = Number(process.env.PT_EVERY ?? 600);
    const everAlive = new Set<number>();
    const deathTick = new Map<number, number>();
    // PT_GS=nowar: Grand Strategy on, but the M4 war layer (occupation,
    // supply, war goals, coalition) off, to measure M4 on its own.
    const noWar = process.env.PT_GS === "nowar";
    // PT_GS=nocivgold / notrade / noartillery / noresearch: one M5 part off.
    const ablate = /^no(civgold|trade|artillery|research|researchlead)$/.exec(
      process.env.PT_GS ?? "",
    )?.[1] as
      | "civgold"
      | "trade"
      | "artillery"
      | "research"
      | "researchlead"
      | undefined;
    while (g.ticks() < END) {
      stepScripted(runner);
      if (noWar) {
        const gsx = grandStrategyOf(g);
        if (gsx !== null) gsx.warLayer = false;
      }
      if (ablate !== undefined) grandStrategyOf(g)?.ablate(ablate);
      const nations = g
        .allPlayers()
        .filter((p) => p.type() === PlayerType.Nation);
      for (const p of nations) {
        const id = p.smallID();
        if (p.isAlive()) everAlive.add(id);
        else if (everAlive.has(id) && !deathTick.has(id)) {
          deathTick.set(id, g.ticks());
        }
      }
      if (g.ticks() % EVERY !== 0 || g.inSpawnPhase()) continue;
      const gs = grandStrategyOf(g);
      if (gsOn && gs === null) {
        throw new Error("PT_GS=on but no GrandStrategyExecution");
      }
      const rows = nations.map((p) => {
        const alive = p.isAlive();
        const s = gs?.stateOf(p) ?? null;
        return {
          smallID: p.smallID(),
          n: p.name(),
          pers: aiPersonalityFor(p.smallID()),
          tiles: alive ? p.numTilesOwned() : 0,
          troops: alive ? Math.floor(p.troops()) : 0,
          alive,
          deathTick: deathTick.get(p.smallID()) ?? null,
          maxT: alive ? g.config().maxTroops(p) : 0,
          gold: Number(p.gold()),
          eq: s ? equippedPermille(s.equipment, p.troops()) : null,
          eff: s?.efficiency ?? null,
          ws: s?.warSupport ?? null,
          pp: s ? Math.floor(s.politicalPower / 1000) : null,
          laws: s ? `${s.conscriptionLaw}/${s.economyLaw}` : null,
          done: s ? s.completed.length : null,
          focus: s?.focus ?? null,
          // M5: deposits held and military factories (need = f/2 steel, f/3 oil).
          res: s ? [s.steelDeposits, s.oilDeposits, s.milFactories] : null,
          // M5 stage B: civilian factories, steel and oil imported.
          civ: s ? [s.civFactories, s.importSteel, s.importOil] : null,
          // M5 stage C: artillery stock and share.
          guns: s ? [s.artillery, s.artilleryShare] : null,
          // M6: technologies researched.
          tech: s ? s.researched.length : null,
        };
      });
      out.push({
        tick: g.ticks(),
        gs: gsOn,
        alive: rows.filter((r) => r.alive).length,
        rows,
      });
    }
    writeFileSync(
      process.env.PT_OUT ?? "/workspace/work/playtest.json",
      JSON.stringify(out),
    );
  },
);

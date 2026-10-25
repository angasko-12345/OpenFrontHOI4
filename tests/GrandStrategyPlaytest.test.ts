import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  aiPersonalityFor,
  equippedPermille,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  GrandStrategyExecution,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { vi } from "vitest";
import { writeFileSync } from "node:fs";
import {
  createScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "./util/ScriptedGame";

// Opt-in balance playtest: PT_RUN=1 npx vitest --run tests/GrandStrategyPlaytest.test.ts
// Writes per-personality snapshots every 1200 ticks to $PT_OUT.
// PT_SEED sets the game id (map seed). PT_GS=off neutralises every Grand
// Strategy effect on combat, troops and gold, as a control run: the same
// nations keep their personality labels, so any gap between labels is the map.
test.skipIf(!process.env.PT_RUN)(
  "playtest: nations-only world match",
  { timeout: 1_100_000 },
  async () => {
    if (process.env.PT_GS === "off") {
      const proto = GrandStrategyExecution.prototype;
      vi.spyOn(proto, "adjustCombat").mockImplementation(
        (_a, _d, _t, attackerTroopLoss, defenderTroopLoss) => ({
          attackerTroopLoss,
          defenderTroopLoss,
        }),
      );
      vi.spyOn(proto, "adjustTroopGrowth").mockImplementation((_p, b) => b);
      vi.spyOn(proto, "adjustGold").mockImplementation((_p, b) => b);
    }
    const start = scriptedGameStart({
      nations: 15,
      bots: 20,
      infiniteGold: false,
      doomsdayClock: { enabled: false, speed: "veryfast" },
    } as never);
    start.players = [];
    if (process.env.PT_SEED) start.gameID = process.env.PT_SEED;
    const runner = await createScriptedRunner("world", start);
    const g = runner.game;
    const out: unknown[] = [];
    const END = Number(process.env.PT_TICKS ?? 9000);
    while (g.ticks() < END) {
      stepScripted(runner);
      if (g.ticks() % 1200 === 0 && !g.inSpawnPhase()) {
        const gs = grandStrategyOf(g)!;
        const rows = g
          .players()
          .filter((p) => p.type() === PlayerType.Nation)
          .map((p) => {
            const s = gs.stateOf(p)!;
            return {
              n: p.name(),
              pers: aiPersonalityFor(p.smallID()),
              tiles: p.numTilesOwned(),
              troops: Math.floor(p.troops()),
              maxT: g.config().maxTroops(p),
              eq: equippedPermille(s.equipment, p.troops()),
              eff: s.efficiency,
              ws: s.warSupport,
              pp: Math.floor(s.politicalPower / 1000),
              laws: `${s.conscriptionLaw}/${s.economyLaw}`,
              done: s.completed.length,
              focus: s.focus,
              gold: Number(p.gold()),
            };
          });
        out.push({ tick: g.ticks(), alive: rows.length, rows });
      }
    }
    writeFileSync(
      process.env.PT_OUT ?? "/workspace/work/playtest.json",
      JSON.stringify(out),
    );
  },
);

import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  advanceSecond,
  newNationState,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  CIV_GOLD_CAP,
  CIV_GOLD_PERMILLE,
  civGoldPermille,
  civilianFactories,
  planTrade,
  withImports,
  DOMESTIC_RESOURCE,
  OIL_SHORTAGE_LOSS,
  STEEL_FLOOR_PERMILLE,
  coveredPermille,
  depositAt,
  oilLossPermille,
  resourceBalance,
  steelProductionPermille,
  tileHash,
} from "@openfront/engine-lib/game/GrandStrategyEconomy";
import {
  aiJustifyTarget,
  newWarState,
} from "@openfront/engine-lib/game/GrandStrategyWar";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

describe("GrandStrategyEconomy rules", () => {
  test("deposits are a pure function of tile and terrain", () => {
    expect(tileHash(12345)).toBe(tileHash(12345));
    expect(tileHash(1)).not.toBe(tileHash(2));
    let steel = 0;
    let oil = 0;
    let ocean = 0;
    for (let t = 0; t < 200_000; t++) {
      if (depositAt(t, 1) === "steel") steel++;
      if (depositAt(t, 0) === "oil") oil++;
      if (depositAt(t, 3) !== null) ocean++;
    }
    expect(ocean).toBe(0);
    // Roughly 1 in 1500 and 1 in 1200.
    expect(steel).toBeGreaterThan(100);
    expect(steel).toBeLessThan(170);
    expect(oil).toBeGreaterThan(130);
    expect(oil).toBeLessThan(210);
  });

  test("balance: domestic supply plus deposits against factory need", () => {
    const b = resourceBalance(3, 0, 10);
    expect(b).toEqual({
      steel: DOMESTIC_RESOURCE + 3,
      oil: DOMESTIC_RESOURCE,
      steelNeeded: 5,
      oilNeeded: 4,
    });
    expect(coveredPermille(4, 5)).toBe(800);
    expect(coveredPermille(9, 5)).toBe(1000);
    expect(coveredPermille(0, 0)).toBe(1000);
  });

  test("steel shortage cuts production to a floor; oil shortage costs troops", () => {
    expect(steelProductionPermille(resourceBalance(10, 10, 4))).toBe(1000);
    const none = { steel: 0, oil: 0, steelNeeded: 5, oilNeeded: 5 };
    expect(steelProductionPermille(none)).toBe(STEEL_FLOOR_PERMILLE);
    expect(oilLossPermille(none)).toBe(1000 + OIL_SHORTAGE_LOSS);
    expect(oilLossPermille(resourceBalance(0, 10, 4))).toBe(1000);
    const half = { steel: 1, oil: 1, steelNeeded: 2, oilNeeded: 2 };
    expect(steelProductionPermille(half)).toBe(700);
    expect(oilLossPermille(half)).toBe(1075);
  });

  test("advanceSecond scales output by productionPermille", () => {
    const input = {
      factoryStructureLevels: 0,
      tilesOwned: 10_000,
      maxTroops: 10_000_000,
      troops: 1000,
    };
    const a = newNationState(0);
    const b = newNationState(0);
    const full = advanceSecond(a, input).produced;
    const cut = advanceSecond(b, {
      ...input,
      productionPermille: 400,
    }).produced;
    expect(full).toBeGreaterThan(0);
    expect(cut).toBe(Math.floor((full * 400) / 1000));
  });
});

describe("GrandStrategyExecution resources", () => {
  let game: Game;
  let a: Player;

  beforeEach(async () => {
    game = await setup("big_plains", { infiniteGold: true });
    const info = new PlayerInfo("A", PlayerType.Human, null, "a_id");
    game.addPlayer(info);
    game.addExecution(
      new SpawnExecution(
        "game_id" as GameID,
        game.player(info.id).info(),
        game.ref(50, 50),
      ),
      new GrandStrategyExecution(),
    );
    game.executeNextTick();
    game.executeNextTick();
    while (game.inSpawnPhase()) game.executeNextTick();
    a = game.player(info.id);
  });

  test("deposits on owned land are counted each second", () => {
    const gs = grandStrategyOf(game)!;
    const { steel, oil } = gs.depositTiles();
    expect(steel.length + oil.length).toBeGreaterThan(0);
    const all = [...steel, ...oil];
    for (const t of all.slice(0, 5)) a.conquer(t);
    for (let i = 0; i < 10; i++) game.executeNextTick();
    const s = gs.stateOf(a)!;
    expect(s.steelDeposits + s.oilDeposits).toBe(Math.min(5, all.length));
    expect(s.milFactories).toBeGreaterThan(0);
  });

  test("civilian factories import shortfalls and raise gold", () => {
    const gs = grandStrategyOf(game)!;
    for (let i = 0; i < 10; i++) game.executeNextTick();
    const s = gs.stateOf(a)!;
    expect(s.civFactories).toBeGreaterThanOrEqual(1);
    const base = gs.adjustGold(a, 1000n);
    a.buildUnit(UnitType.City, a.spawnTile()!, {});
    for (let i = 0; i < 400; i++) game.executeNextTick();
    expect(s.civFactories).toBeGreaterThan(1);
    // A factory raises steel need past the home supply; civilians buy it.
    const free = s.civFactories;
    expect(s.importSteel).toBe(0);
    a.buildUnit(UnitType.Factory, game.ref(52, 50), {});
    for (let i = 0; i < 400; i++) game.executeNextTick();
    expect(s.milFactories).toBeGreaterThan(4);
    expect(s.importSteel).toBeGreaterThan(0);
    expect(s.civFactories).toBe(free);
    expect(gs.adjustGold(a, 1000n)).toBeGreaterThanOrEqual(base - 200n);
  });
});

describe("GrandStrategyEconomy stage B: civilian factories and trade", () => {
  test("civilian factories from land and cities, scaled by economy law", () => {
    expect(civilianFactories(0, 0, "partial_mobilization")).toBe(1);
    expect(civilianFactories(2, 9000, "partial_mobilization")).toBe(1 + 3 + 4);
    expect(civilianFactories(2, 9000, "civilian_economy_law")).toBe(10);
    expect(civilianFactories(2, 9000, "war_economy_law")).toBe(6);
    expect(civilianFactories(2, 9000, "total_mobilization")).toBe(4);
    expect(civilianFactories(0, 0, "unknown_law")).toBe(1);
  });

  test("trade buys steel first, two units per civilian factory", () => {
    const b = { steel: 1, oil: 1, steelNeeded: 6, oilNeeded: 4 };
    // Short 5 steel (3 civ) and 3 oil (2 civ).
    expect(planTrade(b, 10)).toEqual({ steel: 5, oil: 3, civUsed: 5 });
    expect(planTrade(b, 4)).toEqual({ steel: 5, oil: 2, civUsed: 4 });
    expect(planTrade(b, 2)).toEqual({ steel: 4, oil: 0, civUsed: 2 });
    expect(planTrade(b, 0)).toEqual({ steel: 0, oil: 0, civUsed: 0 });
    const full = { steel: 9, oil: 9, steelNeeded: 6, oilNeeded: 4 };
    expect(planTrade(full, 10)).toEqual({ steel: 0, oil: 0, civUsed: 0 });
    const after = withImports(b, planTrade(b, 10));
    expect(steelProductionPermille(after)).toBe(1000);
    expect(oilLossPermille(after)).toBe(1000);
  });

  test("free civilian factories raise gold income, capped", () => {
    expect(civGoldPermille(0)).toBe(0);
    expect(civGoldPermille(4)).toBe(4 * CIV_GOLD_PERMILLE);
    expect(civGoldPermille(1000)).toBe(CIV_GOLD_CAP);
    expect(civGoldPermille(-3)).toBe(0);
  });

  test("AI short of resources plans a war on the richest deposits", () => {
    const w = newWarState();
    const c = [
      { id: 1, tiles: 9000, attacking: false, deposits: 0 },
      { id: 2, tiles: 3000, attacking: false, deposits: 4 },
      { id: 3, tiles: 5000, attacking: false, deposits: 4 },
    ];
    expect(aiJustifyTarget(w, c)).toBe(1);
    expect(aiJustifyTarget(w, c, true)).toBe(3);
    // A war already under way still comes first.
    const att = c.map((x) => (x.id === 1 ? { ...x, attacking: true } : x));
    expect(aiJustifyTarget(w, att, true)).toBe(1);
    // Nobody holds deposits: fall back to the largest.
    const none = c.map((x) => ({ ...x, deposits: 0 }));
    expect(aiJustifyTarget(w, none, true)).toBe(1);
  });

  test("snapshot v6 migration adds trade fields", () => {
    const m = GrandStrategyExecutionSnapshot.migrations;
    const out = m[5]({ initialized: true, states: [{ id: 1 }] }) as {
      states: Record<string, unknown>[];
    };
    expect(out.states[0]).toMatchObject({
      civFactories: 0,
      importSteel: 0,
      importOil: 0,
    });
  });
});

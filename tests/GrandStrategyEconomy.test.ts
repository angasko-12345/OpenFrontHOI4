import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  advanceSecond,
  newNationState,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
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
  GrandStrategyExecution,
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
});

import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  addOccupied,
  advanceWarSecond,
  aiJustifyTarget,
  canJustify,
  grantDefensiveGoal,
  capitalSupplyRange,
  combinedCapModifier,
  COALITION_ENTER_PERMILLE,
  isqrt,
  JUSTIFY_COST,
  JUSTIFY_SECONDS,
  MAX_WAR_GOALS,
  MIN_TOTAL_TROOP_CAP_MODIFIER,
  newWarState,
  nextCoalitionLeader,
  occupationCapModifier,
  occupiedPermille,
  startJustify,
  supplyRange,
  UNREST_WAR_SUPPORT,
  WAR_GOAL_SECONDS,
  warLossMultiplier,
} from "@openfront/engine-lib/game/GrandStrategyWar";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  armyTroops,
  GrandStrategyExecution,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { JustifyWarExecution } from "@openfront/engine/execution/JustifyWarExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

const hasWarGoalOf = (s: { warGoals: { target: number }[] }, t: number) =>
  s.warGoals.some((g) => g.target === t);
import { diffSnapshots, roundTrip } from "./util/Snapshot";

describe("occupation", () => {
  test("occupied land lowers the troop cap in proportion", () => {
    expect(occupationCapModifier(0, 1000)).toBe(0);
    expect(occupationCapModifier(10, 0)).toBe(0);
    // All land freshly occupied: 75% of tile value lost, x0.6 elasticity.
    expect(occupationCapModifier(1000, 1000)).toBe(-450);
    expect(occupationCapModifier(500, 1000)).toBe(-225);
    // More occupied land never helps.
    let prev = 1;
    for (let o = 0; o <= 1000; o += 50) {
      const m = occupationCapModifier(o, 1000);
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeLessThanOrEqual(prev);
      prev = m;
    }
  });

  test("combined modifier is floored", () => {
    expect(combinedCapModifier(-500, 1000, 1000)).toBe(
      MIN_TOTAL_TROOP_CAP_MODIFIER,
    );
    expect(combinedCapModifier(100, 500, 1000)).toBe(100 - 225);
  });

  test("conquering still raises the cap: 0.6 power beats the penalty", () => {
    // cap ~ tiles^0.6; doubling land, all of it occupied, must not shrink it.
    const before = Math.pow(1000, 0.6);
    const after =
      Math.pow(2000, 0.6) * (1 + occupationCapModifier(1000, 2000) / 1000);
    expect(after).toBeGreaterThan(before);
  });

  test("occupation integrates over a few minutes and never exceeds land", () => {
    const s = newWarState();
    addOccupied(s, 1000);
    advanceWarSecond(s, 600);
    expect(s.occupied).toBeLessThanOrEqual(600);
    let t = 0;
    while (s.occupied > 300 && t < 1000) {
      advanceWarSecond(s, 600);
      t++;
    }
    // Half-life of two to four minutes.
    expect(t).toBeGreaterThan(120);
    expect(t).toBeLessThan(240);
    while (s.occupied > 0 && t < 5000) {
      advanceWarSecond(s, 600);
      t++;
    }
    expect(s.occupied).toBe(0);
  });

  test("heavy occupation causes unrest", () => {
    const s = newWarState();
    addOccupied(s, 500);
    expect(occupiedPermille(500, 1000)).toBe(500);
    expect(advanceWarSecond(s, 1000).warSupportDelta).toBe(-UNREST_WAR_SUPPORT);
    const calm = newWarState();
    addOccupied(calm, 100);
    expect(advanceWarSecond(calm, 1000).warSupportDelta).toBe(0);
  });
});

describe("war goals", () => {
  test("justification costs time, then holds a goal that expires", () => {
    const s = newWarState();
    expect(canJustify(s, 1, 2, JUSTIFY_COST, true)).toBe("ok");
    startJustify(s, 2);
    expect(canJustify(s, 1, 3, JUSTIFY_COST, true)).toBe("already_justifying");
    for (let i = 0; i < JUSTIFY_SECONDS - 1; i++) {
      expect(advanceWarSecond(s, 100).justified).toBeNull();
    }
    expect(advanceWarSecond(s, 100).justified).toBe(2);
    expect(s.warGoals).toEqual([{ target: 2, seconds: WAR_GOAL_SECONDS }]);
    expect(canJustify(s, 1, 2, JUSTIFY_COST, true)).toBe("already_justified");
    for (let i = 0; i < WAR_GOAL_SECONDS; i++) advanceWarSecond(s, 100);
    expect(s.warGoals).toEqual([]);
  });

  test("checks: self, invalid, PP, goal limit", () => {
    const s = newWarState();
    expect(canJustify(s, 1, 1, JUSTIFY_COST, true)).toBe("self");
    expect(canJustify(s, 1, 2, JUSTIFY_COST, false)).toBe("invalid_target");
    expect(canJustify(s, 1, 2, JUSTIFY_COST - 1, true)).toBe("not_enough_pp");
    for (let i = 0; i < MAX_WAR_GOALS; i++) {
      s.warGoals.push({ target: 10 + i, seconds: 100 });
    }
    expect(canJustify(s, 1, 2, JUSTIFY_COST, true)).toBe("too_many_goals");
  });

  test("being attacked grants a renewable goal outside the limit", () => {
    const s = newWarState();
    grantDefensiveGoal(s, 9);
    expect(hasWarGoalOf(s, 9)).toBe(true);
    s.warGoals[0].seconds = 5;
    grantDefensiveGoal(s, 9);
    expect(s.warGoals).toEqual([
      { target: 9, seconds: WAR_GOAL_SECONDS, defensive: true },
    ]);
    for (let i = 0; i < MAX_WAR_GOALS; i++) {
      s.warGoals.push({ target: 10 + i, seconds: 100 });
    }
    expect(canJustify(s, 1, 2, JUSTIFY_COST, true)).toBe("too_many_goals");
    s.warGoals.pop();
    expect(canJustify(s, 1, 2, JUSTIFY_COST, true)).toBe("ok");
  });

  test("loss multiplier: supply, goals, coalition", () => {
    const base = {
      targetIsNation: true,
      justified: true,
      targetIsCoalitionLeader: false,
      inSupply: true,
    };
    expect(warLossMultiplier(base)).toBe(1000);
    expect(warLossMultiplier({ ...base, justified: false })).toBe(1200);
    expect(warLossMultiplier({ ...base, inSupply: false })).toBe(1300);
    expect(
      warLossMultiplier({ ...base, justified: false, inSupply: false }),
    ).toBe(1500);
    // The coalition target needs no war goal.
    expect(
      warLossMultiplier({
        ...base,
        justified: false,
        targetIsCoalitionLeader: true,
      }),
    ).toBe(900);
    // Bots and empty land never need a goal.
    expect(
      warLossMultiplier({ ...base, targetIsNation: false, justified: false }),
    ).toBe(1000);
  });

  test("AI justifies against its current war first, then the biggest neighbour", () => {
    const s = newWarState();
    const c = [
      { id: 4, tiles: 900, attacking: false },
      { id: 3, tiles: 100, attacking: true },
      { id: 5, tiles: 900, attacking: false },
    ];
    expect(aiJustifyTarget(s, c)).toBe(3);
    s.warGoals.push({ target: 3, seconds: 10 });
    expect(aiJustifyTarget(s, c)).toBe(4); // tie broken by lower id
    expect(aiJustifyTarget(s, [])).toBeNull();
  });
});

describe("supply and coalition", () => {
  test("supply range scales with the map and is an integer", () => {
    expect(isqrt(651_569)).toBe(807);
    expect(isqrt(0)).toBe(0);
    for (const n of [1, 2, 3, 4, 99, 100, 101, 1e6, 1e6 + 1]) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
    expect(supplyRange(651_569)).toBe(100);
    expect(supplyRange(158_068)).toBe(49);
    expect(supplyRange(100)).toBe(30);
    expect(capitalSupplyRange(651_569)).toBe(200);
  });

  test("coalition forms above the enter share and holds until the exit share", () => {
    const land = 1000;
    const big = (tiles: number) => [
      { id: 2, tiles },
      { id: 3, tiles: 100 },
    ];
    expect(
      nextCoalitionLeader(null, big(COALITION_ENTER_PERMILLE - 1), land),
    ).toBeNull();
    expect(nextCoalitionLeader(null, big(COALITION_ENTER_PERMILLE), land)).toBe(
      2,
    );
    expect(nextCoalitionLeader(2, big(360), land)).toBe(2);
    expect(nextCoalitionLeader(2, big(349), land)).toBeNull();
    // A dead leader is dropped.
    expect(nextCoalitionLeader(7, big(100), land)).toBeNull();
  });
});

describe("GrandStrategyExecution war layer", () => {
  let game: Game;
  let a: Player;
  let b: Player;
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("ocean_and_land", { infiniteGold: true });
    const ai = new PlayerInfo("A", PlayerType.Human, null, "a_id");
    const bi = new PlayerInfo("B", PlayerType.Human, null, "b_id");
    game.addPlayer(ai);
    game.addPlayer(bi);
    const aSpawn: TileRef = game.ref(0, 10);
    const bSpawn: TileRef = game.ref(0, 15);
    game.addExecution(
      new SpawnExecution(gameID, game.player(ai.id).info(), aSpawn),
      new SpawnExecution(gameID, game.player(bi.id).info(), bSpawn),
      new GrandStrategyExecution(),
    );
    game.executeNextTick();
    game.executeNextTick();
    while (game.inSpawnPhase()) game.executeNextTick();
    a = game.player(ai.id);
    b = game.player(bi.id);
  });

  function seconds(n: number) {
    for (let i = 0; i < n * 10; i++) game.executeNextTick();
  }

  test("conquering player land occupies it and lowers the cap", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    const capBefore = game.config().maxTroops(a);
    const tilesBefore = a.numTilesOwned();
    game.addExecution(new AttackExecution(a.troops() * 0.9, a, b.id()));
    // Stop before the once-a-second integration step eats the first tiles.
    for (let i = 0; i < 9 && b.isAlive(); i++) game.executeNextTick();
    const taken = a.numTilesOwned() - tilesBefore;
    expect(taken).toBeGreaterThan(0);
    const w = gs.warOf(a)!;
    expect(w.occupied).toBeGreaterThan(0);
    expect(w.occupied).toBeLessThanOrEqual(taken);
    const mod = occupationCapModifier(w.occupied, a.numTilesOwned());
    expect(mod).toBeLessThan(0);
    // Never below what the land alone would be worth with no conquest.
    expect(game.config().maxTroops(a)).toBeGreaterThan(capBefore * 0.5);
  });

  test("the defender gets a goal against its attacker", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    game.addExecution(new AttackExecution(a.troops() * 0.5, a, b.id()));
    for (let i = 0; i < 9 && b.isAlive(); i++) game.executeNextTick();
    expect(hasWarGoalOf(gs.warOf(b)!, a.smallID())).toBe(true);
    expect(hasWarGoalOf(gs.warOf(a)!, b.smallID())).toBe(false);
  });

  test("warLayer off: no occupation, no war multiplier", () => {
    const gs = grandStrategyOf(game)!;
    gs.warLayer = false;
    seconds(1);
    // Plenty of equipment, so spending some does not move the share.
    gs.stateOf(a)!.equipment = armyTroops(a) * 10;
    const bare = gs.adjustCombat(a, b, 1000, 100, 10);
    gs.warOf(a)!.warGoals.push({ target: b.smallID(), seconds: 600 });
    expect(gs.adjustCombat(a, b, 1000, 100, 10).attackerTroopLoss).toBe(
      bare.attackerTroopLoss,
    );
    game.addExecution(new AttackExecution(a.troops() * 0.9, a, b.id()));
    for (let i = 0; i < 9 && b.isAlive(); i++) game.executeNextTick();
    expect(gs.warOf(a)!.occupied).toBe(0);
  });

  test("justify_war spends PP, then grants a goal; the target sees it", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    gs.stateOf(a)!.politicalPower = JUSTIFY_COST;
    game.addExecution(new JustifyWarExecution(a, b.id()));
    seconds(1);
    expect(gs.stateOf(a)!.politicalPower).toBeLessThan(JUSTIFY_COST);
    expect(gs.warOf(a)!.justifying?.target).toBe(b.smallID());
    seconds(JUSTIFY_SECONDS + 1);
    expect(gs.warOf(a)!.warGoals.map((g) => g.target)).toEqual([b.smallID()]);
    // A second request without PP is refused and changes nothing.
    game.addExecution(new JustifyWarExecution(a, "nobody"));
    seconds(1);
    expect(gs.warOf(a)!.justifying).toBeNull();
  });

  test("an unjustified attack on a nation costs more than a justified one", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    // Plenty of equipment, so spending some does not move the share.
    gs.stateOf(a)!.equipment = armyTroops(a) * 10;
    const bare = gs.adjustCombat(a, b, 1000, 100, 10);
    gs.warOf(a)!.warGoals.push({ target: b.smallID(), seconds: 600 });
    const justified = gs.adjustCombat(a, b, 1000, 100, 10);
    expect(bare.attackerTroopLoss).toBeGreaterThan(justified.attackerTroopLoss);
    expect(bare.attackerTroopLoss * 1000).toBe(
      justified.attackerTroopLoss * 1200,
    );
  });

  test("tiles near the capital are in supply, far ones are not", () => {
    const gs = grandStrategyOf(game)!;
    const spawn = a.spawnTile()!;
    expect(gs.inSupply(a, spawn)).toBe(true);
    // ocean_and_land is tiny, so everything is within the capital radius.
    const far = game.ref(game.width() - 1, game.height() - 1);
    const r = capitalSupplyRange(game.numLandTiles());
    expect(gs.inSupply(a, far)).toBe(
      game.euclideanDistSquared(spawn, far) <= r * r,
    );
  });

  test("snapshot round trip keeps occupation, goals and justification", async () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    const w = gs.warOf(a)!;
    w.occupied = 7;
    w.warGoals.push({ target: b.smallID(), seconds: 99 });
    w.justifying = { target: b.smallID(), seconds: 12 };
    const { bytes, restored, again } = await roundTrip(game, "ocean_and_land");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    const rw = grandStrategyOf(restored)!.warOf(restored.player(a.id()))!;
    expect(rw.occupied).toBe(7);
    expect(rw.warGoals).toEqual([{ target: b.smallID(), seconds: 99 }]);
    expect(rw.justifying).toEqual({ target: b.smallID(), seconds: 12 });
  });
});

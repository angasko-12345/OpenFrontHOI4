import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  advanceSecond,
  attackerLossMultiplier,
  availableFocuses,
  BASE_EFFICIENCY,
  BASE_EFFICIENCY_CAP,
  canStartFocus,
  equippedPermille,
  focusById,
  FOCUS_TREE,
  modifiersOf,
  newNationState,
  ADVISOR_COST,
  ADVISOR_SLOTS,
  aiChoose,
  canTakeAction,
  setLaw,
  startFocus,
  takeAction,
  troopCapModifier,
  ZERO_MODIFIERS,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  aiProductionLine,
  ARTILLERY_COST,
  ARTILLERY_LOSS_CUT,
  artilleryLossPermille,
  LINE_SHARE,
  newNationState as newState,
  advanceSecond as advance,
  takeAction as take,
} from "@openfront/engine-lib/game/GrandStrategy";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  GrandStrategyExecution,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { GsActionExecution } from "@openfront/engine/execution/GsActionExecution";
import { SetFocusExecution } from "@openfront/engine/execution/SetFocusExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { diffSnapshots, roundTrip } from "./util/Snapshot";

const input = {
  factoryStructureLevels: 0,
  tilesOwned: 0,
  maxTroops: 100_000,
  troops: 50_000,
};

describe("GrandStrategy rules", () => {
  test("every focus prerequisite and exclusive exists", () => {
    for (const f of FOCUS_TREE) {
      for (const id of [...f.requires, ...f.exclusive]) {
        expect(focusById(id)).toBeDefined();
      }
    }
  });

  test("focus completes after its duration and grants modifiers", () => {
    const s = newNationState(25_000);
    expect(startFocus(s, "industrial_expansion")).toBe("ok");
    expect(canStartFocus(s, "conscription")).toBe("busy");
    for (let i = 0; i < 59; i++) advanceSecond(s, input);
    expect(s.completed).toEqual([]);
    const r = advanceSecond(s, input);
    expect(r.completedFocus).toBe("industrial_expansion");
    expect(s.focus).toBeNull();
    // +15% on top of the default civilian economy law's -15%.
    expect(modifiersOf(s).production).toBe(150 - 150);
    expect(s.completed).toEqual(["industrial_expansion"]);
  });

  test("prerequisites and mutual exclusion", () => {
    const s = newNationState(0);
    expect(canStartFocus(s, "rearmament")).toBe("missing_prerequisite");
    s.completed.push("civilian_economy");
    s.completed.push("industrial_expansion", "rearmament");
    expect(canStartFocus(s, "war_economy")).toBe("exclusive");
    expect(availableFocuses(s).map((f) => f.id)).not.toContain("war_economy");
    expect(canStartFocus(s, "nope")).toBe("unknown");
  });

  test("efficiency climbs to the cap and production follows it", () => {
    const s = newNationState(0);
    const big = { ...input, maxTroops: 1_000_000_000 };
    const first = advanceSecond(s, big).produced;
    for (let i = 0; i < 600; i++) advanceSecond(s, big);
    expect(s.efficiency).toBe(BASE_EFFICIENCY_CAP);
    const late = advanceSecond(s, big).produced;
    expect(late).toBeGreaterThan(first * 3);
    expect(BASE_EFFICIENCY).toBeLessThan(BASE_EFFICIENCY_CAP);
  });

  test("stockpile is capped at twice max troops", () => {
    const s = newNationState(199_990);
    advanceSecond(s, input);
    expect(s.equipment).toBe(200_000);
  });

  test("equipment shortage raises losses; doctrine and defense apply", () => {
    expect(equippedPermille(0, 0)).toBe(1000);
    expect(equippedPermille(500, 1000)).toBe(500);
    expect(attackerLossMultiplier(1000, ZERO_MODIFIERS, null)).toBe(1000);
    expect(attackerLossMultiplier(0, ZERO_MODIFIERS, null)).toBe(2000);
    expect(
      attackerLossMultiplier(
        1000,
        { ...ZERO_MODIFIERS, attackLoss: -150 },
        null,
      ),
    ).toBe(850);
    expect(
      attackerLossMultiplier(1000, ZERO_MODIFIERS, {
        ...ZERO_MODIFIERS,
        defense: 200,
      }),
    ).toBe(1200);
  });
});

describe("GrandStrategyExecution", () => {
  let game: Game;
  let a: Player;
  let b: Player;
  const gameID: GameID = "game_id";

  async function build(): Promise<void> {
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
    a = game.player(ai.id);
    b = game.player(bi.id);
  }

  function seconds(n: number) {
    for (let i = 0; i < n * 10; i++) game.executeNextTick();
  }

  beforeEach(build);

  test("registers itself and produces equipment over time", () => {
    const gs = grandStrategyOf(game)!;
    expect(gs).not.toBeNull();
    seconds(2);
    const e0 = gs.stateOf(a)!.equipment;
    seconds(5);
    expect(gs.stateOf(a)!.equipment).toBeGreaterThan(e0);
  });

  test("set_focus starts a focus; invalid focus is ignored", () => {
    game.addExecution(new SetFocusExecution(a, "rearmament"));
    seconds(1);
    expect(grandStrategyOf(game)!.stateOf(a)!.focus).toBeNull();
    game.addExecution(new SetFocusExecution(a, "industrial_expansion"));
    seconds(1);
    expect(grandStrategyOf(game)!.stateOf(a)!.focus).toBe(
      "industrial_expansion",
    );
  });

  test("an unequipped attacker loses more troops than an equipped one", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    // A justified war, so only equipment differs.
    gs.warOf(a)!.warGoals.push({ target: b.smallID(), seconds: 600 });
    const equipped = gs.adjustCombat(a, b, 1000, 100, 10);
    gs.stateOf(a)!.equipment = 0;
    const bare = gs.adjustCombat(a, b, 1000, 100, 10);
    expect(bare.attackerTroopLoss).toBeGreaterThan(equipped.attackerTroopLoss);
    expect(bare.attackerTroopLoss).toBe(200);
  });

  test("artillery cuts attacker losses and is lost with them", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    gs.warOf(a)!.warGoals.push({ target: b.smallID(), seconds: 600 });
    const st = gs.stateOf(a)!;
    st.equipment = 1_000_000;
    st.artillery = 0;
    const bare = gs.adjustCombat(a, b, 1000, 100, 10);
    st.artillery = 1000;
    const guns = gs.adjustCombat(a, b, 1000, 100, 10);
    expect(guns.attackerTroopLoss).toBeLessThan(bare.attackerTroopLoss);
    expect(st.artillery).toBeLessThan(1000);
    // Half support, half the cut.
    st.artillery = 500;
    const half = gs.adjustCombat(a, b, 1000, 100, 10);
    expect(half.attackerTroopLoss).toBeGreaterThan(guns.attackerTroopLoss);
    expect(half.attackerTroopLoss).toBeLessThan(bare.attackerTroopLoss);
  });

  test("gs_action production line moves output into artillery", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    game.addExecution(new GsActionExecution(a, "line_artillery"));
    seconds(1);
    const st = gs.stateOf(a)!;
    expect(st.artilleryShare).toBe(500);
    const g0 = st.artillery;
    seconds(10);
    expect(st.artillery).toBeGreaterThan(g0);
    game.addExecution(new GsActionExecution(a, "line_infantry"));
    seconds(1);
    expect(st.artilleryShare).toBe(0);
    const g1 = st.artillery;
    seconds(5);
    expect(st.artillery).toBe(g1);
  });

  test("artillery state survives a snapshot round trip", async () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    gs.stateOf(a)!.artillery = 321;
    gs.stateOf(a)!.artilleryShare = 250;
    const { restored } = await roundTrip(game, "ocean_and_land");
    const rs = grandStrategyOf(restored)!.stateOf(restored.player(a.id()))!;
    expect(rs.artillery).toBe(321);
    expect(rs.artilleryShare).toBe(250);
  });

  test("combat consumes equipment during a real attack", () => {
    seconds(1);
    const gs = grandStrategyOf(game)!;
    const before = gs.stateOf(b)!.equipment;
    game.addExecution(new AttackExecution(1000, a, b.id()));
    for (let i = 0; i < 5; i++) game.executeNextTick();
    expect(gs.stateOf(b)!.equipment).toBeLessThanOrEqual(before);
  });

  test("snapshot round trip preserves grand strategy state", async () => {
    game.addExecution(new SetFocusExecution(a, "conscription"));
    seconds(3);
    const sa = grandStrategyOf(game)!.stateOf(a)!;
    sa.politicalPower = 500_000;
    takeAction(sa, "emergency_production");
    takeAction(sa, "industrial_planner");
    const { bytes, restored, again } = await roundTrip(game, "ocean_and_land");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    const gs = grandStrategyOf(restored)!;
    expect(gs).not.toBeNull();
    const ra = gs.stateOf(restored.player(a.id()))!;
    expect(ra.focus).toBe("conscription");
    expect(ra.advisors).toEqual(["industrial_planner"]);
    expect(ra.activeDecisions.map((e) => e.id)).toEqual([
      "emergency_production",
    ]);
  });

  test("conscription laws raise the troop cap; restore keeps it", async () => {
    seconds(1);
    const gs = grandStrategyOf(game)!;
    const base = game.config().maxTroops(a);
    const s = gs.stateOf(a)!;
    s.warSupport = 1000;
    s.politicalPower = 1_000_000;
    expect(setLaw(s, "extensive_conscription")).toBe("ok");
    expect(troopCapModifier(s)).toBe(100);
    expect(game.config().maxTroops(a)).toBeCloseTo(base * 1.1, 6);
    // The other nation keeps its own cap.
    expect(troopCapModifier(gs.stateOf(b)!)).toBe(0);
    const { restored } = await roundTrip(game, "ocean_and_land");
    expect(restored.config().maxTroops(restored.player(a.id()))).toBeCloseTo(
      base * 1.1,
      6,
    );
  });
});

describe("troop cap modifier", () => {
  test("sums laws and focuses and never drops below half", () => {
    const s = newNationState(0);
    expect(troopCapModifier(s)).toBe(0);
    s.completed.push("conscription", "general_mobilization");
    s.conscriptionLaw = "service_by_requirement";
    expect(troopCapModifier(s)).toBe(50 + 100 + 200);
    s.completed.length = 0;
    s.conscriptionLaw = "volunteer_only";
    expect(troopCapModifier(s)).toBe(-100);
  });
});

describe("decisions and advisors", () => {
  test("a decision costs PP, runs, then cools down", () => {
    const s = newNationState(0);
    const base = modifiersOf(s).production;
    expect(takeAction(s, "emergency_production")).toBe("no_political_power");
    s.politicalPower = 200_000;
    expect(takeAction(s, "emergency_production")).toBe("ok");
    expect(s.politicalPower).toBe(100_000);
    expect(modifiersOf(s).production).toBe(base + 400);
    expect(canTakeAction(s, "emergency_production")).toBe("cooldown");
    for (let i = 0; i < 60; i++) advanceSecond(s, input);
    expect(modifiersOf(s).production).toBe(base);
    expect(canTakeAction(s, "emergency_production")).toBe("cooldown");
    for (let i = 0; i < 120; i++) advanceSecond(s, input);
    expect(canTakeAction(s, "emergency_production")).not.toBe("cooldown");
  });

  test("propaganda drive raises war support instantly", () => {
    const s = newNationState(0);
    s.politicalPower = 100_000;
    const ws = s.warSupport;
    expect(takeAction(s, "propaganda_drive")).toBe("ok");
    expect(s.warSupport).toBe(ws + 100);
    expect(s.activeDecisions).toEqual([]);
  });

  test("advisors are permanent, unique and slot-limited", () => {
    const s = newNationState(0);
    s.politicalPower = ADVISOR_COST * 3;
    expect(takeAction(s, "army_chief")).toBe("ok");
    expect(takeAction(s, "army_chief")).toBe("hired");
    expect(takeAction(s, "defense_minister")).toBe("ok");
    expect(s.advisors.length).toBe(ADVISOR_SLOTS);
    expect(takeAction(s, "political_advisor")).toBe("no_slots");
    expect(modifiersOf(s).attackLoss).toBe(-80);
    expect(modifiersOf(s).defense).toBe(100); // default laws give neither
  });

  test("AI spends political power once its laws are maxed", () => {
    const s = newNationState(0);
    s.conscriptionLaw = "extensive_conscription";
    s.economyLaw = "war_economy_law";
    s.politicalPower = 500_000;
    const c = aiChoose(s, "militarist");
    expect(c.law).toBeNull();
    expect(c.action).toBe("army_chief");
  });
});

describe("GrandStrategy production lines (pure)", () => {
  const input = {
    factoryStructureLevels: 0,
    tilesOwned: 0,
    maxTroops: 1_000_000,
    troops: 1000,
  };

  test("lines set the artillery share; no political power needed", () => {
    const s = newState(0);
    expect(take(s, "line_artillery")).toBe("ok");
    expect(s.artilleryShare).toBe(LINE_SHARE.line_artillery);
    expect(take(s, "line_balanced")).toBe("ok");
    expect(s.artilleryShare).toBe(250);
    expect(s.politicalPower).toBe(0);
  });

  test("output splits between equipment and artillery", () => {
    const inf = newState(0);
    const art = newState(0);
    take(art, "line_artillery");
    advance(inf, input);
    advance(art, input);
    expect(inf.artillery).toBe(0);
    expect(art.equipment).toBe(inf.equipment - Math.floor(inf.equipment / 2));
    expect(art.artillery).toBe(
      Math.floor(Math.floor(inf.equipment / 2) / ARTILLERY_COST),
    );
  });

  test("artillery is capped at max troops", () => {
    const s = newState(0);
    take(s, "line_artillery");
    s.artillery = 99;
    advance(s, { ...input, maxTroops: 100 });
    expect(s.artillery).toBe(100);
  });

  test("loss cut scales with support", () => {
    expect(artilleryLossPermille(0)).toBe(1000);
    expect(artilleryLossPermille(1000)).toBe(1000 - ARTILLERY_LOSS_CUT);
    expect(artilleryLossPermille(500)).toBe(1000 - ARTILLERY_LOSS_CUT / 2);
    expect(artilleryLossPermille(5000)).toBe(1000 - ARTILLERY_LOSS_CUT);
  });

  test("AI moves to guns once its army is equipped", () => {
    const s = newState(0);
    expect(aiProductionLine(s, "industrialist", 1000)).toBe("line_infantry");
    s.equipment = 600;
    expect(aiProductionLine(s, "militarist", 1000)).toBe("line_balanced");
    expect(aiProductionLine(s, "defender", 1000)).toBe("line_infantry");
    s.equipment = 1000;
    expect(aiProductionLine(s, "defender", 1000)).toBe("line_artillery");
  });
});

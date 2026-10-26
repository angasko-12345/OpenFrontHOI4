import {
  CONSCRIPTION_LAW_IDS,
  ECONOMY_LAW_IDS,
  FOCUS_IDS,
  LAW_IDS,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  advanceSecond,
  AI_PERSONALITIES,
  aiChoose,
  aiPersonalityFor,
  attackerLossMultiplier,
  BASE_WAR_SUPPORT,
  canSetLaw,
  defenderLossMultiplier,
  equippedPermille,
  FOCUS_TREE,
  focusById,
  LAW_CHANGE_COST,
  lawById,
  LAWS,
  modifiersOf,
  NationGsState,
  newNationState,
  PP_CAP,
  PP_PER_SECOND,
  setLaw,
  shortageLossPermille,
  startFocus,
  STOCKPILE_CAP_MULTIPLE,
  ZERO_MODIFIERS,
} from "@openfront/engine-lib/game/GrandStrategy";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { SetLawExecution } from "@openfront/engine/execution/SetLawExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  createScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "./util/ScriptedGame";
import { setup } from "./util/Setup";

const input = {
  factoryStructureLevels: 0,
  tilesOwned: 0,
  maxTroops: 100_000,
  troops: 50_000,
};

/** Every invariant a nation's state must hold at a second boundary. */
function checkInvariants(s: NationGsState, maxTroops: number): void {
  for (const v of [
    s.equipment,
    s.efficiency,
    s.focusProgress,
    s.politicalPower,
    s.warSupport,
    s.attackLossesThisSecond,
  ]) {
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(s.equipment).toBeGreaterThanOrEqual(0);
  expect(s.efficiency).toBeGreaterThan(0);
  expect(s.efficiency).toBeLessThanOrEqual(1000);
  expect(s.warSupport).toBeGreaterThanOrEqual(0);
  expect(s.warSupport).toBeLessThanOrEqual(1000);
  expect(s.politicalPower).toBeGreaterThanOrEqual(0);
  expect(s.politicalPower).toBeLessThanOrEqual(PP_CAP);
  expect(new Set(s.completed).size).toBe(s.completed.length);
  expect(new Set(s.advisors).size).toBe(s.advisors.length);
  expect(s.advisors.length).toBeLessThanOrEqual(2);
  for (const e of [...s.activeDecisions, ...s.decisionCooldowns]) {
    expect(Number.isInteger(e.seconds)).toBe(true);
    expect(e.seconds).toBeGreaterThan(0);
  }
  if (s.focus !== null) {
    const f = focusById(s.focus)!;
    expect(f).toBeDefined();
    expect(s.focusProgress).toBeLessThan(f.seconds);
    expect(s.completed).not.toContain(s.focus);
  }
  s.completed.forEach((id, i) => {
    const f = focusById(id)!;
    for (const r of f.requires) {
      expect(s.completed.indexOf(r)).toBeGreaterThanOrEqual(0);
      expect(s.completed.indexOf(r)).toBeLessThan(i);
    }
    for (const x of f.exclusive) expect(s.completed).not.toContain(x);
  });
  expect(lawById(s.conscriptionLaw)?.category).toBe("conscription");
  expect(lawById(s.economyLaw)?.category).toBe("economy");
  void maxTroops;
}

describe("GrandStrategy fuzz", () => {
  test.each([1, 2, 3, 42, 1337])(
    "random play keeps every invariant (seed %i)",
    (seed) => {
      const rand = new PseudoRandom(seed);
      const s = newNationState(rand.nextInt(0, 300_000));
      let maxTroops = 100_000;
      for (let step = 0; step < 4000; step++) {
        switch (rand.nextInt(0, 6)) {
          case 0:
            startFocus(s, rand.randElement([...FOCUS_IDS, "bogus"]));
            break;
          case 1:
            setLaw(s, rand.randElement([...LAW_IDS, "bogus"]));
            break;
          case 2:
            s.defendedThisSecond = true;
            break;
          case 3:
            s.attackLossesThisSecond += rand.nextInt(0, 10_000);
            break;
          case 4:
            s.equipment = Math.max(0, s.equipment - rand.nextInt(0, 50_000));
            break;
          case 5:
            maxTroops = rand.nextInt(1, 2_000_000);
            break;
        }
        const before = s.equipment;
        advanceSecond(s, {
          factoryStructureLevels: rand.nextInt(0, 40),
          tilesOwned: rand.nextInt(0, 200_000),
          maxTroops,
          troops: rand.nextInt(0, maxTroops),
        });
        // Production never confiscates, and never pushes past the cap.
        expect(s.equipment).toBeGreaterThanOrEqual(before);
        if (before <= maxTroops * STOCKPILE_CAP_MULTIPLE) {
          expect(s.equipment).toBeLessThanOrEqual(
            maxTroops * STOCKPILE_CAP_MULTIPLE,
          );
        }
        checkInvariants(s, maxTroops);
      }
    },
  );

  test("a full playthrough can complete every reachable focus", () => {
    // Exclusives split the tree; each branch alone completes cleanly.
    for (const skip of [["war_economy"], ["civilian_economy"]]) {
      const s = newNationState(0);
      for (let i = 0; i < 5000; i++) {
        if (s.focus === null) {
          const next = FOCUS_TREE.find(
            (f) => !skip.includes(f.id) && startFocus(s, f.id) === "ok",
          );
          if (next === undefined && s.focus === null) break;
        }
        advanceSecond(s, input);
      }
      checkInvariants(s, input.maxTroops);
      expect(s.completed.length).toBeGreaterThanOrEqual(FOCUS_TREE.length - 4);
    }
  });
});

describe("GrandStrategy combat math", () => {
  test("multipliers are integers and monotonic", () => {
    let prev = Infinity;
    for (let eq = 0; eq <= 1000; eq += 50) {
      const m = attackerLossMultiplier(eq, ZERO_MODIFIERS, null);
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeLessThanOrEqual(prev);
      prev = m;
      expect(Number.isInteger(defenderLossMultiplier(eq))).toBe(true);
    }
    prev = Infinity;
    for (let ws = 0; ws <= 1000; ws += 100) {
      const m = attackerLossMultiplier(1000, ZERO_MODIFIERS, null, ws);
      expect(m).toBeLessThanOrEqual(prev);
      prev = m;
    }
    expect(attackerLossMultiplier(1000, ZERO_MODIFIERS, null, 0)).toBe(1100);
    expect(attackerLossMultiplier(1000, ZERO_MODIFIERS, null, 1000)).toBe(900);
    expect(attackerLossMultiplier(1000, ZERO_MODIFIERS, null)).toBe(1000);
  });

  test("out-of-range inputs are clamped, never negative", () => {
    expect(shortageLossPermille(-500)).toBe(2000);
    expect(shortageLossPermille(5000)).toBe(1000);
    expect(defenderLossMultiplier(-1)).toBe(1500);
    expect(defenderLossMultiplier(2000)).toBe(1000);
    expect(
      attackerLossMultiplier(
        1000,
        { ...ZERO_MODIFIERS, attackLoss: -5000 },
        { ...ZERO_MODIFIERS, defense: -5000 },
      ),
    ).toBe(0);
    expect(equippedPermille(-10, 100)).toBe(0);
  });
});

describe("Political power, war support and laws", () => {
  test("political power accrues, scales with focuses and caps", () => {
    const s = newNationState(0);
    advanceSecond(s, input);
    expect(s.politicalPower).toBe(PP_PER_SECOND);
    s.completed.push("political_effort");
    advanceSecond(s, input);
    expect(s.politicalPower).toBe(PP_PER_SECOND + 1300);
    for (let i = 0; i < 1000; i++) advanceSecond(s, input);
    expect(s.politicalPower).toBe(PP_CAP);
  });

  test("laws need political power and war support, and cost it", () => {
    const s = newNationState(0);
    expect(canSetLaw(s, "limited_conscription")).toBe("active");
    expect(canSetLaw(s, "volunteer_only")).toBe("no_political_power");
    expect(canSetLaw(s, "service_by_requirement")).toBe("low_war_support");
    expect(canSetLaw(s, "nope")).toBe("unknown");
    s.politicalPower = LAW_CHANGE_COST;
    expect(setLaw(s, "extensive_conscription")).toBe("ok");
    expect(s.politicalPower).toBe(0);
    expect(s.conscriptionLaw).toBe("extensive_conscription");
    expect(modifiersOf(s).manpower).toBe(150);
    // Default economy law is civilian: -15% output.
    expect(modifiersOf(s).production).toBe(-150);
  });

  test("every law category starts at a valid default", () => {
    const s = newNationState(0);
    expect(CONSCRIPTION_LAW_IDS).toContain(s.conscriptionLaw);
    expect(ECONOMY_LAW_IDS).toContain(s.economyLaw);
    for (const l of LAWS) {
      expect(l.minWarSupport).toBeGreaterThanOrEqual(0);
      expect(l.minWarSupport).toBeLessThanOrEqual(1000);
    }
  });

  test("war support rises under attack, falls with heavy losses, drifts back", () => {
    const s = newNationState(0);
    s.defendedThisSecond = true;
    advanceSecond(s, input);
    expect(s.warSupport).toBe(BASE_WAR_SUPPORT + 5);
    expect(s.defendedThisSecond).toBe(false);
    s.attackLossesThisSecond = input.troops; // lost a whole army
    advanceSecond(s, input);
    expect(s.warSupport).toBe(BASE_WAR_SUPPORT + 2);
    advanceSecond(s, input);
    advanceSecond(s, input);
    expect(s.warSupport).toBe(BASE_WAR_SUPPORT);
    s.completed.push("war_propaganda");
    for (let i = 0; i < 400; i++) advanceSecond(s, input);
    expect(s.warSupport).toBe(BASE_WAR_SUPPORT + 150);
  });

  test("light losses do not dent war support", () => {
    const s = newNationState(0);
    s.attackLossesThisSecond = 10;
    advanceSecond(s, input);
    expect(s.warSupport).toBe(BASE_WAR_SUPPORT);
  });
});

describe("Grand Strategy AI", () => {
  test("personalities are stable and all used", () => {
    const seen = new Set<string>();
    for (let id = 1; id <= 30; id++) {
      expect(aiPersonalityFor(id)).toBe(aiPersonalityFor(id));
      seen.add(aiPersonalityFor(id));
    }
    expect(seen.size).toBe(AI_PERSONALITIES.length);
  });

  test.each(AI_PERSONALITIES)(
    "%s plays a long game without invalid moves",
    (personality) => {
      const s = newNationState(50_000);
      let laws = 0;
      for (let i = 0; i < 3000; i++) {
        if (i % 7 === 0) s.defendedThisSecond = true; // a long war
        const c = aiChoose(s, personality);
        if (c.focus !== null) expect(startFocus(s, c.focus)).toBe("ok");
        if (c.law !== null) {
          expect(setLaw(s, c.law)).toBe("ok");
          laws++;
        }
        advanceSecond(s, input);
        checkInvariants(s, input.maxTroops);
      }
      expect(s.completed.length).toBeGreaterThanOrEqual(8);
      expect(laws).toBeGreaterThan(0);
    },
  );

  test.each(AI_PERSONALITIES)(
    "%s never pushes a law past its ceiling",
    (personality) => {
      const s = newNationState(50_000);
      for (let i = 0; i < 4000; i++) {
        s.defendedThisSecond = true; // max war support, every law unlocked
        const c = aiChoose(s, personality);
        if (c.focus !== null) startFocus(s, c.focus);
        if (c.law !== null) setLaw(s, c.law);
        advanceSecond(s, input);
      }
      expect(s.economyLaw).not.toBe("total_mobilization");
      if (personality !== "defender") {
        expect(s.conscriptionLaw).not.toBe("service_by_requirement");
      }
    },
  );

  test("personalities take different paths", () => {
    const paths = AI_PERSONALITIES.map((p) => {
      const s = newNationState(0);
      for (let i = 0; i < 400; i++) {
        const c = aiChoose(s, p);
        if (c.focus !== null) startFocus(s, c.focus);
        advanceSecond(s, input);
      }
      return s.completed.join(",");
    });
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("GrandStrategyExecution edge cases", () => {
  let game: Game;
  let a: Player;
  let b: Player;

  beforeEach(async () => {
    game = await setup("ocean_and_land", { infiniteGold: true });
    const ai = new PlayerInfo("A", PlayerType.Human, null, "a_id");
    const bi = new PlayerInfo("B", PlayerType.Nation, null, "b_id");
    game.addPlayer(ai);
    game.addPlayer(bi);
    game.addExecution(
      new SpawnExecution("game_id", game.player(ai.id).info(), game.ref(0, 10)),
      new SpawnExecution("game_id", game.player(bi.id).info(), game.ref(0, 15)),
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

  test("updates go to humans only", () => {
    let mine = 0;
    let theirs = 0;
    for (let i = 0; i < 30; i++) {
      for (const u of game.executeNextTick()[GameUpdateType.GrandStrategy] ??
        []) {
        if (u.player === a.id()) mine++;
        if (u.player === b.id()) theirs++;
      }
    }
    expect(mine).toBeGreaterThan(0);
    expect(theirs).toBe(0);
  });

  test("nations pick focuses on their own", () => {
    seconds(3);
    expect(grandStrategyOf(game)!.stateOf(b)!.focus).not.toBeNull();
    expect(grandStrategyOf(game)!.stateOf(a)!.focus).toBeNull();
  });

  test("set_law applies once affordable, and is ignored before", () => {
    const gs = grandStrategyOf(game)!;
    game.addExecution(new SetLawExecution(a, "volunteer_only"));
    seconds(1);
    expect(gs.stateOf(a)!.conscriptionLaw).toBe("limited_conscription");
    gs.stateOf(a)!.politicalPower = LAW_CHANGE_COST;
    game.addExecution(new SetLawExecution(a, "volunteer_only"));
    seconds(1);
    expect(gs.stateOf(a)!.conscriptionLaw).toBe("volunteer_only");
  });

  test("being attacked raises the defender's war support", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    const ws = gs.stateOf(b)!.warSupport;
    gs.adjustCombat(a, b, 1000, 10, 10);
    seconds(1);
    expect(gs.stateOf(b)!.warSupport).toBeGreaterThan(ws);
  });

  test("dead players' state is dropped", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    expect(gs.stateOf(b)).not.toBeNull();
    const internal = (gs as unknown as { states: Map<number, unknown> }).states;
    expect(internal.has(b.smallID())).toBe(true);
    for (const t of [...b.tiles()]) b.relinquish(t);
    expect(b.isAlive()).toBe(false);
    seconds(1);
    expect(internal.has(b.smallID())).toBe(false);
  });

  test("troop growth and gold modifiers stay in range", () => {
    const gs = grandStrategyOf(game)!;
    const s = gs.stateOf(a)!;
    s.completed.push("conscription", "general_mobilization", "total_war");
    const max = game.config().maxTroops(a);
    expect(gs.adjustTroopGrowth(a, 1e9, max)).toBeLessThanOrEqual(
      max - a.troops(),
    );
    expect(gs.adjustTroopGrowth(a, -5, max)).toBe(-5);
    s.economyLaw = "total_mobilization";
    s.completed.push("war_economy");
    expect(gs.adjustGold(a, 1000n)).toBeGreaterThanOrEqual(0n);
    expect(gs.adjustGold(a, 1000n)).toBeLessThan(1000n);
  });
});

describe("GrandStrategy snapshot migration", () => {
  test("v1 records migrate through v9 with defaults", () => {
    const m = GrandStrategyExecutionSnapshot.migrations;
    const v2 = m[1]({
      initialized: true,
      states: [
        {
          id: 3,
          equipment: 10,
          efficiency: 200,
          focus: null,
          focusProgress: 0,
          completed: ["conscription"],
        },
      ],
    });
    const parsed = GrandStrategyExecutionSnapshot.schema.parse(
      m[8](m[7](m[6](m[5](m[4](m[3](m[2](v2))))))),
    );
    expect(parsed.coalitionLeader).toBeNull();
    expect(parsed.states[0].steelDeposits).toBe(0);
    expect(parsed.states[0].milFactories).toBe(0);
    expect(parsed.states[0].artillery).toBe(0);
    expect(parsed.states[0].artilleryShare).toBe(0);
    expect(parsed.states[0].researched).toEqual([]);
    expect(parsed.states[0].occupied).toBe(0);
    expect(parsed.states[0].warGoals).toEqual([]);
    expect(parsed.states[0].weariness).toBe(0);
    expect(parsed.states[0].peakTiles).toBe(0);
    expect(parsed.states[0].enemies).toEqual([]);
    expect(parsed.states[0].truces).toEqual([]);
    expect(parsed.states[0].offers).toEqual([]);
    expect(parsed.states[0].advisors).toEqual([]);
    expect(parsed.states[0].activeDecisions).toEqual([]);
    expect(parsed.states[0].warSupport).toBe(BASE_WAR_SUPPORT);
    expect(parsed.states[0].conscriptionLaw).toBe("limited_conscription");
    expect(parsed.states[0].completed).toEqual(["conscription"]);
  });
});

describe("GrandStrategy in a full scripted game", { timeout: 300_000 }, () => {
  test("nations progress and every state stays valid", async () => {
    const runner = await createScriptedRunner("world", scriptedGameStart());
    while (runner.game.ticks() < 2500) stepScripted(runner);
    const gs = grandStrategyOf(runner.game)!;
    expect(gs).not.toBeNull();
    let nations = 0;
    let progressed = 0;
    for (const p of runner.game.players()) {
      const s = gs.stateOf(p);
      if (p.type() === PlayerType.Bot) {
        expect(s).toBeNull();
        continue;
      }
      checkInvariants(s!, runner.game.config().maxTroops(p));
      if (p.type() === PlayerType.Nation) {
        nations++;
        if (s!.completed.length > 0 || s!.focus !== null) progressed++;
      }
    }
    expect(nations).toBeGreaterThan(0);
    expect(progressed).toBe(nations);
  });
});

describe("Grand Strategy lobby toggle", { timeout: 120_000 }, () => {
  test("grandStrategy: false runs a classic game with no GS layer", async () => {
    const start = scriptedGameStart({ grandStrategy: false });
    const runner = await createScriptedRunner("world", start);
    expect(runner.game.config().grandStrategyEnabled()).toBe(false);
    while (runner.game.ticks() < 60) stepScripted(runner);
    expect(grandStrategyOf(runner.game)).toBeNull();
  });

  test("absent setting means on", async () => {
    const runner = await createScriptedRunner("world", scriptedGameStart());
    expect(runner.game.config().grandStrategyEnabled()).toBe(true);
    stepScripted(runner);
    expect(grandStrategyOf(runner.game)).not.toBeNull();
  });
});

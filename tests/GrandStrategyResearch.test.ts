import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  TECH_IDS,
} from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  modifiersOf,
  newNationState,
  takeAction,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  advanceResearch,
  aiResearch,
  canResearch,
  CATCH_UP_DISCOUNT,
  eraOf,
  ERA_ADVANCE,
  MAX_ERA,
  RESEARCH_PER_SECOND,
  RESEARCH_SLOTS,
  ResearchState,
  startResearch,
  techById,
  techCost,
  TECHS,
} from "@openfront/engine-lib/game/GrandStrategyResearch";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { GsActionExecution } from "@openfront/engine/execution/GsActionExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { roundTrip } from "./util/Snapshot";

const fresh = (): ResearchState => ({ researched: [], research: [] });

describe("GrandStrategyResearch rules", () => {
  test("tech table is consistent with the intent ids", () => {
    expect(TECHS.map((t) => t.id).sort()).toEqual([...TECH_IDS].sort());
    for (const t of TECHS) {
      expect(t.era).toBeGreaterThanOrEqual(1);
      expect(t.era).toBeLessThanOrEqual(MAX_ERA);
      for (const r of [...t.requires, ...t.exclusive]) {
        expect(techById(r)).toBeDefined();
      }
      // Prerequisites never sit in a later era.
      for (const r of t.requires)
        expect(techById(r)!.era).toBeLessThanOrEqual(t.era);
    }
    // Every era can be advanced out of.
    for (let e = 1; e < MAX_ERA; e++) {
      expect(TECHS.filter((t) => t.era === e).length).toBeGreaterThanOrEqual(
        ERA_ADVANCE,
      );
    }
  });

  test("eras advance after enough technologies of the current era", () => {
    expect(eraOf([])).toBe(1);
    expect(eraOf(["basic_machine_tools", "improved_workshops"])).toBe(1);
    const e1 = [
      "basic_machine_tools",
      "improved_workshops",
      "infantry_weapons",
    ];
    expect(eraOf(e1)).toBe(2);
    expect(
      eraOf([...e1, "assembly_lines", "civil_administration", "motorization"]),
    ).toBe(3);
    // Era 2 technologies do not count toward leaving era 1.
    expect(
      eraOf(["assembly_lines", "motorization", "civil_administration"]),
    ).toBe(1);
  });

  test("checks: era lock, prerequisites, slots, duplicates", () => {
    const s = fresh();
    expect(canResearch(s, "nope")).toBe("unknown");
    expect(canResearch(s, "assembly_lines")).toBe("era");
    s.researched.push(
      "improved_workshops",
      "infantry_weapons",
      "field_fortifications",
    );
    expect(canResearch(s, "assembly_lines")).toBe("missing_prerequisite");
    expect(startResearch(s, "basic_machine_tools")).toBe("ok");
    expect(canResearch(s, "basic_machine_tools")).toBe("in_progress");
    expect(startResearch(s, "civil_administration")).toBe("ok");
    expect(s.research.length).toBe(RESEARCH_SLOTS);
    expect(canResearch(s, "motorization")).toBe("no_slot");
    expect(canResearch(s, "infantry_weapons")).toBe("researched");
  });

  test("doctrines are mutually exclusive, also while in progress", () => {
    const s = fresh();
    expect(startResearch(s, "maneuver_doctrine")).toBe("ok");
    expect(canResearch(s, "firepower_doctrine")).toBe("exclusive");
    expect(canResearch(s, "defense_doctrine")).toBe("exclusive");
    s.research = [];
    s.researched.push("defense_doctrine");
    expect(canResearch(s, "maneuver_doctrine")).toBe("exclusive");
  });

  test("research finishes after its seconds; catch-up cuts the cost", () => {
    const t = techById("basic_machine_tools")!;
    expect(techCost(t, 0)).toBe(t.seconds * RESEARCH_PER_SECOND);
    expect(techCost(t, 499)).toBe(t.seconds * RESEARCH_PER_SECOND);
    expect(techCost(t, 500)).toBe(
      t.seconds * RESEARCH_PER_SECOND -
        (t.seconds * RESEARCH_PER_SECOND * CATCH_UP_DISCOUNT) / 1000,
    );
    const slow = fresh();
    const fast = fresh();
    startResearch(slow, t.id);
    startResearch(fast, t.id);
    let slowAt = 0;
    let fastAt = 0;
    for (let sec = 1; sec <= t.seconds; sec++) {
      if (advanceResearch(slow, () => 0).length > 0) slowAt = sec;
      if (advanceResearch(fast, () => 1000).length > 0 && fastAt === 0) {
        fastAt = sec;
      }
    }
    expect(slowAt).toBe(t.seconds);
    expect(fastAt).toBe(
      Math.ceil((t.seconds * (1000 - CATCH_UP_DISCOUNT)) / 1000),
    );
    expect(slow.researched).toEqual([t.id]);
    expect(slow.research).toEqual([]);
  });

  test("researched technologies feed the modifiers", () => {
    const s = newNationState(0);
    const before = modifiersOf(s).production;
    s.researched.push("basic_machine_tools");
    expect(modifiersOf(s).production).toBe(before + 50);
  });

  test("gs_action routes technology ids to research", () => {
    const s = newNationState(0);
    expect(takeAction(s, "infantry_weapons")).toBe("ok");
    expect(s.research.map((r) => r.id)).toEqual(["infantry_weapons"]);
    expect(takeAction(s, "infantry_weapons")).toBe("unavailable");
    expect(takeAction(s, "automation")).toBe("unavailable");
  });

  test("AI fills its slots by personality and respects doctrine choice", () => {
    for (const p of ["industrialist", "militarist", "defender"] as const) {
      const s = fresh();
      for (let i = 0; i < RESEARCH_SLOTS + 1; i++) {
        const next = aiResearch(s, p);
        if (next !== null) startResearch(s, next);
      }
      expect(s.research.length).toBe(RESEARCH_SLOTS);
      expect(aiResearch(s, p)).toBeNull();
    }
    // Simulate a long game: the AI always finds work until the tree runs out.
    const s = fresh();
    for (let sec = 0; sec < 20_000; sec++) {
      const next = aiResearch(s, "militarist");
      if (next !== null) startResearch(s, next);
      advanceResearch(s, () => 0);
    }
    const doctrines = s.researched.filter((id) =>
      ["maneuver_doctrine", "firepower_doctrine", "defense_doctrine"].includes(
        id,
      ),
    );
    expect(doctrines).toEqual(["maneuver_doctrine"]);
    expect(eraOf(s.researched)).toBe(MAX_ERA);
    // Everything not blocked by the doctrine choice is researched.
    expect(s.researched.length).toBe(TECHS.length - 4);
  });

  test("snapshot v8 migration adds empty research", () => {
    const m = GrandStrategyExecutionSnapshot.migrations;
    const out = m[7]({ initialized: true, states: [{ id: 1 }] }) as {
      states: Record<string, unknown>[];
    };
    expect(out.states[0].researched).toEqual([]);
    expect(out.states[0].research).toEqual([]);
  });
});

describe("GrandStrategyResearch in a game", () => {
  let game: Game;
  let a: Player;
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("ocean_and_land", { infiniteGold: true });
    const ai = new PlayerInfo("A", PlayerType.Human, null, "a_id");
    const ni = new PlayerInfo("N", PlayerType.Nation, null, "n_id");
    game.addPlayer(ai);
    game.addPlayer(ni);
    const aSpawn: TileRef = game.ref(0, 10);
    const nSpawn: TileRef = game.ref(0, 15);
    game.addExecution(
      new SpawnExecution(gameID, game.player(ai.id).info(), aSpawn),
      new SpawnExecution(gameID, game.player(ni.id).info(), nSpawn),
      new GrandStrategyExecution(),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    a = game.player(ai.id);
  });

  function seconds(n: number) {
    for (let i = 0; i < n * 10; i++) game.executeNextTick();
  }

  test("a human researches through the intent; nations research on their own", () => {
    game.addExecution(new GsActionExecution(a, "infantry_weapons"));
    seconds(1);
    const gs = grandStrategyOf(game)!;
    const s = gs.stateOf(a)!;
    expect(s.research.map((r) => r.id)).toEqual(["infantry_weapons"]);
    const n = game.player("n_id");
    expect(gs.stateOf(n)!.research.length).toBe(RESEARCH_SLOTS);
    seconds(techById("infantry_weapons")!.seconds + 1);
    expect(s.researched).toContain("infantry_weapons");
    expect(s.research).toEqual([]);
  });

  test("research survives a snapshot round trip", async () => {
    game.addExecution(new GsActionExecution(a, "field_fortifications"));
    seconds(5);
    const gs = grandStrategyOf(game)!;
    gs.stateOf(a)!.researched.push("propaganda_bureau");
    const { restored } = await roundTrip(game, "ocean_and_land");
    const rs = grandStrategyOf(restored)!.stateOf(restored.player(a.id()))!;
    expect(rs.researched).toEqual(["propaganda_bureau"]);
    expect(rs.research).toEqual(gs.stateOf(a)!.research);
  });

  test("the research ablation switch clears and stops research", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("research");
    game.addExecution(new GsActionExecution(a, "infantry_weapons"));
    seconds(3);
    expect(gs.stateOf(a)!.research).toEqual([]);
    expect(gs.stateOf(a)!.researched).toEqual([]);
  });
});

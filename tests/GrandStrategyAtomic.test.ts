import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  aiPersonalityFor,
  takeAction,
  newNationState,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  advanceResearch,
  aiResearch,
  ATOMIC_PROJECT,
  ATOMIC_PROJECT_ERA,
  ATOMIC_PROJECT_SECONDS,
  canResearch,
  eraOf,
  RESEARCH_PER_SECOND,
  RESEARCH_SLOTS,
  ResearchState,
  secondsLeft,
  startResearch,
  techById,
  techCost,
  TECHS,
} from "@openfront/engine-lib/game/GrandStrategyResearch";
import {
  GrandStrategyExecution,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { GsActionExecution } from "@openfront/engine/execution/GsActionExecution";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  createScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "./util/ScriptedGame";
import { setup } from "./util/Setup";
import { roundTrip } from "./util/Snapshot";

const ERA1 = ["basic_machine_tools", "improved_workshops", "infantry_weapons"];
/** Era 2 technologies a nation can hold together (no rival doctrines). */
const ERA2_ALL = TECHS.filter(
  (t) =>
    t.era === 2 &&
    t.project !== true &&
    !["rapid_exploitation", "entrenchment"].includes(t.id),
).map((t) => t.id);

const fresh = (): ResearchState => ({ researched: [], research: [] });

describe("Atomic project rules", () => {
  test("is an era 2 world project of 240 s", () => {
    const t = techById(ATOMIC_PROJECT)!;
    expect(t.era).toBe(ATOMIC_PROJECT_ERA);
    expect(t.era).toBe(2);
    expect(t.seconds).toBe(ATOMIC_PROJECT_SECONDS);
    expect(t.project).toBe(true);
    expect(t.requires).toEqual([]);
  });

  test("is era-locked, then takes a research slot", () => {
    const s = fresh();
    expect(canResearch(s, ATOMIC_PROJECT)).toBe("era");
    s.researched.push(...ERA1);
    expect(eraOf(s.researched)).toBe(2);
    expect(startResearch(s, ATOMIC_PROJECT)).toBe("ok");
    expect(canResearch(s, ATOMIC_PROJECT)).toBe("in_progress");
    expect(startResearch(s, "civil_administration")).toBe("ok");
    expect(s.research.length).toBe(RESEARCH_SLOTS);
    expect(canResearch(s, "motorization")).toBe("no_slot");
  });

  test("gets no catch-up discount", () => {
    const t = techById(ATOMIC_PROJECT)!;
    const base = ATOMIC_PROJECT_SECONDS * RESEARCH_PER_SECOND;
    expect(techCost(t, 0)).toBe(base);
    expect(techCost(t, 1000)).toBe(base);
    const s = fresh();
    s.researched.push(...ERA1);
    startResearch(s, ATOMIC_PROJECT);
    let at = 0;
    for (let sec = 1; sec <= ATOMIC_PROJECT_SECONDS + 5; sec++) {
      // Everyone else already knows it: still the full time.
      if (advanceResearch(s, () => 1000).includes(ATOMIC_PROJECT)) at = sec;
    }
    expect(at).toBe(ATOMIC_PROJECT_SECONDS);
    expect(s.researched).toContain(ATOMIC_PROJECT);
    expect(secondsLeft(0, techCost(t, 0))).toBe(ATOMIC_PROJECT_SECONDS);
    expect(secondsLeft(base - 1, base)).toBe(1);
    expect(secondsLeft(base, base)).toBe(0);
  });

  test("does not count toward the next era", () => {
    const e2 = [...ERA1, "civil_administration", "motorization"];
    expect(eraOf(e2)).toBe(2);
    expect(eraOf([...e2, ATOMIC_PROJECT])).toBe(2);
    expect(eraOf([...e2, "assembly_lines"])).toBe(3);
  });

  test("gs_action starts it; it has no modifier effects", () => {
    const s = newNationState(0);
    expect(takeAction(s, ATOMIC_PROJECT)).toBe("unavailable");
    s.researched.push(...ERA1);
    expect(takeAction(s, ATOMIC_PROJECT)).toBe("ok");
    expect(techById(ATOMIC_PROJECT)!.effects).toEqual({});
  });

  test("AI order: militarists start it first in era 2, others after an era 2 tech", () => {
    const at = (p: "industrialist" | "militarist" | "defender") => {
      const s = fresh();
      s.researched.push(
        "infantry_weapons",
        "basic_machine_tools",
        "propaganda_bureau",
        "maneuver_doctrine",
        "firepower_doctrine",
        "defense_doctrine",
      );
      // Simulate until it is started; return how many era 2 starts came first.
      let before = 0;
      for (let sec = 0; sec < 5000; sec++) {
        for (let i = 0; i < RESEARCH_SLOTS; i++) {
          const next = aiResearch(s, p);
          if (next === null) break;
          if (next === ATOMIC_PROJECT) return before;
          if (techById(next)!.era === 2) before++;
          startResearch(s, next);
        }
        advanceResearch(s, () => 0);
      }
      return -1;
    };
    expect(at("militarist")).toBe(0);
    expect(at("industrialist")).toBeGreaterThan(0);
    expect(at("defender")).toBeGreaterThan(0);
    // The ablation skips it.
    const s = fresh();
    s.researched.push(
      ...ERA1,
      "maneuver_doctrine",
      "propaganda_bureau",
      "field_fortifications",
      ...ERA2_ALL,
      "rapid_exploitation",
    );
    expect(aiResearch(s, "militarist")).toBe(ATOMIC_PROJECT);
    expect(aiResearch(s, "militarist", true)).not.toBe(ATOMIC_PROJECT);
  });
});

describe("Atomic project in a game", () => {
  let game: Game;
  let a: Player;
  let n: Player;
  let target: TileRef;
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("ocean_and_land", {
      infiniteGold: true,
      instantBuild: true,
    });
    const ai = new PlayerInfo("A", PlayerType.Human, null, "a_id");
    const ni = new PlayerInfo("N", PlayerType.Nation, null, "n_id");
    game.addPlayer(ai);
    game.addPlayer(ni);
    const aSpawn: TileRef = game.ref(0, 10);
    target = game.ref(0, 15);
    game.addExecution(
      new SpawnExecution(gameID, game.player(ai.id).info(), aSpawn),
      new SpawnExecution(gameID, game.player(ni.id).info(), target),
      new GrandStrategyExecution(),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    a = game.player(ai.id);
    n = game.player(ni.id);
    a.buildUnit(UnitType.MissileSilo, aSpawn, {});
  });

  function seconds(k: number) {
    const all: ReturnType<Game["executeNextTick"]>[] = [];
    for (let i = 0; i < k * 10; i++) all.push(game.executeNextTick());
    return all;
  }

  const atomicMessages = (ups: ReturnType<Game["executeNextTick"]>[]) =>
    ups.flatMap((u) =>
      (u[GameUpdateType.DisplayEvent] ?? []).filter(
        (e) => e.messageType === MessageType.ATOMIC_PROJECT,
      ),
    );

  test("nukes are locked until the project is done; silos and SAMs are not", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1); // the silo is ready the tick after it is placed
    expect(a.canBuild(UnitType.AtomBomb, target)).toBe(false);
    expect(a.canBuild(UnitType.HydrogenBomb, target)).toBe(false);
    expect(a.canBuild(UnitType.MIRV, target)).toBe(false);
    expect(game.config().isUnitLockedFor(a, UnitType.MissileSilo)).toBe(false);
    expect(game.config().isUnitLockedFor(a, UnitType.SAMLauncher)).toBe(false);
    expect(game.config().isUnitLockedFor(a, UnitType.MIRVWarhead)).toBe(false);
    // A locked launch never spawns a bomb.
    game.addExecution(new NukeExecution(UnitType.AtomBomb, a, target, null));
    seconds(1);
    expect(game.units(UnitType.AtomBomb)).toHaveLength(0);

    gs.stateOf(a)!.researched.push(ATOMIC_PROJECT);
    expect(a.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
    expect(a.canBuild(UnitType.HydrogenBomb, target)).not.toBe(false);
    // Only the nation that finished it.
    expect(game.config().isUnitLockedFor(n, UnitType.AtomBomb)).toBe(true);
    game.addExecution(new NukeExecution(UnitType.AtomBomb, a, target, null));
    game.executeNextTick();
    game.executeNextTick();
    expect(game.units(UnitType.AtomBomb)).toHaveLength(1);
  });

  test("ablations unlock nukes (noatomic, noresearch)", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1); // the silo is ready the tick after it is placed
    expect(a.canBuild(UnitType.AtomBomb, target)).toBe(false);
    gs.ablate("atomic");
    expect(a.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
  });

  test("research ablation leaves nukes ungated too", () => {
    seconds(1);
    expect(a.canBuild(UnitType.AtomBomb, target)).toBe(false);
    grandStrategyOf(game)!.ablate("research");
    expect(a.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
  });

  test("start and finish are announced to every player; HUD world list", () => {
    const gs = grandStrategyOf(game)!;
    gs.stateOf(a)!.researched.push(...ERA1);
    game.addExecution(new GsActionExecution(a, ATOMIC_PROJECT));
    let ups = seconds(2);
    let msgs = atomicMessages(ups);
    expect(msgs.map((m) => m.message)).toContain(
      "events_display.atomic_project_started",
    );
    const mine = msgs.filter((m) => m.focusPlayerID === a.smallID());
    expect(mine).toHaveLength(1);
    expect(mine[0].playerID).toBeNull();
    expect(mine[0].params?.name).toBe(a.displayName());
    const hud = ups
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === a.id());
    const last = hud[hud.length - 1];
    const row = last.atomicProjects.find((r) => r.player === a.id());
    expect(row).toBeDefined();
    expect(row!.seconds).toBeGreaterThan(ATOMIC_PROJECT_SECONDS - 3);
    expect(row!.seconds).toBeLessThanOrEqual(ATOMIC_PROJECT_SECONDS);
    expect(last.research.map((r) => r.id)).toContain(ATOMIC_PROJECT);

    ups = seconds(ATOMIC_PROJECT_SECONDS);
    msgs = atomicMessages(ups).filter((m) => m.focusPlayerID === a.smallID());
    expect(msgs.map((m) => m.message)).toEqual([
      "events_display.atomic_project_completed",
    ]);
    expect(gs.stateOf(a)!.researched).toContain(ATOMIC_PROJECT);
    expect(a.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
    const after = ups
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === a.id());
    const end = after[after.length - 1];
    expect(end.atomicPowers).toContain(a.id());
    expect(end.atomicProjects.some((r) => r.player === a.id())).toBe(false);
  });

  test("AI nations start it once their era 2 list is done, with a message", () => {
    const gs = grandStrategyOf(game)!;
    const s = gs.stateOf(n)!;
    s.researched = [
      ...ERA1,
      "propaganda_bureau",
      "field_fortifications",
      ...ERA2_ALL,
    ];
    s.research = [];
    const ups = seconds(1);
    expect(s.research.map((r) => r.id)).toContain(ATOMIC_PROJECT);
    expect(
      atomicMessages(ups).some(
        (m) =>
          m.focusPlayerID === n.smallID() &&
          m.message === "events_display.atomic_project_started",
      ),
    ).toBe(true);
    expect(aiPersonalityFor(n.smallID())).toBeDefined();
  });

  test("AI skips it under the atomic ablation", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("atomic");
    const s = gs.stateOf(n)!;
    s.researched = [
      ...ERA1,
      "propaganda_bureau",
      "field_fortifications",
      ...ERA2_ALL,
    ];
    s.research = [];
    seconds(1);
    expect(s.research.map((r) => r.id)).not.toContain(ATOMIC_PROJECT);
  });

  test("a project mid-way survives a snapshot round trip; the gate is restored", async () => {
    const gs = grandStrategyOf(game)!;
    gs.stateOf(a)!.researched.push(...ERA1);
    game.addExecution(new GsActionExecution(a, ATOMIC_PROJECT));
    seconds(30);
    const before = gs.stateOf(a)!.research.find((r) => r.id === ATOMIC_PROJECT);
    expect(before).toBeDefined();
    expect(before!.progress).toBeGreaterThan(0);
    const { restored } = await roundTrip(game, "ocean_and_land");
    const ra = restored.player(a.id());
    const rgs = grandStrategyOf(restored)!;
    const rs = rgs.stateOf(ra)!;
    expect(rs.research).toEqual(gs.stateOf(a)!.research);
    expect(rs.researched).toEqual(gs.stateOf(a)!.researched);
    expect(ra.canBuild(UnitType.AtomBomb, target)).toBe(false);
    rs.researched.push(ATOMIC_PROJECT);
    expect(ra.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
  });
});

/**
 * Classic (Grand Strategy off) must not change at all. The digest below was
 * recorded at c749d0e (before the atomic project), re-recorded at the
 * 34a6996 upstream merge (upstream changed annexation), with this same scripted
 * game: ownership, troops, gold and unit counts every 100 ticks. The game
 * builds nuclear weapons, so a leak of the gate into classic would show.
 */
describe("Atomic project: classic unchanged", { timeout: 300_000 }, () => {
  test("classic scripted game is byte-identical to pre-M6C", async () => {
    const runner = await createScriptedRunner(
      "world",
      scriptedGameStart({ grandStrategy: false }),
    );
    const g = runner.game;
    expect(grandStrategyOf(g)).toBeNull();
    let h = 2166136261;
    const mix = (x: number) => {
      h = Math.imul(h ^ (x | 0), 16777619) >>> 0;
    };
    while (g.ticks() < 1500) {
      stepScripted(runner);
      if (g.ticks() % 100 !== 0) continue;
      mix(g.ticks());
      for (const p of g.allPlayers()) {
        mix(p.smallID());
        mix(p.numTilesOwned());
        mix(Math.floor(p.troops()));
        mix(Number(p.gold() % 1000000007n));
        mix(p.units().length);
      }
    }
    let nukes = 0;
    for (const p of g.allPlayers()) {
      expect(g.config().isUnitLockedFor(p, UnitType.AtomBomb)).toBe(false);
      nukes +=
        p.unitsConstructed(UnitType.AtomBomb) +
        p.unitsConstructed(UnitType.HydrogenBomb) +
        p.unitsConstructed(UnitType.MIRV);
    }
    expect(nukes).toBe(22);
    expect(h).toBe(2110619737);
  });
});

describe("Atomic project: gate in a full game", { timeout: 300_000 }, () => {
  test("with GS on, nobody launches a nuke before finishing the project", async () => {
    const runner = await createScriptedRunner("world", scriptedGameStart());
    const g = runner.game;
    while (g.ticks() < 1500) stepScripted(runner);
    const gs = grandStrategyOf(g)!;
    expect(gs).not.toBeNull();
    let nukes = 0;
    for (const p of g.allPlayers()) {
      const built =
        p.unitsConstructed(UnitType.AtomBomb) +
        p.unitsConstructed(UnitType.HydrogenBomb) +
        p.unitsConstructed(UnitType.MIRV);
      nukes += built;
      if (built > 0) {
        expect(gs.stateOf(p)?.researched ?? []).toContain(ATOMIC_PROJECT);
      }
    }
    // The same script builds 16 in classic (see above); far too early here.
    expect(nukes).toBe(0);
  });
});

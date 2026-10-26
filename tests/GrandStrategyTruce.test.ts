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
  addTruce,
  advancePeaceTimers,
  aiBreaksTruce,
  AiBreakInput,
  AI_BREAK_STRENGTH,
  BREAK_PP_COST,
  BREAK_WAR_SUPPORT,
  BREAK_WEARINESS,
  canBreakTruce,
  hasTruce,
  newPeaceState,
  recordConquest,
  removeTruce,
  TRUCE_BREAKABLE_SECONDS,
  TRUCE_MAX_LOCK,
  TRUCE_MIN_LOCK,
  truceLockSeconds,
  TruceLockInput,
  truceWith,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import { ATOMIC_PROJECT } from "@openfront/engine-lib/game/GrandStrategyResearch";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { PeaceExecution } from "@openfront/engine/execution/PeaceExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { diffSnapshots, roundTrip } from "./util/Snapshot";

const lockBase: TruceLockInput = {
  capitulation: false,
  loserLostPermille: 100,
  loserTiles: 1000,
  winnerTiles: 1000,
  warSeconds: 300,
  wearinessA: 300,
  wearinessB: 300,
};

describe("truce lock rules (M7 stage A.2)", () => {
  test("capitulation, big losses and a size gap lock longer", () => {
    const peace = truceLockSeconds(lockBase);
    expect(Number.isInteger(peace)).toBe(true);
    expect(
      truceLockSeconds({ ...lockBase, capitulation: true }),
    ).toBeGreaterThan(peace);
    expect(
      truceLockSeconds({ ...lockBase, loserLostPermille: 600 }),
    ).toBeGreaterThan(peace);
    expect(truceLockSeconds({ ...lockBase, loserTiles: 100 })).toBeGreaterThan(
      peace,
    );
  });

  test("short wars and calm sides lock shorter; clamped", () => {
    const peace = truceLockSeconds(lockBase);
    expect(truceLockSeconds({ ...lockBase, warSeconds: 20 })).toBeLessThan(
      peace,
    );
    expect(
      truceLockSeconds({ ...lockBase, wearinessA: 0, wearinessB: 50 }),
    ).toBeLessThan(peace);
    // One weary side is enough to keep the calm discount away.
    expect(truceLockSeconds({ ...lockBase, wearinessA: 0 })).toBe(peace);
    expect(
      truceLockSeconds({
        ...lockBase,
        loserLostPermille: 0,
        warSeconds: 0,
        wearinessA: 0,
        wearinessB: 0,
      }),
    ).toBe(TRUCE_MIN_LOCK);
    expect(
      truceLockSeconds({
        ...lockBase,
        capitulation: true,
        loserLostPermille: 1000,
        loserTiles: 1,
        winnerTiles: 100_000,
      }),
    ).toBe(TRUCE_MAX_LOCK);
    // Degenerate inputs stay in range.
    expect(
      truceLockSeconds({ ...lockBase, winnerTiles: 0, loserLostPermille: -5 }),
    ).toBeGreaterThanOrEqual(TRUCE_MIN_LOCK);
  });

  test("lock counts down, then the truce is breakable until it expires", () => {
    const a = newPeaceState();
    const b = newPeaceState();
    recordConquest(a, 1, b, 2, 5);
    addTruce(a, 1, b, 2, 200);
    expect(truceWith(a, 2)).toEqual({
      target: 2,
      seconds: 200 + TRUCE_BREAKABLE_SECONDS,
      lock: 200,
    });
    expect(canBreakTruce(a, 2)).toBe("locked");
    expect(canBreakTruce(a, 3)).toBe("no_truce");
    for (let i = 0; i < 199; i++) advancePeaceTimers(a, 1);
    expect(canBreakTruce(a, 2)).toBe("locked");
    advancePeaceTimers(a, 1);
    expect(canBreakTruce(a, 2)).toBe("ok");
    expect(truceWith(a, 2)!.lock).toBe(0);
    for (let i = 0; i < TRUCE_BREAKABLE_SECONDS - 1; i++) {
      advancePeaceTimers(a, 1);
    }
    expect(hasTruce(a, 2)).toBe(true);
    advancePeaceTimers(a, 1);
    expect(hasTruce(a, 2)).toBe(false);
    // Breaking removes both mirrors.
    removeTruce(newPeaceState(), 1, b, 2);
    expect(hasTruce(b, 1)).toBe(false);
  });

  test("AI breaks only when much stronger, fresh, idle, next door, solvent", () => {
    const ok: AiBreakInput = {
      strengthPermille: 5000,
      weariness: 0,
      wars: 0,
      borders: true,
      canPay: true,
    };
    for (const p of ["militarist", "industrialist", "defender"] as const) {
      expect(aiBreaksTruce(p, ok)).toBe(true);
      expect(
        aiBreaksTruce(p, {
          ...ok,
          strengthPermille: AI_BREAK_STRENGTH[p] - 1,
        }),
      ).toBe(false);
      expect(aiBreaksTruce(p, { ...ok, borders: false })).toBe(false);
      expect(aiBreaksTruce(p, { ...ok, canPay: false })).toBe(false);
      expect(aiBreaksTruce(p, { ...ok, weariness: 500 })).toBe(false);
      expect(aiBreaksTruce(p, { ...ok, wars: 2 })).toBe(false);
    }
    // Militarists need the least edge and may fight one other war.
    expect(AI_BREAK_STRENGTH.militarist).toBeLessThan(
      AI_BREAK_STRENGTH.industrialist,
    );
    expect(AI_BREAK_STRENGTH.industrialist).toBeLessThan(
      AI_BREAK_STRENGTH.defender,
    );
    expect(aiBreaksTruce("militarist", { ...ok, wars: 1 })).toBe(true);
    expect(aiBreaksTruce("defender", { ...ok, wars: 1 })).toBe(false);
  });
});

describe("GrandStrategyExecution breakable truces", () => {
  let game: Game;
  let a: Player;
  let b: Player;
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("ocean_and_land", {
      infiniteGold: true,
      instantBuild: true,
    });
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
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    a = game.player(ai.id);
    b = game.player(bi.id);
    for (let x = 0; x < game.width(); x++) {
      for (let y = 0; y < game.height(); y++) {
        const t = game.ref(x, y);
        if (!game.isLand(t) || game.hasOwner(t)) continue;
        (y <= 9 ? a : b).conquer(t);
      }
    }
  });

  function seconds(n: number) {
    const all: ReturnType<Game["executeNextTick"]>[] = [];
    for (let i = 0; i < n * 10; i++) all.push(game.executeNextTick());
    return all;
  }

  function fight(tiles = 3) {
    const gs = grandStrategyOf(game)!;
    for (const t of [...b.tiles()].slice(0, tiles)) {
      a.conquer(t);
      gs.onConquer(a, b);
    }
  }

  function makePeace() {
    const gs = grandStrategyOf(game)!;
    expect(gs.offerPeace(a, b)).toBe("offered");
    expect(gs.offerPeace(b, a)).toBe("accepted");
  }

  test("peace gets a dynamic lock; breaking needs the lock over and costs", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    makePeace();
    const t = truceWith(gs.peaceOf(a)!, b.smallID())!;
    expect(t.lock).toBeGreaterThanOrEqual(TRUCE_MIN_LOCK);
    expect(t.lock).toBeLessThanOrEqual(TRUCE_MAX_LOCK);
    expect(t.seconds).toBe(t.lock + TRUCE_BREAKABLE_SECONDS);
    expect(truceWith(gs.peaceOf(b)!, a.smallID())).toEqual({
      ...t,
      target: a.smallID(),
    });
    expect(gs.breakTruce(a, b)).toBe("locked");
    seconds(t.lock);
    expect(game.config().isAttackLocked(a, b)).toBe(true);
    const s = gs.stateOf(a)!;
    s.politicalPower = BREAK_PP_COST - 1;
    expect(gs.breakTruce(a, b)).toBe("no_political_power");
    s.politicalPower = BREAK_PP_COST + 5000;
    s.warSupport = 500;
    s.weariness = 0;
    expect(gs.breakTruce(a, b)).toBe("broken");
    expect(s.politicalPower).toBe(5000);
    expect(s.warSupport).toBe(500 + BREAK_WAR_SUPPORT);
    expect(s.weariness).toBe(BREAK_WEARINESS);
    expect(hasTruce(gs.peaceOf(a)!, b.smallID())).toBe(false);
    expect(hasTruce(gs.peaceOf(b)!, a.smallID())).toBe(false);
    expect(game.config().isAttackLocked(a, b)).toBe(false);
    expect(a.canAttackPlayer(b)).toBe(true);
    // The victim holds a defensive war goal against the breaker.
    expect(
      gs
        .warOf(b)!
        .warGoals.some((g) => g.target === a.smallID() && g.defensive === true),
    ).toBe(true);
    expect(gs.breakTruce(a, b)).toBe("no_truce");
  });

  test("break intent through PeaceExecution, with a world message", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    makePeace();
    for (const side of [gs.peaceOf(a)!, gs.peaceOf(b)!]) {
      for (const t of side.truces) t.lock = 0;
    }
    gs.stateOf(b)!.politicalPower = BREAK_PP_COST;
    game.addExecution(new PeaceExecution(b, a.id(), "break"));
    const ups = [game.executeNextTick(), game.executeNextTick()];
    expect(hasTruce(gs.peaceOf(a)!, b.smallID())).toBe(false);
    const msgs = ups.flatMap((u) =>
      (u[GameUpdateType.DisplayEvent] ?? []).filter(
        (e) => e.messageType === MessageType.GS_DIPLOMACY,
      ),
    );
    expect(msgs.map((m) => m.message)).toContain(
      "events_display.gs_truce_broken",
    );
    expect(msgs.find((m) => m.playerID === null)).toBeDefined();
  });

  test("HUD update carries the lock", () => {
    seconds(1);
    fight();
    makePeace();
    const ups = seconds(1);
    const mine = ups
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === a.id());
    const last = mine[mine.length - 1];
    expect(last.truces).toHaveLength(1);
    expect(last.truces[0].target).toBe(b.id());
    expect(last.truces[0].lock).toBeGreaterThan(0);
    expect(last.truces[0].seconds).toBe(
      last.truces[0].lock + TRUCE_BREAKABLE_SECONDS,
    );
  });

  test("capitulation locks longer than a short calm peace", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    makePeace();
    const peaceLock = truceWith(gs.peaceOf(a)!, b.smallID())!.lock;
    removeTruce(gs.peaceOf(a)!, a.smallID(), gs.peaceOf(b)!, b.smallID());
    fight();
    const pb = gs.peaceOf(b)!;
    pb.peakTiles = Math.max(b.numTilesOwned() * 3, game.numLandTiles());
    seconds(1);
    const capLock = truceWith(pb, a.smallID())!.lock;
    expect(capLock).toBeGreaterThan(peaceLock);
  });

  test("nukes at a truce partner are refused until it is broken", () => {
    const gs = grandStrategyOf(game)!;
    gs.stateOf(a)!.researched.push(ATOMIC_PROJECT);
    // Let stray enclaves of the land split settle before placing the silo.
    seconds(1);
    a.buildUnit(UnitType.MissileSilo, [...a.tiles()][0], {});
    seconds(1);
    expect(a.units(UnitType.MissileSilo)).toHaveLength(1);
    const target = [...b.tiles()][0];
    expect(a.canBuild(UnitType.AtomBomb, target)).not.toBe(false);
    fight(1);
    makePeace();
    const bTiles = [...b.tiles()];
    const t2 = bTiles[bTiles.length - 1];
    expect(game.owner(t2)).toBe(b);
    expect(a.canBuild(UnitType.AtomBomb, t2)).toBe(false);
    expect(a.canBuild(UnitType.HydrogenBomb, t2)).toBe(false);
    expect(a.canBuild(UnitType.MIRV, t2)).toBe(false);
    for (const side of [gs.peaceOf(a)!, gs.peaceOf(b)!]) {
      for (const t of side.truces) t.lock = 0;
    }
    gs.stateOf(a)!.politicalPower = BREAK_PP_COST;
    expect(gs.breakTruce(a, b)).toBe("broken");
    expect(a.canBuild(UnitType.AtomBomb, t2)).not.toBe(false);
  });

  test("ablated: breaking is disabled", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("weariness");
    expect(gs.breakTruce(a, b)).toBe("disabled");
  });

  test("snapshot keeps the lock; v9 truces migrate fully locked", async () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    gs.peaceOf(a)!.truces.push({ target: b.smallID(), seconds: 90, lock: 30 });
    const { bytes, restored, again } = await roundTrip(game, "ocean_and_land");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    const ra = restored.player(a.id());
    expect(
      truceWith(grandStrategyOf(restored)!.peaceOf(ra)!, b.smallID()),
    ).toEqual({ target: b.smallID(), seconds: 90, lock: 30 });
    const migrated = GrandStrategyExecutionSnapshot.migrations[9]({
      initialized: true,
      states: [{ truces: [{ target: 4, seconds: 77 }] }],
    }) as { states: { truces: unknown[] }[] };
    expect(migrated.states[0].truces).toEqual([
      { target: 4, seconds: 77, lock: 77 },
    ]);
  });
});

describe("AI truce breaking in the execution", () => {
  test("a much stronger AI breaks a breakable truce with a neighbour", async () => {
    const game = await setup("ocean_and_land", { infiniteGold: true });
    const gameID: GameID = "game_id";
    // Small ids decide the personality; try nations until one breaks.
    const ni = new PlayerInfo("N", PlayerType.Nation, null, "n_id");
    const bi = new PlayerInfo("B", PlayerType.Human, null, "b_id");
    game.addPlayer(ni);
    game.addPlayer(bi);
    game.addExecution(
      new SpawnExecution(gameID, game.player(ni.id).info(), game.ref(0, 10)),
      new SpawnExecution(gameID, game.player(bi.id).info(), game.ref(0, 15)),
      new GrandStrategyExecution(),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    const n = game.player(ni.id);
    const b = game.player(bi.id);
    for (let x = 0; x < game.width(); x++) {
      for (let y = 0; y < game.height(); y++) {
        const t = game.ref(x, y);
        if (!game.isLand(t) || game.hasOwner(t)) continue;
        (y <= 9 ? n : b).conquer(t);
      }
    }
    // Make sure they share a land border: n takes a land tile of b's
    // that touches another of b's land tiles.
    const edge = [...b.tiles()].find((t) =>
      game.neighbors(t).some((x) => game.isLand(x) && game.owner(x) === b),
    )!;
    n.conquer(edge);
    expect(n.sharesBorderWith(b)).toBe(true);
    const gs = grandStrategyOf(game)!;
    addTruce(gs.peaceOf(n)!, n.smallID(), gs.peaceOf(b)!, b.smallID(), 0);
    // Weak partner: the AI stays put while locked (lock > 0) ...
    gs.peaceOf(n)!.truces[0].lock = 5;
    gs.peaceOf(b)!.truces[0].lock = 5;
    n.addTroops(1_000_000);
    b.removeTroops(b.troops() - 1);
    const sN = gs.stateOf(n)!;
    sN.politicalPower = 400_000;
    sN.weariness = 0;
    for (let i = 0; i < 20; i++) game.executeNextTick();
    expect(hasTruce(gs.peaceOf(n)!, b.smallID())).toBe(true);
    // ... and breaks it once it is breakable.
    for (let i = 0; i < 50; i++) {
      game.executeNextTick();
      b.removeTroops(Math.max(0, b.troops() - 1));
      sN.politicalPower = Math.max(sN.politicalPower, 400_000);
      sN.weariness = 0;
    }
    expect(hasTruce(gs.peaceOf(n)!, b.smallID())).toBe(false);
  });
});

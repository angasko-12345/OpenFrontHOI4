import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  modifiersOf,
  newNationState,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  addOffer,
  addTruce,
  advancePeaceTimers,
  advanceWeariness,
  aiAcceptsPeace,
  aiPeaceTarget,
  AI_ACCEPT_WEARINESS,
  AI_OFFER_WEARINESS,
  capitulationTarget,
  hasSurrendered,
  hasTruce,
  LONG_WAR_SECONDS,
  longWars,
  newPeaceState,
  OFFER_SECONDS,
  recordConquest,
  TRUCE_BREAKABLE_SECONDS,
  TRUCE_MAX_LOCK,
  TRUCE_MIN_LOCK,
  WAR_IDLE_SECONDS,
  WEARINESS_MAX,
  WEARY_ATTACK_LOSS,
  wearinessPermille,
  WearinessInput,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  GrandStrategyExecution,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { PeaceExecution } from "@openfront/engine/execution/PeaceExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { diffSnapshots, roundTrip } from "./util/Snapshot";

const base: WearinessInput = {
  attackLosses: 0,
  maxTroops: 10_000,
  tilesLost: 0,
  peakTiles: 1000,
  tilesOwned: 1000,
  numLandTiles: 100_000,
  occupied: 0,
  longWars: 0,
  atWar: false,
};

describe("war weariness rules", () => {
  test("losses, lost land and long wars raise it; peace lowers it", () => {
    expect(advanceWeariness(0, base)).toBe(0);
    const losses = advanceWeariness(0, { ...base, attackLosses: 1000 });
    const land = advanceWeariness(0, { ...base, tilesLost: 100 });
    const war = advanceWeariness(0, { ...base, longWars: 2, atWar: true });
    for (const v of [losses, land, war]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(advanceWeariness(50_000, base)).toBeLessThan(50_000);
    // Recovery at war is slower than in peace.
    expect(advanceWeariness(50_000, { ...base, atWar: true })).toBeGreaterThan(
      advanceWeariness(50_000, base),
    );
    expect(advanceWeariness(0, base)).toBe(0);
    expect(
      advanceWeariness(WEARINESS_MAX, { ...base, attackLosses: 10 ** 9 }),
    ).toBe(WEARINESS_MAX);
  });

  test("big and over-extended nations tire faster for the same losses", () => {
    const small = advanceWeariness(0, { ...base, attackLosses: 1000 });
    const big = advanceWeariness(0, {
      ...base,
      attackLosses: 1000,
      tilesOwned: 30_000,
      peakTiles: 30_000,
    });
    const occupied = advanceWeariness(0, {
      ...base,
      attackLosses: 1000,
      occupied: 500,
    });
    expect(big).toBeGreaterThan(small);
    expect(occupied).toBeGreaterThan(small);
  });

  test("effects: more attack losses, less PP and war support", () => {
    const s = newNationState(0);
    const calm = modifiersOf(s);
    s.weariness = WEARINESS_MAX;
    const weary = modifiersOf(s);
    expect(weary.attackLoss - calm.attackLoss).toBe(WEARY_ATTACK_LOSS);
    expect(weary.politicalPower).toBeLessThan(calm.politicalPower);
    expect(weary.warSupport).toBeLessThan(calm.warSupport);
    // States from before M7 have no field: no effect.
    delete s.weariness;
    expect(modifiersOf(s)).toEqual(calm);
    expect(wearinessPermille(undefined)).toBe(0);
  });
});

describe("wars, truces and capitulation rules", () => {
  test("conquest starts a war on both sides; it ends when quiet", () => {
    const a = newPeaceState();
    const b = newPeaceState();
    recordConquest(a, 1, b, 2, 3);
    expect(a.enemies).toEqual([
      { target: 2, seconds: 0, idle: 0, won: 3, lost: 0 },
    ]);
    expect(b.enemies[0]).toMatchObject({ target: 1, won: 0, lost: 3 });
    expect(b.tilesLostThisSecond).toBe(3);
    for (let i = 0; i < LONG_WAR_SECONDS; i++) {
      recordConquest(a, 1, newPeaceState(), 2);
      advancePeaceTimers(a, 10);
    }
    expect(longWars(a)).toBe(1);
    for (let i = 0; i < WAR_IDLE_SECONDS; i++) advancePeaceTimers(b, 10);
    expect(b.enemies.length).toBe(1);
    advancePeaceTimers(b, 10);
    expect(b.enemies.length).toBe(0);
    expect(b.peakTiles).toBe(10);
  });

  test("truce clears the war and offers, and expires", () => {
    const a = newPeaceState();
    const b = newPeaceState();
    recordConquest(a, 1, b, 2, 5);
    addOffer(b, 1);
    addTruce(a, 1, b, 2);
    expect(hasTruce(a, 2) && hasTruce(b, 1)).toBe(true);
    expect(a.enemies).toEqual([]);
    expect(b.offers).toEqual([]);
    const total = TRUCE_MIN_LOCK + TRUCE_BREAKABLE_SECONDS;
    for (let i = 0; i < total - 1; i++) advancePeaceTimers(a, 1);
    expect(hasTruce(a, 2)).toBe(true);
    advancePeaceTimers(a, 1);
    expect(hasTruce(a, 2)).toBe(false);
    addOffer(a, 2);
    for (let i = 0; i < OFFER_SECONDS; i++) advancePeaceTimers(a, 1);
    expect(a.offers).toEqual([]);
  });

  test("capitulation below half the peak, to the enemy that took most", () => {
    const s = newPeaceState();
    s.peakTiles = 1000;
    recordConquest(newPeaceState(), 7, s, 1, 200);
    recordConquest(newPeaceState(), 4, s, 1, 350);
    expect(capitulationTarget(s, 501, 10_000)).toBeNull();
    expect(capitulationTarget(s, 450, 10_000)).toBe(4);
    // Too small a peak (under 0.5% of the world) never capitulates.
    expect(capitulationTarget(s, 450, 1_000_000)).toBeNull();
    // No war, no capitulation.
    s.enemies = [];
    expect(capitulationTarget(s, 10, 10_000)).toBeNull();
  });

  test("AI: thresholds by personality, losing always accepts", () => {
    const losing = { target: 2, seconds: 10, idle: 0, won: 1, lost: 5 };
    const winning = { ...losing, won: 5, lost: 1 };
    for (const p of ["defender", "industrialist", "militarist"] as const) {
      const at = AI_ACCEPT_WEARINESS[p] * 1000;
      expect(aiAcceptsPeace(p, at, winning)).toBe(true);
      expect(aiAcceptsPeace(p, at - 1000, winning)).toBe(false);
      expect(aiAcceptsPeace(p, 0, losing)).toBe(true);
    }
    expect(AI_OFFER_WEARINESS.defender).toBeLessThan(
      AI_OFFER_WEARINESS.militarist,
    );
    const s = newPeaceState();
    s.peakTiles = 100;
    s.enemies = [
      { target: 3, seconds: 50, idle: 0, won: 9, lost: 0 },
      { target: 5, seconds: 20, idle: 0, won: 0, lost: 30 },
    ];
    // Not weary: sues only the enemy that is winning, once clearly lost.
    expect(aiPeaceTarget(s, "militarist", 0, null)).toBe(5);
    expect(aiPeaceTarget(s, "militarist", 0, 5)).toBe(5);
    s.enemies[1].lost = 2;
    s.enemies[1].won = 1;
    expect(aiPeaceTarget(s, "militarist", 0, null)).toBeNull();
    // Weary: anyone, but not the coalition target unless losing to it.
    const weary = AI_OFFER_WEARINESS.militarist * 1000;
    expect(aiPeaceTarget(s, "militarist", weary, null)).toBe(5);
    s.enemies[1].lost = 0;
    expect(aiPeaceTarget(s, "militarist", weary, null)).toBe(3);
    expect(aiPeaceTarget(s, "militarist", weary, 3)).toBe(5);
    // One open offer at a time.
    addOffer(s, 9);
    expect(aiPeaceTarget(s, "militarist", weary, null)).toBeNull();
  });
});

describe("GrandStrategyExecution peace", () => {
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
    // Split the land so both sides have room to lose some.
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

  /** a takes three of b's tiles, as a won attack would. */
  function fight() {
    const gs = grandStrategyOf(game)!;
    const tiles = [...b.tiles()].slice(0, 3);
    for (const t of tiles) {
      a.conquer(t);
      gs.onConquer(a, b);
    }
    expect(b.isAlive()).toBe(true);
  }

  test("conquest makes a war; losses raise weariness", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    expect(gs.peaceOf(a)!.enemies[0]?.target).toBe(b.smallID());
    expect(gs.peaceOf(b)!.enemies[0]?.lost).toBeGreaterThan(0);
    // Weariness is judged at the next second boundary.
    const pa = gs.peaceOf(a)!;
    const pb = gs.peaceOf(b)!;
    pa.lossesThisSecond += Math.floor(game.config().maxTroops(a) / 10);
    pb.tilesLostThisSecond += Math.floor(b.numTilesOwned() / 10);
    seconds(1);
    expect(gs.stateOf(a)!.weariness).toBeGreaterThan(0);
    expect(gs.stateOf(b)!.weariness).toBeGreaterThan(0);
  });

  test("peace intent: offer, accept, truce blocks attacks both ways", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    // Not at war with a stranger: refused.
    expect(gs.offerPeace(a, a)).toBe("invalid_target");
    game.addExecution(new PeaceExecution(a, b.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(gs.peaceOf(a)!.offers.map((o) => o.target)).toEqual([b.smallID()]);
    game.addExecution(new PeaceExecution(b, a.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(hasTruce(gs.peaceOf(a)!, b.smallID())).toBe(true);
    expect(hasTruce(gs.peaceOf(b)!, a.smallID())).toBe(true);
    expect(game.config().isAttackLocked(a, b)).toBe(true);
    expect(game.config().isAttackLocked(b, a)).toBe(true);
    expect(a.canAttackPlayer(b)).toBe(false);
    const tiles = b.numTilesOwned();
    game.addExecution(new AttackExecution(a.troops() * 0.5, a, b.id()));
    seconds(1);
    expect(b.numTilesOwned()).toBe(tiles);
    expect(a.outgoingAttacks().length).toBe(0);
    // The truce ends on time and attacks work again.
    seconds(TRUCE_MAX_LOCK + TRUCE_BREAKABLE_SECONDS);
    expect(game.config().isAttackLocked(a, b)).toBe(false);
  });

  test("a truce signed mid-attack makes the attack retreat", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    game.addExecution(new AttackExecution(30, a, b.id()));
    game.executeNextTick();
    expect(a.outgoingAttacks().length).toBeGreaterThan(0);
    gs.offerPeace(b, a);
    gs.offerPeace(a, b);
    for (let i = 0; i < 5; i++) game.executeNextTick();
    expect(a.outgoingAttacks().filter((x) => !x.retreating()).length).toBe(0);
  });

  test("capitulation to a human: a surrender it may accept or ignore", () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    const pb = gs.peaceOf(b)!;
    // Pretend b used to be far bigger than now.
    pb.peakTiles = Math.max(b.numTilesOwned() * 3, game.numLandTiles());
    const taken = a.numTilesOwned();
    const ups = seconds(1);
    // No automatic truce: a (human) is offered b's surrender.
    expect(hasTruce(pb, a.smallID())).toBe(false);
    expect(hasSurrendered(pb, a.smallID())).toBe(true);
    const up = ups
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === a.id())
      .at(-1)!;
    expect(up.surrendersToMe).toEqual([b.id()]);
    expect(up.peaceOffersToMe).toEqual([b.id()]);
    // Ignored, it lapses and the war goes on; no second offer at once.
    seconds(OFFER_SECONDS + 1);
    expect(hasSurrendered(pb, a.smallID())).toBe(false);
    expect(hasTruce(pb, a.smallID())).toBe(false);
    // Another big loss: a surrender again, and accepting it seals it.
    pb.peakTiles = Math.max(b.numTilesOwned() * 3, game.numLandTiles());
    fight();
    seconds(1);
    expect(hasSurrendered(pb, a.smallID())).toBe(true);
    expect(gs.offerPeace(a, b)).toBe("accepted");
    expect(hasTruce(pb, a.smallID())).toBe(true);

    expect(pb.peakTiles).toBe(b.numTilesOwned());
    expect(a.numTilesOwned()).toBeGreaterThanOrEqual(taken - 1);
  });

  test("ablated: no weariness, wars, truces or lock", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("weariness");
    seconds(1);
    fight();
    seconds(1);
    expect(gs.stateOf(a)!.weariness ?? 0).toBe(0);
    expect(gs.peaceOf(a)!.enemies).toEqual([]);
    expect(gs.offerPeace(a, b)).toBe("disabled");
    gs.peaceOf(a)!.truces.push({ target: b.smallID(), seconds: 100, lock: 50 });
    expect(game.config().isAttackLocked(a, b)).toBe(false);
  });

  test("snapshot round trip keeps weariness, wars, truces and offers", async () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    fight();
    gs.stateOf(a)!.weariness = 123_456;
    gs.peaceOf(a)!.truces.push({ target: 99, seconds: 42, lock: 7 });
    gs.peaceOf(b)!.offers.push({ target: a.smallID(), seconds: 17 });
    const { bytes, restored, again } = await roundTrip(game, "ocean_and_land");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    const rgs = grandStrategyOf(restored)!;
    const ra = restored.player(a.id());
    const rb = restored.player(b.id());
    expect(rgs.stateOf(ra)!.weariness).toBe(123_456);
    expect(rgs.peaceOf(ra)!.truces).toEqual([
      { target: 99, seconds: 42, lock: 7 },
    ]);
    expect(rgs.peaceOf(rb)!.offers).toEqual([
      { target: a.smallID(), seconds: 17 },
    ]);
    expect(rgs.peaceOf(ra)!.enemies.length).toBe(1);
    // The truce lock is installed again after a restore.
    rgs.peaceOf(ra)!.truces.push({ target: rb.smallID(), seconds: 5, lock: 0 });
    expect(restored.config().isAttackLocked(rb, ra)).toBe(true);
  });
});

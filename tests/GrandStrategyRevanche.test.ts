import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import { modifiersOf } from "@openfront/engine-lib/game/GrandStrategy";
import {
  addTruce,
  advanceWeariness,
  BREAK_PP_COST,
  hasTruce,
  newPeaceState,
  truceWith,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import {
  addRevanche,
  advanceRevanche,
  AI_REVANCHE_STRENGTH,
  aiSeeksRevanche,
  canRevancheBreak,
  MAX_REVANCHE,
  payRevanche,
  RECOVERY_MANPOWER,
  RECOVERY_POLITICAL_POWER,
  recovering,
  REVANCHE_ATTACK_LOSS,
  REVANCHE_BREAK_PP,
  REVANCHE_SECONDS,
  revancheOf,
  revancheOn,
  revancheWait,
} from "@openfront/engine-lib/game/GrandStrategyRevanche";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { diffSnapshots, roundTrip } from "./util/Snapshot";

describe("revanche rules (M7C stage 2)", () => {
  test("a claim needs a real loss; repeat losses top it up", () => {
    const s = newPeaceState();
    expect(addRevanche(s, 7, 99, 1000, 300)).toBe(false);
    expect(revancheOf(s)).toEqual([]);
    expect(addRevanche(s, 7, 100, 1000, 300)).toBe(true);
    expect(revancheOn(s, 7)).toEqual({
      target: 7,
      tiles: 100,
      seconds: REVANCHE_SECONDS,
      lock: 300,
    });
    advanceRevanche(s);
    expect(addRevanche(s, 7, 150, 1000, 200)).toBe(true);
    expect(revancheOn(s, 7)).toEqual({
      target: 7,
      tiles: 250,
      seconds: REVANCHE_SECONDS,
      lock: 200,
    });
  });

  test("at most MAX_REVANCHE claims, the biggest kept", () => {
    const s = newPeaceState();
    for (let t = 1; t <= MAX_REVANCHE + 1; t++) {
      addRevanche(s, t, 100 + t, 1000, 120);
    }
    expect(revancheOf(s)).toHaveLength(MAX_REVANCHE);
    expect(revancheOn(s, 1)).toBeUndefined();
  });

  test("claims expire and are paid down by retaken land", () => {
    const s = newPeaceState();
    addRevanche(s, 3, 200, 1000, 120);
    payRevanche(s, 3, 50);
    expect(revancheOn(s, 3)?.tiles).toBe(150);
    payRevanche(s, 9, 1000);
    payRevanche(s, 3, 150);
    expect(revancheOn(s, 3)).toBeUndefined();
    addRevanche(s, 3, 200, 1000, 120);
    for (let i = 0; i < REVANCHE_SECONDS - 1; i++) advanceRevanche(s);
    expect(revancheOn(s, 3)?.seconds).toBe(1);
    advanceRevanche(s);
    expect(revancheOn(s, 3)).toBeUndefined();
  });

  test("revanche break after half the lock; recovering while the truce holds", () => {
    const a = newPeaceState();
    const b = newPeaceState();
    addTruce(a, 1, b, 2, 300);
    expect(canRevancheBreak(b, 1)).toBe("no_claim");
    addRevanche(b, 1, 400, 1000, 300);
    expect(recovering(b)).toBe(true);
    expect(recovering(a)).toBe(false);
    expect(canRevancheBreak(b, 1)).toBe("locked");
    expect(revancheWait(b, 1)).toBe(150);
    truceWith(b, 1)!.lock = 150;
    expect(canRevancheBreak(b, 1)).toBe("ok");
    expect(revancheWait(b, 1)).toBe(0);
    b.truces = [];
    expect(canRevancheBreak(b, 1)).toBe("no_truce");
    expect(recovering(b)).toBe(false);
  });

  test("AI seeks revanche with far less edge than a plain break", () => {
    const base = {
      strengthPermille: AI_REVANCHE_STRENGTH.militarist,
      weariness: 0,
      wars: 0,
      canPay: true,
      borders: true,
    };
    expect(aiSeeksRevanche("militarist", base)).toBe(true);
    expect(
      aiSeeksRevanche("militarist", { ...base, strengthPermille: 699 }),
    ).toBe(false);
    expect(aiSeeksRevanche("defender", base)).toBe(false);
    expect(aiSeeksRevanche("militarist", { ...base, wars: 2 })).toBe(false);
    expect(aiSeeksRevanche("militarist", { ...base, canPay: false })).toBe(
      false,
    );
    expect(aiSeeksRevanche("militarist", { ...base, weariness: 400 })).toBe(
      false,
    );
  });

  test("rally: extra weariness recovery only in seconds without gain", () => {
    const quiet = {
      attackLosses: 0,
      maxTroops: 1000,
      tilesLost: 0,
      peakTiles: 100,
      tilesOwned: 100,
      numLandTiles: 1000,
      occupied: 0,
      longWars: 0,
      atWar: false,
    };
    const plain = advanceWeariness(100_000, quiet);
    const rally = advanceWeariness(100_000, { ...quiet, extraRecovery: 4000 });
    expect(plain - rally).toBe(4000);
    const hit = { ...quiet, tilesLost: 10 };
    expect(advanceWeariness(100_000, { ...hit, extraRecovery: 4000 })).toBe(
      advanceWeariness(100_000, hit),
    );
  });
});

describe("GrandStrategyExecution revanche", () => {
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

  /** a takes land from b until b capitulates. */
  function capitulate() {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    for (const t of [...b.tiles()].slice(0, 3)) {
      a.conquer(t);
      gs.onConquer(a, b);
    }
    const pb = gs.peaceOf(b)!;
    pb.peakTiles = Math.max(b.numTilesOwned() * 3, game.numLandTiles());
    return seconds(1);
  }

  test("capitulation leaves the loser a claim and a recovery rally", () => {
    const gs = grandStrategyOf(game)!;
    const ups = capitulate();
    const pb = gs.peaceOf(b)!;
    expect(hasTruce(pb, a.smallID())).toBe(true);
    const claim = revancheOn(pb, a.smallID())!;
    expect(claim.tiles).toBeGreaterThan(0);
    expect(claim.lock).toBe(truceWith(pb, a.smallID())!.lock);
    expect(revancheOf(gs.peaceOf(a)!)).toEqual([]);
    seconds(1);
    const sb = gs.stateOf(b)!;
    expect(sb.recovering).toBe(true);
    expect(gs.stateOf(a)!.recovering).toBe(false);
    const rallied = modifiersOf(sb);
    const plain = modifiersOf({ ...sb, recovering: false });
    expect(rallied.manpower - plain.manpower).toBe(RECOVERY_MANPOWER);
    expect(rallied.politicalPower - plain.politicalPower).toBe(
      RECOVERY_POLITICAL_POWER,
    );
    // HUD update for the human loser.
    const mine = [...ups, ...seconds(1)]
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === b.id());
    const last = mine[mine.length - 1];
    expect(last.recovering).toBe(true);
    expect(last.revanche?.[0]?.target).toBe(a.id());
    expect(last.revanche?.[0]?.wait).toBeGreaterThan(0);
  });

  test("only the claimant may break early, cheaply, and gets the war goal", () => {
    const gs = grandStrategyOf(game)!;
    capitulate();
    const pa = gs.peaceOf(a)!;
    const pb = gs.peaceOf(b)!;
    const claim = revancheOn(pb, a.smallID())!;
    expect(gs.breakTruce(b, a)).toBe("locked");
    const half = Math.floor(claim.lock / 2);
    truceWith(pa, b.smallID())!.lock = half;
    truceWith(pb, a.smallID())!.lock = half;
    // The winner still waits for the full lock.
    gs.stateOf(a)!.politicalPower = BREAK_PP_COST * 2;
    expect(gs.breakTruce(a, b)).toBe("locked");
    const sb = gs.stateOf(b)!;
    sb.politicalPower = REVANCHE_BREAK_PP - 1;
    expect(gs.breakTruce(b, a)).toBe("no_political_power");
    sb.politicalPower = REVANCHE_BREAK_PP + 7000;
    sb.warSupport = 600;
    sb.weariness = 50_000;
    const msgs: string[] = [];
    expect(gs.breakTruce(b, a)).toBe("broken");
    expect(sb.politicalPower).toBe(7000);
    expect(sb.warSupport).toBe(600);
    expect(sb.weariness).toBe(50_000);
    // M7E: a revanche break is justified, so no traitor mark.
    expect(b.isTraitor()).toBe(false);
    expect(hasTruce(pa, b.smallID())).toBe(false);
    expect(game.config().isAttackLocked(a, b)).toBe(false);
    expect(gs.warOf(b)!.warGoals.some((g) => g.target === a.smallID())).toBe(
      true,
    );
    expect(gs.warOf(a)!.warGoals.some((g) => g.target === b.smallID())).toBe(
      false,
    );
    const ev = game
      .executeNextTick()
      [GameUpdateType.DisplayEvent]?.filter(
        (e) => e.messageType === MessageType.GS_DIPLOMACY,
      )
      .map((e) => e.message);
    msgs.push(...(ev ?? []));
    // The claim stays until paid or expired; retaking land pays it down.
    const before = revancheOn(pb, a.smallID())!.tiles;
    const t = [...a.tiles()][0];
    b.conquer(t);
    gs.onConquer(b, a);
    expect(revancheOn(pb, a.smallID())!.tiles).toBe(before - 1);
  });

  test("attacking the claim's target costs fewer troops", () => {
    const gs = grandStrategyOf(game)!;
    capitulate();
    const withClaim = gs.adjustCombat(b, a, 1000, 100, 100);
    gs.peaceOf(b)!.revanche = [];
    const without = gs.adjustCombat(b, a, 1000, 100, 100);
    expect(withClaim.attackerTroopLoss).toBeCloseTo(
      (without.attackerTroopLoss * (1000 + REVANCHE_ATTACK_LOSS)) / 1000,
      9,
    );
  });

  test("ablated: no claims, no rally, plain break rules", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("revanche");
    capitulate();
    expect(revancheOf(gs.peaceOf(b)!)).toEqual([]);
    expect(gs.stateOf(b)!.recovering).toBeUndefined();
    expect(gs.breakTruce(b, a)).toBe("locked");
  });

  test("snapshot keeps claims and the rally; v11 migrates to none", async () => {
    const gs = grandStrategyOf(game)!;
    capitulate();
    seconds(1);
    const claim = { ...revancheOn(gs.peaceOf(b)!, a.smallID())! };
    const { bytes, restored, again } = await roundTrip(game, "ocean_and_land");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    const rgs = grandStrategyOf(restored)!;
    const rb = restored.player(b.id());
    expect(revancheOn(rgs.peaceOf(rb)!, a.smallID())).toEqual(claim);
    expect(rgs.stateOf(rb)!.recovering).toBe(true);
    const migrated = GrandStrategyExecutionSnapshot.migrations[11]({
      initialized: true,
      states: [{ id: 1 }],
    }) as { states: { revanche: unknown[]; recovering: boolean }[] };
    expect(migrated.states[0].revanche).toEqual([]);
    expect(migrated.states[0].recovering).toBe(false);
  });
});

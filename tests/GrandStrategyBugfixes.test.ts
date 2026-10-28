import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  advanceSecond,
  aiProductionLine,
  canSetLaw,
  modifiersOf,
  newNationState,
  takeAction,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  hasTruce,
  truceWith,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import { revancheOn } from "@openfront/engine-lib/game/GrandStrategyRevanche";
import {
  GrandStrategyExecution,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

const input = {
  factoryStructureLevels: 0,
  tilesOwned: 0,
  maxTroops: 1000,
  troops: 1000,
};

describe("bug hunt fixes: core rules", () => {
  test("AI stops sending output to artillery once guns cover the army", () => {
    const s = newNationState(1000);
    s.artillery = 1000;
    expect(aiProductionLine(s, "industrialist", 1000)).toBe("line_infantry");
    s.artillery = 500;
    expect(aiProductionLine(s, "industrialist", 1000)).toBe("line_artillery");
  });

  test("a lower troop cap never scraps artillery already built", () => {
    const s = newNationState(2000);
    s.artillery = 1000;
    advanceSecond(s, { ...input, maxTroops: 500, troops: 500 });
    expect(s.artillery).toBe(1000);
  });

  test("Assembly can always step back to laws that need no war support", () => {
    const s = newNationState(0);
    s.ideology = "assembly";
    s.warSupport = 60;
    s.politicalPower = 400_000;
    s.conscriptionLaw = "extensive_conscription";
    s.economyLaw = "partial_mobilization";
    expect(canSetLaw(s, "limited_conscription")).toBe("ok");
    expect(canSetLaw(s, "volunteer_only")).toBe("ok");
    expect(canSetLaw(s, "civilian_economy_law")).toBe("ok");
    // Real requirements still carry the offset.
    s.warSupport = 450;
    expect(canSetLaw(s, "extensive_conscription")).toBe("active");
    expect(canSetLaw(s, "war_economy_law")).toBe("low_war_support");
  });

  test("a 60 s decision boosts exactly 60 production seconds", () => {
    const s = newNationState(0);
    s.politicalPower = 400_000;
    expect(takeAction(s, "emergency_production")).toBe("ok");
    let boosted = 0;
    for (let i = 0; i < 70; i++) {
      if (
        modifiersOf(s).production >
        modifiersOf({ ...s, activeDecisions: [] }).production
      ) {
        boosted++;
      }
      advanceSecond(s, { ...input, maxTroops: 1e9 });
    }
    expect(boosted).toBe(60);
  });
});

describe("bug hunt fixes: diplomacy", () => {
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
    for (let i = 0; i < n * 10; i++) game.executeNextTick();
  }

  function capitulate() {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    for (const t of [...b.tiles()].slice(0, 3)) {
      a.conquer(t);
      gs.onConquer(a, b);
    }
    gs.peaceOf(b)!.peakTiles = Math.max(
      b.numTilesOwned() * 3,
      game.numLandTiles(),
    );
    seconds(1);
  }

  test("an old revanche claim cannot fast-break a later truce", () => {
    const gs = grandStrategyOf(game)!;
    capitulate();
    const pa = gs.peaceOf(a)!;
    const pb = gs.peaceOf(b)!;
    expect(revancheOn(pb, a.smallID())!.lock).toBeGreaterThan(0);
    // The truce goes, then a second, even peace (no land lost: no refresh).
    pa.truces = [];
    pb.truces = [];
    (
      gs as unknown as { makePeace(x: Player, y: Player, w: string): void }
    ).makePeace(a, b, "peace");
    expect(hasTruce(pb, a.smallID())).toBe(true);
    const lock = truceWith(pb, a.smallID())!.lock;
    expect(lock).toBeGreaterThan(0);
    gs.stateOf(b)!.politicalPower = 400_000;
    expect(gs.breakTruce(b, a)).toBe("locked");
  });

  test("war goals, truces and claims against an eliminated player go", () => {
    const gs = grandStrategyOf(game)!;
    capitulate();
    gs.warOf(a)!.warGoals.push({ target: b.smallID(), seconds: 600 });
    expect(revancheOn(gs.peaceOf(b)!, a.smallID())).toBeDefined();
    // a takes everything b has.
    for (const t of [...b.tiles()]) a.conquer(t);
    seconds(2);
    expect(b.isAlive()).toBe(false);
    expect(gs.warOf(a)!.warGoals.some((g) => g.target === b.smallID())).toBe(
      false,
    );
    expect(hasTruce(gs.peaceOf(a)!, b.smallID())).toBe(false);
    expect(gs.peaceOf(a)!.enemies.some((e) => e.target === b.smallID())).toBe(
      false,
    );
  });
});

describe("bug hunt fixes: factions", () => {
  test("an AI nation cannot join a faction with a human member", async () => {
    const game = await setup("big_plains", { infiniteGold: true });
    const gameID: GameID = "game_id";
    game.addPlayer(new PlayerInfo("H", PlayerType.Human, null, "H_id"));
    game.addPlayer(new PlayerInfo("N", PlayerType.Nation, null, "N_id"));
    game.addExecution(
      new SpawnExecution(gameID, game.player("H_id").info(), game.ref(20, 20)),
      new SpawnExecution(gameID, game.player("N_id").info(), game.ref(60, 20)),
      new GrandStrategyExecution(),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    const gs = grandStrategyOf(game)!;
    const h = game.player("H_id");
    const n = game.player("N_id");
    for (const [p, x] of [
      [h, 20],
      [n, 60],
    ] as const) {
      for (let dx = 0; dx < 5; dx++) {
        const t = game.ref(x + dx, 20);
        if (!game.hasOwner(t)) p.conquer(t);
      }
    }
    game.executeNextTick();
    (gs as unknown as { factions: unknown[] }).factions = [
      { leader: h.smallID(), members: [h.smallID()], calls: [] },
    ];
    expect(gs.joinCheck(n, h)).toBe("invite_only");
    (gs as unknown as { factions: unknown[] }).factions = [
      { leader: n.smallID(), members: [n.smallID()], calls: [] },
    ];
    // A human may still join a nation's faction (other rules permitting).
    expect(gs.joinCheck(h, n)).not.toBe("invite_only");
  });
});

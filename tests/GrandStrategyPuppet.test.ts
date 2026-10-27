import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import { aiPersonalityFor } from "@openfront/engine-lib/game/GrandStrategy";
import {
  hasTruce,
  truceWith,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import {
  addWindow,
  advanceAutonomy,
  advanceWindows,
  aiPrefersPuppet,
  AUTONOMY_MAX,
  canDeclareIndependence,
  canPuppet,
  INDEPENDENCE_LOCK,
  INDEPENDENCE_PP,
  PUPPET_MAX_BLOC_SHARE,
  PUPPET_MAX_PER_OVERLORD,
  PUPPET_PP,
  PUPPET_TRIBUTE,
  PUPPET_WINDOW,
  type PuppetInput,
  puppetJoinsWar,
  TRIBUTE_FADE_SHARE,
  tributeOf,
  tributePermille,
  WAR_JOIN_MAX_WEARINESS,
} from "@openfront/engine-lib/game/GrandStrategyPuppet";
import { revancheOn } from "@openfront/engine-lib/game/GrandStrategyRevanche";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { PuppetExecution } from "@openfront/engine/execution/PuppetExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { diffSnapshots, roundTrip } from "./util/Snapshot";

const input: PuppetInput = {
  demanderIsPuppet: false,
  targetIsPuppet: false,
  window: true,
  demanderTiles: 1000,
  targetTiles: 500,
  puppets: 0,
  blocShare: 100,
  targetShare: 50,
  politicalPower: PUPPET_PP,
};

describe("puppet rules (M7 stage D)", () => {
  test("puppeting needs a window, PP, a smaller target and room in the bloc", () => {
    expect(canPuppet(input)).toBe("ok");
    expect(canPuppet({ ...input, window: false })).toBe("not_puppetable");
    expect(canPuppet({ ...input, demanderIsPuppet: true })).toBe("is_puppet");
    expect(canPuppet({ ...input, targetIsPuppet: true })).toBe(
      "already_puppet",
    );
    expect(canPuppet({ ...input, targetTiles: 751 })).toBe("too_big");
    expect(canPuppet({ ...input, targetTiles: 750 })).toBe("ok");
    expect(canPuppet({ ...input, puppets: PUPPET_MAX_PER_OVERLORD })).toBe(
      "too_many",
    );
    expect(canPuppet({ ...input, blocShare: PUPPET_MAX_BLOC_SHARE - 49 })).toBe(
      "bloc_too_big",
    );
    expect(canPuppet({ ...input, politicalPower: PUPPET_PP - 1 })).toBe(
      "no_political_power",
    );
  });

  test("tribute shrinks as the overlord's bloc grows and with autonomy", () => {
    expect(tributePermille(0, 0)).toBe(PUPPET_TRIBUTE);
    expect(tributePermille(TRIBUTE_FADE_SHARE / 2, 0)).toBe(PUPPET_TRIBUTE / 2);
    expect(tributePermille(TRIBUTE_FADE_SHARE, 0)).toBe(0);
    expect(tributePermille(900, 0)).toBe(0);
    expect(tributePermille(0, AUTONOMY_MAX)).toBe(PUPPET_TRIBUTE / 2);
    // Monotone in both inputs.
    for (let s = 0; s < 400; s += 37) {
      expect(tributePermille(s + 37, 0)).toBeLessThanOrEqual(
        tributePermille(s, 0),
      );
      expect(tributePermille(s, 500)).toBeLessThanOrEqual(
        tributePermille(s, 0),
      );
    }
    expect(tributeOf(999, 250)).toBe(249);
    expect(tributeOf(-5, 250)).toBe(0);
    expect(tributeOf(100, 0)).toBe(0);
  });

  test("autonomy builds faster under a weary, dominant or small overlord", () => {
    const calm = {
      overlordWeariness: 0,
      overlordIsCoalitionTarget: false,
      puppetTiles: 100,
      overlordTiles: 1000,
    };
    expect(advanceAutonomy(0, calm)).toBe(1);
    expect(advanceAutonomy(0, { ...calm, overlordWeariness: 300 })).toBe(3);
    expect(
      advanceAutonomy(0, { ...calm, overlordIsCoalitionTarget: true }),
    ).toBe(3);
    expect(advanceAutonomy(0, { ...calm, puppetTiles: 500 })).toBe(3);
    expect(advanceAutonomy(AUTONOMY_MAX, calm)).toBe(AUTONOMY_MAX);
  });

  test("independence: full autonomy, a very weary overlord, or more troops", () => {
    const base = {
      isPuppet: true,
      autonomy: 0,
      overlordWeariness: 0,
      puppetTroops: 100,
      overlordTroops: 1000,
      politicalPower: INDEPENDENCE_PP,
    };
    expect(canDeclareIndependence(base)).toBe("too_early");
    expect(canDeclareIndependence({ ...base, isPuppet: false })).toBe(
      "not_puppet",
    );
    expect(canDeclareIndependence({ ...base, autonomy: AUTONOMY_MAX })).toBe(
      "ok",
    );
    expect(canDeclareIndependence({ ...base, overlordWeariness: 500 })).toBe(
      "ok",
    );
    expect(canDeclareIndependence({ ...base, puppetTroops: 1000 })).toBe("ok");
    expect(
      canDeclareIndependence({
        ...base,
        autonomy: AUTONOMY_MAX,
        politicalPower: INDEPENDENCE_PP - 1,
      }),
    ).toBe("no_political_power");
  });

  test("AI: industrialists puppet, militarists annex, defenders when worth it", () => {
    expect(aiPrefersPuppet("industrialist", 10, 1000)).toBe(true);
    expect(aiPrefersPuppet("militarist", 900, 1000)).toBe(false);
    expect(aiPrefersPuppet("defender", 250, 1000)).toBe(true);
    expect(aiPrefersPuppet("defender", 249, 1000)).toBe(false);
  });

  test("puppets join wars only when fresh and not busy; windows expire", () => {
    expect(puppetJoinsWar({ weariness: 0, wars: 0, blocked: false })).toBe(
      true,
    );
    expect(
      puppetJoinsWar({
        weariness: WAR_JOIN_MAX_WEARINESS,
        wars: 0,
        blocked: false,
      }),
    ).toBe(false);
    expect(puppetJoinsWar({ weariness: 0, wars: 2, blocked: false })).toBe(
      false,
    );
    expect(puppetJoinsWar({ weariness: 0, wars: 0, blocked: true })).toBe(
      false,
    );
    let w = addWindow([], 4);
    w = addWindow(w, 4);
    expect(w).toEqual([{ target: 4, seconds: PUPPET_WINDOW }]);
    for (let i = 0; i < PUPPET_WINDOW - 1; i++) w = advanceWindows(w);
    expect(w).toEqual([{ target: 4, seconds: 1 }]);
    expect(advanceWindows(w)).toEqual([]);
  });
});

describe("GrandStrategyExecution puppets", () => {
  let game: Game;
  let a: Player;
  let b: Player;
  let c: Player;
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("big_plains", { instantBuild: true });
    const infos = ["A", "B", "C"].map(
      (n) => new PlayerInfo(n, PlayerType.Human, null, `${n}_id`),
    );
    for (const i of infos) game.addPlayer(i);
    game.addExecution(
      new SpawnExecution(gameID, game.player("A_id").info(), game.ref(20, 20)),
      new SpawnExecution(gameID, game.player("B_id").info(), game.ref(60, 20)),
      new SpawnExecution(gameID, game.player("C_id").info(), game.ref(40, 60)),
      new GrandStrategyExecution(),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();
    a = game.player("A_id");
    b = game.player("B_id");
    c = game.player("C_id");
    // A is the big one: a block of extra land.
    for (let x = 0; x < 30; x++) {
      for (let y = 80; y < 110; y++) {
        const t = game.ref(x, y);
        if (game.isLand(t) && !game.hasOwner(t)) a.conquer(t);
      }
    }
    const gs = grandStrategyOf(game)!;
    for (const p of [a, b, c]) gs.stateOf(p)!.politicalPower = 400_000;
  });

  function seconds(n: number) {
    const all: ReturnType<Game["executeNextTick"]>[] = [];
    for (let i = 0; i < n * 10; i++) all.push(game.executeNextTick());
    return all;
  }

  function messages(ups: ReturnType<Game["executeNextTick"]>[]): string[] {
    return ups.flatMap((u) =>
      (u[GameUpdateType.DisplayEvent] ?? [])
        .filter((e) => e.messageType === MessageType.GS_DIPLOMACY)
        .map((e) => e.message),
    );
  }

  function lastUpdate(ups: ReturnType<Game["executeNextTick"]>[], id: string) {
    return ups
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === id)
      .at(-1)!;
  }

  /** `winner` takes land from `loser` until it capitulates. */
  function capitulate(winner: Player, loser: Player) {
    const gs = grandStrategyOf(game)!;
    for (const t of [...loser.tiles()].slice(0, 3)) {
      winner.conquer(t);
      gs.onConquer(winner, loser);
    }
    gs.peaceOf(loser)!.peakTiles = Math.max(
      loser.numTilesOwned() * 3,
      game.numLandTiles(),
    );
    return seconds(1);
  }

  /** B becomes A's puppet through a capitulation. */
  function puppetB() {
    capitulate(a, b);
    expect(grandStrategyOf(game)!.demandPuppet(a, b)).toBe("ok");
  }

  test("a capitulation opens a puppet window; puppeting replaces the truce", () => {
    const gs = grandStrategyOf(game)!;
    expect(gs.demandPuppet(a, b)).toBe("not_puppetable");
    const ups = capitulate(a, b);
    expect(messages(ups)).toContain("events_display.gs_puppet_window");
    expect(hasTruce(gs.peaceOf(b)!, a.smallID())).toBe(true);
    expect(revancheOn(gs.peaceOf(b)!, a.smallID())).toBeDefined();
    expect(lastUpdate(ups, a.id()).puppetWindows).toEqual([
      expect.objectContaining({ target: b.id(), check: "ok" }),
    ]);
    // Only the winner holds the window.
    expect(gs.demandPuppet(b, a)).toBe("not_puppetable");
    const pp = gs.stateOf(a)!.politicalPower;
    expect(gs.demandPuppet(a, b)).toBe("ok");
    expect(gs.stateOf(a)!.politicalPower).toBe(pp - PUPPET_PP);
    expect(gs.overlordOf(b)).toBe(a.smallID());
    expect(gs.puppetsOf(a.smallID())).toEqual([b.smallID()]);
    expect(hasTruce(gs.peaceOf(b)!, a.smallID())).toBe(false);
    expect(revancheOn(gs.peaceOf(b)!, a.smallID())).toBeUndefined();
    expect(gs.stateOf(a)!.puppetWindows).toEqual([]);
    // Bonded: no attacks either way, no war goals between them.
    expect(game.config().isAttackLocked(a, b)).toBe(true);
    expect(game.config().isAttackLocked(b, a)).toBe(true);
    expect(a.canAttackPlayer(b)).toBe(false);
    expect(gs.justifyWar(b, a)).not.toBe("ok");
    expect(gs.justifyWar(a, b)).not.toBe("ok");
    expect(gs.demandPuppet(a, b)).toBe("already_puppet");
    expect(gs.demandPuppet(b, c)).toBe("is_puppet");
  });

  test("the window closes after PUPPET_WINDOW seconds; size and PP limits", () => {
    const gs = grandStrategyOf(game)!;
    capitulate(a, b);
    gs.stateOf(a)!.politicalPower = PUPPET_PP - 1;
    expect(gs.demandPuppet(a, b)).toBe("no_political_power");
    gs.stateOf(a)!.politicalPower = 400_000;
    seconds(PUPPET_WINDOW);
    expect(gs.demandPuppet(a, b)).toBe("not_puppetable");
    // A beaten nation bigger than 75% of the winner cannot be puppeted.
    gs.stateOf(c)!.puppetWindows = [{ target: a.smallID(), seconds: 30 }];
    expect(gs.demandPuppet(c, a)).toBe("too_big");
  });

  test("tribute: gold, manpower and political power go to the overlord", () => {
    const gs = grandStrategyOf(game)!;
    puppetB();
    const share = Math.floor(
      ((a.numTilesOwned() + b.numTilesOwned()) * 1000) / game.numLandTiles(),
    );
    const permille = tributePermille(share, 0);
    expect(permille).toBeGreaterThan(0);
    // Untaxed values: the same calls with the bond lifted for a moment.
    const sb = gs.stateOf(b)!;
    delete sb.overlord;
    const plainGold = gs.adjustGold(b, 1000n);
    const plainTroops = gs.adjustTroopGrowth(b, 1000, 1e9);
    sb.overlord = a.smallID();
    const goldTax = (plainGold * BigInt(permille)) / 1000n;
    expect(goldTax).toBeGreaterThan(0n);
    const gold = a.gold();
    expect(gs.adjustGold(b, 1000n)).toBe(plainGold - goldTax);
    expect(a.gold() - gold).toBe(goldTax);
    a.setTroops(1000);
    const troops = a.troops();
    const troopTax = tributeOf(Math.floor(plainTroops), permille);
    expect(troopTax).toBeGreaterThan(0);
    expect(gs.adjustTroopGrowth(b, 1000, 1e9)).toBe(plainTroops - troopTax);
    expect(a.troops() - troops).toBe(troopTax);
    for (const p of [a, b, c]) gs.stateOf(p)!.politicalPower = 0;
    seconds(1);
    const pa = gs.stateOf(a)!.politicalPower;
    const pb = gs.stateOf(b)!.politicalPower;
    const pc = gs.stateOf(c)!.politicalPower;
    expect(pb).toBeLessThan(pc);
    expect(pa + pb).toBe(2 * pc);
    const up = lastUpdate(seconds(1), b.id());
    expect(up.overlord).toBe(a.id());
    expect(up.tribute).toBe(
      tributePermille(
        Math.floor(
          ((a.numTilesOwned() + b.numTilesOwned()) * 1000) /
            game.numLandTiles(),
        ),
        gs.stateOf(b)!.autonomy!,
      ),
    );
  });

  test("autonomy builds; independence when allowed, with a truce", () => {
    const gs = grandStrategyOf(game)!;
    puppetB();
    expect(gs.declareIndependence(b)).toBe("too_early");
    expect(gs.declareIndependence(a)).toBe("not_puppet");
    a.setTroops(1_000_000);
    b.setTroops(10);
    seconds(5);
    const autonomy = gs.stateOf(b)!.autonomy!;
    expect(autonomy).toBeGreaterThanOrEqual(5);
    let up = lastUpdate(seconds(1), b.id());
    expect(up.independence).toBe("too_early");
    expect(up.autonomy).toBeGreaterThan(autonomy);
    gs.stateOf(b)!.autonomy = AUTONOMY_MAX;
    const pp = gs.stateOf(b)!.politicalPower;
    expect(gs.declareIndependence(b)).toBe("ok");
    expect(gs.stateOf(b)!.politicalPower).toBe(pp - INDEPENDENCE_PP);
    expect(gs.overlordOf(b)).toBeUndefined();
    expect(gs.stateOf(b)!.autonomy).toBe(0);
    expect(truceWith(gs.peaceOf(b)!, a.smallID())?.lock).toBe(
      INDEPENDENCE_LOCK,
    );
    up = lastUpdate(seconds(1), b.id());
    expect(up.overlord).toBeNull();
  });

  test("a very weary overlord lets its puppet go at once", () => {
    const gs = grandStrategyOf(game)!;
    puppetB();
    a.setTroops(1_000_000);
    b.setTroops(10);
    gs.stateOf(a)!.weariness = 600_000;
    expect(gs.independenceCheck(b)).toBe("ok");
  });

  test("release, and losing the overlord, free the puppet", () => {
    const gs = grandStrategyOf(game)!;
    puppetB();
    expect(gs.releasePuppet(c, b)).toBe("invalid_target");
    expect(gs.releasePuppet(a, b)).toBe("ok");
    expect(gs.overlordOf(b)).toBeUndefined();
    expect(hasTruce(gs.peaceOf(a)!, b.smallID())).toBe(true);
    // The overlord dies: the puppet is free at the next second.
    gs.stateOf(b)!.overlord = a.smallID();
    for (const t of [...a.tiles()]) c.conquer(t);
    expect(a.isAlive()).toBe(false);
    seconds(1);
    expect(gs.overlordOf(b)).toBeUndefined();
  });

  test("no chains: puppeting an overlord frees its puppets", () => {
    const gs = grandStrategyOf(game)!;
    puppetB();
    // C beats A and may puppet it (size limit off for the test: C grows).
    for (let x = 60; x < 100; x++) {
      for (let y = 80; y < 140; y++) {
        const t = game.ref(x, y);
        if (game.isLand(t) && !game.hasOwner(t)) c.conquer(t);
      }
    }
    gs.stateOf(c)!.puppetWindows = [{ target: a.smallID(), seconds: 30 }];
    expect(gs.demandPuppet(c, a)).toBe("ok");
    expect(gs.overlordOf(a)).toBe(c.smallID());
    expect(gs.overlordOf(b)).toBeUndefined();
    expect(hasTruce(gs.peaceOf(b)!, a.smallID())).toBe(true);
  });

  test("puppets join their overlord's wars, once, and are protected", () => {
    const gs = grandStrategyOf(game)!;
    puppetB();
    const goal = (p: Player, t: Player) =>
      gs.warOf(p)!.warGoals.some((g) => g.target === t.smallID());
    c.conquer([...a.tiles()][0]);
    gs.onConquer(c, a);
    expect(goal(b, c)).toBe(true);
    // Held already: nothing new (no stacking).
    const n = gs.warOf(b)!.warGoals.length;
    gs.onConquer(c, a);
    expect(gs.warOf(b)!.warGoals.length).toBe(n);
    // The overlord's own attacks call the puppet too.
    gs.warOf(b)!.warGoals = [];
    a.conquer([...c.tiles()][0]);
    gs.onConquer(a, c);
    expect(goal(b, c)).toBe(true);
    // Too weary: stays out.
    gs.warOf(b)!.warGoals = [];
    gs.stateOf(b)!.weariness = WAR_JOIN_MAX_WEARINESS * 1000;
    gs.onConquer(c, a);
    expect(goal(b, c)).toBe(false);
    // Attacked puppet: the overlord holds a war goal on the attacker.
    gs.warOf(a)!.warGoals = [];
    c.conquer([...b.tiles()][0]);
    gs.onConquer(c, b);
    expect(goal(a, c)).toBe(true);
  });

  test("puppets are in no faction and count toward the overlord's share", () => {
    const gs = grandStrategyOf(game)!;
    for (const p of [a, b, c]) gs.stateOf(p)!.ideology = "commune";
    expect(gs.foundFaction(b)).toBe("ok");
    puppetB();
    expect(gs.factionOfPlayer(b)).toBeUndefined();
    expect(gs.foundFaction(b)).toBe("puppet");
    expect(gs.foundFaction(a)).toBe("ok");
    expect(gs.joinFaction(b, a)).toBe("puppet");
    const up = lastUpdate(seconds(1), a.id());
    expect(up.faction?.share).toBe(
      Math.floor(
        ((a.numTilesOwned() + b.numTilesOwned()) * 1000) / game.numLandTiles(),
      ),
    );
    expect(up.puppets).toEqual([
      expect.objectContaining({ id: b.id(), autonomy: expect.any(Number) }),
    ]);
    expect(lastUpdate(seconds(1), b.id()).canFound).toBe("puppet");
  });

  test("intents through PuppetExecution", () => {
    const gs = grandStrategyOf(game)!;
    capitulate(a, b);
    game.addExecution(new PuppetExecution(a, "demand", b.id()));
    const ups = seconds(1);
    expect(gs.overlordOf(b)).toBe(a.smallID());
    gs.stateOf(b)!.autonomy = AUTONOMY_MAX;
    game.addExecution(new PuppetExecution(b, "independence", b.id()));
    ups.push(...seconds(1));
    expect(gs.overlordOf(b)).toBeUndefined();
    // Release goes through the same intent.
    gs.stateOf(b)!.overlord = a.smallID();
    game.addExecution(new PuppetExecution(c, "release", b.id()));
    ups.push(...seconds(1));
    expect(gs.overlordOf(b)).toBe(a.smallID());
    game.addExecution(new PuppetExecution(a, "release", b.id()));
    ups.push(...seconds(1));
    expect(gs.overlordOf(b)).toBeUndefined();
    expect(messages(ups)).toEqual(
      expect.arrayContaining([
        "events_display.gs_puppet_created",
        "events_display.gs_puppet_independent",
        "events_display.gs_puppet_released",
      ]),
    );
  });

  test("ablated: no windows, no puppets, no HUD fields", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("puppet");
    const ups = capitulate(a, b);
    expect(gs.stateOf(a)!.puppetWindows).toEqual([]);
    expect(gs.demandPuppet(a, b)).toBe("disabled");
    expect(gs.declareIndependence(b)).toBe("disabled");
    expect(lastUpdate(ups, a.id()).puppets).toBeUndefined();
    expect(messages(ups)).not.toContain("events_display.gs_puppet_window");
  });

  test("snapshot keeps bonds, autonomy and windows; v13 migrates to none", async () => {
    const gs = grandStrategyOf(game)!;
    puppetB();
    seconds(3);
    gs.stateOf(c)!.puppetWindows = [{ target: a.smallID(), seconds: 30 }];
    const autonomy = gs.stateOf(b)!.autonomy;
    const { bytes, restored, again } = await roundTrip(game, "big_plains");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    const rgs = grandStrategyOf(restored)!;
    expect(rgs.overlordOf(restored.player(b.id()))).toBe(a.smallID());
    expect(rgs.stateOf(restored.player(b.id()))!.autonomy).toBe(autonomy);
    expect(rgs.overlordOf(restored.player(a.id()))).toBeUndefined();
    expect(rgs.stateOf(restored.player(c.id()))!.puppetWindows).toEqual([
      { target: a.smallID(), seconds: 30 },
    ]);
    expect(
      restored
        .config()
        .isAttackLocked(restored.player(a.id()), restored.player(b.id())),
    ).toBe(true);
    const migrated = GrandStrategyExecutionSnapshot.migrations[13]({
      initialized: true,
      states: [{ id: 1 }],
    }) as {
      states: { overlord: null; autonomy: number; puppetWindows: [] }[];
    };
    expect(migrated.states[0]).toMatchObject({
      overlord: null,
      autonomy: 0,
      puppetWindows: [],
    });
  });
});

describe("AI puppets", () => {
  async function nations(n: number) {
    const game = await setup("big_plains", { instantBuild: true });
    const gameID: GameID = "game_id";
    const names = Array.from({ length: n }, (_, i) => `N${i + 1}`);
    for (const nm of names) {
      game.addPlayer(new PlayerInfo(nm, PlayerType.Nation, null, `${nm}_id`));
    }
    game.addExecution(
      ...names.map(
        (nm, i) =>
          new SpawnExecution(
            gameID,
            game.player(`${nm}_id`).info(),
            game.ref(20 + 40 * i, 20),
          ),
      ),
      new GrandStrategyExecution(),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();
    return { game, ns: names.map((nm) => game.player(`${nm}_id`)) };
  }

  test("an industrialist winner puppets; a militarist keeps the truce", async () => {
    const { game, ns } = await nations(4);
    const gs = grandStrategyOf(game)!;
    const ind = ns.find(
      (p) => aiPersonalityFor(p.smallID()) === "industrialist",
    )!;
    const mil = ns.find((p) => aiPersonalityFor(p.smallID()) === "militarist")!;
    const losers = ns.filter((p) => p !== ind && p !== mil);
    for (const [k, w] of [ind, mil].entries()) {
      for (let x = 0; x < 40; x++) {
        for (let y = 0; y < 30; y++) {
          const t = game.ref(x + 50 * k, 100 + y);
          if (game.isLand(t) && !game.hasOwner(t)) w.conquer(t);
        }
      }
    }
    for (const p of ns) gs.stateOf(p)!.politicalPower = 400_000;
    for (const [w, l] of [
      [ind, losers[0]],
      [mil, losers[1]],
    ] as const) {
      for (const t of [...l.tiles()].slice(0, 3)) {
        w.conquer(t);
        gs.onConquer(w, l);
      }
      gs.peaceOf(l)!.peakTiles = Math.max(
        l.numTilesOwned() * 3,
        game.numLandTiles(),
      );
    }
    for (let i = 0; i < 10; i++) game.executeNextTick();
    expect(gs.overlordOf(losers[0])).toBe(ind.smallID());
    expect(gs.overlordOf(losers[1])).toBeUndefined();
    expect(hasTruce(gs.peaceOf(losers[1])!, mil.smallID())).toBe(true);
  });

  test("an AI puppet breaks free as soon as it may", async () => {
    const { game, ns } = await nations(2);
    const gs = grandStrategyOf(game)!;
    const [o, p] = ns;
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 30; y++) {
        const t = game.ref(x, 100 + y);
        if (game.isLand(t) && !game.hasOwner(t)) o.conquer(t);
      }
    }
    gs.stateOf(o)!.politicalPower = 400_000;
    gs.stateOf(o)!.puppetWindows = [{ target: p.smallID(), seconds: 30 }];
    expect(gs.demandPuppet(o, p)).toBe("ok");
    gs.stateOf(p)!.politicalPower = 400_000;
    gs.stateOf(p)!.autonomy = AUTONOMY_MAX - 1;
    o.setTroops(1_000_000);
    for (let i = 0; i < 20; i++) game.executeNextTick();
    expect(gs.overlordOf(p)).toBeUndefined();
    expect(hasTruce(gs.peaceOf(p)!, o.smallID())).toBe(true);
  });
});

describe("classic", () => {
  test("puppet intents do nothing", async () => {
    const game = await setup("big_plains", { grandStrategy: false });
    const gameID: GameID = "game_id";
    for (const n of ["A", "B"]) {
      game.addPlayer(new PlayerInfo(n, PlayerType.Human, null, `${n}_id`));
    }
    game.addExecution(
      new SpawnExecution(gameID, game.player("A_id").info(), game.ref(20, 20)),
      new SpawnExecution(gameID, game.player("B_id").info(), game.ref(60, 20)),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    const a = game.player("A_id");
    const b = game.player("B_id");
    expect(grandStrategyOf(game)).toBeNull();
    game.addExecution(new PuppetExecution(a, "demand", b.id()));
    for (let i = 0; i < 20; i++) game.executeNextTick();
    expect(a.canAttackPlayer(b)).toBe(true);
  });
});

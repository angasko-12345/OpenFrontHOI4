import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  advanceFactionCalls,
  CALL_TO_ARMS_SECONDS,
  canFoundFaction,
  canJoinFaction,
  type Faction,
  FACTION_CREATE_PP,
  FACTION_LEADER_MAX_SHARE,
  FACTION_MAX_SHARE,
  factionCap,
  JoinInput,
  leaveFaction,
  maxFactions,
  mayCallToArms,
  recordCall,
} from "@openfront/engine-lib/game/GrandStrategyFaction";
import { FactionExecution } from "@openfront/engine/execution/FactionExecution";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { diffSnapshots, roundTrip } from "./util/Snapshot";

const join: JoinInput = {
  ideology: "commune",
  leaderIdeology: "commune",
  inFaction: false,
  members: 1,
  nations: 24,
  leaderShare: 100,
  factionShare: 100,
  share: 50,
  atWarWithMember: false,
};

describe("faction rules (M7C stage 3)", () => {
  test("cap and faction count grow with the world, bounded", () => {
    expect(factionCap(0)).toBe(2);
    expect(factionCap(12)).toBe(3);
    expect(factionCap(24)).toBe(4);
    expect(factionCap(400)).toBe(4);
    expect(maxFactions(3)).toBe(1);
    expect(maxFactions(40)).toBe(5);
  });

  test("founding needs an ideology, PP, room and a not-too-big founder", () => {
    const base = {
      ideology: "assembly",
      politicalPower: FACTION_CREATE_PP,
      inFaction: false,
      share: 100,
      factions: 0,
      nations: 20,
    };
    expect(canFoundFaction(base)).toBe("ok");
    expect(canFoundFaction({ ...base, ideology: "nonaligned" })).toBe(
      "no_ideology",
    );
    expect(canFoundFaction({ ...base, ideology: undefined })).toBe(
      "no_ideology",
    );
    expect(
      canFoundFaction({ ...base, politicalPower: FACTION_CREATE_PP - 1 }),
    ).toBe("no_political_power");
    expect(canFoundFaction({ ...base, inFaction: true })).toBe("in_faction");
    expect(canFoundFaction({ ...base, factions: maxFactions(20) })).toBe(
      "too_many",
    );
    expect(
      canFoundFaction({ ...base, share: FACTION_LEADER_MAX_SHARE + 1 }),
    ).toBe("leader_too_big");
  });

  test("joining: same ideology, room, size caps, not at war", () => {
    expect(canJoinFaction(join)).toBe("ok");
    expect(canJoinFaction({ ...join, ideology: "assembly" })).toBe("ideology");
    expect(
      canJoinFaction({
        ...join,
        ideology: "nonaligned",
        leaderIdeology: "nonaligned",
      }),
    ).toBe("ideology");
    expect(canJoinFaction({ ...join, members: factionCap(24) })).toBe("full");
    expect(
      canJoinFaction({ ...join, leaderShare: FACTION_LEADER_MAX_SHARE + 1 }),
    ).toBe("leader_too_big");
    expect(
      canJoinFaction({ ...join, factionShare: FACTION_MAX_SHARE - 49 }),
    ).toBe("too_big");
    expect(canJoinFaction({ ...join, atWarWithMember: true })).toBe("at_war");
  });

  test("calls to arms are rate limited and stop for big factions", () => {
    const f: Faction = { leader: 1, members: [1, 2], calls: [] };
    expect(mayCallToArms(f, 9, 100)).toBe(true);
    expect(mayCallToArms(f, 9, 351)).toBe(false);
    recordCall(f, 9);
    expect(mayCallToArms(f, 9, 100)).toBe(false);
    expect(mayCallToArms(f, 8, 100)).toBe(true);
    for (let i = 0; i < CALL_TO_ARMS_SECONDS; i++) advanceFactionCalls(f);
    expect(mayCallToArms(f, 9, 100)).toBe(true);
  });

  test("leaving: the next member leads; a leader alone dissolves it", () => {
    const fs: Faction[] = [
      { leader: 1, members: [1, 2, 3], calls: [] },
      { leader: 5, members: [5], calls: [] },
    ];
    let out = leaveFaction(fs, 1);
    expect(out[0]).toMatchObject({ leader: 2, members: [2, 3] });
    out = leaveFaction(out, 3);
    expect(out[0]).toMatchObject({ leader: 2, members: [2] });
    out = leaveFaction(out, 2);
    expect(out.map((f) => f.leader)).toEqual([5]);
    out = leaveFaction([{ leader: 1, members: [1, 2], calls: [] }], 1);
    expect(out).toEqual([]);
  });
});

describe("GrandStrategyExecution factions", () => {
  let game: Game;
  let a: Player;
  let b: Player;
  let c: Player;
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("big_plains", {
      infiniteGold: true,
      instantBuild: true,
    });
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
    const gs = grandStrategyOf(game)!;
    for (const p of [a, b, c]) {
      const s = gs.stateOf(p)!;
      s.ideology = "commune";
      s.politicalPower = 400_000;
    }
  });

  function seconds(n: number) {
    const all: ReturnType<Game["executeNextTick"]>[] = [];
    for (let i = 0; i < n * 10; i++) all.push(game.executeNextTick());
    return all;
  }

  test("found, then join: upstream alliances with every member", () => {
    const gs = grandStrategyOf(game)!;
    gs.stateOf(a)!.ideology = "nonaligned";
    expect(gs.foundFaction(a)).toBe("no_ideology");
    gs.stateOf(a)!.ideology = "commune";
    expect(gs.foundFaction(a)).toBe("ok");
    expect(gs.stateOf(a)!.politicalPower).toBe(400_000 - FACTION_CREATE_PP);
    expect(gs.foundFaction(a)).toBe("in_faction");
    gs.stateOf(b)!.ideology = "assembly";
    expect(gs.joinFaction(b, a)).toBe("ideology");
    gs.stateOf(b)!.ideology = "commune";
    expect(a.isAlliedWith(b)).toBe(false);
    expect(gs.joinFaction(b, a)).toBe("ok");
    expect(a.isAlliedWith(b)).toBe(true);
    expect(gs.factionOfPlayer(b)?.members).toEqual([a.smallID(), b.smallID()]);
    // Three nations: cap 2.
    expect(gs.joinFaction(c, a)).toBe("full");
    expect(a.canAttackPlayer(b)).toBe(false);
  });

  test("intents through FactionExecution, with world messages", () => {
    const gs = grandStrategyOf(game)!;
    game.addExecution(new FactionExecution(a, "found", a.id()));
    const ups = seconds(1);
    game.addExecution(new FactionExecution(b, "join", a.id()));
    ups.push(...seconds(1));
    expect(gs.factionOfPlayer(b)?.leader).toBe(a.smallID());
    game.addExecution(new FactionExecution(b, "leave", b.id()));
    ups.push(...seconds(1));
    expect(gs.factionOfPlayer(b)).toBeUndefined();
    const msgs = ups.flatMap((u) =>
      (u[GameUpdateType.DisplayEvent] ?? [])
        .filter((e) => e.messageType === MessageType.GS_DIPLOMACY)
        .map((e) => e.message),
    );
    expect(msgs).toEqual(
      expect.arrayContaining([
        "events_display.gs_faction_created",
        "events_display.gs_faction_joined",
        "events_display.gs_faction_left",
      ]),
    );
  });

  test("a broken alliance drops the later joiner; the leader alone keeps it", () => {
    const gs = grandStrategyOf(game)!;
    gs.foundFaction(a);
    gs.joinFaction(b, a);
    b.breakAlliance(b.allianceWith(a)!);
    seconds(1);
    expect(gs.factionOfPlayer(b)).toBeUndefined();
    expect(gs.factionOfPlayer(a)?.members).toEqual([a.smallID()]);
  });

  test("call to arms: members get a war goal on the attacker, once a minute", () => {
    const gs = grandStrategyOf(game)!;
    gs.foundFaction(a);
    gs.joinFaction(b, a);
    const tile = [...a.tiles()][0];
    c.conquer(tile);
    gs.onConquer(c, a);
    const goals = () =>
      gs.warOf(b)!.warGoals.filter((g) => g.target === c.smallID());
    expect(goals()).toHaveLength(1);
    expect(gs.factionList()[0].calls).toEqual([
      { target: c.smallID(), seconds: CALL_TO_ARMS_SECONDS },
    ]);
    gs.warOf(b)!.warGoals = [];
    c.conquer([...a.tiles()][0]);
    gs.onConquer(c, a);
    expect(goals()).toHaveLength(0);
    // A member taking land from an outsider calls nobody.
    b.conquer([...c.tiles()][0]);
    gs.onConquer(b, c);
    expect(gs.warOf(a)!.warGoals.some((g) => g.target === b.smallID())).toBe(
      false,
    );
  });

  test("HUD update lists our faction and joinable ones", () => {
    const gs = grandStrategyOf(game)!;
    gs.foundFaction(a);
    const ups = seconds(1);
    const last = (id: string) =>
      ups
        .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
        .filter((u) => u.player === id)
        .at(-1)!;
    expect(last(a.id()).faction).toMatchObject({
      leader: a.id(),
      members: [a.id()],
      cap: 2,
    });
    expect(last(b.id()).faction).toBeNull();
    expect(last(b.id()).factions).toEqual([
      expect.objectContaining({ leader: a.id(), join: "ok", members: 1 }),
    ]);
    expect(last(b.id()).canFound).toBe("too_many");
  });

  test("ablated: factions are disabled", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("faction");
    expect(gs.foundFaction(a)).toBe("disabled");
    const ups = seconds(1);
    const mine = ups
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === a.id());
    expect(mine.at(-1)!.factions).toBeUndefined();
  });

  test("snapshot keeps factions and calls; v12 migrates to none", async () => {
    const gs = grandStrategyOf(game)!;
    gs.foundFaction(a);
    gs.joinFaction(b, a);
    c.conquer([...a.tiles()][0]);
    gs.onConquer(c, a);
    const before = JSON.parse(JSON.stringify(gs.factionList()));
    const { bytes, restored, again } = await roundTrip(game, "big_plains");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    expect(grandStrategyOf(restored)!.factionList()).toEqual(before);
    const migrated = GrandStrategyExecutionSnapshot.migrations[12]({
      initialized: true,
      states: [],
    }) as { factions: unknown[] };
    expect(migrated.factions).toEqual([]);
  });
});

describe("AI factions", () => {
  test("nations of one ideology found and join a faction", async () => {
    const game = await setup("big_plains", { infiniteGold: true });
    const gameID: GameID = "game_id";
    const names = ["N1", "N2", "N3"];
    for (const n of names) {
      game.addPlayer(new PlayerInfo(n, PlayerType.Nation, null, `${n}_id`));
    }
    game.addExecution(
      new SpawnExecution(gameID, game.player("N1_id").info(), game.ref(20, 20)),
      new SpawnExecution(gameID, game.player("N2_id").info(), game.ref(60, 20)),
      new SpawnExecution(gameID, game.player("N3_id").info(), game.ref(40, 60)),
      new GrandStrategyExecution(),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    game.executeNextTick();
    game.executeNextTick();
    const gs = grandStrategyOf(game)!;
    const ns = names.map((n) => game.player(`${n}_id`));
    // Give every nation >= 2.5% of the land so any personality may found.
    ns.forEach((p, k) => {
      for (let x = 0; x < 40; x++) {
        for (let y = 0; y < 30; y++) {
          const t = game.ref(x + 50 * k, 100 + y);
          if (!game.hasOwner(t)) p.conquer(t);
        }
      }
    });
    for (let i = 0; i < 300; i++) {
      for (const p of ns) {
        const s = gs.stateOf(p)!;
        s.ideology = "commune";
        s.ideologyCooldown = 300;
        s.politicalPower = Math.max(s.politicalPower, 400_000);
      }
      game.executeNextTick();
    }
    const fs = gs.factionList();
    expect(fs).toHaveLength(1);
    expect(fs[0].members).toHaveLength(2);
    const [x, y] = fs[0].members.map((m) => ns.find((p) => p.smallID() === m)!);
    expect(x.isAlliedWith(y)).toBe(true);
  });

  test("classic: faction intents do nothing and alliances are untouched", async () => {
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
    game.addExecution(new FactionExecution(a, "found", a.id()));
    game.addExecution(new FactionExecution(b, "join", a.id()));
    for (let i = 0; i < 20; i++) game.executeNextTick();
    expect(a.isAlliedWith(b)).toBe(false);
  });
});

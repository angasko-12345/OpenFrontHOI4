import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GS_ACTION_IDS,
  IDEOLOGY_IDS,
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  aiChoose,
  AI_PP_RESERVE,
  aiPersonalityFor,
  canSetLaw,
  modifiersOf,
  newNationState,
  takeAction,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  adoptIdeology,
  aiBreakBias,
  aiPeaceBias,
  AI_IDEOLOGY,
  canAdoptIdeology,
  IDEOLOGIES,
  IDEOLOGY_COOLDOWN,
  IDEOLOGY_COST,
  ideologyAction,
  ideologyDef,
  ideologyOfAction,
  justifyCostFor,
  lawWarSupportFor,
  SAME_IDEOLOGY_BREAK,
  SAME_IDEOLOGY_PEACE,
  sameIdeology,
  tickIdeology,
  wearinessGainFor,
} from "@openfront/engine-lib/game/GrandStrategyIdeology";
import {
  advanceWeariness,
  aiAcceptsPeace,
  aiBreaksTruce,
  AI_ACCEPT_WEARINESS,
  AI_BREAK_STRENGTH,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import { JUSTIFY_COST } from "@openfront/engine-lib/game/GrandStrategyWar";
import {
  GrandStrategyExecution,
  GrandStrategyExecutionSnapshot,
  grandStrategyOf,
} from "@openfront/engine/execution/GrandStrategyExecution";
import { GsActionExecution } from "@openfront/engine/execution/GsActionExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { diffSnapshots, roundTrip } from "./util/Snapshot";

describe("ideology rules (M7 stage B)", () => {
  test("table, ids and gs_action ids agree; generic names", () => {
    expect(IDEOLOGIES.map((i) => i.id)).toEqual([...IDEOLOGY_IDS]);
    for (const id of IDEOLOGY_IDS) {
      expect(GS_ACTION_IDS).toContain(ideologyAction(id));
      expect(ideologyOfAction(ideologyAction(id))).toBe(id);
    }
    expect(ideologyOfAction("war_bonds")).toBeNull();
    expect(ideologyOfAction("ideology_nope")).toBeNull();
    expect(ideologyDef(undefined).id).toBe("nonaligned");
    expect(ideologyDef("garbage").id).toBe("nonaligned");
    // Modest: no single effect beyond 10%.
    for (const i of IDEOLOGIES) {
      for (const v of Object.values(i.effects)) {
        expect(Math.abs(v)).toBeLessThanOrEqual(100);
      }
    }
  });

  test("adopting costs PP, starts a cooldown, and counts down", () => {
    const s = newNationState(0);
    expect(s.ideology).toBe("nonaligned");
    expect(canAdoptIdeology(s, "nonaligned")).toBe("active");
    expect(canAdoptIdeology(s, "nope")).toBe("unknown");
    expect(adoptIdeology(s, "assembly")).toBe("no_political_power");
    s.politicalPower = IDEOLOGY_COST + 7;
    expect(takeAction(s, "ideology_assembly")).toBe("ok");
    expect(s.ideology).toBe("assembly");
    expect(s.politicalPower).toBe(7);
    expect(s.ideologyCooldown).toBe(IDEOLOGY_COOLDOWN);
    s.politicalPower = IDEOLOGY_COST * 2;
    expect(takeAction(s, "ideology_commune")).toBe("cooldown");
    for (let i = 0; i < IDEOLOGY_COOLDOWN; i++) tickIdeology(s);
    expect(s.ideologyCooldown).toBe(0);
    tickIdeology(s);
    expect(s.ideologyCooldown).toBe(0);
    expect(takeAction(s, "ideology_commune")).toBe("ok");
    expect(takeAction(s, "ideology_commune")).toBe("unavailable");
  });

  test("effects reach modifiersOf; absent ideology = non-aligned", () => {
    const s = newNationState(0);
    const base = modifiersOf(s);
    s.ideology = "commune";
    expect(modifiersOf(s).production - base.production).toBe(
      ideologyDef("commune").effects.production,
    );
    s.ideology = "directorate";
    expect(modifiersOf(s).attackLoss).toBeLessThan(base.attackLoss);
    delete s.ideology;
    delete s.ideologyCooldown;
    expect(modifiersOf(s)).toEqual(base);
    expect(canAdoptIdeology(s, "assembly")).toBe("no_political_power");
  });

  test("law access, justification cost and weariness gain", () => {
    const s = newNationState(0);
    s.politicalPower = 500_000;
    // service_by_requirement needs high war support; find the edge.
    const law = "service_by_requirement";
    s.warSupport = 1000;
    expect(canSetLaw(s, law)).toBe("ok");
    let edge = 1000;
    while (edge > 0 && canSetLaw({ ...s, warSupport: edge - 1 }, law) === "ok")
      edge--;
    s.ideology = "directorate";
    expect(canSetLaw({ ...s, warSupport: edge - 1 }, law)).toBe("ok");
    s.ideology = "assembly";
    expect(canSetLaw({ ...s, warSupport: edge }, law)).toBe("low_war_support");
    expect(lawWarSupportFor(undefined)).toBe(0);

    expect(justifyCostFor(JUSTIFY_COST)).toBe(JUSTIFY_COST);
    expect(justifyCostFor(JUSTIFY_COST, "directorate")).toBeLessThan(
      JUSTIFY_COST,
    );
    expect(justifyCostFor(JUSTIFY_COST, "assembly")).toBeGreaterThan(
      JUSTIFY_COST,
    );

    const input = {
      attackLosses: 1000,
      maxTroops: 10_000,
      tilesLost: 0,
      peakTiles: 1000,
      tilesOwned: 1000,
      numLandTiles: 100_000,
      occupied: 0,
      longWars: 0,
      atWar: true,
    };
    const plain = advanceWeariness(0, input);
    expect(advanceWeariness(0, { ...input, gainPermille: 1000 })).toBe(plain);
    expect(
      advanceWeariness(0, {
        ...input,
        gainPermille: wearinessGainFor("commune"),
      }),
    ).toBeLessThan(plain);
    expect(
      advanceWeariness(0, {
        ...input,
        gainPermille: wearinessGainFor("assembly"),
      }),
    ).toBeGreaterThan(plain);
  });

  test("AI diplomacy: same ideology makes peace sooner and breaks truces later", () => {
    expect(sameIdeology("assembly", "assembly")).toBe(true);
    expect(sameIdeology("nonaligned", "nonaligned")).toBe(false);
    expect(sameIdeology(undefined, "commune")).toBe(false);
    expect(aiPeaceBias("commune", "commune")).toBe(-SAME_IDEOLOGY_PEACE);
    expect(aiPeaceBias("commune", "assembly")).toBe(0);
    expect(aiPeaceBias("assembly")).toBeLessThan(aiPeaceBias("directorate"));
    const winning = { target: 2, seconds: 10, idle: 0, won: 5, lost: 1 };
    const w = (AI_ACCEPT_WEARINESS.industrialist - SAME_IDEOLOGY_PEACE) * 1000;
    expect(aiAcceptsPeace("industrialist", w, winning)).toBe(false);
    expect(
      aiAcceptsPeace(
        "industrialist",
        w,
        winning,
        aiPeaceBias("commune", "commune"),
      ),
    ).toBe(true);

    expect(aiBreakBias("commune", "commune")).toBe(SAME_IDEOLOGY_BREAK);
    expect(aiBreakBias("directorate", "assembly")).toBeLessThan(0);
    const input = {
      strengthPermille: AI_BREAK_STRENGTH.militarist,
      weariness: 0,
      wars: 0,
      borders: true,
      canPay: true,
    };
    expect(aiBreaksTruce("militarist", input)).toBe(true);
    expect(
      aiBreaksTruce("militarist", {
        ...input,
        strengthBias: aiBreakBias("directorate", "directorate"),
      }),
    ).toBe(false);
    // Never below parity, whatever the bias.
    expect(
      aiBreaksTruce("militarist", {
        ...input,
        strengthPermille: 999,
        strengthBias: -100_000,
      }),
    ).toBe(false);
  });

  test("AI adopts its personality's ideology from spare PP, once", () => {
    for (const p of ["militarist", "industrialist", "defender"] as const) {
      const s = newNationState(0);
      // Laws maxed so the AI looks at spare-PP purchases.
      s.conscriptionLaw = "service_by_requirement";
      s.economyLaw = "total_mobilization";
      s.politicalPower = AI_PP_RESERVE;
      expect(aiChoose(s, p).action).toBe(ideologyAction(AI_IDEOLOGY[p]));
      expect(aiChoose(s, p, false).action).not.toBe(
        ideologyAction(AI_IDEOLOGY[p]),
      );
      takeAction(s, ideologyAction(AI_IDEOLOGY[p]));
      s.politicalPower = AI_PP_RESERVE;
      expect(aiChoose(s, p).action?.startsWith("ideology_") ?? false).toBe(
        false,
      );
    }
    expect(new Set(Object.values(AI_IDEOLOGY)).size).toBe(3);
  });
});

describe("GrandStrategyExecution ideologies", () => {
  let game: Game;
  let a: Player;
  let b: Player;
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("ocean_and_land", { infiniteGold: true });
    const ai = new PlayerInfo("A", PlayerType.Human, null, "a_id");
    const bi = new PlayerInfo("B", PlayerType.Nation, null, "b_id");
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
    expect(a.isAlive() && b.isAlive()).toBe(true);
  });

  function seconds(n: number) {
    const all: ReturnType<Game["executeNextTick"]>[] = [];
    for (let i = 0; i < n * 10; i++) all.push(game.executeNextTick());
    return all;
  }

  test("gs_action adopts it: world message and HUD row", () => {
    const gs = grandStrategyOf(game)!;
    gs.stateOf(a)!.politicalPower = IDEOLOGY_COST;
    game.addExecution(new GsActionExecution(a, "ideology_directorate"));
    const ups = seconds(1);
    expect(gs.stateOf(a)!.ideology).toBe("directorate");
    const msgs = ups.flatMap((u) =>
      (u[GameUpdateType.DisplayEvent] ?? []).filter(
        (e) => e.messageType === MessageType.GS_DIPLOMACY,
      ),
    );
    const m = msgs.find(
      (x) => x.message === "events_display.gs_ideology_changed",
    );
    expect(m).toBeDefined();
    expect(m!.playerID).toBeNull();
    expect(m!.params?.ideology).toBe("Directorate");
    const mine = ups
      .flatMap((u) => u[GameUpdateType.GrandStrategy] ?? [])
      .filter((u) => u.player === a.id());
    const last = mine[mine.length - 1];
    expect(last.ideology).toBe("directorate");
    expect(last.ideologyCooldown).toBeGreaterThan(0);
  });

  test("justification costs follow the ideology", () => {
    const gs = grandStrategyOf(game)!;
    const s = gs.stateOf(a)!;
    s.ideology = "directorate";
    s.politicalPower = 100_000;
    expect(gs.justifyWar(a, b)).toBe("ok");
    expect(s.politicalPower).toBe(
      100_000 - justifyCostFor(JUSTIFY_COST, "directorate"),
    );
  });

  test("an AI nation adopts its personality's ideology", () => {
    const gs = grandStrategyOf(game)!;
    const s = gs.stateOf(b)!;
    s.conscriptionLaw = "service_by_requirement";
    s.economyLaw = "total_mobilization";
    // Room for a war-goal justification first (the AI justifies before it shops).
    s.politicalPower = AI_PP_RESERVE + JUSTIFY_COST * 2;
    seconds(1);
    expect(s.ideology).toBe(AI_IDEOLOGY[aiPersonalityFor(b.smallID())]);
  });

  test("ablated: no changes, AI stays non-aligned", () => {
    const gs = grandStrategyOf(game)!;
    gs.ablate("ideology");
    const sa = gs.stateOf(a)!;
    sa.politicalPower = IDEOLOGY_COST;
    expect(gs.takeAction(a, "ideology_commune")).toBe("unavailable");
    expect(sa.politicalPower).toBe(IDEOLOGY_COST);
    const sb = gs.stateOf(b)!;
    sb.conscriptionLaw = "service_by_requirement";
    sb.economyLaw = "total_mobilization";
    sb.politicalPower = AI_PP_RESERVE + JUSTIFY_COST * 2;
    seconds(2);
    expect(sb.ideology).toBe("nonaligned");
    // Justification at the plain price.
    sa.politicalPower = JUSTIFY_COST;
    sa.ideology = "assembly";
    expect(gs.justifyWar(a, b)).toBe("ok");
  });

  test("snapshot keeps ideology and cooldown; v10 migrates non-aligned", async () => {
    const gs = grandStrategyOf(game)!;
    seconds(1);
    const s = gs.stateOf(a)!;
    s.ideology = "commune";
    s.ideologyCooldown = 42;
    const { bytes, restored, again } = await roundTrip(game, "ocean_and_land");
    expect(diffSnapshots(bytes, again)).toEqual([]);
    const rs = grandStrategyOf(restored)!.stateOf(restored.player(a.id()))!;
    expect(rs.ideology).toBe("commune");
    expect(rs.ideologyCooldown).toBe(42);
    const migrated = GrandStrategyExecutionSnapshot.migrations[10]({
      initialized: true,
      states: [{ id: 1 }],
    }) as { states: { ideology: string; ideologyCooldown: number }[] };
    expect(migrated.states[0].ideology).toBe("nonaligned");
    expect(migrated.states[0].ideologyCooldown).toBe(0);
  });
});

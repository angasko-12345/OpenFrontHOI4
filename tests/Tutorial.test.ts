import { readFileSync } from "node:fs";
import {
  GS_ECONOMY_STEPS,
  GS_WAR_STEPS,
  STEP_DONE_LINGER_TICKS,
  TUTORIAL_STEPS,
  TutorialContext,
  TutorialProgress,
} from "../src/client/hud/Tutorial";

function ctx(overrides: Partial<TutorialContext> = {}): TutorialContext {
  return {
    hasSpawned: false,
    inSpawnPhase: false,
    attacking: false,
    attackRatioMoved: false,
    boatsDisabled: false,
    boatSent: false,
    botsExist: true,
    nationsExist: true,
    alliancesDisabled: false,
    allied: false,
    gold: 0n,
    cityCost: null,
    cityDisabled: false,
    cities: 0,
    portDisabled: false,
    ports: 0,
    defensePostDisabled: false,
    defensePosts: 0,
    factoryDisabled: false,
    factories: 0,
    warshipDisabled: false,
    warships: 0,
    siloDisabled: false,
    silos: 0,
    atomDisabled: false,
    siloReady: false,
    atomLaunched: false,
    hydrogenDisabled: false,
    mirvDisabled: false,
    samDisabled: false,
    grandStrategy: false,
    ...overrides,
  };
}

// Feed the same context until the completed step has lingered and advanced.
function settle(progress: TutorialProgress, c: TutorialContext) {
  for (let i = 0; i <= STEP_DONE_LINGER_TICKS; i++) progress.update(c);
}

describe("TutorialProgress", () => {
  it("walks the steps in order as the player acts", () => {
    const p = new TutorialProgress();
    p.update(ctx());
    expect(p.current()?.id).toBe("spawn");
    expect(p.stepDone()).toBe(false);

    p.update(ctx({ hasSpawned: true }));
    expect(p.current()?.id).toBe("spawn");
    expect(p.stepDone()).toBe(true);

    settle(p, ctx({ hasSpawned: true }));
    expect(p.current()?.id).toBe("attack_wilderness");

    settle(p, ctx({ hasSpawned: true, attacking: true }));
    expect(p.current()?.id).toBe("troops");

    p.acknowledge();
    settle(p, ctx({ hasSpawned: true, attacking: true }));
    expect(p.current()?.id).toBe("troop_rate");
    p.acknowledge();
    settle(p, ctx({ hasSpawned: true, attacking: true }));
    expect(p.current()?.id).toBe("attack_ratio");
    // Completed by moving the slider, which only shows up for a single tick.
    p.update(
      ctx({ hasSpawned: true, attacking: true, attackRatioMoved: true }),
    );
    expect(p.stepDone()).toBe(true);
    settle(p, ctx({ hasSpawned: true, attacking: true }));
    expect(p.current()?.id).toBe("capture_tribes");

    settle(
      p,
      ctx({
        hasSpawned: true,
        attacking: true,
        gold: 125_000n,
        cityCost: 125_000n,
      }),
    );
    expect(p.current()?.id).toBe("buy_city");
  });

  it("holds the spawn step until the multiplayer spawn timer ends", () => {
    const p = new TutorialProgress();
    // Spot picked, but the spawn phase is still running: stay put.
    for (let i = 0; i < 100; i++) {
      p.update(ctx({ hasSpawned: true, inSpawnPhase: true }));
    }
    expect(p.current()?.id).toBe("spawn");
    expect(p.stepDone()).toBe(false);

    settle(p, ctx({ hasSpawned: true }));
    expect(p.current()?.id).toBe("attack_wilderness");
  });

  it("lingers on a completed step before advancing", () => {
    const p = new TutorialProgress();
    p.update(ctx({ hasSpawned: true }));
    for (let i = 1; i < STEP_DONE_LINGER_TICKS; i++) {
      p.update(ctx({ hasSpawned: true }));
      expect(p.current()?.id).toBe("spawn");
    }
    p.update(ctx({ hasSpawned: true }));
    expect(p.current()?.id).toBe("attack_wilderness");
  });

  it("only advances informational steps on acknowledge", () => {
    const p = new TutorialProgress();
    const c = ctx({ hasSpawned: true, attacking: true });
    settle(p, c);
    settle(p, c);
    expect(p.current()?.id).toBe("troops");

    for (let i = 0; i < 100; i++) p.update(c);
    expect(p.current()?.id).toBe("troops");
    expect(p.stepDone()).toBe(false);

    p.acknowledge();
    expect(p.stepDone()).toBe(true);
    settle(p, c);
    expect(p.current()?.id).toBe("troop_rate");
  });

  it("ignores acknowledge on action steps", () => {
    const p = new TutorialProgress();
    p.update(ctx());
    p.acknowledge();
    expect(p.stepDone()).toBe(false);
  });

  it("skips steps that don't apply to the game and counts only the rest", () => {
    const p = new TutorialProgress();
    const c = ctx({
      hasSpawned: true,
      attacking: true,
      boatsDisabled: true,
      botsExist: false,
      nationsExist: false,
      cityDisabled: true,
      portDisabled: true,
      defensePostDisabled: true,
      factoryDisabled: true,
      warshipDisabled: true,
      siloDisabled: true,
      atomDisabled: true,
      hydrogenDisabled: true,
      mirvDisabled: true,
      samDisabled: true,
    });
    expect(p.total(c)).toBe(
      TUTORIAL_STEPS.length -
        17 -
        GS_ECONOMY_STEPS.length -
        GS_WAR_STEPS.length,
    );

    settle(p, c);
    settle(p, c);
    expect(p.current()?.id).toBe("troops");
    expect(p.position(c)).toBe(3);

    p.acknowledge();
    settle(p, c);
    expect(p.current()?.id).toBe("troop_rate");
    expect(p.position(c)).toBe(4);
    p.acknowledge();
    settle(p, c);
    expect(p.current()?.id).toBe("attack_ratio");
    p.update({ ...c, attackRatioMoved: true });
    settle(p, c);
    expect(p.finished()).toBe(true);
    expect(p.current()).toBeNull();
  });

  it("asks for an alliance after the city, then explains traitors", () => {
    const first = TUTORIAL_STEPS.findIndex((s) => s.id === "propose_alliance");
    const p = new TutorialProgress(TUTORIAL_STEPS.slice(first));
    p.update(ctx());
    expect(p.current()?.id).toBe("propose_alliance");
    expect(p.current()?.highlight).toBe("nation");

    settle(p, ctx({ allied: true }));
    expect(p.current()?.id).toBe("alliance_info");
    p.acknowledge();
    settle(p, ctx({ allied: true }));
    expect(p.current()?.id).toBe("buy_factory");

    // Without nations (or with alliances off) both steps are skipped.
    const q = new TutorialProgress(TUTORIAL_STEPS.slice(first));
    q.update(ctx({ nationsExist: false }));
    expect(q.current()?.id).toBe("buy_factory");
  });

  it("gates the tribes step on affordable gold, then the city step on the city existing", () => {
    const p = new TutorialProgress([
      TUTORIAL_STEPS.find((s) => s.id === "capture_tribes")!,
      TUTORIAL_STEPS.find((s) => s.id === "buy_city")!,
    ]);
    p.update(ctx({ gold: 500_000n, cityCost: null }));
    expect(p.stepDone()).toBe(false);

    p.update(ctx({ gold: 100_000n, cityCost: 125_000n }));
    expect(p.stepDone()).toBe(false);

    p.update(ctx({ gold: 125_000n, cityCost: 125_000n }));
    expect(p.stepDone()).toBe(true);
    settle(p, ctx({ gold: 125_000n, cityCost: 125_000n }));
    expect(p.current()?.id).toBe("buy_city");

    // Spending the gold elsewhere doesn't complete the step; the city does.
    p.update(ctx({ gold: 0n, cityCost: 125_000n }));
    expect(p.stepDone()).toBe(false);
    p.update(ctx({ gold: 0n, cityCost: 250_000n, cities: 1 }));
    expect(p.stepDone()).toBe(true);
  });

  it("runs city, factory, port, warship, silo, pausing on each info step", () => {
    const first = TUTORIAL_STEPS.findIndex((s) => s.id === "buy_factory");
    const p = new TutorialProgress(TUTORIAL_STEPS.slice(first));
    p.update(ctx());
    expect(p.current()?.id).toBe("buy_factory");

    settle(p, ctx({ factories: 1 }));
    expect(p.current()?.id).toBe("factory_info");
    for (let i = 0; i < 50; i++) p.update(ctx({ factories: 1 }));
    expect(p.current()?.id).toBe("factory_info");
    p.acknowledge();
    settle(p, ctx({ factories: 1 }));

    expect(p.current()?.id).toBe("send_boat");
    settle(p, ctx({ factories: 1, boatSent: true }));

    expect(p.current()?.id).toBe("buy_port");
    expect(p.current()?.highlight).toBe("port");
    settle(p, ctx({ factories: 1, ports: 1 }));
    expect(p.current()?.id).toBe("port_info");
    expect(p.current()?.bullets).toHaveLength(2);
    p.acknowledge();
    settle(p, ctx({ factories: 1, ports: 1 }));

    expect(p.current()?.id).toBe("buy_defense_post");
    expect(p.current()?.highlight).toBe("defense_post");
    settle(p, ctx({ factories: 1, ports: 1, defensePosts: 1 }));

    expect(p.current()?.id).toBe("buy_warship");
    expect(p.current()?.highlight).toBe("warship");
    settle(p, ctx({ factories: 1, ports: 1, warships: 1 }));

    expect(p.current()?.id).toBe("buy_silo");
    expect(p.current()?.highlight).toBe("silo");
    p.update(ctx({ factories: 1, ports: 1, warships: 1 }));
    expect(p.stepDone()).toBe(false);
    settle(p, ctx({ factories: 1, ports: 1, warships: 1, silos: 1 }));

    expect(p.current()?.id).toBe("launch_atom");
    expect(p.current()?.highlight).toBe("atom");
    settle(p, ctx({ silos: 1, atomLaunched: true }));

    for (const [id, highlight] of [
      ["atom_info", "atom"],
      ["hydrogen_info", "hydrogen"],
      ["mirv_info", "mirv"],
      ["sam_info", "sam"],
    ]) {
      expect(p.current()?.id).toBe(id);
      expect(p.current()?.highlight).toBe(highlight);
      p.acknowledge();
      settle(p, ctx({ silos: 1 }));
    }
    expect(p.finished()).toBe(true);
  });
});

describe("TutorialProgress.skip", () => {
  it("moves past the current step without completing it", () => {
    const p = new TutorialProgress();
    p.update(ctx());
    expect(p.current()?.id).toBe("spawn");

    p.skip();
    expect(p.stepDone()).toBe(false);
    p.update(ctx());
    expect(p.current()?.id).toBe("attack_wilderness");

    // Skipping lands on the next *applicable* step.
    p.skip();
    p.update(ctx({ botsExist: false }));
    expect(p.current()?.id).toBe("troops");
    p.skip();
    p.skip();
    p.skip();
    p.update(ctx({ botsExist: false, cityDisabled: true }));
    expect(p.current()?.id).toBe("propose_alliance");
  });

  it("can skip through to the end", () => {
    const p = new TutorialProgress();
    for (let i = 0; i < TUTORIAL_STEPS.length; i++) p.skip();
    p.update(ctx());
    expect(p.finished()).toBe(true);
    p.skip();
    expect(p.finished()).toBe(true);
  });
});

describe("TutorialProgress step counter", () => {
  it("doesn't shrink when bots or nations die off mid-tutorial", () => {
    const p = new TutorialProgress();
    // Pre-spawn ticks (nothing spawned yet) must not freeze the counter.
    p.update(ctx({ botsExist: false, nationsExist: false }));
    const before = ctx({ hasSpawned: true });
    p.update(before);
    const total = p.total(before);
    // Classic game: the grand strategy steps don't count.
    expect(total).toBe(
      TUTORIAL_STEPS.length - GS_ECONOMY_STEPS.length - GS_WAR_STEPS.length,
    );

    const after = ctx({
      hasSpawned: true,
      botsExist: false,
      nationsExist: false,
    });
    p.update(after);
    expect(p.total(after)).toBe(total);
    expect(p.position(after)).toBeGreaterThanOrEqual(1);
  });
});

describe("grand strategy tutorial steps", () => {
  const gsIds = [...GS_ECONOMY_STEPS, ...GS_WAR_STEPS].map((s) => s.id);

  it("classic games skip every grand strategy step", () => {
    const p = new TutorialProgress();
    const seen = new Set<string>();
    const c = ctx({ hasSpawned: true });
    for (let i = 0; i < 200 && !p.finished(); i++) {
      p.update(c);
      const id = p.current()?.id;
      if (id) seen.add(id);
      p.skip();
    }
    for (const id of gsIds) expect(seen.has(id)).toBe(false);
  });

  it("GS games explain the HUD after the first City, one idea per step", () => {
    const first = TUTORIAL_STEPS.findIndex((s) => s.id === "buy_city");
    const p = new TutorialProgress(TUTORIAL_STEPS.slice(first));
    const c = ctx({ grandStrategy: true, hasSpawned: true });
    settle(p, { ...c, cities: 1 });
    const order: string[] = [];
    while (p.current()?.id.startsWith("gs_")) {
      const s = p.current()!;
      expect(s.manual).toBe(true);
      order.push(s.id);
      p.acknowledge();
      settle(p, { ...c, cities: 1 });
    }
    expect(order).toEqual(GS_ECONOMY_STEPS.map((s) => s.id));
    expect(p.current()?.id).toBe("propose_alliance");
    // Each dock tab gets its highlight.
    const hl = GS_ECONOMY_STEPS.map((s) => s.highlight);
    for (const h of [
      "gs_resources",
      "gs_dock",
      "gs_economy",
      "gs_laws",
      "gs_focus",
      "gs_research",
      "gs_decisions",
    ]) {
      expect(hl).toContain(h);
    }
  });

  it("GS games cover war goals, peace, truce breaking, factions and puppets after alliances", () => {
    const i = TUTORIAL_STEPS.findIndex((s) => s.id === "alliance_info");
    expect(TUTORIAL_STEPS.slice(i + 1, i + 1 + GS_WAR_STEPS.length)).toEqual(
      GS_WAR_STEPS,
    );
    expect(GS_WAR_STEPS.map((s) => s.id)).toEqual([
      "gs_war_goal",
      "gs_peace",
      "gs_truce_break",
      "gs_factions",
      "gs_puppets",
    ]);
    for (const s of GS_WAR_STEPS) expect(s.highlight).toBe("gs_war");
    // Counted only in GS games.
    const p = new TutorialProgress();
    const gs = ctx({ hasSpawned: true, grandStrategy: true });
    p.update(gs);
    expect(p.total(gs)).toBe(TUTORIAL_STEPS.length);
  });

  it("every grand strategy step has English text", () => {
    const en = JSON.parse(readFileSync("resources/lang/en.json", "utf8"));
    for (const id of gsIds) {
      const text = en.tutorial.step[id];
      expect(typeof text, id).toBe("string");
      expect(text.length, id).toBeGreaterThan(20);
      expect(text.length, id).toBeLessThan(260);
    }
    expect(en.tutorial.step.gs_truce_break).toContain("traitor for 30 seconds");
  });
});

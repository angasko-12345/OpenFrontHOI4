import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { diffGsAlerts } from "../../src/client/hud/layers/gs/GsAlerts";

function upd(over: Partial<GrandStrategyUpdate> = {}): GrandStrategyUpdate {
  return {
    type: GameUpdateType.GrandStrategy,
    player: "me",
    equipment: 0,
    equipped: 0,
    efficiency: 0,
    factories: 0,
    focus: null,
    focusProgress: 0,
    completed: [],
    politicalPower: 0,
    warSupport: 0,
    conscriptionLaw: "",
    economyLaw: "",
    troopCapModifier: 0,
    advisors: [],
    activeDecisions: [],
    decisionCooldowns: [],
    civFactories: 0,
    civFree: 0,
    importSteel: 0,
    importOil: 0,
    artillery: 0,
    artilleryShare: 0,
    artillerySupport: 0,
    era: 1,
    researched: [],
    research: [],
    steel: 0,
    steelNeeded: 0,
    oil: 0,
    oilNeeded: 0,
    occupied: 0,
    occupationModifier: 0,
    justifying: null,
    warGoals: [],
    justifiedAgainstMe: [],
    coalitionLeader: null,
    atomicProjects: [],
    atomicPowers: [],
    weariness: 0,
    wars: [],
    peaceOffers: [],
    peaceOffersToMe: [],
    truces: [],
    peakTiles: 100,
    ideology: "nonaligned",
    ideologyCooldown: 0,
    ...over,
  };
}

const name = (id: string) => `N-${id}`;

describe("diffGsAlerts", () => {
  it("raises nothing on the first update or when nothing changed", () => {
    expect(
      diffGsAlerts(
        null,
        upd({ wars: [{ target: "a", seconds: 1, won: 0, lost: 0 }] }),
        name,
      ),
    ).toEqual([]);
    expect(diffGsAlerts(upd(), upd(), name)).toEqual([]);
  });

  it("reports a new war, a peace offer and a war goal on the War tab", () => {
    const a = diffGsAlerts(
      upd(),
      upd({
        wars: [{ target: "a", seconds: 1, won: 0, lost: 3 }],
        peaceOffersToMe: ["b"],
        justifiedAgainstMe: ["c"],
      }),
      name,
    );
    expect(a.map((x) => [x.kind, x.tab, x.target])).toEqual([
      ["war", "war", "a"],
      ["peace", "war", "b"],
      ["wargoal", "war", "c"],
    ]);
  });

  it("tells our capitulation, theirs and a plain truce apart", () => {
    const truce = [{ target: "a", seconds: 300, lock: 180 }];
    expect(
      diffGsAlerts(
        upd({ peakTiles: 100 }),
        upd({ peakTiles: 40, truces: truce }),
        name,
      )[0].kind,
    ).toBe("capitulation");
    const theirs = diffGsAlerts(
      upd(),
      upd({ truces: truce }),
      name,
      new Set(["a"]),
    )[0];
    expect([theirs.kind, theirs.tone]).toEqual(["capitulation", "good"]);
    expect(diffGsAlerts(upd(), upd({ truces: truce }), name)[0].kind).toBe(
      "truce",
    );
  });

  it("reports finished research and focuses on their tabs", () => {
    const a = diffGsAlerts(
      upd(),
      upd({ researched: ["atomic_project"], completed: ["x"] }),
      name,
    );
    expect(a.map((x) => [x.kind, x.tab])).toEqual([
      ["atomic", "research"],
      ["focus", "focus"],
    ]);
  });

  it("folds many atomic projects starting together into one alert", () => {
    const a = diffGsAlerts(
      upd(),
      upd({
        atomicProjects: [
          { player: "me", seconds: 240 },
          { player: "a", seconds: 240 },
          { player: "b", seconds: 240 },
        ],
      }),
      name,
    );
    expect(a).toHaveLength(1);
    expect(a[0].text).toBe("2 nations started atomic projects");
  });

  it("reports a truce that vanishes early as broken, not one that ran out", () => {
    const t = (seconds: number) => [{ target: "a", seconds, lock: 0 }];
    const broken = diffGsAlerts(upd({ truces: t(90) }), upd(), name);
    expect(broken.map((x) => [x.kind, x.text])).toEqual([
      ["trucebroken", "Truce with N-a broken"],
    ]);
    expect(diffGsAlerts(upd({ truces: t(1) }), upd(), name)).toEqual([]);
  });

  it("reports our ideology change", () => {
    const a = diffGsAlerts(
      upd(),
      upd({ ideology: "assembly", ideologyCooldown: 300 }),
      name,
    );
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("ideology");
    expect(a[0].tab).toBe("decisions");
    expect(diffGsAlerts(upd(), upd({ ideologyCooldown: 5 }), name)).toEqual([]);
  });
  it("reports a new revanche claim and when it becomes usable", () => {
    const truce = { target: "w", seconds: 300, lock: 100 };
    const claim = { target: "w", tiles: 40, seconds: 900, wait: 30 };
    const gained = diffGsAlerts(
      upd({ truces: [truce] }),
      upd({ truces: [truce], revanche: [claim] }),
      name,
    );
    expect(gained).toEqual([
      expect.objectContaining({ kind: "revanche", target: "w", tab: "war" }),
    ]);
    expect(gained[0].text).toContain("40 tiles");
    const ready = diffGsAlerts(
      upd({ truces: [truce], revanche: [claim] }),
      upd({ truces: [truce], revanche: [{ ...claim, wait: 0 }] }),
      name,
    );
    expect(ready.map((x) => x.text)).toEqual(["Revanche ready against N-w"]);
    // Counting down further raises nothing.
    expect(
      diffGsAlerts(
        upd({ truces: [truce], revanche: [{ ...claim, wait: 0 }] }),
        upd({ truces: [truce], revanche: [{ ...claim, wait: 0, seconds: 1 }] }),
        name,
      ),
    ).toEqual([]);
  });
});

describe("truce ends that are not breaks", () => {
  test("puppeting or elimination is not reported as a broken truce", () => {
    const prev = upd({ truces: [{ target: "b", seconds: 150, lock: 0 }] });
    const puppet = upd({ puppets: [{ id: "b", autonomy: 0, tribute: 250 }] });
    const kinds = (l: { kind: string }[]) => l.map((a) => a.kind);
    expect(kinds(diffGsAlerts(prev, puppet, name))).not.toContain(
      "trucebroken",
    );
    const gone = upd({ truces: [] });
    expect(
      kinds(diffGsAlerts(prev, gone, name, new Set(), () => false)),
    ).not.toContain("trucebroken");
    expect(kinds(diffGsAlerts(prev, gone, name))).toContain("trucebroken");
  });
});

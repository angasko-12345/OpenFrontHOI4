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
    const truce = [{ target: "a", seconds: 300 }];
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
});

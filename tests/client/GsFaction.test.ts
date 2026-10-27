// @vitest-environment jsdom
import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderFaction } from "../../src/client/hud/layers/GrandStrategyDiplomacy";
import { diffGsAlerts } from "../../src/client/hud/layers/gs/GsAlerts";

const name = (id: string) => `N-${id}`;
const base = {
  player: "me",
  politicalPower: 200,
} as unknown as GrandStrategyUpdate;

function mount(d: Partial<GrandStrategyUpdate>) {
  const el = document.createElement("div");
  const on = { found: vi.fn(), join: vi.fn(), leave: vi.fn() };
  render(renderFaction({ ...base, ...d } as GrandStrategyUpdate, name, on), el);
  return { el, on };
}

describe("GS faction HUD", () => {
  it("renders nothing when factions are off", () => {
    const { el } = mount({});
    expect(el.textContent?.trim()).toBe("");
  });

  it("offers Found and Join, with reasons when unavailable", () => {
    const { el, on } = mount({
      faction: null,
      canFound: "ok",
      factions: [
        {
          leader: "a",
          ideology: "commune",
          members: 2,
          share: 120,
          join: "ok",
        },
        {
          leader: "b",
          ideology: "assembly",
          members: 1,
          share: 50,
          join: "ideology",
        },
      ],
    });
    el.querySelector<HTMLButtonElement>(
      '[data-testid="gs-faction-found"]',
    )!.click();
    expect(on.found).toHaveBeenCalled();
    const joins = el.querySelectorAll<HTMLButtonElement>(
      '[data-testid="gs-faction-join"]',
    );
    expect(joins).toHaveLength(1);
    joins[0].click();
    expect(on.join).toHaveBeenCalledWith("a");
    expect(el.textContent).toContain("N-a Pact");
    expect(el.textContent).toContain("Other ideology");
  });

  it("shows our faction with members and Leave", () => {
    const { el, on } = mount({
      faction: { leader: "a", members: ["a", "me"], cap: 3, share: 180 },
      factions: [],
      canFound: "in_faction",
    });
    expect(
      el.querySelector('[data-testid="gs-faction-members"]')?.textContent,
    ).toContain("★ N-a");
    expect(el.textContent).toContain("2/3");
    el.querySelector<HTMLButtonElement>(
      '[data-testid="gs-faction-leave"]',
    )!.click();
    expect(on.leave).toHaveBeenCalled();
  });

  it("alerts on joining, new members and leaving", () => {
    const u = (f: GrandStrategyUpdate["faction"]) =>
      ({
        ...base,
        wars: [],
        truces: [],
        peaceOffersToMe: [],
        justifiedAgainstMe: [],
        researched: [],
        completed: [],
        coalitionLeader: null,
        factions: [],
        faction: f,
      }) as unknown as GrandStrategyUpdate;
    const f1 = { leader: "a", members: ["a", "me"], cap: 3, share: 100 };
    expect(diffGsAlerts(u(null), u(f1), name).map((x) => x.text)).toEqual([
      "We joined N-a's faction",
    ]);
    expect(
      diffGsAlerts(u(f1), u({ ...f1, members: ["a", "me", "c"] }), name).map(
        (x) => x.text,
      ),
    ).toEqual(["N-c joined our faction"]);
    expect(diffGsAlerts(u(f1), u(null), name).map((x) => x.kind)).toEqual([
      "faction",
    ]);
  });
});

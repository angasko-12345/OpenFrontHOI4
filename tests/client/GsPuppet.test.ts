// @vitest-environment jsdom
import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderPuppets } from "../../src/client/hud/layers/GrandStrategyDiplomacy";
import { diffGsAlerts } from "../../src/client/hud/layers/gs/GsAlerts";

const name = (id: string) => `N-${id}`;
const base = {
  player: "me",
  politicalPower: 200,
} as unknown as GrandStrategyUpdate;

function mount(d: Partial<GrandStrategyUpdate>) {
  const el = document.createElement("div");
  const on = { demand: vi.fn(), release: vi.fn(), independence: vi.fn() };
  render(renderPuppets({ ...base, ...d } as GrandStrategyUpdate, name, on), el);
  return { el, on };
}

const q = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

describe("GS puppet HUD", () => {
  it("renders nothing when puppets are off or there is no bond", () => {
    expect(mount({}).el.textContent?.trim()).toBe("");
    expect(
      mount({
        puppets: [],
        overlord: null,
        puppetWindows: [],
      }).el.textContent?.trim(),
    ).toBe("");
  });

  it("puppet view: overlord, tribute, autonomy bar and Independence", () => {
    const { el, on } = mount({
      overlord: "o",
      autonomy: 420,
      tribute: 180,
      independence: "too_early",
      puppets: [],
      puppetWindows: [],
    });
    expect(el.textContent).toContain("Puppet of N-o");
    expect(el.textContent).toContain("tribute 18%");
    expect(el.textContent).toContain("Autonomy 42%");
    const bar = el.querySelector('[data-testid="gs-autonomy-bar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    const btn = q(el, "gs-independence")!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Not yet");
    const ready = mount({
      overlord: "o",
      autonomy: 1000,
      tribute: 125,
      independence: "ok",
      puppets: [],
      puppetWindows: [],
    });
    const b2 = q(ready.el, "gs-independence")!;
    expect(b2.disabled).toBe(false);
    b2.click();
    expect(ready.on.independence).toHaveBeenCalled();
    expect(on.independence).not.toHaveBeenCalled();
  });

  it("overlord view: puppet rows with Release; windows with Puppet or a reason", () => {
    const { el, on } = mount({
      overlord: null,
      puppets: [{ id: "p", autonomy: 100, tribute: 200 }],
      puppetCap: 2,
      puppetWindows: [
        { target: "x", seconds: 42, check: "ok" },
        { target: "y", seconds: 10, check: "too_big" },
      ],
    });
    expect(el.textContent).toContain("Puppets 1/2");
    expect(el.textContent).toContain("tribute 20%");
    q(el, "gs-puppet-release")!.click();
    expect(on.release).toHaveBeenCalledWith("p");
    const demands = el.querySelectorAll<HTMLButtonElement>(
      '[data-testid="gs-puppet-demand"]',
    );
    expect(demands).toHaveLength(1);
    demands[0].click();
    expect(on.demand).toHaveBeenCalledWith("x");
    expect(el.textContent).toContain("42s");
    expect(el.textContent).toContain("Too big");
  });

  it("alerts: became a puppet, may break free, freed, gained/lost puppets, windows", () => {
    const u = (d: Partial<GrandStrategyUpdate>) =>
      ({
        ...base,
        wars: [],
        truces: [],
        peaceOffersToMe: [],
        justifiedAgainstMe: [],
        researched: [],
        completed: [],
        coalitionLeader: null,
        puppets: [],
        overlord: null,
        puppetWindows: [],
        independence: "not_puppet",
        ...d,
      }) as unknown as GrandStrategyUpdate;
    const texts = (a: GrandStrategyUpdate, b: GrandStrategyUpdate) =>
      diffGsAlerts(a, b, name).map((x) => x.text);
    const bound = u({ overlord: "o", independence: "too_early" });
    expect(texts(u({}), bound)).toEqual(["We are now a puppet of N-o"]);
    expect(texts(bound, u({ overlord: "o", independence: "ok" }))).toEqual([
      "We may break free of N-o",
    ]);
    expect(texts(bound, u({}))).toEqual(["We are free of N-o"]);
    const p = { id: "p", autonomy: 0, tribute: 250 };
    expect(texts(u({}), u({ puppets: [p] }))).toEqual([
      "N-p is now our puppet",
    ]);
    expect(texts(u({ puppets: [p] }), u({}))).toEqual([
      "N-p is no longer our puppet",
    ]);
    expect(
      texts(
        u({}),
        u({ puppetWindows: [{ target: "x", seconds: 60, check: "ok" }] }),
      ),
    ).toEqual(["N-x is beaten: make it our puppet?"]);
    // Puppets off: no puppet alerts.
    expect(
      diffGsAlerts(
        { ...u({}), puppets: undefined } as GrandStrategyUpdate,
        { ...bound, puppets: undefined } as GrandStrategyUpdate,
        name,
      ).filter((x) => x.kind === "puppet"),
    ).toEqual([]);
  });
});

// @vitest-environment jsdom
import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { BREAK_PP_COST } from "@openfront/engine-lib/game/GrandStrategyPeace";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  GS_TRAITOR_SECONDS,
  renderTruces,
  truceRulesNote,
} from "../../src/client/hud/layers/GrandStrategyDiplomacy";
import { diffGsAlerts } from "../../src/client/hud/layers/gs/GsAlerts";

// M7E: truce breaking makes the breaker a traitor for 30 s.
const name = (id: string) => `N-${id}`;
const base = {
  player: "me",
  politicalPower: BREAK_PP_COST / 1000,
  truces: [],
} as unknown as GrandStrategyUpdate;

function mount(d: Partial<GrandStrategyUpdate>) {
  const el = document.createElement("div");
  const onBreak = vi.fn();
  render(
    renderTruces({ ...base, ...d } as GrandStrategyUpdate, name, onBreak),
    el,
  );
  return { el, onBreak };
}
const q = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, " ") ?? "";

describe("GS truce rows (M7E traitor)", () => {
  it("a locked truce says when it becomes breakable", () => {
    const { el } = mount({ truces: [{ target: "x", seconds: 200, lock: 80 }] });
    expect(text(el)).toContain("breakable in 80s");
    expect(q(el, "gs-break-truce")).toBeNull();
  });

  it("a breakable truce has a Break button with the traitor warning", () => {
    const { el, onBreak } = mount({
      truces: [{ target: "x", seconds: 90, lock: 0 }],
    });
    const btn = q(el, "gs-break-truce")!;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain(`${BREAK_PP_COST / 1000} PP`);
    expect(btn.title).toContain(`traitor for ${GS_TRAITOR_SECONDS}s`);
    expect(q(el, "gs-break-warning")!.textContent).toContain(
      "You'll be a traitor for 30s",
    );
    btn.click();
    expect(onBreak).toHaveBeenCalledWith("x");
  });

  it("Break is disabled without the political power", () => {
    const { el } = mount({
      politicalPower: BREAK_PP_COST / 1000 - 1,
      truces: [{ target: "x", seconds: 90, lock: 0 }],
    });
    expect(q(el, "gs-break-truce")!.disabled).toBe(true);
  });

  it("our traitor countdown shows as a banner", () => {
    expect(q(mount({}).el, "gs-traitor")).toBeNull();
    expect(q(mount({ traitorSeconds: 0 }).el, "gs-traitor")).toBeNull();
    const { el } = mount({ traitorSeconds: 21 });
    expect(q(el, "gs-traitor")!.textContent).toContain("Traitor 21s");
  });

  it("the rules note names the window and the traitor mark", () => {
    const note = truceRulesNote();
    expect(note).toContain("last 2 min");
    expect(note).toContain("traitor for 30s");
    expect(note).not.toContain("weariness");
  });
});

describe("GS traitor alert", () => {
  const u = (traitorSeconds?: number) =>
    ({
      ...base,
      peakTiles: 100,
      completed: [],
      researched: [],
      research: [],
      wars: [],
      warGoals: [],
      justifiedAgainstMe: [],
      peaceOffers: [],
      peaceOffersToMe: [],
      atomicProjects: [],
      atomicPowers: [],
      coalitionLeader: null,
      focus: null,
      ideology: "nonaligned",
      traitorSeconds,
    }) as unknown as GrandStrategyUpdate;
  it("fires once when we become a traitor", () => {
    const a = diffGsAlerts(u(0), u(30), name);
    expect(a.map((x) => x.kind)).toEqual(["traitor"]);
    expect(a[0].text).toContain("traitor for 30s");
    expect(a[0].tone).toBe("danger");
    expect(diffGsAlerts(u(30), u(29), name)).toEqual([]);
    expect(diffGsAlerts(u(undefined), u(30), name)).toHaveLength(1);
    expect(diffGsAlerts(u(1), u(0), name)).toEqual([]);
  });
});

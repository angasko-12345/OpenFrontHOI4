// @vitest-environment jsdom
import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { GsTab } from "../../src/client/hud/layers/gs/GsAlerts";
import {
  GS_TABS,
  GsTabMeta,
  renderGsDock,
} from "../../src/client/hud/layers/gs/GsDock";
import { GsIconName } from "../../src/client/hud/layers/gs/GsIcons";
import {
  GS_LEGEND,
  GS_TAB_DESC,
  legendIcons,
  renderGsLegend,
} from "../../src/client/hud/layers/gs/GsLegend";
import { renderGsResourceBar } from "../../src/client/hud/layers/gs/GsResourceBar";

// M7E: every dock tab, resource icon and HUD icon explains itself.
const meta = Object.fromEntries(
  GS_TABS.map((t) => [t.id, { badge: "none" }]),
) as Record<GsTab, GsTabMeta>;

function dock(over: Partial<Parameters<typeof renderGsDock>[0]> = {}) {
  const el = document.createElement("div");
  const on = { tab: vi.fn(), close: vi.fn(), legend: vi.fn() };
  render(
    renderGsDock(
      {
        tab: "war",
        meta,
        wide: false,
        bottomInset: 0,
        title: "War & Diplomacy",
        subtitle: "0 wars",
        onTab: on.tab,
        onClose: on.close,
        onLegend: on.legend,
        ...over,
      },
      over.legendOpen ? renderGsLegend() : html`<div>body</div>`,
    ),
    el,
  );
  return { el, on };
}
const q = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("GS dock labels and descriptions", () => {
  it("every tab has a visible text label and a tooltip with its meaning", () => {
    const { el } = dock();
    for (const t of GS_TABS) {
      const b = q(el, `gs-tab-${t.id}`)!;
      expect(b.textContent).toContain(t.label);
      expect(b.title).toContain(t.label);
      expect(b.title).toContain(GS_TAB_DESC[t.id]);
      expect(b.getAttribute("aria-label")).toBe(t.label);
    }
  });

  it("each tab opens with its one-line description", () => {
    for (const t of GS_TABS) {
      const { el } = dock({ tab: t.id });
      expect(q(el, "gs-tab-desc")!.textContent?.trim()).toBe(GS_TAB_DESC[t.id]);
      expect(GS_TAB_DESC[t.id].length).toBeLessThanOrEqual(80);
    }
  });

  it("the ? button toggles the legend, which replaces the tab body", () => {
    const { el, on } = dock();
    const btn = q(el, "gs-legend-toggle")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.click();
    expect(on.legend).toHaveBeenCalledOnce();
    const open = dock({ legendOpen: true }).el;
    expect(q(open, "gs-legend")).not.toBeNull();
    expect(q(open, "gs-tab-desc")).toBeNull();
    expect(q(open, "gs-legend-toggle")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(open.textContent).toContain("Legend");
  });

  it("the tutorial's tab gets the pulsing highlight", () => {
    const { el } = dock({ highlightTab: "research" });
    expect(q(el, "gs-tab-research")!.className).toContain("tutorial-highlight");
    expect(q(el, "gs-tab-war")!.className).not.toContain("tutorial-highlight");
  });
});

describe("GS icon legend", () => {
  it("lists every icon the HUD shows, each with a label and meaning", () => {
    const shown: GsIconName[] = [
      ...GS_TABS.map((t) => t.icon),
      "gold",
      "pp",
      "manpower",
      "equipment",
      "artillery",
      "steel",
      "oil",
      "weariness",
      "research",
      "command",
      "down",
      "close",
      "war",
      "peace",
      "atomic",
    ];
    const covered = legendIcons();
    for (const i of shown) expect(covered.has(i), i).toBe(true);
    for (const s of GS_LEGEND) {
      for (const e of s.entries) {
        expect(e.label.length).toBeGreaterThan(0);
        expect(e.text.length).toBeGreaterThan(5);
      }
    }
    const el = document.createElement("div");
    render(renderGsLegend(), el);
    const rows = el.querySelectorAll('[data-testid^="gs-legend-"]');
    expect(rows.length).toBe(GS_LEGEND.flatMap((s) => s.entries).length);
    // Icons in the legend are labelled images, not decoration.
    const svg = q(el, "gs-legend-oil")!.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Oil");
  });
});

describe("GS resource bar", () => {
  const items = [
    {
      key: "oil",
      icon: "oil" as const,
      label: "Oil",
      value: "3/4",
      tone: "bad" as const,
      detail: ["3 available, 4 needed per second"],
    },
  ];
  function bar(highlight?: "bar" | "dock" | null) {
    const el = document.createElement("div");
    const h = { detail: vi.fn(), toggleDock: vi.fn() };
    render(
      renderGsResourceBar(
        items,
        { openDetail: null, dockOpen: false, attention: "none", highlight },
        h,
      ),
      el,
    );
    return { el, h };
  }

  it("chips have a tooltip, and tap or long-press opens their detail", () => {
    const { el, h } = bar();
    const chip = q(el, "gs-res-oil")!;
    expect(chip.title).toContain("Oil");
    expect(chip.title).toContain("needed per second");
    chip.click();
    expect(h.detail).toHaveBeenCalledWith("oil");
    chip.dispatchEvent(new Event("contextmenu", { cancelable: true }));
    expect(h.detail).toHaveBeenLastCalledWith("oil");
  });

  it("the command chip is labelled and can be highlighted", () => {
    const { el } = bar("dock");
    const t = q(el, "gs-dock-toggle")!;
    expect(t.textContent).toContain("Cmd");
    expect(t.className).toContain("tutorial-highlight");
    const b = bar("bar").el;
    expect(b.querySelector('[role="toolbar"]')!.className).toContain(
      "tutorial-highlight",
    );
  });
});

describe("GS panel and the tutorial", () => {
  it("a tab step opens that tab; bar and Cmd steps only highlight", async () => {
    const { GrandStrategyPanel } =
      await import("../../src/client/hud/layers/GrandStrategyPanel");
    const p = new GrandStrategyPanel() as unknown as {
      onTutorialHighlight: (t: string | null) => void;
      tab: GsTab | null;
      legendOpen: boolean;
      tutorialHighlight: string | null;
    };
    p.tab = null;
    p.legendOpen = true;
    p.onTutorialHighlight("gs_laws");
    expect(p.tab).toBe("laws");
    expect(p.legendOpen).toBe(false);
    p.onTutorialHighlight("gs_resources");
    expect(p.tab).toBe("laws");
    expect(p.tutorialHighlight).toBe("gs_resources");
    p.onTutorialHighlight("city");
    expect(p.tab).toBe("laws");
    p.onTutorialHighlight(null);
    expect(p.tutorialHighlight).toBeNull();
  });
});

// @vitest-environment jsdom
import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderInfoHint } from "../../src/client/hud/layers/GrandStrategyDiplomacy";

describe("GS info hint", () => {
  it("shows only the one-line hint until toggled", () => {
    const el = document.createElement("div");
    const toggle = vi.fn();
    render(
      renderInfoHint(
        "peace",
        "Short hint.",
        html`Long rules text.`,
        false,
        toggle,
      ),
      el,
    );
    expect(el.textContent).toContain("Short hint.");
    expect(el.textContent).not.toContain("Long rules text.");
    const btn = el.querySelector<HTMLButtonElement>(
      '[data-testid="gs-info-toggle-peace"]',
    )!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.click();
    expect(toggle).toHaveBeenCalledWith("peace");
  });

  it("keeps the full detail reachable when open", () => {
    const el = document.createElement("div");
    render(
      renderInfoHint(
        "peace",
        "Short hint.",
        html`Long rules text.`,
        true,
        () => {},
      ),
      el,
    );
    expect(
      el.querySelector('[data-testid="gs-info-detail-peace"]')?.textContent,
    ).toContain("Long rules text.");
    expect(
      el
        .querySelector('[data-testid="gs-info-toggle-peace"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

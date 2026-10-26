import { html, svg, SVGTemplateResult, TemplateResult } from "lit";

/**
 * Inline line icons for the Grand Strategy HUD. Original simple geometry on
 * a 24x24 grid, stroked in currentColor, so no image assets are needed and
 * the icons take the text colour (warnings tint them too).
 */
export type GsIconName =
  | "gold"
  | "pp"
  | "manpower"
  | "equipment"
  | "artillery"
  | "steel"
  | "oil"
  | "weariness"
  | "research"
  | "economy"
  | "laws"
  | "focus"
  | "decisions"
  | "war"
  | "command"
  | "close"
  | "down"
  | "atomic"
  | "peace";

const PATHS: Record<GsIconName, SVGTemplateResult> = {
  gold: svg`<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/>`,
  pp: svg`<path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z"/>`,
  manpower: svg`<circle cx="12" cy="7" r="3.5"/><path d="M5 21c0-4 3-7 7-7s7 3 7 7"/>`,
  equipment: svg`<rect x="3.5" y="7" width="17" height="12" rx="1"/><path d="M3.5 11h17M9 7v4M15 7v4"/>`,
  artillery: svg`<circle cx="8" cy="17" r="3"/><path d="M10 15L21 7M3 21h10"/>`,
  steel: svg`<path d="M2.5 18h19l-3.5-8h-12z"/><path d="M7 10l1.5-3h7l1.5 3"/>`,
  oil: svg`<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>`,
  weariness: svg`<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/><path d="M12.5 8.5l-2 3.5 3 1.5-2 3.5"/>`,
  research: svg`<path d="M9 3h6M10 3v6l-5.4 9.3A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.6-2.7L14 9V3"/><path d="M7.5 15h9"/>`,
  economy: svg`<path d="M3 21V11l6 3.5V11l6 3.5V5h4.5v16z"/><path d="M3 21h18"/>`,
  laws: svg`<path d="M12 4v16M7.5 20h9M5 7.5h14"/><path d="M5 7.5l-2.5 6h5zM19 7.5l-2.5 6h5z"/>`,
  focus: svg`<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8"/>`,
  decisions: svg`<path d="M13 2.5L4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>`,
  war: svg`<path d="M4 4l11 11M20 4L9 15M13.5 17.5l4-4M10.5 17.5l-4-4M3.5 20.5l3-3M20.5 20.5l-3-3"/>`,
  command: svg`<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>`,
  close: svg`<path d="M6 6l12 12M18 6L6 18"/>`,
  down: svg`<path d="M6 9l6 6 6-6"/>`,
  atomic: svg`<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(-60 12 12)"/>`,
  peace: svg`<path d="M4 13l4 4 4-3 4 3 4-4"/><path d="M8 17l-2 3M16 17l2 3M12 14V5"/>`,
};

/** An icon at `size` px (default 16), decorative unless a label is given. */
export function gsIcon(
  name: GsIconName,
  size = 16,
  label?: string,
): TemplateResult {
  return html`<svg
    viewBox="0 0 24 24"
    width=${size}
    height=${size}
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0"
    role=${label ? "img" : "presentation"}
    aria-hidden=${label ? "false" : "true"}
    aria-label=${label ?? ""}
  >
    ${PATHS[name]}
  </svg>`;
}

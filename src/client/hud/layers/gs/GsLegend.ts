import { html, TemplateResult } from "lit";
import { GsTab } from "./GsAlerts";
import { renderGsGuide } from "./GsGuide";
import { gsIcon, GsIconName } from "./GsIcons";

/**
 * M7E: what every Grand Strategy icon means. One source for the dock's
 * "?" legend, the one-line description at the top of each tab, and the
 * tooltips on the dock tabs, so the three never disagree.
 */

/** One-line description shown at the top of each dock tab. */
export const GS_TAB_DESC: Readonly<Record<GsTab, string>> = {
  economy: "Factories, equipment, steel and oil: what your army fights with.",
  laws: "Spend political power on conscription and economy laws.",
  focus: "Pick a national focus; it completes over time for a lasting bonus.",
  research: "Research technologies for permanent bonuses and new eras.",
  decisions: "Advisors, decisions and ideology, paid in political power.",
  war: "War goals, peace and truces, factions and puppets.",
};

export interface GsLegendEntry {
  icon: GsIconName;
  label: string;
  text: string;
}

export interface GsLegendSection {
  title: string;
  entries: readonly GsLegendEntry[];
}

export const GS_LEGEND: readonly GsLegendSection[] = [
  {
    title: "Resource bar (tap or hover a chip for details)",
    entries: [
      { icon: "gold", label: "Gold", text: "Money for buildings and units." },
      {
        icon: "pp",
        label: "Political power (PP)",
        text: "Pays for laws, focuses, war goals, decisions and diplomacy.",
      },
      {
        icon: "manpower",
        label: "Manpower",
        text: "Troops now and the most you can hold.",
      },
      {
        icon: "equipment",
        label: "Equipment",
        text: "Made by military factories; % of the army equipped.",
      },
      {
        icon: "artillery",
        label: "Artillery",
        text: "Share of the army with gun support.",
      },
      {
        icon: "steel",
        label: "Steel",
        text: "Have / need per second; a shortage slows production.",
      },
      {
        icon: "oil",
        label: "Oil",
        text: "Have / need per second; a shortage makes attacks costlier.",
      },
      {
        icon: "weariness",
        label: "War weariness",
        text: "Rises in long, costly wars; ▲ means rising.",
      },
      {
        icon: "research",
        label: "Research",
        text: "Research slots in use.",
      },
    ],
  },
  {
    title: "Command panel tabs (F1-F6)",
    entries: [
      { icon: "economy", label: "Economy", text: GS_TAB_DESC.economy },
      { icon: "laws", label: "Laws", text: GS_TAB_DESC.laws },
      { icon: "focus", label: "Focus", text: GS_TAB_DESC.focus },
      { icon: "research", label: "Research", text: GS_TAB_DESC.research },
      { icon: "decisions", label: "Decisions", text: GS_TAB_DESC.decisions },
      { icon: "war", label: "War", text: GS_TAB_DESC.war },
    ],
  },
  {
    title: "Alerts and controls",
    entries: [
      {
        icon: "command",
        label: "Cmd",
        text: "Opens the command panel (` key).",
      },
      { icon: "down", label: "Minimize", text: "Hides the command panel." },
      {
        icon: "war",
        label: "War alert",
        text: "War, broken truce, war goal, coalition or traitor.",
      },
      {
        icon: "peace",
        label: "Diplomacy alert",
        text: "Peace offer, truce, faction or puppet news.",
      },
      {
        icon: "atomic",
        label: "Atomic",
        text: "Atomic project: nukes need it under grand strategy.",
      },
      { icon: "close", label: "Dismiss", text: "Closes an alert." },
    ],
  },
];

/** Every icon name the legend explains (tests check none is missing). */
export function legendIcons(): Set<GsIconName> {
  return new Set(GS_LEGEND.flatMap((s) => s.entries.map((e) => e.icon)));
}

/** The "?" panel: the plain-language guide, then every icon's meaning. */
export function renderGsLegend(): TemplateResult {
  return html`<div class="mt-1 space-y-2" data-testid="gs-legend">
    ${renderGsGuide()}
    ${GS_LEGEND.map(
      (s) =>
        html`<div>
          <div class="mb-0.5 font-semibold">${s.title}</div>
          ${s.entries.map(
            (e) =>
              html`<div
                class="flex items-start gap-2 py-0.5"
                data-testid="gs-legend-${e.icon}"
              >
                ${gsIcon(e.icon, 16, e.label)}
                <span class="min-w-0"
                  ><span class="font-semibold">${e.label}</span>
                  <span class="opacity-80">${e.text}</span></span
                >
              </div>`,
          )}
        </div>`,
    )}
  </div>`;
}

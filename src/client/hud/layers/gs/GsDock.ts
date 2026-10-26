import { html, nothing, TemplateResult } from "lit";
import { GsTab } from "./GsAlerts";
import { gsIcon, GsIconName } from "./GsIcons";

export interface GsTabDef {
  id: GsTab;
  label: string;
  icon: GsIconName;
  /** KeyboardEvent.code of its hotkey. Upstream binds no function keys. */
  key: string;
}

export const GS_TABS: readonly GsTabDef[] = [
  { id: "economy", label: "Economy", icon: "economy", key: "F1" },
  { id: "laws", label: "Laws", icon: "laws", key: "F2" },
  { id: "focus", label: "Focus", icon: "focus", key: "F3" },
  { id: "research", label: "Research", icon: "research", key: "F4" },
  { id: "decisions", label: "Decisions", icon: "decisions", key: "F5" },
  { id: "war", label: "War", icon: "war", key: "F6" },
];

/** Toggles the dock (reopens the last tab). Upstream does not bind it. */
export const GS_DOCK_KEY = "Backquote";

export type GsBadge = "none" | "info" | "danger" | "good";

export interface GsTabMeta {
  badge: GsBadge;
  /** 0..100, drawn as a thin bar under the tab (focus/research progress). */
  progress?: number;
}

const BADGE: Record<GsBadge, string> = {
  none: "",
  info: "bg-amber-400",
  danger: "bg-red-500",
  good: "bg-emerald-400",
};

/** Horizontal progress bar. `pct` 0..100. */
export function gsBar(
  pct: number,
  color = "bg-sky-400",
  testid?: string,
): TemplateResult {
  const w = Math.max(0, Math.min(100, Math.floor(pct)));
  return html`<div
    class="h-1.5 w-full overflow-hidden rounded bg-white/15"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${w}
    data-testid=${testid ?? ""}
  >
    <div class="h-full rounded ${color}" style="width:${w}%"></div>
  </div>`;
}

export interface GsDockOptions {
  tab: GsTab;
  meta: Record<GsTab, GsTabMeta>;
  /** Side dock on wide screens; bottom sheet otherwise. */
  wide: boolean;
  /** Px from the viewport bottom to sit above (upstream control panel). */
  bottomInset: number;
  title: string;
  /** Short line next to the title (e.g. PP for laws). */
  subtitle?: TemplateResult | string;
  onTab: (t: GsTab) => void;
  onClose: () => void;
}

/**
 * The command card: tab content above a strip of icon tabs. Phones get a
 * full-width bottom sheet capped at 42% of the height, so the map centre
 * stays visible; wide screens a 380px dock at the bottom-left corner,
 * which upstream leaves empty from 1280px up.
 */
export function renderGsDock(
  o: GsDockOptions,
  content: TemplateResult | typeof nothing,
): TemplateResult {
  const pos = o.wide
    ? "left-2 bottom-2 w-[380px]"
    : "inset-x-0 sm:inset-x-auto sm:left-2 sm:w-[440px] sm:rounded-t-lg rounded-t-lg";
  const style = o.wide ? "" : `bottom:${Math.max(0, o.bottomInset)}px`;
  const maxH = o.wide ? "max-h-[min(62vh,560px)]" : "max-h-[42vh]";
  return html`<div
    class="pointer-events-auto fixed z-[890] flex flex-col overflow-hidden bg-gray-900/95 text-white shadow-2xl backdrop-blur-sm ${pos} ${
      o.wide ? "rounded-lg" : ""
    }"
    style=${style}
    data-testid="gs-dock"
    data-tab=${o.tab}
  >
    <div class="flex min-h-10 items-center gap-2 border-b border-white/10 px-2">
      <span class="font-bold">${o.title}</span>
      <span class="min-w-0 flex-1 truncate text-xs opacity-80"
        >${o.subtitle ?? ""}</span
      >
      <button
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded hover:bg-white/10"
        aria-label="Minimize"
        data-testid="gs-dock-close"
        @click=${() => o.onClose()}
      >
        ${gsIcon("down", 18)}
      </button>
    </div>
    <div
      class="gs-dock-content min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 text-sm sm:text-xs ${maxH}"
    >
      ${content}
    </div>
    <div
      class="grid grid-cols-6 border-t border-white/10 bg-black/30"
      role="tablist"
    >
      ${GS_TABS.map((t) => {
        const m = o.meta[t.id];
        const active = t.id === o.tab;
        return html`<button
          class="relative flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 text-[10px] leading-none ${
            active
              ? "bg-blue-800 text-white"
              : "text-white/75 hover:bg-white/10"
          }"
          role="tab"
          aria-selected=${active ? "true" : "false"}
          aria-label=${t.label}
          title="${t.label} (${t.key})"
          data-testid="gs-tab-${t.id}"
          @click=${() => o.onTab(t.id)}
        >
          ${gsIcon(t.icon, 18)}
          <span class="max-w-full truncate px-0.5"
            >${t.label}${
              o.wide
                ? html`<span class="ml-0.5 opacity-50">${t.key}</span>`
                : nothing
            }</span
          >
          ${
            m.badge !== "none"
              ? html`<span
                  class="absolute right-2 top-1.5 h-2 w-2 rounded-full ${BADGE[m.badge]}"
                ></span>`
              : nothing
          }
          ${
            m.progress !== undefined
              ? html`<span class="absolute inset-x-1 bottom-0.5"
                  >${gsBar(m.progress, "bg-sky-400")}</span
                >`
              : nothing
          }
        </button>`;
      })}
    </div>
  </div>`;
}

import { html, nothing, TemplateResult } from "lit";
import { gsIcon, GsIconName } from "./GsIcons";

export type GsTone = "normal" | "warn" | "bad" | "good";

/** One chip on the top resource bar. */
export interface GsResource {
  key: string;
  icon: GsIconName;
  label: string;
  value: string;
  tone: GsTone;
  /** Small mark after the value, e.g. a rising-trend arrow. */
  mark?: string;
  /** Lines shown in the tap / long-press detail popover. */
  detail: string[];
}

const TONE_TEXT: Record<GsTone, string> = {
  normal: "text-white",
  warn: "text-amber-300",
  bad: "text-red-400",
  good: "text-emerald-300",
};

export interface GsBarHandlers {
  /** Tap on a chip: toggle its detail popover. */
  detail: (key: string | null) => void;
  /** The command-panel toggle chip. */
  toggleDock: () => void;
}

export interface GsBarState {
  openDetail: string | null;
  dockOpen: boolean;
  /** Dot on the command chip: something wants attention in a tab. */
  attention: "none" | "info" | "danger" | "good";
}

const DOT: Record<GsBarState["attention"], string> = {
  none: "",
  info: "bg-amber-400",
  danger: "bg-red-500",
  good: "bg-emerald-400",
};

/**
 * Slim always-on resource bar. Phones: a 5x2 grid of 40px chips under the
 * upstream top sidebars; wider screens: one centred row.
 */
export function renderGsResourceBar(
  items: readonly GsResource[],
  st: GsBarState,
  h: GsBarHandlers,
): TemplateResult {
  const open = items.find((i) => i.key === st.openDetail);
  return html`<div
    class="pointer-events-none fixed inset-x-1 top-[44px] z-[890] flex flex-col items-center
      sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
    data-testid="gs-bar"
  >
    <div
      class="pointer-events-auto grid w-full grid-cols-5 gap-0.5 rounded-md bg-gray-900/88 p-0.5 text-white shadow-lg backdrop-blur-sm
        sm:flex sm:w-auto sm:flex-nowrap"
      role="toolbar"
      aria-label="Grand Strategy resources"
    >
      ${items.map(
        (i) =>
          html`<button
            class="flex h-10 min-w-0 items-center justify-center gap-1 rounded px-1 text-[12px] font-semibold tabular-nums leading-none
              sm:h-8 sm:justify-start sm:px-2 ${
              st.openDetail === i.key ? "bg-white/15" : "hover:bg-white/10"
            } ${TONE_TEXT[i.tone]}"
            title="${i.label}: ${i.detail.join(" · ")}"
            aria-label="${i.label} ${i.value}"
            aria-expanded=${st.openDetail === i.key ? "true" : "false"}
            data-testid="gs-res-${i.key}"
            @click=${() => h.detail(st.openDetail === i.key ? null : i.key)}
            @contextmenu=${(e: Event) => {
              // Long-press on touch fires contextmenu: show the detail.
              e.preventDefault();
              h.detail(i.key);
            }}
          >
            ${gsIcon(i.icon, 15)}
            <span class="truncate">${i.value}</span>
            ${
              i.mark
                ? html`<span class="text-[10px]" aria-hidden="true"
                    >${i.mark}</span
                  >`
                : nothing
            }
          </button>`,
      )}
      <button
        class="relative flex h-10 min-w-0 items-center justify-center gap-1 rounded px-1 text-[12px] font-semibold
          sm:h-8 sm:px-2 ${st.dockOpen ? "bg-blue-700" : "bg-blue-900/70 hover:bg-blue-800"}"
        aria-label=${st.dockOpen ? "Hide command panel" : "Open command panel"}
        aria-expanded=${st.dockOpen ? "true" : "false"}
        title="Command panel (\`)"
        data-testid="gs-dock-toggle"
        @click=${() => h.toggleDock()}
      >
        ${gsIcon(st.dockOpen ? "down" : "command", 15)}
        <span class="sm:hidden">${st.dockOpen ? "Hide" : "Cmd"}</span>
        ${
          st.attention !== "none" && !st.dockOpen
            ? html`<span
                class="absolute right-1 top-1 h-2 w-2 rounded-full ${DOT[st.attention]}"
              ></span>`
            : nothing
        }
      </button>
    </div>
    ${
      open
        ? html`<div
            class="pointer-events-auto mt-1 w-full max-w-xs rounded-md bg-gray-900/95 px-3 py-2 text-xs text-white shadow-lg sm:w-72"
            data-testid="gs-res-detail"
            @click=${() => h.detail(null)}
          >
            <div
              class="mb-1 flex items-center gap-2 font-semibold ${TONE_TEXT[open.tone]}"
            >
              ${gsIcon(open.icon, 14)} ${open.label}
              <span class="ml-auto tabular-nums">${open.value}</span>
            </div>
            ${open.detail.map((l) => html`<div class="opacity-85">${l}</div>`)}
          </div>`
        : nothing
    }
  </div>`;
}

import { FocusID } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  GrandStrategyUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  availableFocuses,
  canStartFocus,
  focusById,
  FOCUS_TREE,
  NationGsState,
} from "@openfront/engine-lib/game/GrandStrategy";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { SendSetFocusIntentEvent } from "../../Transport";
import { GameView } from "../../view";

/**
 * Grand Strategy HUD: the local nation's military industry, equipment
 * stockpile and national focus tree. Reads GrandStrategy updates; picking a
 * focus sends a set_focus intent.
 */
@customElement("grand-strategy-panel")
export class GrandStrategyPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private data: GrandStrategyUpdate | null = null;
  /** Whole panel expanded. Phones start collapsed to a small chip. */
  @state() private expanded =
    typeof window === "undefined" || window.innerWidth >= 640;
  @state() private showFocuses = false;

  createRenderRoot() {
    return this;
  }

  init() {}

  tick() {
    const me = this.game?.myPlayer();
    if (!me) return;
    const updates = this.game.updatesSinceLastTick();
    const list = updates?.[GameUpdateType.GrandStrategy] ?? [];
    for (const u of list) {
      if (u.player === me.id()) this.data = u;
    }
  }

  private pick(id: FocusID) {
    this.eventBus.emit(new SendSetFocusIntentEvent(id));
    // On phones, get the list out of the way once a focus is picked.
    if (typeof window !== "undefined" && window.innerWidth < 640) {
      this.showFocuses = false;
    }
  }

  render() {
    const d = this.data;
    if (d === null) return nothing;
    const state: NationGsState = {
      equipment: d.equipment,
      efficiency: d.efficiency,
      focus: d.focus,
      focusProgress: d.focusProgress,
      completed: d.completed,
    };
    const current = d.focus === null ? undefined : focusById(d.focus);
    const canPick = d.focus === null && availableFocuses(state).length > 0;
    const pct = (permille: number) => `${Math.floor(permille / 10)}%`;
    const equippedColor =
      d.equipped >= 900
        ? "text-green-400"
        : d.equipped >= 500
          ? "text-yellow-400"
          : "text-red-400";

    if (!this.expanded) {
      // Collapsed chip: left edge, mid-height, clear of the top sidebars
      // and the bottom control panel. 44px tall for a comfortable tap.
      return html`
        <button
          class="fixed left-0 top-1/3 z-[900] flex h-11 min-w-11 items-center gap-1 rounded-r-lg bg-gray-800/92 px-2 text-xs text-white shadow-lg pointer-events-auto"
          aria-label="Open Grand Strategy"
          @click=${() => (this.expanded = true)}
        >
          <span aria-hidden="true">⚙</span>
          <span class=${equippedColor}>${pct(d.equipped)}</span>
          ${
            canPick
              ? html`<span
                  class="h-2 w-2 rounded-full bg-yellow-400"
                  title="Pick a focus"
                ></span>`
              : nothing
          }
        </button>
      `;
    }

    return html`
      <div
        class="fixed z-[900] rounded-lg bg-gray-800/95 p-2 text-sm text-white shadow-lg pointer-events-auto
          inset-x-2 top-14 max-h-[65vh] overflow-y-auto
          sm:inset-x-auto sm:left-2 sm:top-1/4 sm:w-72 sm:max-h-[60vh] sm:text-xs"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="font-bold">Grand Strategy</span>
          <div class="flex gap-1">
            <button
              class="min-h-9 rounded bg-gray-700 px-3 hover:bg-gray-600 sm:min-h-0 sm:px-2"
              @click=${() => (this.showFocuses = !this.showFocuses)}
            >
              ${this.showFocuses ? "Hide focuses" : "Focuses"}
              ${
                canPick && !this.showFocuses
                  ? html`<span
                      class="ml-1 inline-block h-2 w-2 rounded-full bg-yellow-400"
                    ></span>`
                  : nothing
              }
            </button>
            <button
              class="min-h-9 min-w-9 rounded bg-gray-700 px-2 hover:bg-gray-600 sm:min-h-0 sm:min-w-0"
              aria-label="Minimize"
              @click=${() => {
                this.expanded = false;
                this.showFocuses = false;
              }}
            >
              –
            </button>
          </div>
        </div>
        <div class="mt-1 grid grid-cols-2 gap-x-2">
          <span>Equipment</span>
          <span class="text-right">${renderTroops(d.equipment)}</span>
          <span>Equipped</span>
          <span class="text-right ${equippedColor}">${pct(d.equipped)}</span>
          <span>Mil. factories</span>
          <span class="text-right">${d.factories}</span>
          <span>Efficiency</span>
          <span class="text-right">${pct(d.efficiency)}</span>
        </div>
        <div class="mt-1">
          ${
            current
              ? html`<div>Focus: ${current.name}</div>
                  <div class="h-1.5 w-full rounded bg-gray-600">
                    <div
                      class="h-1.5 rounded bg-blue-400"
                      style="width:${Math.floor(
                        (d.focusProgress * 100) / current.seconds,
                      )}%"
                    ></div>
                  </div>`
              : html`<div class="text-yellow-300">No focus selected</div>`
          }
        </div>
        ${
          this.showFocuses
            ? html`<div class="mt-2 space-y-1">
                ${FOCUS_TREE.map((f) => {
                  const check = canStartFocus(state, f.id);
                  const done = check === "completed";
                  const active = d.focus === f.id;
                  const enabled = check === "ok";
                  return html`<button
                    class="block w-full rounded px-3 py-2 text-left sm:px-2 sm:py-1 ${
                      done
                        ? "bg-green-900/70"
                        : active
                          ? "bg-blue-900/80"
                          : enabled
                            ? "bg-gray-700 hover:bg-gray-600"
                            : "bg-gray-900/60 text-gray-500"
                    }"
                    ?disabled=${!enabled}
                    @click=${() => this.pick(f.id)}
                  >
                    <div class="font-semibold">
                      ${f.name}
                      <span class="float-right font-normal">${f.seconds}s</span>
                    </div>
                    <div class="opacity-80">${f.description}</div>
                    ${
                      f.requires.length > 0
                        ? html`<div class="opacity-60">
                            Needs:
                            ${f.requires.map((r) => focusById(r)?.name).join(", ")}
                          </div>`
                        : nothing
                    }
                  </button>`;
                })}
              </div>`
            : nothing
        }
      </div>
    `;
  }
}

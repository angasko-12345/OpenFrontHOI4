import { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import {
  BREAK_PP_COST,
  TRUCE_BREAKABLE_SECONDS,
  TRUCE_MAX_LOCK,
  TRUCE_MIN_LOCK,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import { html, nothing } from "lit";

/**
 * Self-contained Grand Strategy HUD pieces for M7 stage A.2 (breakable
 * truces). Kept out of GrandStrategyPanel so the panel layout can change
 * without touching them: each helper takes the update and callbacks and
 * returns a lit template.
 */

/** "2m 5s" / "45s". */
export function gsDuration(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/**
 * Truce list: each truce shows "locked Xs" while it cannot be broken, then
 * "breakable" with a Break button (costs PP, war support and weariness).
 */
export function renderTruces(
  d: GrandStrategyUpdate,
  name: (id: string) => string,
  onBreak: (id: string) => void,
) {
  const truces = d.truces ?? [];
  if (truces.length === 0) return nothing;
  const canPay = d.politicalPower * 1000 >= BREAK_PP_COST;
  return html`<div class="font-semibold">Truces</div>
    ${truces.map((t) => {
      const lock = t.lock ?? 0;
      return html`<div
        class="flex items-center justify-between gap-2"
        data-testid="gs-truce"
      >
        <span class="min-w-0 truncate"
          >${name(t.target)}
          <span class="opacity-70">ends ${gsDuration(t.seconds)}</span></span
        >
        ${
          lock > 0
            ? html`<span class="shrink-0 opacity-80">locked ${lock}s</span>`
            : html`<span class="flex shrink-0 items-center gap-1">
                <span class="text-yellow-300">breakable</span>
                <button
                  class="min-h-9 rounded px-3 sm:min-h-0 sm:px-2 ${
                    canPay
                      ? "bg-red-800 hover:bg-red-700"
                      : "bg-gray-900/60 text-gray-500"
                  }"
                  ?disabled=${!canPay}
                  data-testid="gs-break-truce"
                  @click=${() => onBreak(t.target)}
                >
                  Break
                </button>
              </span>`
        }
      </div>`;
    })}`;
}

/** One-line rules note for truces. */
export function truceRulesNote(): string {
  return (
    `Peace and capitulation bring a truce: no attacks or nukes either way, ` +
    `land stays where it is. It cannot be broken for ${TRUCE_MIN_LOCK / 60}-` +
    `${TRUCE_MAX_LOCK / 60} min (longer after a capitulation, a big loss or ` +
    `against a much bigger winner; shorter after a short war between calm ` +
    `sides), then either side may break it for ${BREAK_PP_COST / 1000} PP, ` +
    `war support and weariness, giving the victim a war goal. It ends ` +
    `${TRUCE_BREAKABLE_SECONDS / 60} min after the lock.`
  );
}

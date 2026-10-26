import {
  AdvisorID,
  DecisionID,
  FocusID,
  LawID,
  PlayerID,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  GrandStrategyUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  ADVISOR_COST,
  ADVISOR_SLOTS,
  ADVISORS,
  availableFocuses,
  canTakeAction,
  DECISIONS,
  canSetLaw,
  canStartFocus,
  focusById,
  FOCUS_TREE,
  LAW_CHANGE_COST,
  LawCategory,
  lawsIn,
  NationGsState,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  JUSTIFY_COST,
  JUSTIFY_SECONDS,
  MAX_WAR_GOALS,
  MIN_TOTAL_TROOP_CAP_MODIFIER,
} from "@openfront/engine-lib/game/GrandStrategyWar";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  SendGsActionIntentEvent,
  SendJustifyWarIntentEvent,
  SendSetFocusIntentEvent,
  SendSetLawIntentEvent,
} from "../../Transport";
import { GameView } from "../../view";

/**
 * Grand Strategy HUD: the local nation's military industry, equipment
 * stockpile, national focus tree, political power, war support and laws.
 * Reads GrandStrategy updates; picking a focus or law sends an intent.
 */
@customElement("grand-strategy-panel")
export class GrandStrategyPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private data: GrandStrategyUpdate | null = null;
  /** Whole panel expanded. Phones start collapsed to a small chip. */
  @state() private expanded =
    typeof window === "undefined" || window.innerWidth >= 640;
  @state() private section: "none" | "focuses" | "laws" | "decisions" | "war" =
    "none";

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
      if (u.player !== me.id()) continue;
      const total = u.troopCapModifier + u.occupationModifier;
      const prevTotal =
        this.data === null
          ? null
          : this.data.troopCapModifier + this.data.occupationModifier;
      if (prevTotal !== total) {
        // The client only learns its own cap modifier; show it in the HUD.
        // Same combination as the engine (laws floored, then occupation).
        const myId = me.id();
        const m = Math.max(MIN_TOTAL_TROOP_CAP_MODIFIER, total);
        this.game
          .config()
          .setTroopCapModifier((p) =>
            p.isPlayer() && p.id() === myId ? m : 0,
          );
      }
      this.data = u;
    }
  }

  private pick(id: FocusID) {
    this.eventBus.emit(new SendSetFocusIntentEvent(id));
    // On phones, get the list out of the way once a focus is picked.
    if (typeof window !== "undefined" && window.innerWidth < 640) {
      this.section = "none";
    }
  }

  private adopt(id: LawID) {
    this.eventBus.emit(new SendSetLawIntentEvent(id));
  }

  private act(id: DecisionID | AdvisorID) {
    this.eventBus.emit(new SendGsActionIntentEvent(id));
  }

  private justify(id: PlayerID) {
    this.eventBus.emit(new SendJustifyWarIntentEvent(id));
  }

  private name(id: string): string {
    try {
      return this.game.player(id).displayName();
    } catch {
      return "?";
    }
  }

  /** Who the player may want a war goal against: current wars first, then the largest nations. */
  private justifyCandidates(): { id: PlayerID; name: string; tiles: number }[] {
    const me = this.game.myPlayer();
    if (!me) return [];
    const fighting = new Set<number>();
    for (const a of me.outgoingAttacks()) fighting.add(a.targetID);
    for (const a of me.incomingAttacks()) fighting.add(a.attackerID);
    const others = this.game
      .players()
      .filter(
        (p) =>
          p !== me &&
          p.isAlive() &&
          p.type() !== PlayerType.Bot &&
          !me.isFriendly(p),
      );
    others.sort((x, y) => {
      const fx = fighting.has(x.smallID()) ? 1 : 0;
      const fy = fighting.has(y.smallID()) ? 1 : 0;
      return fy - fx || y.numTilesOwned() - x.numTilesOwned();
    });
    return others.slice(0, 6).map((p) => ({
      id: p.id(),
      name: p.displayName(),
      tiles: p.numTilesOwned(),
    }));
  }

  private toggle(section: "focuses" | "laws" | "decisions" | "war") {
    this.section = this.section === section ? "none" : section;
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
      politicalPower: d.politicalPower * 1000,
      warSupport: d.warSupport,
      conscriptionLaw: d.conscriptionLaw,
      economyLaw: d.economyLaw,
      defendedThisSecond: false,
      attackLossesThisSecond: 0,
      activeDecisions: d.activeDecisions,
      decisionCooldowns: d.decisionCooldowns,
      advisors: d.advisors,
      steelDeposits: 0,
      oilDeposits: 0,
      milFactories: d.factories,
    };
    const canAffordLaw = d.politicalPower * 1000 >= LAW_CHANGE_COST;
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
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-bold">Grand Strategy</span>
          <div class="flex flex-wrap justify-end gap-1">
            <button
              class="min-h-9 rounded px-3 sm:min-h-0 sm:px-2 ${
                this.section === "focuses"
                  ? "bg-blue-800"
                  : "bg-gray-700 hover:bg-gray-600"
              }"
              @click=${() => this.toggle("focuses")}
            >
              Focuses
              ${
                canPick && this.section !== "focuses"
                  ? html`<span
                      class="ml-1 inline-block h-2 w-2 rounded-full bg-yellow-400"
                    ></span>`
                  : nothing
              }
            </button>
            <button
              class="min-h-9 rounded px-3 sm:min-h-0 sm:px-2 ${
                this.section === "laws"
                  ? "bg-blue-800"
                  : "bg-gray-700 hover:bg-gray-600"
              }"
              @click=${() => this.toggle("laws")}
            >
              Laws
            </button>
            <button
              class="min-h-9 rounded px-3 sm:min-h-0 sm:px-2 ${
                this.section === "decisions"
                  ? "bg-blue-800"
                  : "bg-gray-700 hover:bg-gray-600"
              }"
              @click=${() => this.toggle("decisions")}
            >
              Decisions
            </button>
            <button
              class="min-h-9 rounded px-3 sm:min-h-0 sm:px-2 ${
                this.section === "war"
                  ? "bg-blue-800"
                  : "bg-gray-700 hover:bg-gray-600"
              }"
              @click=${() => this.toggle("war")}
            >
              War
              ${
                d.justifiedAgainstMe.length > 0 && this.section !== "war"
                  ? html`<span
                      class="ml-1 inline-block h-2 w-2 rounded-full bg-red-500"
                    ></span>`
                  : nothing
              }
            </button>
            <button
              class="min-h-9 min-w-9 rounded bg-gray-700 px-2 hover:bg-gray-600 sm:min-h-0 sm:min-w-0"
              aria-label="Minimize"
              @click=${() => {
                this.expanded = false;
                this.section = "none";
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
          <span>Political power</span>
          <span class="text-right">${d.politicalPower}</span>
          <span>War support</span>
          <span class="text-right">${pct(d.warSupport)}</span>
          <span>Steel</span>
          <span
            class="text-right ${d.steel < d.steelNeeded ? "text-red-400" : ""}"
            >${d.steel} / ${d.steelNeeded}</span
          >
          <span>Oil</span>
          <span class="text-right ${d.oil < d.oilNeeded ? "text-red-400" : ""}"
            >${d.oil} / ${d.oilNeeded}</span
          >
          ${
            d.occupied > 0
              ? html`<span>Occupied land</span>
                  <span class="text-right text-yellow-300"
                    >${renderTroops(d.occupied)} tiles</span
                  >`
              : nothing
          }
          ${
            d.troopCapModifier + d.occupationModifier !== 0
              ? html`<span>Max troops</span>
                  <span class="text-right"
                    >${
                      d.troopCapModifier + d.occupationModifier > 0 ? "+" : ""
                    }${pct(d.troopCapModifier + d.occupationModifier)}</span
                  >`
              : nothing
          }
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
          this.section === "laws"
            ? html`<div class="mt-2 space-y-2">
                <div class="opacity-70">
                  Changing a law costs ${LAW_CHANGE_COST / 1000} political
                  power.
                </div>
                ${(["conscription", "economy"] as LawCategory[]).map(
                  (cat) =>
                    html`<div>
                      <div class="font-semibold capitalize">${cat}</div>
                      ${lawsIn(cat).map((l) => {
                        const check = canSetLaw(state, l.id);
                        const active = check === "active";
                        const enabled = check === "ok";
                        return html`<button
                          class="mt-1 block w-full rounded px-3 py-2 text-left sm:px-2 sm:py-1 ${
                            active
                              ? "bg-blue-900/80"
                              : enabled
                                ? "bg-gray-700 hover:bg-gray-600"
                                : "bg-gray-900/60 text-gray-500"
                          }"
                          ?disabled=${!enabled}
                          @click=${() => this.adopt(l.id)}
                        >
                          <div class="font-semibold">
                            ${l.name}
                            ${
                              active
                                ? html`<span class="float-right font-normal"
                                    >Active</span
                                  >`
                                : l.minWarSupport > 0
                                  ? html`<span class="float-right font-normal"
                                      >WS ${pct(l.minWarSupport)}</span
                                    >`
                                  : nothing
                            }
                          </div>
                          <div class="opacity-80">${l.description}</div>
                        </button>`;
                      })}
                    </div>`,
                )}
                ${
                  canAffordLaw
                    ? nothing
                    : html`<div class="text-yellow-300">
                        Not enough political power.
                      </div>`
                }
              </div>`
            : nothing
        }
        ${
          this.section === "decisions"
            ? html`<div class="mt-2 space-y-2">
                <div>
                  <div class="font-semibold">Decisions</div>
                  ${DECISIONS.map((dec) => {
                    const check = canTakeAction(state, dec.id);
                    const running = d.activeDecisions.find(
                      (e) => e.id === dec.id,
                    );
                    const cooldown = d.decisionCooldowns.find(
                      (e) => e.id === dec.id,
                    );
                    const enabled = check === "ok";
                    return html`<button
                      class="mt-1 block w-full rounded px-3 py-2 text-left sm:px-2 sm:py-1 ${
                        running
                          ? "bg-blue-900/80"
                          : enabled
                            ? "bg-gray-700 hover:bg-gray-600"
                            : "bg-gray-900/60 text-gray-500"
                      }"
                      ?disabled=${!enabled}
                      @click=${() => this.act(dec.id)}
                    >
                      <div class="font-semibold">
                        ${dec.name}
                        <span class="float-right font-normal"
                          >${
                            running
                              ? `${running.seconds}s left`
                              : cooldown
                                ? `ready in ${cooldown.seconds}s`
                                : `${dec.cost / 1000} PP`
                          }</span
                        >
                      </div>
                      <div class="opacity-80">${dec.description}</div>
                    </button>`;
                  })}
                </div>
                <div>
                  <div class="font-semibold">
                    Advisors (${d.advisors.length}/${ADVISOR_SLOTS},
                    ${ADVISOR_COST / 1000} PP)
                  </div>
                  ${ADVISORS.map((a) => {
                    const check = canTakeAction(state, a.id);
                    const hired = check === "hired";
                    const enabled = check === "ok";
                    return html`<button
                      class="mt-1 block w-full rounded px-3 py-2 text-left sm:px-2 sm:py-1 ${
                        hired
                          ? "bg-green-900/70"
                          : enabled
                            ? "bg-gray-700 hover:bg-gray-600"
                            : "bg-gray-900/60 text-gray-500"
                      }"
                      ?disabled=${!enabled}
                      @click=${() => this.act(a.id)}
                    >
                      <div class="font-semibold">
                        ${a.name}
                        ${
                          hired
                            ? html`<span class="float-right font-normal"
                                >Hired</span
                              >`
                            : nothing
                        }
                      </div>
                      <div class="opacity-80">${a.description}</div>
                    </button>`;
                  })}
                </div>
              </div>`
            : nothing
        }
        ${this.section === "war" ? this.renderWar(d) : nothing}
        ${
          this.section === "focuses"
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

  private renderWar(d: GrandStrategyUpdate) {
    const canAfford = d.politicalPower * 1000 >= JUSTIFY_COST;
    const goals = new Set(d.warGoals.map((g) => g.target));
    const full = d.warGoals.length >= MAX_WAR_GOALS;
    return html`<div class="mt-2 space-y-2">
      ${
        d.coalitionLeader !== null
          ? html`<div class="rounded bg-red-900/60 px-2 py-1">
              ${
                d.coalitionLeader === this.game.myPlayer()?.id()
                  ? "The world has formed a coalition against you."
                  : html`Coalition against
                      <b>${this.name(d.coalitionLeader)}</b>: attack them with
                      no war goal and 10% fewer losses.`
              }
            </div>`
          : nothing
      }
      ${
        d.justifiedAgainstMe.length > 0
          ? html`<div class="rounded bg-red-900/40 px-2 py-1">
              War goals against you:
              ${d.justifiedAgainstMe.map((id) => this.name(id)).join(", ")}
            </div>`
          : nothing
      }
      <div class="opacity-70">
        Attacking a nation without a war goal costs 20% more troops. Fighting
        far from your capital, cities, ports and factories costs 30% more.
        Justifying takes ${JUSTIFY_SECONDS}s and ${JUSTIFY_COST / 1000} PP.
      </div>
      ${
        d.justifying !== null
          ? html`<div>
              Justifying against <b>${this.name(d.justifying.target)}</b>:
              ${d.justifying.seconds}s left
            </div>`
          : nothing
      }
      ${
        d.warGoals.length > 0
          ? html`<div>
              <div class="font-semibold">War goals</div>
              ${d.warGoals.map(
                (g) =>
                  html`<div>
                    ${this.name(g.target)}
                    <span class="float-right"
                      >${Math.ceil(g.seconds / 60)} min</span
                    >
                  </div>`,
              )}
            </div>`
          : nothing
      }
      <div>
        <div class="font-semibold">Justify a war goal</div>
        ${this.justifyCandidates().map((c) => {
          const has = goals.has(c.id) || d.justifying?.target === c.id;
          const enabled = !has && canAfford && !full && d.justifying === null;
          return html`<button
            class="mt-1 block w-full rounded px-3 py-2 text-left sm:px-2 sm:py-1 ${
              has
                ? "bg-blue-900/80"
                : enabled
                  ? "bg-gray-700 hover:bg-gray-600"
                  : "bg-gray-900/60 text-gray-500"
            }"
            ?disabled=${!enabled}
            @click=${() => this.justify(c.id)}
          >
            ${c.name}
            <span class="float-right font-normal"
              >${has ? "Justified" : `${renderTroops(c.tiles)} tiles`}</span
            >
          </button>`;
        })}
      </div>
    </div>`;
  }
}

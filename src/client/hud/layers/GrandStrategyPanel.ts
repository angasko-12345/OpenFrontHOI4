import {
  FocusID,
  LawID,
  PlayerID,
  PlayerType,
  GsActionID,
  MessageType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DisplayMessageUpdate,
  GameUpdateType,
  GrandStrategyUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
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
import { CAPITULATE_PERMILLE } from "@openfront/engine-lib/game/GrandStrategyPeace";
import {
  ATOMIC_PROJECT_ERA,
  canResearch,
  ERA_ADVANCE,
  MAX_ERA,
  RESEARCH_SLOTS,
  techById,
  TECHS,
} from "@openfront/engine-lib/game/GrandStrategyResearch";
import {
  JUSTIFY_COST,
  JUSTIFY_SECONDS,
  MAX_WAR_GOALS,
  MIN_TOTAL_TROOP_CAP_MODIFIER,
} from "@openfront/engine-lib/game/GrandStrategyWar";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  SendGsActionIntentEvent,
  SendJustifyWarIntentEvent,
  SendPeaceIntentEvent,
  SendSetFocusIntentEvent,
  SendSetLawIntentEvent,
} from "../../Transport";
import { GameView } from "../../view";
import {
  renderIdeologyChoices,
  renderIdeologyRow,
  renderInfoHint,
  renderTruces,
  truceRulesNote,
} from "./GrandStrategyDiplomacy";
import {
  ALERT_MS,
  diffGsAlerts,
  GsAlert,
  GsTab,
  MAX_ALERTS,
  renderGsAlerts,
} from "./gs/GsAlerts";
import {
  GS_DOCK_KEY,
  GS_TABS,
  gsBar,
  GsBadge,
  GsTabMeta,
  renderGsDock,
} from "./gs/GsDock";
import { GsResource, renderGsResourceBar } from "./gs/GsResourceBar";

/** Side dock from this width up; upstream leaves the bottom-left free there. */
const WIDE_PX = 1280;
const isWide = () =>
  typeof window !== "undefined" && window.innerWidth >= WIDE_PX;

/** Below upstream's 40px top sidebars. */
const BAR_TOP_PX = 44;

const pct = (permille: number) => `${Math.floor(permille / 10)}%`;

/**
 * Grand Strategy HUD, laid out like an RTS: an always-on resource bar at the
 * top, a command card with icon tabs (Economy, Laws, Focus, Research,
 * Decisions, War; hotkeys F1-F6, backquote toggles it) docked at the bottom
 * on phones and bottom-left on wide screens, and an alert stack for wars,
 * peace offers, capitulations, research and atomic projects. Reads
 * GrandStrategy updates; every button sends the same intents as before.
 * Chrome lives in ./gs/*; tab bodies are the render* methods below.
 */
@customElement("grand-strategy-panel")
export class GrandStrategyPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private data: GrandStrategyUpdate | null = null;
  /** Open command tab, or null when minimized to the resource bar.
   * Wide screens start on Economy, phones minimized. */
  @state() private tab: GsTab | null = isWide() ? "economy" : null;
  private lastTab: GsTab = "economy";
  /** Resource chip whose detail popover is open. */
  @state() private detail: string | null = null;
  @state() private alerts: GsAlert[] = [];
  /** Px the bottom sheet keeps clear for the upstream control panel. */
  @state() private bottomInset = 0;
  @state() private wide = isWide();
  /** Top of the phone/tablet bar: under the upstream sidebars, or under
   * the upstream player info overlay while that is showing. */
  @state() private topOffset = BAR_TOP_PX;
  /** War weariness went up in the latest update. */
  @state() private wearinessRising = false;
  /** Keys of rules hints whose (i) detail is expanded. */
  @state() private infoOpen: ReadonlySet<string> = new Set();
  private nextAlertId = 1;
  /** Players who capitulated to us, by Date.now() of the world message. */
  private readonly capitulations = new Map<string, number>();
  private lastMeasure = 0;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private readonly onResize = () => this.measure(true);

  createRenderRoot() {
    return this;
  }

  init() {}

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("resize", this.onResize);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("resize", this.onResize);
    super.disconnectedCallback();
  }

  tick() {
    const me = this.game?.myPlayer();
    if (!me) return;
    const updates = this.game.updatesSinceLastTick();
    const list = updates?.[GameUpdateType.GrandStrategy] ?? [];
    // The world message can land a tick before the update with the truce.
    for (const id of this.capitulationsToMe(
      (updates?.[GameUpdateType.DisplayEvent] ?? []) as DisplayMessageUpdate[],
      me.displayName(),
    )) {
      this.capitulations.set(id, Date.now());
    }
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
      if (this.data !== null) {
        this.wearinessRising = (u.weariness ?? 0) > (this.data.weariness ?? 0);
      }
      const recent = new Set(
        [...this.capitulations]
          .filter(([, at]) => Date.now() - at < 5000)
          .map(([id]) => id),
      );
      this.raise(diffGsAlerts(this.data, u, (id) => this.name(id), recent));
      this.data = u;
    }
    this.expireAlerts();
    this.measure(false);
  }

  /** Players whose capitulation to us came in as a world message. */
  private capitulationsToMe(
    events: readonly DisplayMessageUpdate[],
    myName: string,
  ): Set<string> {
    const out = new Set<string>();
    for (const e of events) {
      if (
        e.messageType !== MessageType.GS_DIPLOMACY ||
        e.message !== "events_display.gs_capitulated" ||
        e.params?.other !== myName
      ) {
        continue;
      }
      const who = this.game
        .players()
        .find((p) => p.displayName() === e.params?.name);
      if (who) out.add(who.id());
    }
    return out;
  }

  private raise(drafts: ReturnType<typeof diffGsAlerts>) {
    if (drafts.length === 0) return;
    const now = Date.now();
    const fresh = drafts.map((a) => ({
      ...a,
      id: this.nextAlertId++,
      born: now,
    }));
    this.alerts = [...fresh.reverse(), ...this.alerts].slice(0, MAX_ALERTS);
  }

  private expireAlerts() {
    if (this.alerts.length === 0) return;
    const now = Date.now();
    const toMe = this.data?.peaceOffersToMe ?? [];
    const keep = this.alerts.filter(
      (a) =>
        now - a.born < ALERT_MS[a.kind] &&
        // A peace alert goes when its offer does.
        (a.kind !== "peace" ||
          (a.target !== undefined && toMe.includes(a.target))),
    );
    if (keep.length !== this.alerts.length) this.alerts = keep;
  }

  /** Keep the phone sheet above the upstream bottom control panel. */
  private measure(force: boolean) {
    if (typeof window === "undefined") return;
    const now = Date.now();
    if (!force && now - this.lastMeasure < 250) return;
    this.lastMeasure = now;
    const wide = isWide();
    if (wide !== this.wide) this.wide = wide;
    const box = document.querySelector("control-panel")?.parentElement;
    const r = box?.getBoundingClientRect();
    const inset =
      r && r.height > 0
        ? Math.min(
            Math.round(window.innerHeight * 0.45),
            Math.max(0, Math.round(window.innerHeight - r.top)),
          )
        : 0;
    if (inset !== this.bottomInset) this.bottomInset = inset;
    // Upstream's player info overlay is fixed at the top centre (z 1001)
    // and would cover the bar: step below it while it shows.
    let top = BAR_TOP_PX;
    const info = document.querySelector("player-info-overlay .fixed > div");
    if (info && !info.classList.contains("invisible")) {
      const ir = info.getBoundingClientRect();
      if (ir.height > 0 && ir.bottom + 4 > top) top = Math.round(ir.bottom + 4);
    }
    if (top !== this.topOffset) this.topOffset = top;
  }

  private handleKey(e: KeyboardEvent) {
    if (this.data === null || e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }
    if (e.code === GS_DOCK_KEY) {
      e.preventDefault();
      this.toggleDock();
      return;
    }
    const def = GS_TABS.find((x) => x.key === e.code);
    if (def) {
      // F-keys otherwise reach the browser (help, reload, address bar).
      e.preventDefault();
      this.openTab(def.id);
    }
  }

  private openTab(t: GsTab) {
    this.tab = this.tab === t ? null : t;
    if (this.tab !== null) this.lastTab = this.tab;
    this.detail = null;
  }

  private toggleDock() {
    this.tab = this.tab === null ? this.lastTab : null;
    this.detail = null;
  }

  private pick(id: FocusID) {
    this.eventBus.emit(new SendSetFocusIntentEvent(id));
  }

  private adopt(id: LawID) {
    this.eventBus.emit(new SendSetLawIntentEvent(id));
  }

  private act(id: GsActionID) {
    this.eventBus.emit(new SendGsActionIntentEvent(id));
  }

  private justify(id: PlayerID) {
    this.eventBus.emit(new SendJustifyWarIntentEvent(id));
  }

  private peace(id: PlayerID) {
    this.eventBus.emit(new SendPeaceIntentEvent(id));
  }

  private breakTruce(id: PlayerID) {
    this.eventBus.emit(new SendPeaceIntentEvent(id, "break"));
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

  private nationState(d: GrandStrategyUpdate): NationGsState {
    return {
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
      civFactories: d.civFactories,
      importSteel: d.importSteel,
      importOil: d.importOil,
      artillery: d.artillery,
      artilleryShare: d.artilleryShare,
      researched: d.researched,
      research: d.research.map((r) => ({ id: r.id, progress: r.progress })),
      weariness: (d.weariness ?? 0) * 1000,
      ideology: d.ideology,
      ideologyCooldown: d.ideologyCooldown,
    };
  }

  /** Chips of the top resource bar, in display order. */
  private resources(d: GrandStrategyUpdate): GsResource[] {
    const me = this.game.myPlayer();
    const troops = me?.troops() ?? 0;
    const maxTroops = me ? this.game.config().maxTroops(me) : 0;
    const capMod = d.troopCapModifier + d.occupationModifier;
    const w = d.weariness ?? 0;
    const signed = (p: number) => `${p > 0 ? "+" : ""}${pct(p)}`;
    return [
      {
        key: "gold",
        icon: "gold",
        label: "Gold",
        value: me ? renderNumber(me.gold()) : "-",
        tone: "normal",
        detail: [`${d.civFree} free civilian factories add gold income`],
      },
      {
        key: "pp",
        icon: "pp",
        label: "Political power",
        value: `${d.politicalPower}`,
        tone: "normal",
        detail: [
          `War support ${pct(d.warSupport)}`,
          `Law change ${LAW_CHANGE_COST / 1000} PP, war goal ${JUSTIFY_COST / 1000} PP`,
        ],
      },
      {
        key: "manpower",
        icon: "manpower",
        label: "Manpower",
        value: renderTroops(troops),
        tone: "normal",
        detail: [
          `${renderTroops(troops)} of ${renderTroops(maxTroops)} troops`,
          ...(capMod !== 0
            ? [`Max troops ${signed(capMod)} from laws, focuses, occupation`]
            : []),
          ...(d.occupied > 0
            ? [`${renderTroops(d.occupied)} occupied tiles not integrated`]
            : []),
        ],
      },
      {
        key: "equipment",
        icon: "equipment",
        label: "Equipment",
        value: renderTroops(d.equipment),
        tone: d.equipped >= 900 ? "normal" : d.equipped >= 500 ? "warn" : "bad",
        mark: pct(d.equipped),
        markWide: true,
        detail: [
          `Equips ${pct(d.equipped)} of the army`,
          `${d.factories} military factories at ${pct(d.efficiency)} efficiency`,
        ],
      },
      {
        key: "artillery",
        icon: "artillery",
        label: "Artillery",
        value: pct(d.artillerySupport),
        tone: "normal",
        detail: [
          `Supports ${pct(d.artillerySupport)} of the army (${renderTroops(d.artillery)} troops)`,
          `${d.artilleryShare / 10}% of military output goes to guns`,
        ],
      },
      {
        key: "steel",
        icon: "steel",
        label: "Steel",
        value: `${d.steel}/${d.steelNeeded}`,
        tone: d.steel < d.steelNeeded ? "bad" : "normal",
        detail: [
          `${d.steel} available, ${d.steelNeeded} needed per second`,
          ...(d.importSteel > 0 ? [`${d.importSteel} imported`] : []),
          ...(d.steel < d.steelNeeded ? ["Shortage: production slows"] : []),
        ],
      },
      {
        key: "oil",
        icon: "oil",
        label: "Oil",
        value: `${d.oil}/${d.oilNeeded}`,
        tone: d.oil < d.oilNeeded ? "bad" : "normal",
        detail: [
          `${d.oil} available, ${d.oilNeeded} needed per second`,
          ...(d.importOil > 0 ? [`${d.importOil} imported`] : []),
          ...(d.oil < d.oilNeeded
            ? ["Shortage: attacks cost more troops"]
            : []),
        ],
      },
      {
        key: "weariness",
        icon: "weariness",
        label: "War weariness",
        value: pct(w),
        tone:
          w >= 500
            ? "bad"
            : w >= 250 || this.wearinessRising
              ? "warn"
              : "normal",
        mark: this.wearinessRising ? "▲" : undefined,
        detail: [
          this.wearinessRising
            ? "Rising"
            : w > 0
              ? "Steady or recovering"
              : "None",
          "Raises attack losses, cuts political power and war support",
          `Capitulation below ${CAPITULATE_PERMILLE / 10}% of peak land (${d.peakTiles ?? 0} tiles) while at war`,
        ],
      },
      {
        key: "research",
        icon: "research",
        label: "Research",
        value: `${d.research.length}/${RESEARCH_SLOTS}`,
        tone: d.research.length < RESEARCH_SLOTS ? "warn" : "normal",
        detail: [
          `Era ${d.era}, ${d.research.length} of ${RESEARCH_SLOTS} slots in use`,
          ...d.research.map(
            (r) =>
              `${techById(r.id)?.name ?? r.id}: ${Math.min(100, Math.floor((r.progress * 100) / Math.max(1, r.cost)))}%`,
          ),
        ],
      },
    ];
  }

  private tabMeta(
    d: GrandStrategyUpdate,
    state: NationGsState,
  ): Record<GsTab, GsTabMeta> {
    const current = d.focus === null ? undefined : focusById(d.focus);
    const canPick = d.focus === null && availableFocuses(state).length > 0;
    const myId = this.game.myPlayer()?.id();
    const slot = d.research[0];
    const warBadge: GsBadge =
      (d.peaceOffersToMe ?? []).length > 0
        ? "good"
        : d.justifiedAgainstMe.length > 0 || d.coalitionLeader === myId
          ? "danger"
          : "none";
    return {
      economy: {
        badge:
          d.steel < d.steelNeeded || d.oil < d.oilNeeded || d.equipped < 500
            ? "danger"
            : "none",
      },
      laws: { badge: "none" },
      focus: {
        badge: canPick ? "info" : "none",
        progress: current
          ? (d.focusProgress * 100) / Math.max(1, current.seconds)
          : undefined,
      },
      research: {
        badge: d.research.length < RESEARCH_SLOTS ? "info" : "none",
        progress: slot
          ? (slot.progress * 100) / Math.max(1, slot.cost)
          : undefined,
      },
      decisions: { badge: "none" },
      war: { badge: warBadge },
    };
  }

  private tabTitle(
    tab: GsTab,
    d: GrandStrategyUpdate,
  ): { title: string; subtitle: string } {
    const current = d.focus === null ? undefined : focusById(d.focus);
    switch (tab) {
      case "economy":
        return {
          title: "Economy",
          subtitle: `${d.factories} mil. · ${d.civFree}/${d.civFactories} civ. factories free`,
        };
      case "laws":
        return {
          title: "Laws",
          subtitle: `${d.politicalPower} PP · change ${LAW_CHANGE_COST / 1000} PP`,
        };
      case "focus":
        return {
          title: "Focus",
          subtitle: current ? current.name : "No focus selected",
        };
      case "research":
        return {
          title: "Research",
          subtitle: `Era ${d.era} · ${d.research.length}/${RESEARCH_SLOTS} slots`,
        };
      case "decisions":
        return {
          title: "Decisions",
          subtitle: `${d.politicalPower} PP · advisors ${d.advisors.length}/${ADVISOR_SLOTS}`,
        };
      case "war":
        return {
          title: "War & Diplomacy",
          subtitle: `${(d.wars ?? []).length} wars · weariness ${pct(d.weariness ?? 0)}`,
        };
    }
  }

  render() {
    const d = this.data;
    if (d === null) return nothing;
    const state = this.nationState(d);
    const meta = this.tabMeta(d, state);
    const rank: Record<GsBadge, number> = {
      none: 0,
      info: 1,
      good: 2,
      danger: 3,
    };
    let attention: GsBadge = "none";
    for (const m of Object.values(meta)) {
      if (rank[m.badge] > rank[attention]) attention = m.badge;
    }
    const tab = this.tab;
    const t = tab === null ? null : this.tabTitle(tab, d);
    const bar = renderGsResourceBar(
      this.resources(d),
      { openDetail: this.detail, dockOpen: tab !== null, attention },
      {
        detail: (k) => (this.detail = k),
        toggleDock: () => this.toggleDock(),
      },
      this.wide ? { mode: "inline" } : { mode: "top", topPx: this.topOffset },
    );
    const dock =
      tab !== null && t !== null
        ? renderGsDock(
            {
              tab,
              meta,
              wide: this.wide,
              bottomInset: this.bottomInset,
              title: t.title,
              subtitle: t.subtitle,
              onTab: (x) => this.openTab(x),
              onClose: () => {
                this.tab = null;
              },
            },
            this.renderTab(tab, d, state),
          )
        : nothing;
    return html`
      <style>
        @media (max-width: 639px) {
          grand-strategy-panel .gs-dock-content button {
            min-height: 40px;
          }
        }
      </style>
      ${
        this.wide
          ? html`<div
              class="pointer-events-none fixed bottom-2 left-2 z-[890] flex w-[380px] flex-col gap-1"
              data-testid="gs-wide-column"
            >
              ${dock} ${bar}
            </div>`
          : html`${bar} ${dock}`
      }
      ${renderGsAlerts(
        this.alerts,
        {
          open: (a) => {
            this.tab = a.tab;
            this.lastTab = a.tab;
            this.alerts = this.alerts.filter((x) => x.id !== a.id);
          },
          dismiss: (a) => {
            this.alerts = this.alerts.filter((x) => x.id !== a.id);
          },
          accept: (a) => {
            if (a.target !== undefined) this.peace(a.target);
            this.alerts = this.alerts.filter((x) => x.id !== a.id);
          },
          offerOpen: (target) => (d.peaceOffersToMe ?? []).includes(target),
        },
        // Under the bar: 2 rows of 40px on phones, one 32px row from sm.
        this.wide ? 48 : this.topOffset + (window.innerWidth < 640 ? 88 : 44),
      )}
    `;
  }

  private toggleInfo(key: string) {
    const next = new Set(this.infoOpen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.infoOpen = next;
  }

  private info(key: string, hint: string, detail: unknown) {
    return renderInfoHint(key, hint, detail, this.infoOpen.has(key), (k) =>
      this.toggleInfo(k),
    );
  }

  private renderTab(
    tab: GsTab,
    d: GrandStrategyUpdate,
    state: NationGsState,
  ): TemplateResult {
    switch (tab) {
      case "economy":
        return this.renderEconomy(d);
      case "laws":
        return this.renderLaws(d, state);
      case "focus":
        return this.renderFocuses(d, state);
      case "research":
        return this.renderTech(d, state);
      case "decisions":
        return this.renderDecisions(d, state);
      case "war":
        return html`${this.renderAtomicWorld(d)}${this.renderWar(d)}`;
    }
  }

  /** Economy tab: production lines, equipment and industry figures. */
  private renderEconomy(d: GrandStrategyUpdate) {
    const equippedColor =
      d.equipped >= 900
        ? "text-green-400"
        : d.equipped >= 500
          ? "text-yellow-400"
          : "text-red-400";
    return html`<div class="mt-2 space-y-2" data-testid="gs-economy">
      <div>
        <div class="mb-1 font-semibold">Production line</div>
        <div class="flex items-center gap-1">
          ${(
            [
              ["line_infantry", "Infantry", 0],
              ["line_balanced", "Mixed", 250],
              ["line_artillery", "Artillery", 500],
            ] as const
          ).map(
            ([id, label, share]) =>
              html`<button
                class="min-h-10 flex-1 rounded px-1 sm:min-h-8 ${
                  d.artilleryShare === share
                    ? "bg-blue-700"
                    : "bg-gray-700 hover:bg-gray-600"
                }"
                title="${share / 10}% of military output on artillery"
                @click=${() => this.act(id)}
              >
                ${label}
              </button>`,
          )}
        </div>
      </div>
      <div>
        <div class="flex justify-between">
          <span>Army equipped</span>
          <span class=${equippedColor}>${pct(d.equipped)}</span>
        </div>
        ${gsBar(
          d.equipped / 10,
          d.equipped >= 900
            ? "bg-green-400"
            : d.equipped >= 500
              ? "bg-yellow-400"
              : "bg-red-400",
          "gs-bar-equipped",
        )}
        <div class="mt-1 flex justify-between">
          <span>Production efficiency</span><span>${pct(d.efficiency)}</span>
        </div>
        ${gsBar(d.efficiency / 10, "bg-sky-400", "gs-bar-efficiency")}
        <div class="mt-1 flex justify-between">
          <span>Artillery support</span><span>${pct(d.artillerySupport)}</span>
        </div>
        ${gsBar(d.artillerySupport / 10, "bg-orange-400")}
      </div>
      <div class="grid grid-cols-2 gap-x-2">
        <span>Equipment</span>
        <span class="text-right">${renderTroops(d.equipment)}</span>
        <span>Mil. factories</span>
        <span class="text-right">${d.factories}</span>
        <span>Political power</span>
        <span class="text-right">${d.politicalPower}</span>
        <span>War support</span>
        <span class="text-right">${pct(d.warSupport)}</span>
        <span>War weariness</span>
        <span
          class="text-right ${
            (d.weariness ?? 0) >= 500
              ? "text-red-400"
              : (d.weariness ?? 0) >= 250
                ? "text-yellow-300"
                : ""
          }"
          data-testid="gs-weariness"
          >${pct(d.weariness ?? 0)}</span
        >
        ${renderIdeologyRow(d)}
        <span>Civ. factories</span>
        <span class="text-right">${d.civFree} free / ${d.civFactories}</span>
        ${
          d.importSteel + d.importOil > 0
            ? html`<span>Imports</span>
                <span class="text-right text-yellow-300"
                  >${d.importSteel} steel, ${d.importOil} oil</span
                >`
            : nothing
        }
        <span>Artillery</span>
        <span class="text-right">${pct(d.artillerySupport)}</span>
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
    </div>`;
  }

  private renderLaws(d: GrandStrategyUpdate, state: NationGsState) {
    const canAffordLaw = d.politicalPower * 1000 >= LAW_CHANGE_COST;
    return html`<div class="mt-2 space-y-2" data-testid="gs-laws">
      <div>
        <div class="flex justify-between text-xs">
          <span>Political power</span>
          <span>${d.politicalPower} / ${LAW_CHANGE_COST / 1000}</span>
        </div>
        ${gsBar(
          (d.politicalPower * 100000) / LAW_CHANGE_COST,
          canAffordLaw ? "bg-emerald-400" : "bg-amber-400",
        )}
      </div>
      <div class="opacity-70">
        Changing a law costs ${LAW_CHANGE_COST / 1000} political power.
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
          : html`<div class="text-yellow-300">Not enough political power.</div>`
      }
    </div>`;
  }

  private renderDecisions(d: GrandStrategyUpdate, state: NationGsState) {
    return html`<div class="mt-2 space-y-2" data-testid="gs-decisions">
      ${renderIdeologyChoices(d, (id) => this.act(id))}
      <div>
        <div class="font-semibold">Decisions</div>
        ${DECISIONS.map((dec) => {
          const check = canTakeAction(state, dec.id);
          const running = d.activeDecisions.find((e) => e.id === dec.id);
          const cooldown = d.decisionCooldowns.find((e) => e.id === dec.id);
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
                  ? html`<span class="float-right font-normal">Hired</span>`
                  : nothing
              }
            </div>
            <div class="opacity-80">${a.description}</div>
          </button>`;
        })}
      </div>
    </div>`;
  }

  private renderFocuses(d: GrandStrategyUpdate, state: NationGsState) {
    const current = d.focus === null ? undefined : focusById(d.focus);
    return html`<div class="mt-2 space-y-1" data-testid="gs-focuses">
      ${
        current
          ? html`<div class="rounded bg-blue-950/80 px-2 py-1">
              <div class="flex justify-between">
                <span class="font-semibold">${current.name}</span>
                <span
                  >${Math.max(0, current.seconds - d.focusProgress)}s left</span
                >
              </div>
              ${gsBar(
                (d.focusProgress * 100) / Math.max(1, current.seconds),
                "bg-blue-400",
                "gs-bar-focus",
              )}
            </div>`
          : html`<div class="text-yellow-300">No focus selected</div>`
      }
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
                  Needs: ${f.requires.map((r) => focusById(r)?.name).join(", ")}
                </div>`
              : nothing
          }
        </button>`;
      })}
    </div>`;
  }

  private renderTech(d: GrandStrategyUpdate, state: NationGsState) {
    const slotPct = (p: number, c: number) =>
      `${Math.min(100, Math.floor((p * 100) / Math.max(1, c)))}%`;
    return html`<div class="mt-2 space-y-1">
      <div class="font-semibold">
        Era ${d.era}
        <span class="float-right font-normal"
          >${d.research.length} / ${RESEARCH_SLOTS} slots</span
        >
      </div>
      ${d.research.map((r) => {
        const t = techById(r.id);
        return html`<div
          class="rounded bg-blue-900/80 px-3 py-2 sm:px-2 sm:py-1"
        >
          ${t?.name ?? r.id}
          <span class="float-right">${slotPct(r.progress, r.cost)}</span>
          ${gsBar((r.progress * 100) / Math.max(1, r.cost), "bg-sky-400", "gs-bar-research")}
        </div>`;
      })}
      ${TECHS.filter((t) => t.era <= d.era || t.project === true).map((t) => {
        const check = canResearch(state, t.id);
        const done = check === "researched";
        if (check === "in_progress") return nothing;
        const enabled = check === "ok";
        return html`<button
          class="block w-full rounded px-3 py-2 text-left sm:px-2 sm:py-1 ${
            done
              ? "bg-green-900/70"
              : enabled
                ? "bg-gray-700 hover:bg-gray-600"
                : "bg-gray-900/60 text-gray-500"
          }"
          ?disabled=${!enabled}
          @click=${() => this.act(t.id)}
        >
          <div class="font-semibold">
            ${t.name}
            <span class="float-right font-normal">${t.seconds}s</span>
          </div>
          <div class="opacity-80">${t.description}</div>
          ${
            check === "era"
              ? html`<div class="opacity-60">Unlocks in era ${t.era}</div>`
              : check === "exclusive"
                ? html`<div class="opacity-60">Another doctrine chosen</div>`
                : check === "missing_prerequisite"
                  ? html`<div class="opacity-60">
                      Needs:
                      ${t.requires.map((r) => techById(r)?.name).join(", ")}
                    </div>`
                  : nothing
          }
        </button>`;
      })}
      ${this.info(
        "tech",
        d.era < MAX_ERA
          ? `${ERA_ADVANCE} era ${d.era} techs reach era ${d.era + 1}.`
          : `Nukes need the atomic project.`,
        html`${
          d.era < MAX_ERA
            ? html`Research ${ERA_ADVANCE} era ${d.era} technologies to reach
              era ${d.era + 1}. Technologies most nations know cost 30% less. `
            : nothing
        }Atom
        bombs, hydrogen bombs and MIRVs need the atomic project (era
        ${ATOMIC_PROJECT_ERA}, no catch-up discount). Every nation is told when
        one starts or finishes.`,
      )}
    </div>`;
  }

  /** World list: who is building the bomb, and who already has it. */
  private renderAtomicWorld(d: GrandStrategyUpdate) {
    const projects = d.atomicProjects ?? [];
    const powers = d.atomicPowers ?? [];
    if (projects.length === 0 && powers.length === 0) return nothing;
    const MAX = 5;
    const rows = [
      ...projects.map((p) => ({ id: p.player, label: `${p.seconds}s` })),
      ...powers.map((id) => ({ id, label: "Nuclear" })),
    ];
    const myId = this.game.myPlayer()?.id();
    return html`<div
      class="mt-1 rounded bg-red-900/40 px-2 py-1"
      data-testid="gs-atomic-world"
    >
      <div class="font-semibold">Atomic projects</div>
      ${rows.slice(0, MAX).map(
        (r) =>
          html`<div class="flex justify-between gap-2">
            <span class="truncate ${r.id === myId ? "text-yellow-300" : ""}"
              >${this.name(r.id)}</span
            >
            <span class="shrink-0">${r.label}</span>
          </div>`,
      )}
      ${
        rows.length > MAX
          ? html`<div class="opacity-60">+${rows.length - MAX} more</div>`
          : nothing
      }
    </div>`;
  }

  /** M7 stage A: wars, peace offers and truces. */
  private renderPeace(d: GrandStrategyUpdate) {
    const wars = d.wars ?? [];
    const offers = d.peaceOffers ?? [];
    const toMe = d.peaceOffersToMe ?? [];
    const offered = new Map(offers.map((o) => [o.target, o.seconds]));
    const mins = (s: number) =>
      s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    return html`<div class="space-y-1" data-testid="gs-peace">
      ${toMe.map(
        (id) =>
          html`<div
            class="flex items-center justify-between gap-2 rounded bg-green-900/60 px-2 py-1"
          >
            <span class="min-w-0 truncate"
              ><b>${this.name(id)}</b> offers peace</span
            >
            <button
              class="min-h-9 shrink-0 rounded bg-green-700 px-3 hover:bg-green-600 sm:min-h-0 sm:px-2"
              @click=${() => this.peace(id)}
            >
              Accept
            </button>
          </div>`,
      )}
      <div class="font-semibold">
        Wars
        <span class="float-right font-normal"
          >Weariness ${Math.floor((d.weariness ?? 0) / 10)}%</span
        >
      </div>
      ${
        wars.length === 0
          ? html`<div class="opacity-60">At peace.</div>`
          : wars.map((w) => {
              const pending = offered.get(w.target);
              const theirs = toMe.includes(w.target);
              return html`<div class="flex items-center justify-between gap-2">
                <span class="min-w-0 truncate"
                  >${this.name(w.target)}
                  <span class="opacity-70"
                    >${mins(w.seconds)}, +${w.won} / -${w.lost}</span
                  ></span
                >
                <button
                  class="min-h-9 shrink-0 rounded px-3 sm:min-h-0 sm:px-2 ${
                    pending !== undefined
                      ? "bg-gray-900/60 text-gray-500"
                      : "bg-gray-700 hover:bg-gray-600"
                  }"
                  ?disabled=${pending !== undefined}
                  @click=${() => this.peace(w.target)}
                >
                  ${
                    theirs
                      ? "Accept"
                      : pending !== undefined
                        ? `Offered ${pending}s`
                        : "Offer peace"
                  }
                </button>
              </div>`;
            })
      }
      ${renderTruces(
        d,
        (id) => this.name(id),
        (id) => this.breakTruce(id),
      )}
      ${this.info(
        "peace",
        `Capitulate below ${CAPITULATE_PERMILLE / 10}% of peak land (${d.peakTiles ?? 0} tiles).`,
        html`Weariness grows with troops lost attacking, land lost and long
        wars, fastest for large, over-extended nations; it raises attack losses
        and cuts political power and war support. Below
        ${CAPITULATE_PERMILLE / 10}% of your peak land (${d.peakTiles ?? 0}
        tiles) while at war you capitulate. ${truceRulesNote()}`,
      )}
    </div>`;
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
      ${this.renderPeace(d)}
      ${this.info(
        "justify",
        `No war goal: +20% losses. Justify: ${JUSTIFY_SECONDS}s, ${JUSTIFY_COST / 1000} PP.`,
        html`Attacking a nation without a war goal costs 20% more troops.
        Fighting far from your capital, cities, ports and factories costs 30%
        more. Justifying takes ${JUSTIFY_SECONDS}s and ${JUSTIFY_COST / 1000}
        PP.`,
      )}
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

import { GsActionID } from "@openfront/engine-api/game/GameTypes";
import { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import {
  FACTION_CREATE_PP,
  factionName,
} from "@openfront/engine-lib/game/GrandStrategyFaction";
import {
  canAdoptIdeology,
  IDEOLOGIES,
  IDEOLOGY_COST,
  IDEOLOGY_COOLDOWN,
  ideologyAction,
  ideologyDef,
} from "@openfront/engine-lib/game/GrandStrategyIdeology";
import {
  BREAK_PP_COST,
  BREAK_WAR_SUPPORT,
  TRUCE_BREAKABLE_SECONDS,
  TRUCE_MAX_LOCK,
  TRUCE_MIN_LOCK,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import {
  AUTONOMY_MAX,
  INDEPENDENCE_LOCK,
  INDEPENDENCE_PP,
  INDEPENDENCE_EARLY_AUTONOMY,
  INDEPENDENCE_WEARY_AT,
  PUPPET_MAX_BLOC_SHARE,
  PUPPET_MAX_SIZE,
  PUPPET_PP,
  PUPPET_TRIBUTE,
  PUPPET_WINDOW,
  TRIBUTE_FADE_SHARE,
} from "@openfront/engine-lib/game/GrandStrategyPuppet";
import {
  RECOVERY_MANPOWER,
  RECOVERY_POLITICAL_POWER,
  REVANCHE_ATTACK_LOSS,
  REVANCHE_BREAK_PP,
  REVANCHE_MIN_LOST_PERMILLE,
  REVANCHE_SECONDS,
} from "@openfront/engine-lib/game/GrandStrategyRevanche";
import { html, nothing } from "lit";

/**
 * Self-contained Grand Strategy HUD pieces for M7 stage A.2 (breakable
 * truces) and stage B (ideologies). Kept out of GrandStrategyPanel so the panel layout can change
 * without touching them: each helper takes the update and callbacks and
 * returns a lit template.
 */

/**
 * One-line hint with an (i) toggle: the full rules text stays one tap away
 * instead of a paragraph that fills a phone screen. `open` and `onToggle`
 * belong to the caller (the panel keeps the set of open keys).
 */
export function renderInfoHint(
  key: string,
  hint: string,
  detail: unknown,
  open: boolean,
  onToggle: (key: string) => void,
) {
  return html`<div class="opacity-70" data-testid="gs-info-${key}">
    <div class="flex items-start justify-between gap-2">
      <span class="min-w-0">${hint}</span>
      <button
        class="min-h-10 min-w-10 shrink-0 rounded-full border border-gray-500 px-1 text-[11px] leading-none hover:bg-gray-700 sm:min-h-0 sm:min-w-0 sm:px-1.5 sm:py-0.5"
        aria-label="More info"
        aria-expanded=${open ? "true" : "false"}
        data-testid="gs-info-toggle-${key}"
        @click=${() => onToggle(key)}
      >
        ${open ? "×" : "i"}
      </button>
    </div>
    ${
      open
        ? html`<div class="mt-1 opacity-90" data-testid="gs-info-detail-${key}">
            ${detail}
          </div>`
        : nothing
    }
  </div>`;
}

/** "2m 5s" / "45s". */
export function gsDuration(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Seconds a truce breaker stays a traitor (upstream Config.traitorDuration). */
export const GS_TRAITOR_SECONDS = 30;

/**
 * Truce list: each truce shows "breakable in Xs" while it cannot be
 * broken, then a Break button (PP and war support) with the warning that
 * breaking makes us a traitor for 30 s (M7E). A banner shows our own
 * traitor countdown. M7C stage 2: a truce with a nation we hold a revanche
 * claim on shows an earlier Revanche button once half its lock is over
 * (same break intent, no traitor mark).
 */
export function renderTruces(
  d: GrandStrategyUpdate,
  name: (id: string) => string,
  onBreak: (id: string) => void,
) {
  const truces = d.truces ?? [];
  const traitor = d.traitorSeconds ?? 0;
  const claims = new Map((d.revanche ?? []).map((r) => [r.target, r]));
  const pp = d.politicalPower * 1000;
  const canPay = pp >= BREAK_PP_COST;
  const canRevanche = pp >= REVANCHE_BREAK_PP;
  const loose = (d.revanche ?? []).filter(
    (r) => !truces.some((t) => t.target === r.target),
  );
  return html`${
    traitor > 0
      ? html`<div
          class="rounded bg-red-900/60 px-2 py-1 text-red-100"
          data-testid="gs-traitor"
        >
          Traitor ${traitor}s: weaker defence, nations target you
        </div>`
      : nothing
  }${
    d.recovering === true
      ? html`<div
          class="rounded bg-emerald-900/50 px-2 py-1"
          data-testid="gs-recovering"
        >
          Recovering: +${RECOVERY_MANPOWER / 10}% manpower,
          +${RECOVERY_POLITICAL_POWER / 10}% PP
        </div>`
      : nothing
  }
  ${loose.map(
    (r) =>
      html`<div
        class="flex justify-between gap-2 text-amber-200"
        data-testid="gs-revanche-claim"
      >
        <span class="min-w-0 truncate">Revanche: ${name(r.target)}</span>
        <span class="shrink-0"
          >${r.tiles} tiles, ${-REVANCHE_ATTACK_LOSS / 10}% losses,
          ${gsDuration(r.seconds)}</span
        >
      </div>`,
  )}
  ${truces.length === 0 ? nothing : html`<div class="font-semibold">Truces</div>`}
  ${truces.map((t) => {
    const lock = t.lock ?? 0;
    const claim = claims.get(t.target);
    return html`<div
      class="flex items-center justify-between gap-2"
      data-testid="gs-truce"
    >
      <span class="min-w-0 truncate"
        >${name(t.target)}
        <span class="opacity-70">ends ${gsDuration(t.seconds)}</span></span
      >
      ${
        claim !== undefined && claim.wait === 0
          ? html`<button
              class="min-h-10 shrink-0 rounded px-3 sm:min-h-0 sm:px-2 ${
                canRevanche
                  ? "bg-amber-700 hover:bg-amber-600"
                  : "bg-gray-900/60 text-gray-500"
              }"
              ?disabled=${!canRevanche}
              title="Break for ${REVANCHE_BREAK_PP / 1000} PP to win back ${claim.tiles} tiles (justified: no traitor mark)"
              data-testid="gs-revanche"
              @click=${() => onBreak(t.target)}
            >
              Revanche
            </button>`
          : lock > 0
            ? html`<span class="shrink-0 opacity-80" data-testid="gs-truce-lock"
                >breakable in
                ${lock}s${
                  claim !== undefined
                    ? html`<span class="text-amber-300">
                        · revanche ${claim.wait}s</span
                      >`
                    : nothing
                }</span
              >`
            : html`<span class="flex shrink-0 flex-col items-end">
                <button
                  class="min-h-9 rounded px-3 sm:min-h-0 sm:px-2 ${
                    canPay
                      ? "bg-red-800 hover:bg-red-700"
                      : "bg-gray-900/60 text-gray-500"
                  }"
                  ?disabled=${!canPay}
                  title="Break for ${BREAK_PP_COST / 1000} PP and ${-BREAK_WAR_SUPPORT / 10}% war support; you'll be a traitor for ${GS_TRAITOR_SECONDS}s"
                  data-testid="gs-break-truce"
                  @click=${() => onBreak(t.target)}
                >
                  Break (${BREAK_PP_COST / 1000} PP)
                </button>
                <span
                  class="text-[10px] leading-tight text-yellow-300"
                  data-testid="gs-break-warning"
                  >You'll be a traitor for ${GS_TRAITOR_SECONDS}s</span
                >
              </span>`
      }
    </div>`;
  })}`;
}

/** Rules note for revanche (shown behind the War tab's (i)). */
export function revancheRulesNote(): string {
  return (
    `Losing ${REVANCHE_MIN_LOST_PERMILLE / 10}%+ of your peak land in a war ` +
    `leaves a revanche claim on the winner for ${REVANCHE_SECONDS / 60} min: ` +
    `while the truce holds you recover (+${RECOVERY_MANPOWER / 10}% manpower, ` +
    `+${RECOVERY_POLITICAL_POWER / 10}% PP, faster weariness recovery); after ` +
    `half its lock you may break it for ${REVANCHE_BREAK_PP / 1000} PP with no ` +
    `other cost and no traitor mark, and attacking the winner costs ` +
    `${-REVANCHE_ATTACK_LOSS / 10}% fewer troops until the land is back.`
  );
}

/** One-line rules note for truces. */
export function truceRulesNote(): string {
  return (
    `Peace and capitulation bring a truce: no attacks or nukes either way, ` +
    `land stays where it is. It cannot be broken for ${TRUCE_MIN_LOCK / 60}-` +
    `${TRUCE_MAX_LOCK / 60} min (longer after a capitulation, a big loss or ` +
    `against a much bigger winner; shorter after a short war between calm ` +
    `sides). In its last ${TRUCE_BREAKABLE_SECONDS / 60} min either side may ` +
    `break it for ${BREAK_PP_COST / 1000} PP and ` +
    `${-BREAK_WAR_SUPPORT / 10}% war support: the breaker is a traitor for ` +
    `${GS_TRAITOR_SECONDS}s (weaker defence, nations target it) and the ` +
    `victim gets a war goal.`
  );
}

/** Two cells for the panel's two-column stats grid: the current ideology. */
export function renderIdeologyRow(d: GrandStrategyUpdate) {
  const def = ideologyDef(d.ideology);
  return html`<span>Ideology</span>
    <span class="text-right" data-testid="gs-ideology"
      >${def.name}${
        (d.ideologyCooldown ?? 0) > 0
          ? html` <span class="opacity-60">(${d.ideologyCooldown}s)</span>`
          : nothing
      }</span
    >`;
}

/**
 * Ideology picker (for the Decisions tab): one button per ideology with
 * its effects; adopting costs IDEOLOGY_COST PP and starts a cooldown.
 */
export function renderIdeologyChoices(
  d: GrandStrategyUpdate,
  onAdopt: (id: GsActionID) => void,
) {
  const holder = {
    politicalPower: d.politicalPower * 1000,
    ideology: d.ideology,
    ideologyCooldown: d.ideologyCooldown,
  };
  return html`<div data-testid="gs-ideologies">
    <div class="font-semibold">
      Ideology (${IDEOLOGY_COST / 1000} PP, then ${IDEOLOGY_COOLDOWN / 60} min
      cooldown)
    </div>
    ${IDEOLOGIES.map((i) => {
      const check = canAdoptIdeology(holder, i.id);
      const active = check === "active";
      const enabled = check === "ok";
      return html`<button
        class="mt-1 block w-full rounded px-3 py-2 text-left sm:px-2 sm:py-1 ${
          active
            ? "bg-green-900/70"
            : enabled
              ? "bg-gray-700 hover:bg-gray-600"
              : "bg-gray-900/60 text-gray-500"
        }"
        ?disabled=${!enabled}
        @click=${() => onAdopt(ideologyAction(i.id))}
      >
        <div class="font-semibold">
          ${i.name}
          ${
            active
              ? html`<span class="float-right font-normal">Active</span>`
              : check === "cooldown"
                ? html`<span class="float-right font-normal"
                    >${d.ideologyCooldown}s</span
                  >`
                : nothing
          }
        </div>
        <div class="opacity-80">${i.description}</div>
      </button>`;
    })}
    <div class="opacity-60">
      Nations sharing an ideology make peace more readily and rarely break
      truces with each other.
    </div>
  </div>`;
}

/** Short reason a faction action is unavailable. */
const FACTION_REASON: Record<string, string> = {
  disabled: "Unavailable",
  in_faction: "In a faction",
  no_faction: "Gone",
  no_ideology: "Needs an ideology",
  ideology: "Other ideology",
  no_political_power: `Needs ${FACTION_CREATE_PP / 1000} PP`,
  too_many: "Too many factions",
  full: "Full",
  leader_too_big: "Leader too big",
  too_big: "Too big",
  at_war: "At war",
  alliance_blocked: "Can't ally",
  invite_only: "Humans only",
  puppet: "Puppets can't",
};

/**
 * M7C stage 3, War tab: our faction (members, Leave) or a Found button
 * and the factions we could join.
 */
export function renderFaction(
  d: GrandStrategyUpdate,
  name: (id: string) => string,
  on: {
    found: () => void;
    join: (leader: string) => void;
    leave: () => void;
  },
) {
  if (d.factions === undefined) return nothing;
  const f = d.faction ?? null;
  const btn = (enabled: boolean) =>
    `min-h-10 shrink-0 rounded px-3 sm:min-h-0 sm:px-2 ${
      enabled ? "bg-gray-700 hover:bg-gray-600" : "bg-gray-900/60 text-gray-500"
    }`;
  if (f !== null) {
    return html`<div data-testid="gs-faction">
      <div class="flex items-center justify-between gap-2">
        <span class="min-w-0 truncate font-semibold"
          >${factionName(name(f.leader))}
          <span class="font-normal opacity-70"
            >${f.members.length}/${f.cap} · ${Math.floor(f.share / 10)}%</span
          ></span
        >
        <button
          class=${btn(true)}
          data-testid="gs-faction-leave"
          @click=${() => on.leave()}
        >
          Leave
        </button>
      </div>
      <div class="truncate opacity-80" data-testid="gs-faction-members">
        ${f.members
          .map((m, i) => (i === 0 ? `★ ${name(m)}` : name(m)))
          .join(" · ")}
      </div>
    </div>`;
  }
  const canFound = d.canFound === "ok";
  return html`<div data-testid="gs-faction">
    <div class="flex items-center justify-between gap-2">
      <span class="font-semibold">Faction</span>
      <button
        class=${btn(canFound)}
        ?disabled=${!canFound}
        data-testid="gs-faction-found"
        @click=${() => on.found()}
      >
        ${
          canFound
            ? `Found (${FACTION_CREATE_PP / 1000} PP)`
            : (FACTION_REASON[d.canFound ?? "disabled"] ?? "Found")
        }
      </button>
    </div>
    ${d.factions.map(
      (x) =>
        html`<div
          class="flex items-center justify-between gap-2"
          data-testid="gs-faction-row"
        >
          <span class="min-w-0 truncate"
            >${factionName(name(x.leader))}
            <span class="opacity-70"
              >${ideologyDef(x.ideology).name} · ${x.members} ·
              ${Math.floor(x.share / 10)}%</span
            ></span
          >
          ${
            x.join === "ok"
              ? html`<button
                  class=${btn(true)}
                  data-testid="gs-faction-join"
                  @click=${() => on.join(x.leader)}
                >
                  Join
                </button>`
              : html`<span class="shrink-0 text-[11px] opacity-60"
                  >${FACTION_REASON[x.join] ?? x.join}</span
                >`
          }
        </div>`,
    )}
  </div>`;
}

/** Rules note for factions (behind the War tab's (i)). */
export function factionRulesNote(): string {
  return (
    `Factions: nations of one ideology, all allied. Founding costs ` +
    `${FACTION_CREATE_PP / 1000} PP. When a member loses land, the others get ` +
    `a war goal on the attacker (call to arms). Size is capped by the number ` +
    `of nations; a leader over 25% of the world cannot take members, no join ` +
    `may push a faction past 40%, no calls to arms above 35%, and a faction ` +
    `over 50% breaks up.`
  );
}

/** Short reason a puppet action is unavailable. */
const PUPPET_REASON: Record<string, string> = {
  disabled: "Unavailable",
  invalid_target: "Gone",
  not_puppetable: "Too late",
  is_puppet: "We are a puppet",
  already_puppet: "Already a puppet",
  too_big: "Too big",
  bloc_too_big: "Bloc too big",
  too_many: "Puppet cap",
  no_political_power: "Needs PP",
  too_early: "Not yet",
  not_puppet: "",
};

/**
 * M7 stage D, War tab: our overlord (autonomy bar, tribute, Independence
 * button), our puppets (autonomy, tribute, Release), and beaten nations we
 * may still puppet (Puppet button with the seconds left).
 */
export function renderPuppets(
  d: GrandStrategyUpdate,
  name: (id: string) => string,
  on: {
    demand: (id: string) => void;
    release: (id: string) => void;
    independence: () => void;
  },
) {
  if (d.puppets === undefined) return nothing;
  const overlord = d.overlord ?? null;
  const windows = d.puppetWindows ?? [];
  if (overlord === null && d.puppets.length === 0 && windows.length === 0) {
    return nothing;
  }
  const btn = (enabled: boolean, tone = "bg-gray-700 hover:bg-gray-600") =>
    `min-h-10 shrink-0 rounded px-3 sm:min-h-0 sm:px-2 ${
      enabled ? tone : "bg-gray-900/60 text-gray-500"
    }`;
  const bar = (autonomy: number, testid: string) => {
    const pct = Math.floor(
      (Math.min(autonomy, AUTONOMY_MAX) * 100) / AUTONOMY_MAX,
    );
    return html`<div
      class="h-1.5 w-full overflow-hidden rounded bg-gray-800"
      role="progressbar"
      aria-valuenow=${pct}
      aria-valuemin="0"
      aria-valuemax="100"
      data-testid=${testid}
    >
      <div class="h-full bg-sky-400" style="width:${pct}%"></div>
    </div>`;
  };
  const free = d.independence === "ok";
  return html`<div class="space-y-1" data-testid="gs-puppets">
    ${
      overlord !== null
        ? html`<div
            class="space-y-1 rounded bg-sky-950/60 px-2 py-1"
            data-testid="gs-overlord"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 truncate"
                >Puppet of <b>${name(overlord)}</b></span
              >
              <button
                class=${btn(free, "bg-sky-700 hover:bg-sky-600")}
                ?disabled=${!free}
                title="Break free for ${INDEPENDENCE_PP / 1000} PP"
                data-testid="gs-independence"
                @click=${() => on.independence()}
              >
                ${
                  free
                    ? `Independence (${INDEPENDENCE_PP / 1000} PP)`
                    : (PUPPET_REASON[d.independence ?? "too_early"] ??
                      "Not yet")
                }
              </button>
            </div>
            <div class="flex items-center gap-2">
              <span class="shrink-0 opacity-70"
                >Autonomy ${Math.floor((d.autonomy ?? 0) / 10)}% · tribute
                ${Math.floor((d.tribute ?? 0) / 10)}%</span
              >
              ${bar(d.autonomy ?? 0, "gs-autonomy-bar")}
            </div>
          </div>`
        : nothing
    }
    ${
      d.puppets.length > 0
        ? html`<div class="font-semibold">
            Puppets ${d.puppets.length}/${d.puppetCap ?? d.puppets.length}
          </div>`
        : nothing
    }
    ${d.puppets.map(
      (p) =>
        html`<div class="space-y-0.5" data-testid="gs-puppet-row">
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate"
              >${name(p.id)}
              <span class="opacity-70"
                >· tribute ${Math.floor(p.tribute / 10)}% · autonomy
                ${Math.floor(p.autonomy / 10)}%</span
              ></span
            >
            <button
              class=${btn(true)}
              data-testid="gs-puppet-release"
              @click=${() => on.release(p.id)}
            >
              Release
            </button>
          </div>
          ${bar(p.autonomy, "gs-puppet-autonomy")}
        </div>`,
    )}
    ${windows.map(
      (w) =>
        html`<div
          class="flex items-center justify-between gap-2"
          data-testid="gs-puppet-window"
        >
          <span class="min-w-0 truncate"
            >${name(w.target)} is beaten
            <span class="opacity-70">${w.seconds}s</span></span
          >
          ${
            w.check === "ok"
              ? html`<button
                  class=${btn(true, "bg-sky-700 hover:bg-sky-600")}
                  data-testid="gs-puppet-demand"
                  @click=${() => on.demand(w.target)}
                >
                  Puppet (${PUPPET_PP / 1000} PP)
                </button>`
              : html`<span class="shrink-0 text-[11px] opacity-60"
                  >${PUPPET_REASON[w.check] ?? w.check}</span
                >`
          }
        </div>`,
    )}
  </div>`;
}

/** Rules note for puppets (behind the War tab's (i)). */
export function puppetRulesNote(): string {
  return (
    `Puppets: for ${PUPPET_WINDOW}s after a won peace or capitulation you ` +
    `may make the loser your puppet for ${PUPPET_PP / 1000} PP instead of ` +
    `leaving it a truce (it may hold at most ${PUPPET_MAX_SIZE / 10}% of your ` +
    `land; your bloc may not pass ${PUPPET_MAX_BLOC_SHARE / 10}% of the ` +
    `world). A puppet keeps its land, never fights its overlord, is in no ` +
    `faction, joins the overlord's wars and pays up to ` +
    `${PUPPET_TRIBUTE / 10}% of its PP, gold and manpower (less as the ` +
    `overlord's bloc nears ${TRIBUTE_FADE_SHARE / 10}% of the world). ` +
    `Autonomy builds over time, faster under a weary or dominant overlord; ` +
    `at full autonomy, or from ${INDEPENDENCE_EARLY_AUTONOMY / 10}% ` +
    `autonomy if the overlord is over ${INDEPENDENCE_WEARY_AT / 10}% ` +
    `weariness or has fewer troops than the puppet, the puppet may break ` +
    `free for ${INDEPENDENCE_PP / 1000} PP (truce ${INDEPENDENCE_LOCK / 60} ` +
    `min).`
  );
}

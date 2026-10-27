import { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { focusById } from "@openfront/engine-lib/game/GrandStrategy";
import { ideologyDef } from "@openfront/engine-lib/game/GrandStrategyIdeology";
import {
  ATOMIC_PROJECT,
  techById,
} from "@openfront/engine-lib/game/GrandStrategyResearch";
import { html, nothing, TemplateResult } from "lit";
import { gsIcon, GsIconName } from "./GsIcons";

/** Command-panel tabs, in hotkey order (F1..F6). */
export type GsTab =
  | "economy"
  | "laws"
  | "focus"
  | "research"
  | "decisions"
  | "war";

export type GsAlertKind =
  | "war"
  | "peace"
  | "truce"
  | "trucebroken"
  | "ideology"
  | "capitulation"
  | "research"
  | "focus"
  | "atomic"
  | "wargoal"
  | "coalition"
  | "revanche"
  | "faction"
  | "puppet";

export type GsAlertTone = "danger" | "good" | "warn" | "info";

/** One alert as derived from two consecutive updates (no id/time yet). */
export interface GsAlertDraft {
  kind: GsAlertKind;
  text: string;
  tab: GsTab;
  tone: GsAlertTone;
  /** Player the alert is about, when it has one (peace: Accept target). */
  target?: string;
}

export interface GsAlert extends GsAlertDraft {
  id: number;
  /** Date.now() when raised. */
  born: number;
}

/** How long an alert stays, ms. Peace offers stay while the offer is open. */
export const ALERT_MS: Record<GsAlertKind, number> = {
  war: 10_000,
  peace: 60_000,
  truce: 10_000,
  trucebroken: 12_000,
  ideology: 8_000,
  capitulation: 15_000,
  research: 8_000,
  focus: 8_000,
  atomic: 10_000,
  wargoal: 12_000,
  coalition: 15_000,
  revanche: 12_000,
  faction: 10_000,
  puppet: 12_000,
};

export const MAX_ALERTS = 4;

function added<T>(before: readonly T[], after: readonly T[]): T[] {
  const s = new Set(before);
  return after.filter((x) => !s.has(x));
}

/**
 * Alerts for what changed between two Grand Strategy updates of the local
 * nation. Pure: reads only the two updates (the client gets nothing else
 * about these events), so it can be unit tested without a game.
 * `capitulatedToMe` holds players whose capitulation to us arrived as a
 * world message this tick; their new truce is reported as a capitulation.
 */
export function diffGsAlerts(
  prev: GrandStrategyUpdate | null,
  next: GrandStrategyUpdate,
  nameOf: (id: string) => string,
  capitulatedToMe: ReadonlySet<string> = new Set(),
): GsAlertDraft[] {
  if (prev === null) return [];
  const out: GsAlertDraft[] = [];
  const ids = <T extends { target: string }>(l: readonly T[] | undefined) =>
    (l ?? []).map((x) => x.target);

  for (const t of added(ids(prev.wars), ids(next.wars))) {
    out.push({
      kind: "war",
      text: `War with ${nameOf(t)}`,
      tab: "war",
      tone: "danger",
      target: t,
    });
  }
  for (const t of added(
    prev.peaceOffersToMe ?? [],
    next.peaceOffersToMe ?? [],
  )) {
    out.push({
      kind: "peace",
      text: `${nameOf(t)} offers peace`,
      tab: "war",
      tone: "good",
      target: t,
    });
  }
  // Our own capitulation resets our peak land to the land we kept.
  const iCapitulated = (next.peakTiles ?? 0) < (prev.peakTiles ?? 0);
  for (const t of added(ids(prev.truces), ids(next.truces))) {
    if (iCapitulated) {
      out.push({
        kind: "capitulation",
        text: `We capitulated to ${nameOf(t)}`,
        tab: "war",
        tone: "danger",
        target: t,
      });
    } else if (capitulatedToMe.has(t)) {
      out.push({
        kind: "capitulation",
        text: `${nameOf(t)} capitulated to us`,
        tab: "war",
        tone: "good",
        target: t,
      });
    } else {
      out.push({
        kind: "truce",
        text: `Truce with ${nameOf(t)}`,
        tab: "war",
        tone: "good",
        target: t,
      });
    }
  }
  // A truce that vanishes with time still left on it was broken (by us or
  // by them); one that ran out counts down to its last second first.
  const nextTruces = new Set(ids(next.truces));
  for (const t of prev.truces ?? []) {
    if (t.seconds > 2 && !nextTruces.has(t.target)) {
      out.push({
        kind: "trucebroken",
        text: `Truce with ${nameOf(t.target)} broken`,
        tab: "war",
        tone: "danger",
        target: t.target,
      });
    }
  }
  // M7C stage 2: a new revanche claim, and a claim whose truce may now be
  // broken (its wait reached zero while the truce still stands).
  const prevClaims = new Map((prev.revanche ?? []).map((r) => [r.target, r]));
  const truceNow = new Set(ids(next.truces));
  for (const r of next.revanche ?? []) {
    const before = prevClaims.get(r.target);
    if (before === undefined) {
      out.push({
        kind: "revanche",
        text: `Revanche claim on ${nameOf(r.target)}: ${r.tiles} tiles`,
        tab: "war",
        tone: "warn",
        target: r.target,
      });
    } else if (before.wait > 0 && r.wait === 0 && truceNow.has(r.target)) {
      out.push({
        kind: "revanche",
        text: `Revanche ready against ${nameOf(r.target)}`,
        tab: "war",
        tone: "warn",
        target: r.target,
      });
    }
  }
  // M7C stage 3: faction membership.
  const pf = prev.faction ?? null;
  const nf = next.faction ?? null;
  if (prev.factions !== undefined && next.factions !== undefined) {
    if (pf === null && nf !== null) {
      out.push({
        kind: "faction",
        text:
          nf.leader === next.player
            ? "We founded a faction"
            : `We joined ${nameOf(nf.leader)}'s faction`,
        tab: "war",
        tone: "good",
        target: nf.leader,
      });
    } else if (pf !== null && nf === null) {
      out.push({
        kind: "faction",
        text: "We are no longer in a faction",
        tab: "war",
        tone: "warn",
      });
    } else if (pf !== null && nf !== null) {
      for (const m of added(pf.members, nf.members)) {
        if (m === next.player) continue;
        out.push({
          kind: "faction",
          text: `${nameOf(m)} joined our faction`,
          tab: "war",
          tone: "good",
          target: m,
        });
      }
    }
  }
  // M7 stage D: puppet bonds (fields absent when puppets are off).
  if (prev.puppets !== undefined && next.puppets !== undefined) {
    const po = prev.overlord ?? null;
    const no = next.overlord ?? null;
    if (po === null && no !== null) {
      out.push({
        kind: "puppet",
        text: `We are now a puppet of ${nameOf(no)}`,
        tab: "war",
        tone: "danger",
        target: no,
      });
    } else if (po !== null && no === null) {
      out.push({
        kind: "puppet",
        text: `We are free of ${nameOf(po)}`,
        tab: "war",
        tone: "good",
        target: po,
      });
    } else if (
      no !== null &&
      prev.independence !== "ok" &&
      next.independence === "ok"
    ) {
      out.push({
        kind: "puppet",
        text: `We may break free of ${nameOf(no)}`,
        tab: "war",
        tone: "good",
        target: no,
      });
    }
    const had = prev.puppets.map((x) => x.id);
    const have = next.puppets.map((x) => x.id);
    for (const id of added(had, have)) {
      out.push({
        kind: "puppet",
        text: `${nameOf(id)} is now our puppet`,
        tab: "war",
        tone: "good",
        target: id,
      });
    }
    for (const id of added(have, had)) {
      out.push({
        kind: "puppet",
        text: `${nameOf(id)} is no longer our puppet`,
        tab: "war",
        tone: "warn",
        target: id,
      });
    }
    const opened = added(
      (prev.puppetWindows ?? []).map((w) => w.target),
      (next.puppetWindows ?? [])
        .filter((w) => w.check === "ok")
        .map((w) => w.target),
    );
    for (const id of opened) {
      out.push({
        kind: "puppet",
        text: `${nameOf(id)} is beaten: make it our puppet?`,
        tab: "war",
        tone: "info",
        target: id,
      });
    }
  }
  if (
    prev.ideology !== undefined &&
    next.ideology !== undefined &&
    next.ideology !== prev.ideology
  ) {
    out.push({
      kind: "ideology",
      text: `New ideology: ${ideologyDef(next.ideology).name}`,
      tab: "decisions",
      tone: "info",
    });
  }
  for (const t of added(prev.justifiedAgainstMe, next.justifiedAgainstMe)) {
    out.push({
      kind: "wargoal",
      text: `${nameOf(t)} seeks a war goal on us`,
      tab: "war",
      tone: "danger",
      target: t,
    });
  }
  if (
    next.coalitionLeader !== null &&
    next.coalitionLeader !== prev.coalitionLeader
  ) {
    const me = next.player;
    out.push({
      kind: "coalition",
      text:
        next.coalitionLeader === me
          ? "A coalition has formed against us"
          : `Coalition against ${nameOf(next.coalitionLeader)}`,
      tab: "war",
      tone: next.coalitionLeader === me ? "danger" : "info",
      target: next.coalitionLeader,
    });
  }
  for (const id of added(prev.researched, next.researched)) {
    out.push(
      id === ATOMIC_PROJECT
        ? {
            kind: "atomic",
            text: "Our atomic project is complete",
            tab: "research",
            tone: "warn",
          }
        : {
            kind: "research",
            text: `Researched ${techById(id)?.name ?? id}`,
            tab: "research",
            tone: "info",
          },
    );
  }
  for (const id of added(prev.completed, next.completed)) {
    out.push({
      kind: "focus",
      text: `Focus done: ${focusById(id)?.name ?? id}`,
      tab: "focus",
      tone: "info",
    });
  }
  // Other nations' bombs. Many AIs start in the same second: one line.
  const me = next.player;
  const started = added(
    (prev.atomicProjects ?? []).map((p) => p.player),
    (next.atomicProjects ?? []).map((p) => p.player),
  ).filter((p) => p !== me);
  if (started.length === 1) {
    out.push({
      kind: "atomic",
      text: `${nameOf(started[0])} started an atomic project`,
      tab: "war",
      tone: "warn",
      target: started[0],
    });
  } else if (started.length > 1) {
    out.push({
      kind: "atomic",
      text: `${started.length} nations started atomic projects`,
      tab: "war",
      tone: "warn",
    });
  }
  const powers = added(prev.atomicPowers ?? [], next.atomicPowers ?? []).filter(
    (p) => p !== me,
  );
  if (powers.length === 1) {
    out.push({
      kind: "atomic",
      text: `${nameOf(powers[0])} can build nuclear weapons`,
      tab: "war",
      tone: "danger",
      target: powers[0],
    });
  } else if (powers.length > 1) {
    out.push({
      kind: "atomic",
      text: `${powers.length} nations can build nuclear weapons`,
      tab: "war",
      tone: "danger",
    });
  }
  return out;
}

const TONE_CLASS: Record<GsAlertTone, string> = {
  danger: "border-red-500 bg-red-950/90",
  good: "border-emerald-500 bg-emerald-950/90",
  warn: "border-amber-400 bg-amber-950/90",
  info: "border-sky-500 bg-slate-900/90",
};

const KIND_ICON: Record<GsAlertKind, GsIconName> = {
  war: "war",
  peace: "peace",
  truce: "peace",
  trucebroken: "war",
  ideology: "decisions",
  capitulation: "war",
  research: "research",
  focus: "focus",
  atomic: "atomic",
  wargoal: "war",
  coalition: "war",
  revanche: "war",
  faction: "peace",
  puppet: "peace",
};

export interface GsAlertHandlers {
  open: (a: GsAlert) => void;
  dismiss: (a: GsAlert) => void;
  /** Accept button on a peace offer (sends the existing peace intent). */
  accept: (a: GsAlert) => void;
  /** Whether a peace offer from `target` is still open. */
  offerOpen: (target: string) => boolean;
}

/** The notification stack: newest on top, tap to open the relevant tab. */
export function renderGsAlerts(
  alerts: readonly GsAlert[],
  h: GsAlertHandlers,
  topPx: number,
): TemplateResult | typeof nothing {
  if (alerts.length === 0) return nothing;
  return html`<div
    class="pointer-events-none fixed right-1 z-[890] flex w-[min(272px,72vw)] flex-col gap-1 sm:right-2"
    style="top:${topPx}px"
    data-testid="gs-alerts"
    aria-live="polite"
  >
    ${alerts.map(
      (a) =>
        html`<div
          class="pointer-events-auto flex items-stretch overflow-hidden rounded-md border-l-4 text-white shadow-lg ${TONE_CLASS[a.tone]}"
          data-testid="gs-alert"
          data-kind=${a.kind}
        >
          <button
            class="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-xs leading-tight"
            title="Open ${a.tab} tab"
            @click=${() => h.open(a)}
          >
            ${gsIcon(KIND_ICON[a.kind], 16)}
            <span class="min-w-0 break-words">${a.text}</span>
          </button>
          ${
            a.kind === "peace" &&
            a.target !== undefined &&
            h.offerOpen(a.target)
              ? html`<button
                  class="my-1 min-h-8 shrink-0 rounded bg-emerald-600 px-2 text-xs font-semibold hover:bg-emerald-500"
                  data-testid="gs-alert-accept"
                  @click=${() => h.accept(a)}
                >
                  Accept
                </button>`
              : nothing
          }
          <button
            class="flex min-h-10 w-9 shrink-0 items-center justify-center text-white/60 hover:text-white"
            aria-label="Dismiss"
            @click=${() => h.dismiss(a)}
          >
            ${gsIcon("close", 14)}
          </button>
        </div>`,
    )}
  </div>`;
}

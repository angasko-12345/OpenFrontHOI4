/**
 * Grand Strategy, M7 stage D: puppets. Pure rules, integer maths only.
 * Inspired by the general idea of subject states in grand strategy games;
 * names and numbers are our own.
 *
 * - After a won peace or capitulation (the loser lost at least
 *   PUPPET_MIN_LOST of its peak land in the war), the winner may, for
 *   PUPPET_WINDOW seconds, make the loser its puppet instead of keeping
 *   the plain truce (and the option to finish it off later): PUPPET_PP,
 *   bounded by size, by a per-overlord cap and by the bloc's land share.
 * - A puppet keeps its land, may never attack (or be attacked by) its
 *   overlord, is in no faction, and pays the overlord a share of its
 *   political power, gold and manpower. The share falls as the overlord's
 *   bloc grows and as the puppet's autonomy builds.
 * - Autonomy builds every second (faster while the overlord is war-weary,
 *   the coalition target, or not much bigger than the puppet). The puppet
 *   may declare independence once autonomy is full, or at once while the
 *   overlord is very weary or has fewer troops than the puppet.
 *   No randomness: every rule is a threshold.
 */
import type { AiPersonality } from "./GrandStrategy";

/** Political power (thousandths) to puppet a beaten nation. */
export const PUPPET_PP = 75_000;
/** Seconds after the peace/capitulation the winner may still puppet. */
export const PUPPET_WINDOW = 60;
/** Share of its peak land (per-mille) the loser must have lost in the war. */
export const PUPPET_MIN_LOST = 200;
/** The puppet may hold at most this share of the overlord's land, per-mille. */
export const PUPPET_MAX_SIZE = 750;
/** Most puppets one overlord may hold. */
export const PUPPET_MAX_PER_OVERLORD = 2;
/** Overlord + puppets + the new puppet may hold at most this world share. */
export const PUPPET_MAX_BLOC_SHARE = 350;
/** Share (per-mille) of PP, gold and manpower a fresh puppet pays. */
export const PUPPET_TRIBUTE = 250;
/** Overlord bloc share (per-mille) at which tribute reaches zero. */
export const TRIBUTE_FADE_SHARE = 400;
/** Autonomy is per-mille; full autonomy allows independence. */
export const AUTONOMY_MAX = 1000;
/** Autonomy per second, always. */
export const AUTONOMY_BASE = 1;
/** Extra autonomy per second while the overlord is war-weary. */
export const AUTONOMY_WEARY = 2;
/** Overlord weariness (per-mille) that counts as war-weary. */
export const AUTONOMY_WEARY_AT = 300;
/** Extra autonomy per second while the overlord is the coalition target. */
export const AUTONOMY_COALITION = 2;
/** Extra autonomy per second while the puppet has half the overlord's land. */
export const AUTONOMY_STRONG = 2;
/** Overlord weariness (per-mille) at which a puppet may break free early. */
export const INDEPENDENCE_WEARY_AT = 500;
/**
 * Autonomy a puppet needs before it may break free early (weary or weaker
 * overlord). A minimum term: without it a puppet made right after a war
 * could leave at once, since the winner is usually weary and its troops
 * are out fighting.
 */
export const INDEPENDENCE_EARLY_AUTONOMY = 500;
/** Political power (thousandths) to declare independence. */
export const INDEPENDENCE_PP = 25_000;
/** Truce lock (seconds) after independence or a release. */
export const INDEPENDENCE_LOCK = 120;
/** A puppet joins an overlord's war only below this weariness (per-mille). */
export const WAR_JOIN_MAX_WEARINESS = 300;
/** ... and only while fighting at most this many wars of its own. */
export const WAR_JOIN_MAX_WARS = 1;

export type PuppetCheck =
  | "ok"
  | "disabled"
  | "invalid_target"
  | "not_puppetable"
  | "is_puppet"
  | "already_puppet"
  | "too_big"
  | "bloc_too_big"
  | "too_many"
  | "no_political_power";

export interface PuppetInput {
  /** The demander is itself a puppet. */
  demanderIsPuppet: boolean;
  /** The target is already someone's puppet. */
  targetIsPuppet: boolean;
  /** An open puppet window on the target (won peace / capitulation). */
  window: boolean;
  demanderTiles: number;
  targetTiles: number;
  /** Puppets the demander holds now. */
  puppets: number;
  /** Bloc share (demander + its puppets) per-mille, before the target. */
  blocShare: number;
  /** Target's world share per-mille. */
  targetShare: number;
  politicalPower: number;
}

/** Whether a winner may puppet the loser now. */
export function canPuppet(i: PuppetInput): PuppetCheck {
  if (i.demanderIsPuppet) return "is_puppet";
  if (i.targetIsPuppet) return "already_puppet";
  if (!i.window) return "not_puppetable";
  if (i.targetTiles * 1000 > i.demanderTiles * PUPPET_MAX_SIZE) {
    return "too_big";
  }
  if (i.puppets >= PUPPET_MAX_PER_OVERLORD) return "too_many";
  if (i.blocShare + i.targetShare > PUPPET_MAX_BLOC_SHARE) {
    return "bloc_too_big";
  }
  if (i.politicalPower < PUPPET_PP) return "no_political_power";
  return "ok";
}

/**
 * Tribute share (per-mille) a puppet pays: PUPPET_TRIBUTE, scaled down
 * linearly to 0 as the overlord's bloc nears TRIBUTE_FADE_SHARE of the
 * world, and by up to half at full autonomy.
 */
export function tributePermille(blocShare: number, autonomy: number): number {
  const fade = clamp(
    TRIBUTE_FADE_SHARE - Math.floor(blocShare),
    0,
    TRIBUTE_FADE_SHARE,
  );
  const base = Math.floor((PUPPET_TRIBUTE * fade) / TRIBUTE_FADE_SHARE);
  const keep = 1000 - Math.floor(clamp(autonomy, 0, AUTONOMY_MAX) / 2);
  return Math.floor((base * keep) / 1000);
}

/** The part of `amount` paid as tribute (rounded down, never negative). */
export function tributeOf(amount: number, permille: number): number {
  if (amount <= 0 || permille <= 0) return 0;
  return Math.floor((amount * Math.min(1000, permille)) / 1000);
}

export interface AutonomyInput {
  /** Overlord weariness, per-mille. */
  overlordWeariness: number;
  overlordIsCoalitionTarget: boolean;
  puppetTiles: number;
  overlordTiles: number;
}

/** Autonomy after one second. */
export function advanceAutonomy(current: number, i: AutonomyInput): number {
  let gain = AUTONOMY_BASE;
  if (i.overlordWeariness >= AUTONOMY_WEARY_AT) gain += AUTONOMY_WEARY;
  if (i.overlordIsCoalitionTarget) gain += AUTONOMY_COALITION;
  if (i.puppetTiles * 2 >= i.overlordTiles) gain += AUTONOMY_STRONG;
  return clamp(Math.floor(current) + gain, 0, AUTONOMY_MAX);
}

export type IndependenceCheck =
  | "ok"
  | "disabled"
  | "not_puppet"
  | "too_early"
  | "no_political_power";

export interface IndependenceInput {
  isPuppet: boolean;
  autonomy: number;
  /** Overlord weariness, per-mille. */
  overlordWeariness: number;
  puppetTroops: number;
  overlordTroops: number;
  politicalPower: number;
}

/**
 * Whether a puppet may declare independence: full autonomy, or (after
 * INDEPENDENCE_EARLY_AUTONOMY) an overlord that is very war-weary or has
 * fewer troops than the puppet.
 */
export function canDeclareIndependence(
  i: IndependenceInput,
): IndependenceCheck {
  if (!i.isPuppet) return "not_puppet";
  const early =
    i.autonomy >= INDEPENDENCE_EARLY_AUTONOMY &&
    (i.overlordWeariness >= INDEPENDENCE_WEARY_AT ||
      i.puppetTroops >= i.overlordTroops);
  const free = i.autonomy >= AUTONOMY_MAX || early;
  if (!free) return "too_early";
  if (i.politicalPower < INDEPENDENCE_PP) return "no_political_power";
  return "ok";
}

/**
 * Whether an AI winner puppets its beaten enemy rather than keeping the
 * plain truce: militarists never (they keep the option to annex),
 * industrialists always (tribute), defenders when the loser is worth it
 * (at least a quarter of the winner's land).
 */
export function aiPrefersPuppet(
  personality: AiPersonality,
  loserTiles: number,
  winnerTiles: number,
): boolean {
  if (personality === "militarist") return false;
  if (personality === "industrialist") return true;
  return loserTiles * 4 >= winnerTiles;
}

/** Whether a puppet joins its overlord's war against an enemy. */
export function puppetJoinsWar(i: {
  /** Puppet weariness, per-mille. */
  weariness: number;
  /** Wars the puppet fights now. */
  wars: number;
  /** A truce (or a goal already held) stops it. */
  blocked: boolean;
}): boolean {
  return (
    !i.blocked &&
    i.weariness < WAR_JOIN_MAX_WEARINESS &&
    i.wars <= WAR_JOIN_MAX_WARS
  );
}

/** Open puppet windows: (target, seconds left). */
export interface PuppetWindow {
  target: number;
  seconds: number;
}

export function addWindow(
  list: PuppetWindow[],
  target: number,
): PuppetWindow[] {
  return [
    ...list.filter((w) => w.target !== target),
    { target, seconds: PUPPET_WINDOW },
  ];
}

export function advanceWindows(list: readonly PuppetWindow[]): PuppetWindow[] {
  return list
    .map((w) => ({ target: w.target, seconds: w.seconds - 1 }))
    .filter((w) => w.seconds > 0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

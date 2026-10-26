/**
 * Grand Strategy, milestone 7 stage A: war weariness, capitulation and
 * peace. Pure rules, integer maths only.
 *
 * OpenFront has no formal war state: any two non-friendly players may
 * attack each other. Here two nations are "at war" while land keeps
 * changing hands between them (an enemy entry, refreshed by every
 * conquered tile, dropped after WAR_IDLE_SECONDS without one).
 *
 * - War weariness rises with troops lost attacking, land lost and long
 *   wars, faster for big and over-extended nations, and decays in peace.
 *   It raises attack losses and lowers political power and war support.
 * - Capitulation: a nation that keeps less than CAPITULATE_PERMILLE of its
 *   peak land gets a truce with its main attacker, who keeps what it took.
 * - Peace: an offer between nations at war; accepted, it becomes a truce.
 * - A truce forbids attacks between the pair for TRUCE_SECONDS. It is a
 *   lock on attacking only, not an alliance.
 */
import type { AiPersonality } from "./GrandStrategy";

/** Seconds without a tile changing hands before a war is over. */
export const WAR_IDLE_SECONDS = 60;
/** A war older than this (seconds) wears the nation down every second. */
export const LONG_WAR_SECONDS = 120;
/** Weariness is stored in thousandths of a per-mille: 1_000_000 = 100%. */
export const WEARINESS_MAX = 1_000_000;
/** Weariness (thousandths) for losing troops equal to the troop cap attacking. */
export const LOSS_WEARINESS = 200_000;
/** Weariness (thousandths) for losing all of the peak land. */
export const LAND_WEARINESS = 400_000;
/** Weariness (thousandths) per second for each long war. */
export const LONG_WAR_WEARINESS = 300;
/** Gain multiplier (per-mille added per 1000 of world land share). */
export const SIZE_WEARINESS = 3000;
/** Gain multiplier (per-mille added per 1000 of occupied share). */
export const OCCUPIED_WEARINESS = 1000;
/** Weariness (thousandths) recovered per second at peace, and at war. */
export const PEACE_RECOVERY = 4000;
export const WAR_RECOVERY = 500;
/** At 100% weariness: attacker losses, political power and war support target. */
export const WEARY_ATTACK_LOSS = 400;
export const WEARY_POLITICAL_POWER = -500;
export const WEARY_WAR_SUPPORT = -500;

/** A nation at war below this share of its peak land capitulates, per-mille. */
export const CAPITULATE_PERMILLE = 500;
/** Peak land must be at least this share of the world (per-mille) to count. */
export const CAPITULATE_MIN_PEAK_PERMILLE = 5;
/** Seconds a truce (from peace or capitulation) forbids attacks. */
export const TRUCE_SECONDS = 300;
/** Seconds a peace offer stays open. */
export const OFFER_SECONDS = 60;

/** One ongoing war, seen from one side. */
export interface EnemyEntry {
  target: number;
  /** Seconds since the war started. */
  seconds: number;
  /** Seconds since land last changed hands. */
  idle: number;
  /** Tiles taken from the enemy in this war. */
  won: number;
  /** Tiles lost to the enemy in this war. */
  lost: number;
}

export interface TimedTarget {
  target: number;
  seconds: number;
}

export interface NationPeaceState {
  /** Most land held (tiles), reset after a capitulation. */
  peakTiles: number;
  /** Tiles lost to other nations since the last second boundary. */
  tilesLostThisSecond: number;
  /** Troops lost attacking nations (not tribes) since the last second boundary. */
  lossesThisSecond: number;
  enemies: EnemyEntry[];
  /** Truces (mirrored on both sides) and their seconds left. */
  truces: TimedTarget[];
  /** Peace offers this nation made, and their seconds left. */
  offers: TimedTarget[];
}

export function newPeaceState(): NationPeaceState {
  return {
    peakTiles: 0,
    tilesLostThisSecond: 0,
    lossesThisSecond: 0,
    enemies: [],
    truces: [],
    offers: [],
  };
}

export function wearinessPermille(weariness: number | undefined): number {
  return Math.floor(clamp(weariness ?? 0, 0, WEARINESS_MAX) / 1000);
}

export function hasTruce(s: NationPeaceState, target: number): boolean {
  return s.truces.some((t) => t.target === target);
}

export function enemyEntry(
  s: NationPeaceState,
  target: number,
): EnemyEntry | undefined {
  return s.enemies.find((e) => e.target === target);
}

function touchEnemy(s: NationPeaceState, target: number): EnemyEntry {
  let e = enemyEntry(s, target);
  if (e === undefined) {
    e = { target, seconds: 0, idle: 0, won: 0, lost: 0 };
    s.enemies.push(e);
  }
  e.idle = 0;
  return e;
}

/** Land changed hands between two nations: both are at war. */
export function recordConquest(
  attacker: NationPeaceState,
  attackerId: number,
  defender: NationPeaceState,
  defenderId: number,
  tiles = 1,
): void {
  const n = Math.max(0, Math.floor(tiles));
  touchEnemy(attacker, defenderId).won += n;
  touchEnemy(defender, attackerId).lost += n;
  defender.tilesLostThisSecond += n;
}

/** Count wars, truces and offers on one second; track peak land. */
export function advancePeaceTimers(
  s: NationPeaceState,
  tilesOwned: number,
): void {
  for (const e of s.enemies) {
    e.seconds++;
    e.idle++;
  }
  s.enemies = s.enemies.filter((e) => e.idle <= WAR_IDLE_SECONDS);
  s.truces = s.truces
    .map((t) => ({ target: t.target, seconds: t.seconds - 1 }))
    .filter((t) => t.seconds > 0);
  s.offers = s.offers
    .map((t) => ({ target: t.target, seconds: t.seconds - 1 }))
    .filter((t) => t.seconds > 0);
  s.peakTiles = Math.max(s.peakTiles, Math.max(0, Math.floor(tilesOwned)));
}

export interface WearinessInput {
  /** Troops lost attacking nations in the second. */
  attackLosses: number;
  maxTroops: number;
  /** Tiles lost to nations in the second. */
  tilesLost: number;
  peakTiles: number;
  tilesOwned: number;
  numLandTiles: number;
  occupied: number;
  /** Wars older than LONG_WAR_SECONDS. */
  longWars: number;
  atWar: boolean;
}

/** Weariness after one second (thousandths of per-mille). */
export function advanceWeariness(current: number, i: WearinessInput): number {
  const lossGain = Math.floor(
    (Math.max(0, Math.floor(i.attackLosses)) * LOSS_WEARINESS) /
      Math.max(1, Math.floor(i.maxTroops)),
  );
  const landGain = Math.floor(
    (Math.max(0, i.tilesLost) * LAND_WEARINESS) / Math.max(1, i.peakTiles),
  );
  const warGain = Math.max(0, i.longWars) * LONG_WAR_WEARINESS;
  const share = permilleOf(i.tilesOwned, i.numLandTiles);
  const occupied = permilleOf(i.occupied, i.tilesOwned);
  const scale =
    1000 +
    Math.floor((share * SIZE_WEARINESS) / 1000) +
    Math.floor((occupied * OCCUPIED_WEARINESS) / 1000);
  const gain = Math.floor(((lossGain + landGain + warGain) * scale) / 1000);
  const recovery = i.atWar ? WAR_RECOVERY : PEACE_RECOVERY;
  return clamp(
    Math.floor(current) + gain - (gain > 0 ? 0 : recovery),
    0,
    WEARINESS_MAX,
  );
}

/** Wars older than LONG_WAR_SECONDS. */
export function longWars(s: NationPeaceState): number {
  return s.enemies.filter((e) => e.seconds >= LONG_WAR_SECONDS).length;
}

/**
 * Who a nation capitulates to this second, if anyone: the enemy that took
 * the most land from it, once it holds less than CAPITULATE_PERMILLE of
 * its peak. Ties go to the lower id.
 */
export function capitulationTarget(
  s: NationPeaceState,
  tilesOwned: number,
  numLandTiles: number,
): number | null {
  if (s.enemies.length === 0) return null;
  if (s.peakTiles * 1000 < numLandTiles * CAPITULATE_MIN_PEAK_PERMILLE) {
    return null;
  }
  if (tilesOwned * 1000 >= s.peakTiles * CAPITULATE_PERMILLE) return null;
  let best: EnemyEntry | null = null;
  for (const e of s.enemies) {
    if (e.lost <= 0) continue;
    if (
      best === null ||
      e.lost > best.lost ||
      (e.lost === best.lost && e.target < best.target)
    ) {
      best = e;
    }
  }
  return best?.target ?? null;
}

/** Truce between two sides; their war and any offers between them end. */
export function addTruce(
  a: NationPeaceState,
  aId: number,
  b: NationPeaceState,
  bId: number,
): void {
  for (const [s, other] of [
    [a, bId],
    [b, aId],
  ] as const) {
    s.enemies = s.enemies.filter((e) => e.target !== other);
    s.offers = s.offers.filter((o) => o.target !== other);
    s.truces = s.truces.filter((t) => t.target !== other);
    s.truces.push({ target: other, seconds: TRUCE_SECONDS });
  }
}

export function hasOffered(s: NationPeaceState, target: number): boolean {
  return s.offers.some((o) => o.target === target);
}

export function addOffer(s: NationPeaceState, target: number): void {
  s.offers = s.offers.filter((o) => o.target !== target);
  s.offers.push({ target, seconds: OFFER_SECONDS });
}

/** Weariness (per-mille) at which each AI personality offers peace. */
export const AI_OFFER_WEARINESS: Readonly<Record<AiPersonality, number>> = {
  defender: 250,
  industrialist: 400,
  militarist: 600,
};
/** Weariness (per-mille) at which each AI personality accepts peace. */
export const AI_ACCEPT_WEARINESS: Readonly<Record<AiPersonality, number>> = {
  defender: 150,
  industrialist: 300,
  militarist: 500,
};

/** Losing a war: more land lost to the enemy than taken from it. */
export function losingTo(e: EnemyEntry | undefined): boolean {
  return e !== undefined && e.lost > e.won;
}

/** Whether an AI accepts a peace offer from an enemy. */
export function aiAcceptsPeace(
  personality: AiPersonality,
  weariness: number,
  e: EnemyEntry | undefined,
): boolean {
  return (
    losingTo(e) ||
    wearinessPermille(weariness) >= AI_ACCEPT_WEARINESS[personality]
  );
}

/**
 * The enemy a weary AI offers peace to: the one taking the most land from
 * it, else its longest war. Null when not weary enough. `skip` names
 * enemies it will not offer to unless losing (the coalition target).
 */
export function aiPeaceTarget(
  s: NationPeaceState,
  personality: AiPersonality,
  weariness: number,
  skip: number | null,
): number | null {
  if (s.offers.length > 0) return null;
  const weary = wearinessPermille(weariness) >= AI_OFFER_WEARINESS[personality];
  let best: EnemyEntry | null = null;
  for (const e of s.enemies) {
    if (hasTruce(s, e.target)) continue;
    const losing = losingTo(e);
    if (!weary && !losing) continue;
    if (e.target === skip && !losing) continue;
    if (
      best === null ||
      e.lost > best.lost ||
      (e.lost === best.lost &&
        (e.seconds > best.seconds ||
          (e.seconds === best.seconds && e.target < best.target)))
    ) {
      best = e;
    }
  }
  if (best === null) return null;
  // Not weary: only sue for peace once the war is clearly lost.
  if (!weary && best.lost < Math.max(1, Math.floor(s.peakTiles / 5))) {
    return null;
  }
  return best.target;
}

function permilleOf(part: number, whole: number): number {
  if (whole <= 0 || part <= 0) return 0;
  return Math.min(1000, Math.floor((part * 1000) / whole));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

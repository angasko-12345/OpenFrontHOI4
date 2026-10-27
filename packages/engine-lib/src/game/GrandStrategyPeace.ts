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
 * - A truce forbids attacks between the pair. It is a lock on attacking
 *   (and nuking) only, not an alliance. Stage A.2: its minimum lock is
 *   dynamic (truceLockSeconds); after it the truce still holds but either
 *   side may break it at a price, until it expires TRUCE_BREAKABLE_SECONDS
 *   later.
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
/**
 * Stage A.2 truce lock (seconds a truce cannot be broken), see
 * truceLockSeconds. Clamped to [TRUCE_MIN_LOCK, TRUCE_MAX_LOCK].
 */
export const TRUCE_MIN_LOCK = 120;
export const TRUCE_MAX_LOCK = 480;
/** Base lock after a negotiated peace and after a capitulation. */
export const TRUCE_PEACE_BASE = 180;
export const TRUCE_CAPITULATION_BASE = 300;
/** Extra lock when the loser lost all of its peak land (scaled by share). */
export const TRUCE_LAND_SECONDS = 180;
/** Extra lock when the loser is tiny next to the winner (scaled by gap). */
export const TRUCE_SIZE_SECONDS = 120;
/** Wars shorter than this get a shorter lock: 1 s less per 2 s short. */
export const TRUCE_SHORT_WAR = 120;
/** Less lock when both sides are calm (weariness below TRUCE_CALM_WEARINESS). */
export const TRUCE_CALM_SECONDS = 60;
export const TRUCE_CALM_WEARINESS = 100;
/** After the lock, a truce holds (breakable) this long, then expires. */
export const TRUCE_BREAKABLE_SECONDS = 120;
/** Breaking a truce: political power (thousandths), war support, weariness. */
export const BREAK_PP_COST = 100_000;
export const BREAK_WAR_SUPPORT = -100;
export const BREAK_WEARINESS = 100_000;
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

/** A truce, mirrored on both sides. */
export interface Truce {
  target: number;
  /** Seconds until it expires on its own. */
  seconds: number;
  /** Seconds it still cannot be broken (0 = breakable). */
  lock: number;
}

export interface NationPeaceState {
  /** Most land held (tiles), reset after a capitulation. */
  peakTiles: number;
  /** Tiles lost to other nations since the last second boundary. */
  tilesLostThisSecond: number;
  /** Troops lost attacking nations (not tribes) since the last second boundary. */
  lossesThisSecond: number;
  enemies: EnemyEntry[];
  /** Truces (mirrored on both sides), seconds left and lock left. */
  truces: Truce[];
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

export function truceWith(
  s: NationPeaceState,
  target: number,
): Truce | undefined {
  return s.truces.find((t) => t.target === target);
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
    .map((t) => ({
      target: t.target,
      seconds: t.seconds - 1,
      lock: Math.max(0, t.lock - 1),
    }))
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
  /** Gain multiplier (ideology, stage B), per-mille; absent = 1000. */
  gainPermille?: number;
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
  const gain = Math.floor(
    (Math.floor(((lossGain + landGain + warGain) * scale) / 1000) *
      Math.max(0, i.gainPermille ?? 1000)) /
      1000,
  );
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

export interface TruceLockInput {
  capitulation: boolean;
  /** Share of its peak land the losing side lost, per-mille. */
  loserLostPermille: number;
  /** Land of the losing and winning side now, tiles. */
  loserTiles: number;
  winnerTiles: number;
  /** Seconds the war lasted. */
  warSeconds: number;
  /** Weariness of both sides, per-mille. */
  wearinessA: number;
  wearinessB: number;
}

/**
 * Minimum lock of a new truce, seconds. A capitulation locks longer than a
 * negotiated peace (the loser needs time to recover, which is the point of
 * the anti-snowball lever); more land lost and a bigger size gap lengthen
 * it (protects small losers from being finished off); a short war or two
 * calm (weariness-free) sides shorten it (a skirmish should not freeze the
 * border for long, so the map keeps moving). Clamped to
 * [TRUCE_MIN_LOCK, TRUCE_MAX_LOCK].
 */
export function truceLockSeconds(i: TruceLockInput): number {
  let s = i.capitulation ? TRUCE_CAPITULATION_BASE : TRUCE_PEACE_BASE;
  s += Math.floor(
    (clamp(i.loserLostPermille, 0, 1000) * TRUCE_LAND_SECONDS) / 1000,
  );
  const ratio =
    i.winnerTiles <= 0
      ? 1000
      : Math.min(
          1000,
          Math.floor((Math.max(0, i.loserTiles) * 1000) / i.winnerTiles),
        );
  s += Math.floor(((1000 - ratio) * TRUCE_SIZE_SECONDS) / 1000);
  if (i.warSeconds < TRUCE_SHORT_WAR) {
    s -= Math.floor((TRUCE_SHORT_WAR - Math.max(0, i.warSeconds)) / 2);
  }
  if (
    i.wearinessA < TRUCE_CALM_WEARINESS &&
    i.wearinessB < TRUCE_CALM_WEARINESS
  ) {
    s -= TRUCE_CALM_SECONDS;
  }
  return clamp(Math.floor(s), TRUCE_MIN_LOCK, TRUCE_MAX_LOCK);
}

/**
 * Truce between two sides, locked for `lock` seconds and expiring
 * TRUCE_BREAKABLE_SECONDS after that; their war and offers end.
 */
export function addTruce(
  a: NationPeaceState,
  aId: number,
  b: NationPeaceState,
  bId: number,
  lock: number = TRUCE_MIN_LOCK,
): void {
  const l = clamp(Math.floor(lock), 0, TRUCE_MAX_LOCK);
  for (const [s, other] of [
    [a, bId],
    [b, aId],
  ] as const) {
    s.enemies = s.enemies.filter((e) => e.target !== other);
    s.offers = s.offers.filter((o) => o.target !== other);
    s.truces = s.truces.filter((t) => t.target !== other);
    s.truces.push({
      target: other,
      seconds: l + TRUCE_BREAKABLE_SECONDS,
      lock: l,
    });
  }
}

export type BreakCheck = "ok" | "no_truce" | "locked";

/** Whether `s` may break its truce with `target` now. */
export function canBreakTruce(s: NationPeaceState, target: number): BreakCheck {
  const t = truceWith(s, target);
  if (t === undefined) return "no_truce";
  return t.lock > 0 ? "locked" : "ok";
}

/** End the truce between two sides (both mirrors). */
export function removeTruce(
  a: NationPeaceState,
  aId: number,
  b: NationPeaceState,
  bId: number,
): void {
  a.truces = a.truces.filter((t) => t.target !== bId);
  b.truces = b.truces.filter((t) => t.target !== aId);
}

/** Troop strength (own / partner, per-mille) an AI wants before breaking. */
export const AI_BREAK_STRENGTH: Readonly<Record<AiPersonality, number>> = {
  militarist: 1250,
  industrialist: 2000,
  defender: 3000,
};
/** Most weariness (per-mille) at which an AI still breaks a truce. */
export const AI_BREAK_MAX_WEARINESS: Readonly<Record<AiPersonality, number>> = {
  militarist: 150,
  industrialist: 75,
  defender: 30,
};
/** Most other wars an AI may be fighting when it breaks a truce. */
export const AI_BREAK_MAX_WARS: Readonly<Record<AiPersonality, number>> = {
  militarist: 1,
  industrialist: 0,
  defender: 0,
};

export interface AiBreakInput {
  /** Own troops / partner troops, per-mille. */
  strengthPermille: number;
  /** Own weariness, per-mille. */
  weariness: number;
  /** Wars being fought now. */
  wars: number;
  /** Shares a land border with the partner. */
  borders: boolean;
  /** Can pay BREAK_PP_COST. */
  canPay: boolean;
  /** Per-mille added to the strength needed (ideology); floor 1000. */
  strengthBias?: number;
}

/**
 * Whether an AI breaks a breakable truce: only when much stronger, fresh,
 * not busy elsewhere, next door and able to pay. Militarists need the
 * least edge, defenders almost never break.
 */
export function aiBreaksTruce(
  personality: AiPersonality,
  i: AiBreakInput,
): boolean {
  if (!i.borders || !i.canPay) return false;
  if (i.wars > AI_BREAK_MAX_WARS[personality]) return false;
  if (i.weariness > AI_BREAK_MAX_WEARINESS[personality]) return false;
  return (
    i.strengthPermille >=
    Math.max(1000, AI_BREAK_STRENGTH[personality] + (i.strengthBias ?? 0))
  );
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

/**
 * Whether an AI accepts a peace offer from an enemy. `bias` (per-mille,
 * ideology) moves the weariness threshold.
 */
export function aiAcceptsPeace(
  personality: AiPersonality,
  weariness: number,
  e: EnemyEntry | undefined,
  bias = 0,
): boolean {
  return (
    losingTo(e) ||
    wearinessPermille(weariness) >=
      Math.max(0, AI_ACCEPT_WEARINESS[personality] + bias)
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
  bias = 0,
): number | null {
  if (s.offers.length > 0) return null;
  const weary =
    wearinessPermille(weariness) >=
    Math.max(0, AI_OFFER_WEARINESS[personality] + bias);
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

/**
 * Grand Strategy, M7C stage 2: revanche (comebacks). Pure rules, integer
 * maths only.
 *
 * Stage A truces made the map calm: a loser keeps its rump, the winner
 * keeps the land, and nobody fights for it again until the truce runs
 * out. Revanche gives the loser a way back without un-protecting it:
 *
 * - A nation that ends a war (capitulation or peace) having lost at least
 *   REVANCHE_MIN_LOST_PERMILLE of its peak land holds a revanche claim on
 *   the winner: the tiles it lost, for REVANCHE_SECONDS.
 * - Recovery: while that truce holds, the claimant rallies (more manpower
 *   and political power, faster weariness recovery).
 * - Revanche break: once half of the truce's minimum lock is over, the
 *   claimant (only) may break the truce at a discount: REVANCHE_BREAK_PP,
 *   no war-support or weariness cost, no war goal for the old winner; the
 *   claimant gets a war goal against it instead.
 * - Attacking the claim's target costs REVANCHE_ATTACK_LOSS fewer troops.
 * - Retaking land from the target pays the claim down; at zero, or when
 *   it expires, it is gone.
 *
 * The winner gains nothing new, so the anti-snowball truce still protects
 * small losers; what changes is that big winners get pushed back.
 */
import type { AiPersonality } from "./GrandStrategy";
import { type NationPeaceState, truceWith } from "./GrandStrategyPeace";

/** Share of peak land (per-mille) a war must cost to leave a claim. */
export const REVANCHE_MIN_LOST_PERMILLE = 100;
/** Seconds a claim lasts. */
export const REVANCHE_SECONDS = 900;
/** Most claims a nation keeps (newest replace the smallest). */
export const MAX_REVANCHE = 3;
/** PP (milli) a revanche break costs (a normal break: BREAK_PP_COST). */
export const REVANCHE_BREAK_PP = 50_000;
/** Per-mille attacker losses vs the claim's target. */
export const REVANCHE_ATTACK_LOSS = -150;
/** Recovery while the truce with the claim's target holds, per-mille. */
export const RECOVERY_MANPOWER = 200;
export const RECOVERY_POLITICAL_POWER = 250;
/** Extra weariness recovery per second while recovering (thousandths). */
export const RECOVERY_WEARINESS = 4000;

/** A claim on land lost to `target`. */
export interface Revanche {
  target: number;
  /** Tiles still to win back. */
  tiles: number;
  /** Seconds until the claim lapses. */
  seconds: number;
  /** Minimum lock the truce started with (half of it may be skipped). */
  lock: number;
}

export function revancheOf(s: NationPeaceState): Revanche[] {
  return s.revanche ?? [];
}

export function revancheOn(
  s: NationPeaceState,
  target: number,
): Revanche | undefined {
  return s.revanche?.find((r) => r.target === target);
}

/**
 * A war just ended in a truce with the loser down `lost` tiles of a
 * `peak`: record (or top up) its claim on the winner.
 */
export function addRevanche(
  s: NationPeaceState,
  target: number,
  lost: number,
  peak: number,
  lock: number,
): boolean {
  const n = Math.max(0, Math.floor(lost));
  if (n <= 0 || n * 1000 < Math.max(1, peak) * REVANCHE_MIN_LOST_PERMILLE) {
    return false;
  }
  const list = revancheOf(s).filter((r) => r.target !== target);
  const old = revancheOn(s, target);
  list.push({
    target,
    tiles: (old?.tiles ?? 0) + n,
    seconds: REVANCHE_SECONDS,
    lock: Math.max(0, Math.floor(lock)),
  });
  // Keep the biggest claims (ties: lower id), at most MAX_REVANCHE.
  list.sort((a, b) => b.tiles - a.tiles || a.target - b.target);
  s.revanche = list.slice(0, MAX_REVANCHE);
  return true;
}

/** Count claims down one second. */
export function advanceRevanche(s: NationPeaceState): void {
  if (s.revanche === undefined || s.revanche.length === 0) return;
  s.revanche = s.revanche
    .map((r) => ({ ...r, seconds: r.seconds - 1 }))
    .filter((r) => r.seconds > 0);
}

/** `n` tiles retaken from `target` pay the claim down. */
export function payRevanche(
  s: NationPeaceState,
  target: number,
  n: number,
): void {
  const r = revancheOn(s, target);
  if (r === undefined) return;
  r.tiles -= Math.max(0, Math.floor(n));
  if (r.tiles <= 0) s.revanche = revancheOf(s).filter((x) => x !== r);
}

export type RevancheCheck = "ok" | "no_claim" | "no_truce" | "locked";

/**
 * Whether the claimant may break its truce with `target` now: half of the
 * truce's minimum lock must be over.
 */
export function canRevancheBreak(
  s: NationPeaceState,
  target: number,
): RevancheCheck {
  const r = revancheOn(s, target);
  if (r === undefined) return "no_claim";
  const t = truceWith(s, target);
  if (t === undefined) return "no_truce";
  return t.lock * 2 <= r.lock ? "ok" : "locked";
}

/** Seconds until a revanche break is allowed (0 = now or no truce). */
export function revancheWait(s: NationPeaceState, target: number): number {
  const r = revancheOn(s, target);
  const t = truceWith(s, target);
  if (r === undefined || t === undefined) return 0;
  return Math.max(0, t.lock - Math.floor(r.lock / 2));
}

/** Recovering: holds a claim whose truce still stands. */
export function recovering(s: NationPeaceState): boolean {
  return revancheOf(s).some((r) => truceWith(s, r.target) !== undefined);
}

/** Troop strength (own / target, per-mille) an AI wants for revanche. */
export const AI_REVANCHE_STRENGTH: Readonly<Record<AiPersonality, number>> = {
  militarist: 700,
  industrialist: 900,
  defender: 1200,
};
/** Most weariness (per-mille) at which an AI still seeks revanche. */
export const AI_REVANCHE_MAX_WEARINESS: Readonly<
  Record<AiPersonality, number>
> = {
  militarist: 300,
  industrialist: 200,
  defender: 120,
};

export interface AiRevancheInput {
  strengthPermille: number;
  weariness: number;
  /** Wars being fought now. */
  wars: number;
  canPay: boolean;
  borders: boolean;
}

/**
 * Whether an AI claimant breaks for revanche: needs far less edge than a
 * plain break (it is taking its own land back), at most one other war.
 */
export function aiSeeksRevanche(
  personality: AiPersonality,
  i: AiRevancheInput,
): boolean {
  if (!i.borders || !i.canPay || i.wars > 1) return false;
  if (i.weariness > AI_REVANCHE_MAX_WEARINESS[personality]) return false;
  return i.strengthPermille >= AI_REVANCHE_STRENGTH[personality];
}

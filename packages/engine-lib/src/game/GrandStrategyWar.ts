/**
 * Grand Strategy, milestone 4: how wars are shaped. Pure rules, integer
 * maths only (per-mille or whole units), so every client agrees.
 *
 * - Occupation: land taken from another player is "occupied" at first and
 *   counts for only part of the troop cap until it integrates.
 * - Supply: attacks far from the attacker's capital, cities, ports and
 *   factories suffer attrition (higher losses).
 * - War goals: attacking a nation without a justified war goal costs more
 *   troops. Justifying takes time and the target can see it coming.
 * - Coalition: once one nation holds a large share of the land, everyone
 *   may attack it without a war goal and fights it at an advantage.
 */

/** An occupied tile counts this much (per-mille) of an integrated one. */
export const OCCUPIED_YIELD_PERMILLE = 250;
/** Share of occupied land that integrates each second (half-life about 2.5 min). */
export const OCCUPATION_INTEGRATION_PERMILLE = 5;
/**
 * The troop cap grows with tiles^0.6, so losing a fraction f of tile value
 * moves the cap by roughly 0.6 f. Per-mille of that exponent.
 */
export const CAP_TILE_ELASTICITY_PERMILLE = 600;
/** Occupied share (per-mille) above which unrest drains war support. */
export const UNREST_OCCUPIED_PERMILLE = 350;
/** War support lost per second while unrest lasts. */
export const UNREST_WAR_SUPPORT = 1;
/** The combined troop-cap modifier never drops below this, per-mille. */
export const MIN_TOTAL_TROOP_CAP_MODIFIER = -700;

/** Extra attacker losses, per-mille, when fighting outside supply. */
export const OUT_OF_SUPPLY_LOSS_PERMILLE = 300;
/** Extra attacker losses, per-mille, attacking a nation without a war goal. */
export const UNJUSTIFIED_LOSS_PERMILLE = 200;
/** Attacker loss change, per-mille, when attacking the coalition target. */
export const COALITION_LOSS_PERMILLE = -100;

/** Political power (thousandths) to start justifying a war goal. */
export const JUSTIFY_COST = 50_000;
/** Seconds a justification takes. */
export const JUSTIFY_SECONDS = 60;
/** Seconds a justified war goal stays valid. */
export const WAR_GOAL_SECONDS = 600;
/** War goals a nation may hold at once (justifying included). */
export const MAX_WAR_GOALS = 3;

/** Share of all land tiles (per-mille) that puts a nation in the coalition's sights. */
export const COALITION_ENTER_PERMILLE = 400;
/** It stays the target until it falls below this share (hysteresis). */
export const COALITION_EXIT_PERMILLE = 350;

/** A war goal against one player (by small id) and its seconds left. */
export interface WarGoal {
  target: number;
  seconds: number;
  /** Granted for being attacked; does not count toward MAX_WAR_GOALS. */
  defensive?: boolean;
}

export interface NationWarState {
  /** Tiles taken from other players that have not integrated yet. */
  occupied: number;
  /** The war goal being justified, if any. */
  justifying: WarGoal | null;
  /** Justified war goals and the seconds each stays valid. */
  warGoals: WarGoal[];
}

export function newWarState(): NationWarState {
  return { occupied: 0, justifying: null, warGoals: [] };
}

/** One tile taken from another player. */
export function addOccupied(s: NationWarState, tiles = 1): void {
  s.occupied += Math.max(0, Math.floor(tiles));
}

/** Occupied share of a nation's land, per-mille. */
export function occupiedPermille(occupied: number, tilesOwned: number): number {
  if (tilesOwned <= 0 || occupied <= 0) return 0;
  return Math.min(1000, Math.floor((occupied * 1000) / tilesOwned));
}

/**
 * Troop-cap modifier (per-mille, zero or negative) from occupied land:
 * occupied tiles count only OCCUPIED_YIELD_PERMILLE of an integrated one.
 */
export function occupationCapModifier(
  occupied: number,
  tilesOwned: number,
): number {
  const share = occupiedPermille(occupied, tilesOwned);
  if (share === 0) return 0;
  const lost = Math.floor(
    (share * (1000 - OCCUPIED_YIELD_PERMILLE) * CAP_TILE_ELASTICITY_PERMILLE) /
      1_000_000,
  );
  return -lost;
}

/** Law/focus cap modifier combined with occupation, floored. */
export function combinedCapModifier(
  lawModifier: number,
  occupied: number,
  tilesOwned: number,
): number {
  return Math.max(
    MIN_TOTAL_TROOP_CAP_MODIFIER,
    lawModifier + occupationCapModifier(occupied, tilesOwned),
  );
}

export interface WarSecondResult {
  /** War support change this second from unrest. */
  warSupportDelta: number;
  /** A justification that finished this second (target small id). */
  justified: number | null;
}

/**
 * Advance one second: occupation integrates (never more than the land
 * held), justification progresses, war goals expire.
 */
export function advanceWarSecond(
  s: NationWarState,
  tilesOwned: number,
): WarSecondResult {
  s.occupied = Math.min(s.occupied, Math.max(0, tilesOwned));
  const unrest =
    occupiedPermille(s.occupied, tilesOwned) > UNREST_OCCUPIED_PERMILLE;
  if (s.occupied > 0) {
    s.occupied -= Math.max(
      1,
      Math.floor((s.occupied * OCCUPATION_INTEGRATION_PERMILLE) / 1000),
    );
    if (s.occupied < 0) s.occupied = 0;
  }

  s.warGoals = s.warGoals
    .map((g) => ({ ...g, seconds: g.seconds - 1 }))
    .filter((g) => g.seconds > 0);

  let justified: number | null = null;
  if (s.justifying !== null) {
    const left = s.justifying.seconds - 1;
    if (left <= 0) {
      justified = s.justifying.target;
      s.warGoals = s.warGoals.filter((g) => g.target !== justified);
      s.warGoals.push({ target: justified, seconds: WAR_GOAL_SECONDS });
      s.justifying = null;
    } else {
      s.justifying = { target: s.justifying.target, seconds: left };
    }
  }
  return { warSupportDelta: unrest ? -UNREST_WAR_SUPPORT : 0, justified };
}

/**
 * Being attacked gives a war goal against the attacker at once (or renews
 * it), so counterattacks are never penalised. Not limited by MAX_WAR_GOALS.
 */
export function grantDefensiveGoal(s: NationWarState, attacker: number): void {
  const g = s.warGoals.find((x) => x.target === attacker);
  if (g !== undefined) g.seconds = WAR_GOAL_SECONDS;
  else {
    s.warGoals.push({
      target: attacker,
      seconds: WAR_GOAL_SECONDS,
      defensive: true,
    });
  }
}

export function hasWarGoal(s: NationWarState, target: number): boolean {
  return s.warGoals.some((g) => g.target === target);
}

export type JustifyCheck =
  | "ok"
  | "self"
  | "already_justifying"
  | "already_justified"
  | "too_many_goals"
  | "not_enough_pp"
  | "invalid_target";

/**
 * Whether a nation can start justifying against `target`. `targetValid`
 * is the caller's game-level check (a living, non-bot, non-allied player).
 */
export function canJustify(
  s: NationWarState,
  selfId: number,
  target: number,
  politicalPower: number,
  targetValid: boolean,
  cost: number = JUSTIFY_COST,
): JustifyCheck {
  if (target === selfId) return "self";
  if (!targetValid) return "invalid_target";
  if (s.justifying !== null) return "already_justifying";
  if (hasWarGoal(s, target)) return "already_justified";
  const offensive = s.warGoals.filter((g) => g.defensive !== true).length;
  if (offensive + 1 > MAX_WAR_GOALS) return "too_many_goals";
  if (politicalPower < cost) return "not_enough_pp";
  return "ok";
}

/** Start justifying; the caller deducts JUSTIFY_COST on "ok". */
export function startJustify(s: NationWarState, target: number): void {
  s.justifying = { target, seconds: JUSTIFY_SECONDS };
}

export interface AttackContext {
  /** Target is a nation or human (bots and empty land need no war goal). */
  targetIsNation: boolean;
  /** Attacker holds a justified war goal against the target. */
  justified: boolean;
  /** Target is the current coalition target. */
  targetIsCoalitionLeader: boolean;
  /** The conquered tile is within the attacker's supply. */
  inSupply: boolean;
}

/** Attacker loss multiplier, per-mille, from supply, war goals and the coalition. */
export function warLossMultiplier(c: AttackContext): number {
  let m = 1000;
  if (!c.inSupply) m += OUT_OF_SUPPLY_LOSS_PERMILLE;
  if (c.targetIsNation) {
    if (c.targetIsCoalitionLeader) m += COALITION_LOSS_PERMILLE;
    else if (!c.justified) m += UNJUSTIFIED_LOSS_PERMILLE;
  }
  return Math.max(100, m);
}

/** Integer square root (floor). */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  // Guard against float rounding at the edges.
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/** Supply radius (tiles) of a city, port or factory, scaled to the map. */
export function supplyRange(numLandTiles: number): number {
  return Math.max(30, Math.floor(isqrt(numLandTiles) / 8));
}

/** Supply radius (tiles) around the capital (spawn tile). */
export function capitalSupplyRange(numLandTiles: number): number {
  return supplyRange(numLandTiles) * 2;
}

/**
 * The coalition target next second: the largest nation if it holds at
 * least the enter share, kept while above the exit share.
 */
export function nextCoalitionLeader(
  current: number | null,
  nations: readonly { id: number; tiles: number }[],
  numLandTiles: number,
): number | null {
  if (numLandTiles <= 0) return null;
  const share = (tiles: number) => Math.floor((tiles * 1000) / numLandTiles);
  if (current !== null) {
    const cur = nations.find((n) => n.id === current);
    if (cur !== undefined && share(cur.tiles) >= COALITION_EXIT_PERMILLE) {
      return current;
    }
  }
  let best: { id: number; tiles: number } | null = null;
  for (const n of nations) {
    if (
      best === null ||
      n.tiles > best.tiles ||
      (n.tiles === best.tiles && n.id < best.id)
    ) {
      best = n;
    }
  }
  if (best !== null && share(best.tiles) >= COALITION_ENTER_PERMILLE) {
    return best.id;
  }
  return null;
}

export interface JustifyCandidate {
  id: number;
  tiles: number;
  /** The AI is already attacking this player. */
  attacking: boolean;
}

/**
 * The AI's justification target: one it is already attacking without a
 * goal (largest first), else its largest neighbour without a goal. Ties go
 * to the lower id so every client picks the same.
 */
export function aiJustifyTarget(
  s: NationWarState,
  candidates: readonly JustifyCandidate[],
): number | null {
  // M5B's "target the richest deposits when short" rule was removed after
  // ablation showed it never changed a game (see notes/milestones.md).
  const open = candidates.filter((c) => !hasWarGoal(s, c.id));
  const pick = (list: readonly JustifyCandidate[]) =>
    list.reduce<JustifyCandidate | null>(
      (b, c) =>
        b === null || c.tiles > b.tiles || (c.tiles === b.tiles && c.id < b.id)
          ? c
          : b,
      null,
    );
  return (pick(open.filter((c) => c.attacking)) ?? pick(open))?.id ?? null;
}

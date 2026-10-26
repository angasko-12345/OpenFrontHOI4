// Grand Strategy M5 stage A: strategic resources (OpenFront x HOI4 fork).
//
// Steel and oil come from deposits fixed by the map: the same tile always
// holds the same deposit, so they are worth learning and fighting over.
// Nothing here is stored: deposits are derived from the map, and what a
// nation holds is counted from tile ownership each second, so snapshots
// need no new fields. Integer math only (determinism).

export type ResourceType = "steel" | "oil";

export const RESOURCES: readonly ResourceType[] = ["steel", "oil"];

/** Terrain classes the deposit rule reads (TerrainType values). */
export const TERRAIN_PLAINS = 0;
export const TERRAIN_HIGHLAND = 1;
export const TERRAIN_MOUNTAIN = 2;

// Calibrated on the world map (652k land, 2/3 highland or mountain): about
// one steel per 2,300 land tiles and one oil per 3,500, so a mid-size nation
// (15k tiles, 12 military factories) holds roughly what it needs and a
// mountain-poor or plains-poor one runs short.
/** One steel deposit per this many highland or mountain tiles (on average). */
export const STEEL_DEPOSIT_EVERY = 1500;
/** One oil deposit per this many plains tiles (on average). */
export const OIL_DEPOSIT_EVERY = 1200;
/** Resource units one deposit tile yields per second. */
export const DEPOSIT_YIELD = 1;
/** Units of each resource every nation produces at home, deposits or not. */
export const DOMESTIC_RESOURCE = 1;
/** Military factories one unit of steel supplies. */
export const FACTORIES_PER_STEEL = 2;
/** Military factories one unit of oil supplies. */
export const FACTORIES_PER_OIL = 3;
/** Production with no steel at all, per-mille of normal. */
export const STEEL_FLOOR_PERMILLE = 400;
/** Extra attacker losses, per-mille, with no oil at all. */
export const OIL_SHORTAGE_LOSS = 150;

/** Integer hash of a tile ref (32-bit, deterministic). */
export function tileHash(ref: number): number {
  let h = Math.imul(ref ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The deposit on a land tile, if any. `terrain` is its TerrainType. */
export function depositAt(ref: number, terrain: number): ResourceType | null {
  const h = tileHash(ref);
  if (terrain === TERRAIN_HIGHLAND || terrain === TERRAIN_MOUNTAIN) {
    return h % STEEL_DEPOSIT_EVERY === 0 ? "steel" : null;
  }
  if (terrain === TERRAIN_PLAINS) {
    return h % OIL_DEPOSIT_EVERY === 0 ? "oil" : null;
  }
  return null;
}

export interface ResourceBalance {
  /** Units available this second (deposits + domestic). */
  steel: number;
  oil: number;
  /** Units the nation's military factories need. */
  steelNeeded: number;
  oilNeeded: number;
}

export function resourceBalance(
  steelDeposits: number,
  oilDeposits: number,
  militaryFactories: number,
): ResourceBalance {
  const f = Math.max(0, militaryFactories);
  return {
    steel: DOMESTIC_RESOURCE + steelDeposits * DEPOSIT_YIELD,
    oil: DOMESTIC_RESOURCE + oilDeposits * DEPOSIT_YIELD,
    steelNeeded: Math.ceil(f / FACTORIES_PER_STEEL),
    oilNeeded: Math.ceil(f / FACTORIES_PER_OIL),
  };
}

/** Share of need met, per-mille (1000 when nothing is needed). */
export function coveredPermille(have: number, need: number): number {
  if (need <= 0 || have >= need) return 1000;
  return Math.max(0, Math.floor((have * 1000) / need));
}

/** Equipment production multiplier, per-mille, from steel coverage. */
export function steelProductionPermille(b: ResourceBalance): number {
  const c = coveredPermille(b.steel, b.steelNeeded);
  return (
    STEEL_FLOOR_PERMILLE +
    Math.floor(((1000 - STEEL_FLOOR_PERMILLE) * c) / 1000)
  );
}

/** Attacker loss multiplier, per-mille, from oil coverage. */
export function oilLossPermille(b: ResourceBalance): number {
  const c = coveredPermille(b.oil, b.oilNeeded);
  return 1000 + Math.floor((OIL_SHORTAGE_LOSS * (1000 - c)) / 1000);
}

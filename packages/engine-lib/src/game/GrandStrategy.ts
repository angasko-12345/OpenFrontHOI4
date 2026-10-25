/**
 * Grand Strategy layer (HOI4-inspired): national focuses, military industry,
 * production efficiency and equipment.
 *
 * Original mechanics inspired by grand-strategy games; no third-party code,
 * data or assets. Pure and deterministic: every stored value is an integer,
 * percentages are per-mille (1000 = 100%), no floats are kept between ticks.
 *
 * The simulation runs these rules once per second from
 * GrandStrategyExecution. Combat reads equipment through
 * `equippedPermille`, which AttackExecution applies to the existing
 * attackLogic result.
 */

import { FOCUS_IDS, FocusID } from "@openfront/engine-api/game/GameTypes";

/** Modifiers a focus grants, all in per-mille. */
export interface GsModifiers {
  /** Military factory output. */
  production: number;
  /** Production-efficiency cap, added to the base cap. */
  efficiencyCap: number;
  /** Attacker troop losses when this nation attacks (negative = fewer losses). */
  attackLoss: number;
  /** Extra attacker losses inflicted on whoever attacks this nation. */
  defense: number;
  /** Troop (manpower) growth. */
  manpower: number;
  /** Gold income. */
  gold: number;
}

export const ZERO_MODIFIERS: Readonly<GsModifiers> = Object.freeze({
  production: 0,
  efficiencyCap: 0,
  attackLoss: 0,
  defense: 0,
  manpower: 0,
  gold: 0,
});

export interface FocusDef {
  id: FocusID;
  name: string;
  description: string;
  /** Seconds to complete. */
  seconds: number;
  /** All of these must be completed first. */
  requires: readonly string[];
  /** Cannot be taken if any of these is completed or in progress. */
  exclusive: readonly string[];
  effects: Partial<GsModifiers>;
}

export const FOCUS_TREE: readonly FocusDef[] = [
  {
    id: "industrial_expansion",
    name: "Industrial Expansion",
    description: "Military factory output +15%.",
    seconds: 60,
    requires: [],
    exclusive: [],
    effects: { production: 150 },
  },
  {
    id: "conscription",
    name: "Conscription Law",
    description: "Manpower growth +10%.",
    seconds: 60,
    requires: [],
    exclusive: [],
    effects: { manpower: 100 },
  },
  {
    id: "civilian_economy",
    name: "Civilian Economy",
    description: "Gold income +15%.",
    seconds: 60,
    requires: [],
    exclusive: ["war_economy"],
    effects: { gold: 150 },
  },
  {
    id: "rearmament",
    name: "Rearmament",
    description: "Factory output +10%, efficiency cap +10%.",
    seconds: 60,
    requires: ["industrial_expansion"],
    exclusive: [],
    effects: { production: 100, efficiencyCap: 100 },
  },
  {
    id: "general_mobilization",
    name: "General Mobilization",
    description: "Manpower growth +15%, gold -5%.",
    seconds: 90,
    requires: ["conscription"],
    exclusive: [],
    effects: { manpower: 150, gold: -50 },
  },
  {
    id: "war_economy",
    name: "War Economy",
    description: "Factory output +25%, gold -10%.",
    seconds: 90,
    requires: ["rearmament"],
    exclusive: ["civilian_economy"],
    effects: { production: 250, gold: -100 },
  },
  {
    id: "mobile_warfare",
    name: "Mobile Warfare Doctrine",
    description: "Losses when attacking -15%.",
    seconds: 90,
    requires: ["rearmament"],
    exclusive: ["defense_in_depth"],
    effects: { attackLoss: -150 },
  },
  {
    id: "defense_in_depth",
    name: "Defense in Depth Doctrine",
    description: "Enemies attacking you lose 20% more troops.",
    seconds: 90,
    requires: ["conscription"],
    exclusive: ["mobile_warfare"],
    effects: { defense: 200 },
  },
  {
    id: "fortify_borders",
    name: "Fortify the Borders",
    description: "Enemies attacking you lose 10% more troops.",
    seconds: 60,
    requires: ["defense_in_depth"],
    exclusive: [],
    effects: { defense: 100 },
  },
  {
    id: "total_war",
    name: "Total War",
    description: "Output +15%, attack losses -10%, manpower +10%.",
    seconds: 120,
    requires: ["war_economy", "general_mobilization"],
    exclusive: [],
    effects: { production: 150, attackLoss: -100, manpower: 100 },
  },
];

const FOCUS_BY_ID = new Map<string, FocusDef>(FOCUS_TREE.map((f) => [f.id, f]));

// The wire enum and the tree must list the same focuses.
if (
  FOCUS_TREE.length !== FOCUS_IDS.length ||
  !FOCUS_IDS.every((id) => FOCUS_BY_ID.has(id))
) {
  throw new Error("FOCUS_TREE and FOCUS_IDS disagree");
}

export function focusById(id: string): FocusDef | undefined {
  return FOCUS_BY_ID.get(id);
}

/** Per-nation state. Integers only. */
export interface NationGsState {
  /** Stockpiled equipment (one unit equips one troop). */
  equipment: number;
  /** Production efficiency, per-mille. */
  efficiency: number;
  /** Focus in progress, or null. */
  focus: string | null;
  /** Seconds spent on the focus in progress. */
  focusProgress: number;
  /** Completed focus ids, in completion order. */
  completed: string[];
}

// Tunables
/** Efficiency a nation starts at, and drops back to when it has no factories. */
export const BASE_EFFICIENCY = 100;
export const BASE_EFFICIENCY_CAP = 500;
/** Equipment per military factory per second at 100% efficiency. */
export const EQUIPMENT_PER_FACTORY = 600;
/** Every nation runs this many factories before it builds any. */
export const BASE_FACTORIES = 2;
/** Each built Factory structure level counts as this many military factories. */
export const FACTORIES_PER_STRUCTURE_LEVEL = 3;
/** Owned land tiles per extra base factory (bigger countries, more industry). */
export const TILES_PER_BASE_FACTORY = 2500;
/** Stockpile cap as a multiple of max troops. */
export const STOCKPILE_CAP_MULTIPLE = 2;
/** At 0% equipped, losses are multiplied by 1 + this (per-mille). */
export const UNEQUIPPED_LOSS_PENALTY = 1000;

export function newNationState(startEquipment: number): NationGsState {
  return {
    equipment: Math.max(0, Math.floor(startEquipment)),
    efficiency: BASE_EFFICIENCY,
    focus: null,
    focusProgress: 0,
    completed: [],
  };
}

export function modifiersOf(state: NationGsState): GsModifiers {
  const m: GsModifiers = { ...ZERO_MODIFIERS };
  for (const id of state.completed) {
    const f = FOCUS_BY_ID.get(id);
    if (f === undefined) continue;
    for (const k of Object.keys(f.effects) as (keyof GsModifiers)[]) {
      m[k] += f.effects[k] ?? 0;
    }
  }
  return m;
}

export type FocusCheck =
  | "ok"
  | "unknown"
  | "completed"
  | "busy"
  | "missing_prerequisite"
  | "exclusive";

export function canStartFocus(state: NationGsState, id: string): FocusCheck {
  const f = FOCUS_BY_ID.get(id);
  if (f === undefined) return "unknown";
  if (state.completed.includes(id)) return "completed";
  if (state.focus !== null) return "busy";
  if (!f.requires.every((r) => state.completed.includes(r))) {
    return "missing_prerequisite";
  }
  if (f.exclusive.some((x) => state.completed.includes(x))) return "exclusive";
  return "ok";
}

/** Focuses a nation could start right now, in tree order. */
export function availableFocuses(state: NationGsState): FocusDef[] {
  if (state.focus !== null) return [];
  return FOCUS_TREE.filter((f) => canStartFocus(state, f.id) === "ok");
}

export function startFocus(state: NationGsState, id: string): FocusCheck {
  const check = canStartFocus(state, id);
  if (check === "ok") {
    state.focus = id;
    state.focusProgress = 0;
  }
  return check;
}

export function militaryFactories(
  factoryStructureLevels: number,
  tilesOwned: number,
): number {
  return (
    BASE_FACTORIES +
    Math.floor(tilesOwned / TILES_PER_BASE_FACTORY) +
    factoryStructureLevels * FACTORIES_PER_STRUCTURE_LEVEL
  );
}

export interface NationSecondInput {
  factoryStructureLevels: number;
  tilesOwned: number;
  maxTroops: number;
}

export interface NationSecondResult {
  produced: number;
  completedFocus: string | null;
}

/** Advance one second: focus progress, efficiency growth, production. */
export function advanceSecond(
  state: NationGsState,
  input: NationSecondInput,
): NationSecondResult {
  let completedFocus: string | null = null;
  if (state.focus !== null) {
    const f = FOCUS_BY_ID.get(state.focus);
    state.focusProgress += 1;
    if (f === undefined || state.focusProgress >= f.seconds) {
      if (f !== undefined) {
        state.completed.push(f.id);
        completedFocus = f.id;
      }
      state.focus = null;
      state.focusProgress = 0;
    }
  }

  const mods = modifiersOf(state);
  const cap = Math.min(1000, BASE_EFFICIENCY_CAP + mods.efficiencyCap);
  // Efficiency climbs fast when low and slows near the cap.
  if (state.efficiency < cap) {
    state.efficiency = Math.min(
      cap,
      state.efficiency + Math.max(1, Math.floor((cap - state.efficiency) / 40)),
    );
  } else if (state.efficiency > cap) {
    state.efficiency = cap;
  }

  const factories = militaryFactories(
    input.factoryStructureLevels,
    input.tilesOwned,
  );
  const produced = Math.max(
    0,
    Math.floor(
      (factories *
        EQUIPMENT_PER_FACTORY *
        state.efficiency *
        (1000 + mods.production)) /
        1_000_000,
    ),
  );
  const stockCap = Math.floor(input.maxTroops * STOCKPILE_CAP_MULTIPLE);
  const before = state.equipment;
  state.equipment = Math.min(stockCap, state.equipment + produced);
  if (state.equipment < before) state.equipment = before; // never confiscate
  return { produced: state.equipment - before, completedFocus };
}

/** Share of `troops` the stockpile can equip, per-mille. */
export function equippedPermille(equipment: number, troops: number): number {
  if (troops <= 0) return 1000;
  if (equipment >= troops) return 1000;
  return Math.max(0, Math.floor((equipment * 1000) / troops));
}

/** Loss multiplier (per-mille) for a force equipped at `equipped` per-mille. */
export function shortageLossPermille(equipped: number): number {
  return (
    1000 + Math.floor(((1000 - equipped) * UNEQUIPPED_LOSS_PENALTY) / 1000)
  );
}

/**
 * Combined attacker loss multiplier, per-mille: the attacker's own equipment
 * and doctrine, and the defender's defensive focuses.
 */
export function attackerLossMultiplier(
  attackerEquipped: number,
  attackerMods: GsModifiers,
  defenderMods: GsModifiers | null,
): number {
  const shortage = shortageLossPermille(attackerEquipped);
  const doctrine = Math.max(100, 1000 + attackerMods.attackLoss);
  const defense = 1000 + (defenderMods?.defense ?? 0);
  return Math.floor((((shortage * doctrine) / 1000) * defense) / 1000);
}

/** Defender loss multiplier, per-mille, from its own equipment shortage. */
export function defenderLossMultiplier(defenderEquipped: number): number {
  return 1000 + Math.floor((1000 - defenderEquipped) / 2);
}

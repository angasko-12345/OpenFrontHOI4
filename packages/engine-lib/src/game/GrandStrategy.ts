/**
 * Grand Strategy layer (HOI4-inspired): national focuses, military industry,
 * production efficiency and equipment.
 *
 * Also political power, laws (conscription and economy) and war support.
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

import {
  CONSCRIPTION_LAW_IDS,
  ECONOMY_LAW_IDS,
  FOCUS_IDS,
  FocusID,
  LAW_IDS,
  LawID,
} from "@openfront/engine-api/game/GameTypes";

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
  /** Political power gain. */
  politicalPower: number;
  /** War support the nation drifts toward (added to the baseline). */
  warSupport: number;
}

export const ZERO_MODIFIERS: Readonly<GsModifiers> = Object.freeze({
  production: 0,
  efficiencyCap: 0,
  attackLoss: 0,
  defense: 0,
  manpower: 0,
  gold: 0,
  politicalPower: 0,
  warSupport: 0,
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
  {
    id: "political_effort",
    name: "Political Effort",
    description: "Political power gain +30%.",
    seconds: 60,
    requires: [],
    exclusive: [],
    effects: { politicalPower: 300 },
  },
  {
    id: "war_propaganda",
    name: "War Propaganda",
    description: "War support +15%, political power gain +10%.",
    seconds: 90,
    requires: ["political_effort"],
    exclusive: [],
    effects: { warSupport: 150, politicalPower: 100 },
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

export type LawCategory = "conscription" | "economy";

export interface LawDef {
  id: LawID;
  category: LawCategory;
  name: string;
  description: string;
  /** War support (per-mille) needed to adopt it. */
  minWarSupport: number;
  effects: Partial<GsModifiers>;
}

export const LAWS: readonly LawDef[] = [
  {
    id: "volunteer_only",
    category: "conscription",
    name: "Volunteer Only",
    description: "Manpower -15%, gold +5%.",
    minWarSupport: 0,
    effects: { manpower: -150, gold: 50 },
  },
  {
    id: "limited_conscription",
    category: "conscription",
    name: "Limited Conscription",
    description: "No modifiers.",
    minWarSupport: 0,
    effects: {},
  },
  {
    id: "extensive_conscription",
    category: "conscription",
    name: "Extensive Conscription",
    description: "Manpower +15%, gold -5%.",
    minWarSupport: 400,
    effects: { manpower: 150, gold: -50 },
  },
  {
    id: "service_by_requirement",
    category: "conscription",
    name: "Service by Requirement",
    description: "Manpower +30%, gold -15%, factory output -5%.",
    minWarSupport: 700,
    effects: { manpower: 300, gold: -150, production: -50 },
  },
  {
    id: "civilian_economy_law",
    category: "economy",
    name: "Civilian Economy",
    description: "Factory output -15%, gold +10%.",
    minWarSupport: 0,
    effects: { production: -150, gold: 100 },
  },
  {
    id: "partial_mobilization",
    category: "economy",
    name: "Partial Mobilization",
    description: "No modifiers.",
    minWarSupport: 300,
    effects: {},
  },
  {
    id: "war_economy_law",
    category: "economy",
    name: "War Economy",
    description: "Factory output +20%, gold -10%.",
    minWarSupport: 600,
    effects: { production: 200, gold: -100 },
  },
  {
    id: "total_mobilization",
    category: "economy",
    name: "Total Mobilization",
    description: "Factory output +35%, gold -20%, manpower -5%.",
    minWarSupport: 800,
    effects: { production: 350, gold: -200, manpower: -50 },
  },
];

const LAW_BY_ID = new Map<string, LawDef>(LAWS.map((l) => [l.id, l]));

if (
  LAWS.length !== LAW_IDS.length ||
  !LAW_IDS.every((id) => LAW_BY_ID.has(id)) ||
  !CONSCRIPTION_LAW_IDS.every(
    (id) => LAW_BY_ID.get(id)?.category === "conscription",
  ) ||
  !ECONOMY_LAW_IDS.every((id) => LAW_BY_ID.get(id)?.category === "economy")
) {
  throw new Error("LAWS and LAW_IDS disagree");
}

export function lawById(id: string): LawDef | undefined {
  return LAW_BY_ID.get(id);
}

export function lawsIn(category: LawCategory): LawDef[] {
  return LAWS.filter((l) => l.category === category);
}

export const DEFAULT_CONSCRIPTION_LAW: LawID = "limited_conscription";
export const DEFAULT_ECONOMY_LAW: LawID = "civilian_economy_law";

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
  /** Political power, in thousandths of a point. */
  politicalPower: number;
  /** War support, per-mille. */
  warSupport: number;
  conscriptionLaw: string;
  economyLaw: string;
  /** Attacked by another nation since the last second boundary. */
  defendedThisSecond: boolean;
  /** Troops lost attacking other nations since the last second boundary. */
  attackLossesThisSecond: number;
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
/** Political power gained per second, in thousandths, before modifiers. */
export const PP_PER_SECOND = 1000;
/** Political power cap, in thousandths. */
export const PP_CAP = 500_000;
/** Cost of changing one law, in thousandths of political power. */
export const LAW_CHANGE_COST = 150_000;
export const BASE_WAR_SUPPORT = 500;
/** War support gained each second the nation is under attack. */
export const WAR_SUPPORT_DEFENDING = 5;
/** War support lost in a second of heavy attack losses. */
export const WAR_SUPPORT_CASUALTIES = 3;
/** Losses over this share of troops in one second count as heavy, per-mille. */
export const HEAVY_LOSSES_PERMILLE = 30;
/** At 0 war support attack losses grow by this much, at 1000 they shrink by it. */
export const WAR_SUPPORT_LOSS_SWING = 100;

export function newNationState(startEquipment: number): NationGsState {
  return {
    equipment: Math.max(0, Math.floor(startEquipment)),
    efficiency: BASE_EFFICIENCY,
    focus: null,
    focusProgress: 0,
    completed: [],
    politicalPower: 0,
    warSupport: BASE_WAR_SUPPORT,
    conscriptionLaw: DEFAULT_CONSCRIPTION_LAW,
    economyLaw: DEFAULT_ECONOMY_LAW,
    defendedThisSecond: false,
    attackLossesThisSecond: 0,
  };
}

function addEffects(m: GsModifiers, effects: Partial<GsModifiers>): void {
  for (const k of Object.keys(effects) as (keyof GsModifiers)[]) {
    m[k] += effects[k] ?? 0;
  }
}

export function modifiersOf(state: NationGsState): GsModifiers {
  const m: GsModifiers = { ...ZERO_MODIFIERS };
  for (const id of state.completed) {
    const f = FOCUS_BY_ID.get(id);
    if (f !== undefined) addEffects(m, f.effects);
  }
  for (const id of [state.conscriptionLaw, state.economyLaw]) {
    const l = LAW_BY_ID.get(id);
    if (l !== undefined) addEffects(m, l.effects);
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

export type LawCheck =
  | "ok"
  | "unknown"
  | "active"
  | "low_war_support"
  | "no_political_power";

export function canSetLaw(state: NationGsState, id: string): LawCheck {
  const l = LAW_BY_ID.get(id);
  if (l === undefined) return "unknown";
  const current =
    l.category === "conscription" ? state.conscriptionLaw : state.economyLaw;
  if (current === id) return "active";
  if (state.warSupport < l.minWarSupport) return "low_war_support";
  if (state.politicalPower < LAW_CHANGE_COST) return "no_political_power";
  return "ok";
}

export function setLaw(state: NationGsState, id: string): LawCheck {
  const check = canSetLaw(state, id);
  if (check !== "ok") return check;
  const l = LAW_BY_ID.get(id)!;
  state.politicalPower -= LAW_CHANGE_COST;
  if (l.category === "conscription") state.conscriptionLaw = l.id;
  else state.economyLaw = l.id;
  return "ok";
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
  /** Troops at the second boundary, for judging how heavy losses were. */
  troops: number;
}

export interface NationSecondResult {
  produced: number;
  completedFocus: string | null;
}

/** Move war support for the second that just ended, then clear its events. */
function advanceWarSupport(
  state: NationGsState,
  troops: number,
  mods: GsModifiers,
): void {
  const target = clampPermille(BASE_WAR_SUPPORT + mods.warSupport);
  let ws = state.warSupport;
  const heavy =
    state.attackLossesThisSecond * 1000 >
    Math.max(1, troops) * HEAVY_LOSSES_PERMILLE;
  if (state.defendedThisSecond) ws += WAR_SUPPORT_DEFENDING;
  if (heavy) ws -= WAR_SUPPORT_CASUALTIES;
  if (!state.defendedThisSecond && !heavy) {
    if (ws < target) ws += 1;
    else if (ws > target) ws -= 1;
  }
  state.warSupport = clampPermille(ws);
  state.defendedThisSecond = false;
  state.attackLossesThisSecond = 0;
}

function clampPermille(v: number): number {
  return Math.max(0, Math.min(1000, Math.floor(v)));
}

/**
 * Advance one second: focus progress, political power, war support,
 * efficiency growth, production.
 */
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

  const ppGain = Math.max(
    0,
    Math.floor((PP_PER_SECOND * (1000 + mods.politicalPower)) / 1000),
  );
  state.politicalPower = Math.min(PP_CAP, state.politicalPower + ppGain);
  advanceWarSupport(state, input.troops, mods);

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
    1000 +
    Math.floor(
      ((1000 - clampPermille(equipped)) * UNEQUIPPED_LOSS_PENALTY) / 1000,
    )
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
  attackerWarSupport: number = BASE_WAR_SUPPORT,
): number {
  const shortage = shortageLossPermille(attackerEquipped);
  const doctrine = Math.max(100, 1000 + attackerMods.attackLoss);
  const defense = Math.max(0, 1000 + (defenderMods?.defense ?? 0));
  const morale =
    1000 +
    Math.trunc(
      ((BASE_WAR_SUPPORT - clampPermille(attackerWarSupport)) *
        WAR_SUPPORT_LOSS_SWING) /
        BASE_WAR_SUPPORT,
    );
  const a = Math.floor((shortage * doctrine) / 1000);
  const b = Math.floor((a * defense) / 1000);
  return Math.floor((b * morale) / 1000);
}

/** Defender loss multiplier, per-mille, from its own equipment shortage. */
export function defenderLossMultiplier(defenderEquipped: number): number {
  return 1000 + Math.floor((1000 - clampPermille(defenderEquipped)) / 2);
}

/** How an AI nation plays the Grand Strategy layer. */
export type AiPersonality = "industrialist" | "militarist" | "defender";

export const AI_PERSONALITIES: readonly AiPersonality[] = [
  "industrialist",
  "militarist",
  "defender",
];

/** Stable per nation, so every client derives the same personality. */
export function aiPersonalityFor(smallID: number): AiPersonality {
  return AI_PERSONALITIES[Math.abs(smallID) % AI_PERSONALITIES.length];
}

const AI_FOCUS_ORDER: Record<AiPersonality, readonly FocusID[]> = {
  industrialist: [
    "industrial_expansion",
    "rearmament",
    "civilian_economy",
    "political_effort",
    "conscription",
    "general_mobilization",
    "defense_in_depth",
    "fortify_borders",
    "war_propaganda",
  ],
  militarist: [
    "industrial_expansion",
    "rearmament",
    "war_economy",
    "conscription",
    "general_mobilization",
    "total_war",
    "mobile_warfare",
    "political_effort",
    "war_propaganda",
  ],
  defender: [
    "conscription",
    "defense_in_depth",
    "fortify_borders",
    "political_effort",
    "war_propaganda",
    "industrial_expansion",
    "rearmament",
    "general_mobilization",
  ],
};

/** Law categories in the order an AI tries to strengthen them. */
const AI_LAW_ORDER: Record<AiPersonality, readonly LawCategory[]> = {
  industrialist: ["economy"],
  militarist: ["economy", "conscription"],
  defender: ["conscription", "economy"],
};

export interface AiChoice {
  focus: FocusID | null;
  law: LawID | null;
}

/**
 * The AI's move this second: a focus when idle (its preferred one, else the
 * first available), and the next stronger law when it can afford one.
 */
export function aiChoose(
  state: NationGsState,
  personality: AiPersonality,
): AiChoice {
  let focus: FocusID | null = null;
  if (state.focus === null) {
    const preferred = AI_FOCUS_ORDER[personality].find(
      (id) => canStartFocus(state, id) === "ok",
    );
    focus = preferred ?? availableFocuses(state)[0]?.id ?? null;
  }
  let law: LawID | null = null;
  for (const category of AI_LAW_ORDER[personality]) {
    const ids =
      category === "conscription" ? CONSCRIPTION_LAW_IDS : ECONOMY_LAW_IDS;
    const current =
      category === "conscription" ? state.conscriptionLaw : state.economyLaw;
    const next = ids[ids.indexOf(current as never) + 1];
    if (next !== undefined && canSetLaw(state, next) === "ok") {
      law = next;
      break;
    }
  }
  return { focus, law };
}

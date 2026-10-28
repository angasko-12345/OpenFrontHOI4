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
  ADVISOR_IDS,
  AdvisorID,
  CONSCRIPTION_LAW_IDS,
  DECISION_IDS,
  DecisionID,
  ECONOMY_LAW_IDS,
  FOCUS_IDS,
  IdeologyActionID,
  FocusID,
  LAW_IDS,
  LawID,
} from "@openfront/engine-api/game/GameTypes";
import {
  adoptIdeology,
  AI_IDEOLOGY,
  canAdoptIdeology,
  DEFAULT_IDEOLOGY,
  ideologyAction,
  ideologyDef,
  ideologyOfAction,
  lawWarSupportFor,
  tickIdeology,
} from "./GrandStrategyIdeology";
import {
  WEARY_ATTACK_LOSS,
  WEARY_POLITICAL_POWER,
  WEARY_WAR_SUPPORT,
  wearinessPermille,
} from "./GrandStrategyPeace";
import {
  addResearchEffects,
  ResearchSlot,
  startResearch,
  techById,
} from "./GrandStrategyResearch";
import {
  RECOVERY_MANPOWER,
  RECOVERY_POLITICAL_POWER,
} from "./GrandStrategyRevanche";

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
  /** Troop cap (max troops). */
  maxTroops: number;
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
  maxTroops: 0,
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
    name: "Conscription Drive",
    description: "Manpower growth +10%, max troops +5%.",
    seconds: 60,
    requires: [],
    exclusive: [],
    effects: { manpower: 100, maxTroops: 50 },
  },
  {
    id: "civilian_economy",
    name: "Consumer Goods Drive",
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
    description: "Manpower growth +15%, max troops +10%, gold -5%.",
    seconds: 90,
    requires: ["conscription"],
    exclusive: [],
    effects: { manpower: 150, maxTroops: 100, gold: -50 },
  },
  {
    id: "war_economy",
    name: "Arms Programme",
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
    description: "Max troops -10%, manpower -15%, gold +5%.",
    minWarSupport: 0,
    effects: { manpower: -150, maxTroops: -100, gold: 50 },
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
    description: "Max troops +10%, manpower +15%, gold -5%.",
    minWarSupport: 400,
    effects: { manpower: 150, maxTroops: 100, gold: -50 },
  },
  {
    id: "service_by_requirement",
    category: "conscription",
    name: "Service by Requirement",
    description:
      "Max troops +20%, manpower +30%, gold -15%, factory output -5%.",
    minWarSupport: 700,
    effects: { manpower: 300, maxTroops: 200, gold: -150, production: -50 },
  },
  {
    id: "civilian_economy_law",
    category: "economy",
    name: "Civilian Economy",
    description: "Factory output -15%, gold +10%, civilian factories +25%.",
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
    description: "Factory output +20%, gold -10%, civilian factories -25%.",
    minWarSupport: 600,
    effects: { production: 200, gold: -100 },
  },
  {
    id: "total_mobilization",
    category: "economy",
    name: "Total Mobilization",
    description:
      "Factory output +35%, gold -20%, manpower -5%, civilian factories -50%.",
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

export interface DecisionDef {
  id: DecisionID;
  name: string;
  description: string;
  /** Political power cost, in thousandths. */
  cost: number;
  /** Seconds the effects last (0 = instant only). */
  seconds: number;
  /** Seconds before it can be taken again, counted from when it is taken. */
  cooldown: number;
  effects: Partial<GsModifiers>;
  /** Instant war support change, per-mille. */
  warSupport: number;
}

export const DECISIONS: readonly DecisionDef[] = [
  {
    id: "emergency_production",
    name: "Emergency Production",
    description: "Factory output +40% for 60s.",
    cost: 100_000,
    seconds: 60,
    cooldown: 180,
    effects: { production: 400 },
    warSupport: 0,
  },
  {
    id: "war_bonds",
    name: "War Bonds",
    description: "Gold income +30% for 60s, war support -2%.",
    cost: 75_000,
    seconds: 60,
    cooldown: 180,
    effects: { gold: 300 },
    warSupport: -20,
  },
  {
    id: "propaganda_drive",
    name: "Propaganda Drive",
    description: "War support +10% now.",
    cost: 75_000,
    seconds: 0,
    cooldown: 120,
    effects: {},
    warSupport: 100,
  },
];

export interface AdvisorDef {
  id: AdvisorID;
  name: string;
  description: string;
  effects: Partial<GsModifiers>;
}

export const ADVISORS: readonly AdvisorDef[] = [
  {
    id: "industrial_planner",
    name: "Industrial Planner",
    description: "Factory output +10%.",
    effects: { production: 100 },
  },
  {
    id: "army_chief",
    name: "Chief of the Army",
    description: "Losses when attacking -8%.",
    effects: { attackLoss: -80 },
  },
  {
    id: "defense_minister",
    name: "Defense Minister",
    description: "Enemies attacking you lose 10% more troops.",
    effects: { defense: 100 },
  },
  {
    id: "political_advisor",
    name: "Political Advisor",
    description: "Political power gain +20%.",
    effects: { politicalPower: 200 },
  },
];

/** Advisor slots per nation. */
export const ADVISOR_SLOTS = 2;
/** Cost of hiring an advisor, in thousandths of political power. */
export const ADVISOR_COST = 150_000;

const DECISION_BY_ID = new Map<string, DecisionDef>(
  DECISIONS.map((d) => [d.id, d]),
);
const ADVISOR_BY_ID = new Map<string, AdvisorDef>(
  ADVISORS.map((a) => [a.id, a]),
);

if (
  DECISIONS.length !== DECISION_IDS.length ||
  !DECISION_IDS.every((id) => DECISION_BY_ID.has(id)) ||
  ADVISORS.length !== ADVISOR_IDS.length ||
  !ADVISOR_IDS.every((id) => ADVISOR_BY_ID.has(id))
) {
  throw new Error("DECISIONS/ADVISORS and their ids disagree");
}

export function decisionById(id: string): DecisionDef | undefined {
  return DECISION_BY_ID.get(id);
}

export function advisorById(id: string): AdvisorDef | undefined {
  return ADVISOR_BY_ID.get(id);
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
  /** Decisions whose effects are running: id and seconds left. */
  activeDecisions: TimedEntry[];
  /** Decisions on cooldown: id and seconds left. */
  decisionCooldowns: TimedEntry[];
  /** Hired advisor ids, in hiring order. */
  advisors: string[];
  /** M5: steel and oil deposit tiles held at the last second boundary. */
  steelDeposits: number;
  oilDeposits: number;
  /** M5: military factories at the last second boundary. */
  milFactories: number;
  /** M5 stage B: civilian factories, and steel and oil imported, last second. */
  civFactories: number;
  importSteel: number;
  importOil: number;
  /** M5 stage C: artillery stock, counted in troops it supports. */
  artillery: number;
  /** M5 stage C: share of military output on artillery, per-mille. */
  artilleryShare: number;
  /** M6: researched technology ids, in order, and the slots in progress. */
  researched: string[];
  research: ResearchSlot[];
  /**
   * M7 stage A: war weariness, thousandths of a per-mille (see
   * GrandStrategyPeace). Absent = 0 (states built before M7).
   */
  weariness?: number;
  /**
   * M7 stage B: ideology id and seconds before it may change again.
   * Absent = non-aligned / 0 (states built before M7 stage B).
   */
  ideology?: string;
  ideologyCooldown?: number;
  /**
   * M7C stage 2: holds a revanche claim whose truce still stands (set each
   * second by the execution). Optional: absent = false.
   */
  recovering?: boolean;
  /**
   * M7 stage D (GrandStrategyPuppet): small id of our overlord while we are
   * a puppet, our autonomy (per-mille), and the beaten nations we may
   * still puppet (seconds left). Optional: absent = independent / 0 / none.
   */
  overlord?: number;
  autonomy?: number;
  puppetWindows?: { target: number; seconds: number }[];
}

export interface TimedEntry {
  id: string;
  seconds: number;
}

// Tunables
/** Efficiency a nation starts at, and drops back to when it has no factories. */
export const BASE_EFFICIENCY = 100;
export const BASE_EFFICIENCY_CAP = 500;
/** Equipment per military factory per second at 100% efficiency. */
export const EQUIPMENT_PER_FACTORY = 1000;
/** Every nation runs this many factories before it builds any. */
export const BASE_FACTORIES = 2;
/** Each built Factory structure level counts as this many military factories. */
export const FACTORIES_PER_STRUCTURE_LEVEL = 3;
/** Owned land tiles per extra base factory (bigger countries, more industry). */
export const TILES_PER_BASE_FACTORY = 1500;
/** Stockpile cap as a multiple of max troops. */
export const STOCKPILE_CAP_MULTIPLE = 2;
/** At 0% equipped, losses are multiplied by 1 + this (per-mille). */
export const UNEQUIPPED_LOSS_PENALTY = 500;
/** Political power gained per second, in thousandths, before modifiers. */
export const PP_PER_SECOND = 1000;
/** Lowest troop-cap modifier, per-mille: max troops never drop below half. */
export const MIN_TROOP_CAP_MODIFIER = -500;
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
    activeDecisions: [],
    decisionCooldowns: [],
    advisors: [],
    steelDeposits: 0,
    oilDeposits: 0,
    milFactories: 0,
    civFactories: 0,
    importSteel: 0,
    importOil: 0,
    artillery: 0,
    artilleryShare: 0,
    researched: [],
    research: [],
    weariness: 0,
    ideology: DEFAULT_IDEOLOGY,
    ideologyCooldown: 0,
    autonomy: 0,
    puppetWindows: [],
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
  for (const id of state.advisors) {
    const a = ADVISOR_BY_ID.get(id);
    if (a !== undefined) addEffects(m, a.effects);
  }
  for (const e of state.activeDecisions) {
    const d = DECISION_BY_ID.get(e.id);
    if (d !== undefined) addEffects(m, d.effects);
  }
  addResearchEffects(m, state.researched ?? []);
  addWearinessEffects(m, state.weariness);
  addEffects(m, ideologyDef(state.ideology).effects);
  if (state.recovering === true) {
    m.manpower += RECOVERY_MANPOWER;
    m.politicalPower += RECOVERY_POLITICAL_POWER;
  }
  return m;
}

/** M7 stage A: war weariness raises attack losses, cuts PP and war support. */
function addWearinessEffects(m: GsModifiers, weariness?: number): void {
  const w = wearinessPermille(weariness);
  if (w === 0) return;
  m.attackLoss += Math.trunc((w * WEARY_ATTACK_LOSS) / 1000);
  m.politicalPower += Math.trunc((w * WEARY_POLITICAL_POWER) / 1000);
  m.warSupport += Math.trunc((w * WEARY_WAR_SUPPORT) / 1000);
}

/** Troop-cap modifier (per-mille) a state's focuses and laws give. */
export function troopCapModifier(state: NationGsState): number {
  return Math.max(MIN_TROOP_CAP_MODIFIER, modifiersOf(state).maxTroops);
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
  // The ideology offset only raises or lowers a real requirement: stepping
  // back to a law that needs no war support is always allowed.
  if (
    l.minWarSupport > 0 &&
    state.warSupport < l.minWarSupport + lawWarSupportFor(state.ideology)
  ) {
    return "low_war_support";
  }
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

export type ActionCheck =
  | "ok"
  | "unknown"
  | "cooldown"
  | "hired"
  | "no_slots"
  | "no_political_power"
  | "unavailable";

/** Can the nation take this decision or hire this advisor now? */
export function canTakeAction(state: NationGsState, id: string): ActionCheck {
  const d = DECISION_BY_ID.get(id);
  if (d !== undefined) {
    if (state.decisionCooldowns.some((c) => c.id === id)) return "cooldown";
    if (state.politicalPower < d.cost) return "no_political_power";
    return "ok";
  }
  if (ADVISOR_BY_ID.has(id)) {
    if (state.advisors.includes(id)) return "hired";
    if (state.advisors.length >= ADVISOR_SLOTS) return "no_slots";
    if (state.politicalPower < ADVISOR_COST) return "no_political_power";
    return "ok";
  }
  return "unknown";
}

/** Take a decision or hire an advisor, paying its political power. */
export function takeAction(state: NationGsState, id: string): ActionCheck {
  const line = LINE_SHARE[id];
  if (line !== undefined) {
    state.artilleryShare = line;
    return "ok";
  }
  if (techById(id) !== undefined) {
    state.researched ??= [];
    state.research ??= [];
    return startResearch(state, id) === "ok" ? "ok" : "unavailable";
  }
  const ideology = ideologyOfAction(id);
  if (ideology !== null) {
    const r = adoptIdeology(state, ideology);
    return r === "ok"
      ? "ok"
      : r === "no_political_power"
        ? "no_political_power"
        : r === "cooldown"
          ? "cooldown"
          : "unavailable";
  }
  const check = canTakeAction(state, id);
  if (check !== "ok") return check;
  const d = DECISION_BY_ID.get(id);
  if (d !== undefined) {
    state.politicalPower -= d.cost;
    state.warSupport = clampPermille(state.warSupport + d.warSupport);
    if (d.seconds > 0) state.activeDecisions.push({ id, seconds: d.seconds });
    state.decisionCooldowns.push({ id, seconds: d.cooldown });
  } else {
    state.politicalPower -= ADVISOR_COST;
    state.advisors.push(id);
  }
  return "ok";
}

/** Count timers down one second and drop the finished ones. */
function tickTimers(list: TimedEntry[]): TimedEntry[] {
  const out: TimedEntry[] = [];
  for (const e of list) {
    if (e.seconds > 1) out.push({ id: e.id, seconds: e.seconds - 1 });
  }
  return out;
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
  /** Resource multiplier on production, per-mille (M5; default 1000). */
  productionPermille?: number;
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

  // Active decisions count down after this second's production (below), so
  // a 60 s decision boosts 60 seconds; cooldowns count down here.
  state.decisionCooldowns = tickTimers(state.decisionCooldowns);
  tickIdeology(state);

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
  const base = Math.floor(
    (factories *
      EQUIPMENT_PER_FACTORY *
      state.efficiency *
      (1000 + mods.production)) /
      1_000_000,
  );
  const total = Math.max(
    0,
    Math.floor((base * (input.productionPermille ?? 1000)) / 1000),
  );
  const share = clampPermille(state.artilleryShare ?? 0);
  const toGuns = Math.floor((total * share) / 1000);
  const produced = total - toGuns;
  // New guns fill up to max troops; a lower cap later never scraps guns
  // already built (like equipment: never confiscate).
  const guns = state.artillery ?? 0;
  state.artillery = Math.max(
    guns,
    Math.min(
      Math.max(0, Math.floor(input.maxTroops)),
      guns + Math.floor(toGuns / ARTILLERY_COST),
    ),
  );
  const stockCap = Math.floor(input.maxTroops * STOCKPILE_CAP_MULTIPLE);
  const before = state.equipment;
  state.equipment = Math.min(stockCap, state.equipment + produced);
  if (state.equipment < before) state.equipment = before; // never confiscate
  state.activeDecisions = tickTimers(state.activeDecisions);
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

// ---------------------------------------------------------------------------
// M5 stage C: production lines and artillery.
//
// A nation splits military output between infantry equipment and artillery.
// Artillery is stocked in "troops supported" (like equipment, capped at max
// troops); each unit costs ARTILLERY_COST equipment of output. An attack
// with full artillery support takes ARTILLERY_LOSS_CUT fewer losses, and
// guns are lost with the troops they support.

/** Equipment of output per troop of artillery support. */
export const ARTILLERY_COST = 4;
/** Attacker losses cut at full artillery support, per-mille. */
export const ARTILLERY_LOSS_CUT = 150;

/** Artillery share each production line sets, per-mille. */
export const LINE_SHARE: Readonly<Record<string, number>> = {
  line_infantry: 0,
  line_balanced: 250,
  line_artillery: 500,
};

/** Attacker loss multiplier (per-mille) from artillery support. */
export function artilleryLossPermille(supported: number): number {
  return (
    1000 - Math.floor((clampPermille(supported) * ARTILLERY_LOSS_CUT) / 1000)
  );
}

/**
 * AI production line: guns once the infantry stockpile covers the army,
 * militarists earlier.
 */
export function aiProductionLine(
  state: NationGsState,
  personality: AiPersonality,
  maxTroops: number,
): string {
  // Guns already cover the army: more would be wasted, so equipment only.
  if ((state.artillery ?? 0) >= Math.floor(maxTroops)) return "line_infantry";
  if (state.equipment >= Math.floor(maxTroops)) return "line_artillery";
  if (personality === "militarist" && state.equipment * 2 >= maxTroops) {
    return "line_balanced";
  }
  return "line_infantry";
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
  industrialist: ["economy", "conscription"],
  militarist: ["economy", "conscription"],
  defender: ["conscription", "economy"],
};

/** The strongest law each personality will adopt; past it the costs outweigh the gains. */
const AI_LAW_CEILING: Record<AiPersonality, readonly LawID[]> = {
  industrialist: ["extensive_conscription", "war_economy_law"],
  militarist: ["extensive_conscription", "war_economy_law"],
  defender: ["service_by_requirement", "war_economy_law"],
};

export interface AiChoice {
  focus: FocusID | null;
  law: LawID | null;
  /** Decision, advisor or (M7 stage B) ideology to buy with spare PP. */
  action: DecisionID | AdvisorID | IdeologyActionID | null;
}

const AI_ADVISORS: Record<AiPersonality, readonly AdvisorID[]> = {
  industrialist: ["industrial_planner", "political_advisor"],
  militarist: ["army_chief", "industrial_planner"],
  defender: ["defense_minister", "industrial_planner"],
};

const AI_DECISIONS: Record<AiPersonality, readonly DecisionID[]> = {
  industrialist: ["war_bonds", "emergency_production"],
  militarist: ["emergency_production", "propaganda_drive"],
  defender: ["propaganda_drive", "emergency_production"],
};

/** AI only spends on decisions and advisors above this reserve (thousandths). */
export const AI_PP_RESERVE = LAW_CHANGE_COST + 100_000;

/**
 * The AI's move this second: a focus when idle (its preferred one, else the
 * first available), and the next stronger law when it can afford one.
 */
export function aiChoose(
  state: NationGsState,
  personality: AiPersonality,
  ideologies = true,
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
    const at = ids.indexOf(current as never);
    const next = ids[at + 1];
    const ceiling = AI_LAW_CEILING[personality].find((id) =>
      ids.includes(id as never),
    );
    if (ceiling !== undefined && at >= ids.indexOf(ceiling as never)) continue;
    if (next !== undefined && canSetLaw(state, next) === "ok") {
      law = next;
      break;
    }
  }
  let action: DecisionID | AdvisorID | IdeologyActionID | null = null;
  // M7 stage B: adopt the personality's ideology once, out of spare PP.
  const wanted = AI_IDEOLOGY[personality];
  if (
    law === null &&
    ideologies &&
    state.politicalPower >= AI_PP_RESERVE &&
    canAdoptIdeology(state, wanted) === "ok"
  ) {
    action = ideologyAction(wanted);
  } else if (law === null && state.politicalPower >= AI_PP_RESERVE) {
    action =
      AI_ADVISORS[personality].find(
        (id) => canTakeAction(state, id) === "ok",
      ) ??
      AI_DECISIONS[personality].find(
        (id) => canTakeAction(state, id) === "ok",
      ) ??
      null;
  }
  return { focus, law, action };
}

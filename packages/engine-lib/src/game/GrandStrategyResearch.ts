/**
 * M6 stage A: research, eras and doctrines. Pure rules, integers only.
 *
 * Each nation has RESEARCH_SLOTS slots. A slot gains 1000 progress per
 * second; a technology finishes when progress reaches its cost. Costs are
 * cut by CATCH_UP_DISCOUNT when at least half of the other Grand Strategy
 * nations already know the technology, so laggards catch up (anti-snowball:
 * big nations do not research faster).
 *
 * Technologies belong to an era. A nation starts in era 1 and enters the next
 * era once it has researched ERA_ADVANCE technologies of its current era;
 * technologies of a later era stay locked until then. Doctrine roots are
 * mutually exclusive.
 *
 * Land technologies lean on defense: a paired 15-seed ablation (2026-10-26)
 * showed attack-heavy research raised the snowball index by +3.4 +-1.9, since
 * leaders attack the most. A research slowdown for large nations was tried
 * and measured inert (-0.5 +-1.0), so it was reverted.
 */
import type { TechID } from "@openfront/engine-api/game/GameTypes";
import type { AiPersonality, GsModifiers } from "./GrandStrategy";

export type TechBranch = "industry" | "land" | "doctrine" | "politics";

export interface TechDef {
  id: TechID;
  name: string;
  description: string;
  branch: TechBranch;
  era: number;
  /** Seconds of one research slot. */
  seconds: number;
  requires: readonly TechID[];
  /** Cannot be researched once any of these is researched or in progress. */
  exclusive: readonly TechID[];
  effects: Partial<GsModifiers>;
}

export const RESEARCH_SLOTS = 2;
export const MAX_ERA = 3;
/** Technologies of the current era needed to enter the next one. */
export const ERA_ADVANCE = 3;
/** Progress a slot gains per second. */
export const RESEARCH_PER_SECOND = 1000;
/** Cost cut, per-mille, for a technology most other nations already know. */
export const CATCH_UP_DISCOUNT = 300;
/** Share of other nations (per-mille) that must know it for the discount. */
export const CATCH_UP_SHARE = 500;

const DOCTRINES: readonly TechID[] = [
  "maneuver_doctrine",
  "firepower_doctrine",
  "defense_doctrine",
];

export const TECHS: readonly TechDef[] = [
  // Era 1
  {
    id: "basic_machine_tools",
    name: "Machine Tools",
    description: "+5% military production",
    branch: "industry",
    era: 1,
    seconds: 90,
    requires: [],
    exclusive: [],
    effects: { production: 50 },
  },
  {
    id: "improved_workshops",
    name: "Improved Workshops",
    description: "+5% production efficiency cap",
    branch: "industry",
    era: 1,
    seconds: 90,
    requires: [],
    exclusive: [],
    effects: { efficiencyCap: 50 },
  },
  {
    id: "infantry_weapons",
    name: "Infantry Weapons",
    description: "-2% attacker losses, +2% defense",
    branch: "land",
    era: 1,
    seconds: 90,
    requires: [],
    exclusive: [],
    effects: { attackLoss: -20, defense: 20 },
  },
  {
    id: "field_fortifications",
    name: "Field Fortifications",
    description: "+5% losses for attackers",
    branch: "land",
    era: 1,
    seconds: 90,
    requires: [],
    exclusive: [],
    effects: { defense: 50 },
  },
  {
    id: "propaganda_bureau",
    name: "Propaganda Bureau",
    description: "+10% political power, +2% war support",
    branch: "politics",
    era: 1,
    seconds: 90,
    requires: [],
    exclusive: [],
    effects: { politicalPower: 100, warSupport: 20 },
  },
  {
    id: "maneuver_doctrine",
    name: "Maneuver Doctrine",
    description: "Doctrine: -5% attacker losses, -2% defense",
    branch: "doctrine",
    era: 1,
    seconds: 120,
    requires: [],
    exclusive: DOCTRINES.filter((d) => d !== "maneuver_doctrine"),
    effects: { attackLoss: -50, defense: -20 },
  },
  {
    id: "firepower_doctrine",
    name: "Firepower Doctrine",
    description: "Doctrine: -3% attacker losses, +3% defense",
    branch: "doctrine",
    era: 1,
    seconds: 120,
    requires: [],
    exclusive: DOCTRINES.filter((d) => d !== "firepower_doctrine"),
    effects: { attackLoss: -30, defense: 30 },
  },
  {
    id: "defense_doctrine",
    name: "Defense Doctrine",
    description: "Doctrine: +8% defense",
    branch: "doctrine",
    era: 1,
    seconds: 120,
    requires: [],
    exclusive: DOCTRINES.filter((d) => d !== "defense_doctrine"),
    effects: { defense: 80 },
  },
  // Era 2
  {
    id: "assembly_lines",
    name: "Assembly Lines",
    description: "+7.5% military production",
    branch: "industry",
    era: 2,
    seconds: 150,
    requires: ["basic_machine_tools"],
    exclusive: [],
    effects: { production: 75 },
  },
  {
    id: "civil_administration",
    name: "Civil Administration",
    description: "+5% gold",
    branch: "politics",
    era: 2,
    seconds: 150,
    requires: [],
    exclusive: [],
    effects: { gold: 50 },
  },
  {
    id: "improved_artillery",
    name: "Improved Artillery",
    description: "-2% attacker losses, +3% defense",
    branch: "land",
    era: 2,
    seconds: 150,
    requires: ["infantry_weapons"],
    exclusive: [],
    effects: { attackLoss: -20, defense: 30 },
  },
  {
    id: "motorization",
    name: "Motorization",
    description: "+5% manpower growth",
    branch: "land",
    era: 2,
    seconds: 150,
    requires: [],
    exclusive: [],
    effects: { manpower: 50 },
  },
  {
    id: "rapid_exploitation",
    name: "Rapid Exploitation",
    description: "Maneuver doctrine: -3% attacker losses",
    branch: "doctrine",
    era: 2,
    seconds: 150,
    requires: ["maneuver_doctrine"],
    exclusive: [],
    effects: { attackLoss: -30 },
  },
  {
    id: "concentrated_fire",
    name: "Concentrated Fire",
    description: "Firepower doctrine: -3% attacker losses, +3% defense",
    branch: "doctrine",
    era: 2,
    seconds: 150,
    requires: ["firepower_doctrine"],
    exclusive: [],
    effects: { attackLoss: -30, defense: 30 },
  },
  {
    id: "entrenchment",
    name: "Entrenchment",
    description: "Defense doctrine: +6% defense, +3% max troops",
    branch: "doctrine",
    era: 2,
    seconds: 150,
    requires: ["defense_doctrine"],
    exclusive: [],
    effects: { defense: 60, maxTroops: 30 },
  },
  // Era 3
  {
    id: "automation",
    name: "Automation",
    description: "+10% military production, +5% efficiency cap",
    branch: "industry",
    era: 3,
    seconds: 240,
    requires: ["assembly_lines"],
    exclusive: [],
    effects: { production: 100, efficiencyCap: 50 },
  },
  {
    id: "mechanized_warfare",
    name: "Mechanized Warfare",
    description: "-3% attacker losses, +3% defense",
    branch: "land",
    era: 3,
    seconds: 240,
    requires: ["motorization"],
    exclusive: [],
    effects: { attackLoss: -30, defense: 30 },
  },
  {
    id: "total_defense",
    name: "Total Defense",
    description: "+6% defense, +5% manpower growth",
    branch: "land",
    era: 3,
    seconds: 240,
    requires: ["field_fortifications"],
    exclusive: [],
    effects: { defense: 60, manpower: 50 },
  },
];

const TECH_BY_ID = new Map<string, TechDef>(TECHS.map((t) => [t.id, t]));

export function techById(id: string): TechDef | undefined {
  return TECH_BY_ID.get(id);
}

/** A technology being researched in one slot. */
export interface ResearchSlot {
  id: string;
  /** Progress, in RESEARCH_PER_SECOND units per second. */
  progress: number;
}

/** The research part of a nation's state. */
export interface ResearchState {
  researched: string[];
  research: ResearchSlot[];
}

/** Era a nation is in, from what it has researched. */
export function eraOf(researched: readonly string[]): number {
  let era = 1;
  while (era < MAX_ERA) {
    let n = 0;
    for (const id of researched) {
      if (TECH_BY_ID.get(id)?.era === era) n++;
    }
    if (n < ERA_ADVANCE) break;
    era++;
  }
  return era;
}

/** Progress a technology needs, after the catch-up discount. */
export function techCost(def: TechDef, knownByPermille: number): number {
  const base = def.seconds * RESEARCH_PER_SECOND;
  if (knownByPermille < CATCH_UP_SHARE) return base;
  return base - Math.floor((base * CATCH_UP_DISCOUNT) / 1000);
}

export type ResearchCheck =
  | "ok"
  | "unknown"
  | "researched"
  | "in_progress"
  | "no_slot"
  | "era"
  | "missing_prerequisite"
  | "exclusive";

export function canResearch(s: ResearchState, id: string): ResearchCheck {
  const t = TECH_BY_ID.get(id);
  if (t === undefined) return "unknown";
  if (s.researched.includes(id)) return "researched";
  if (s.research.some((r) => r.id === id)) return "in_progress";
  if (s.research.length >= RESEARCH_SLOTS) return "no_slot";
  if (t.era > eraOf(s.researched)) return "era";
  if (!t.requires.every((r) => s.researched.includes(r))) {
    return "missing_prerequisite";
  }
  if (
    t.exclusive.some(
      (x) => s.researched.includes(x) || s.research.some((r) => r.id === x),
    )
  ) {
    return "exclusive";
  }
  return "ok";
}

export function startResearch(s: ResearchState, id: string): ResearchCheck {
  const check = canResearch(s, id);
  if (check === "ok") s.research.push({ id, progress: 0 });
  return check;
}

/**
 * One second of research. `knownBy` gives, per technology, the per-mille of
 * other nations that already know it. Returns the technologies finished.
 */
export function advanceResearch(
  s: ResearchState,
  knownBy: (id: string) => number,
): string[] {
  const done: string[] = [];
  const left: ResearchSlot[] = [];
  for (const slot of s.research) {
    const t = TECH_BY_ID.get(slot.id);
    if (t === undefined || s.researched.includes(slot.id)) continue;
    const progress = slot.progress + RESEARCH_PER_SECOND;
    if (progress >= techCost(t, knownBy(slot.id))) {
      s.researched.push(slot.id);
      done.push(slot.id);
    } else {
      left.push({ id: slot.id, progress });
    }
  }
  s.research = left;
  return done;
}

/** Effects of everything researched, added into `m`. */
export function addResearchEffects(
  m: GsModifiers,
  researched: readonly string[],
): void {
  for (const id of researched) {
    const t = TECH_BY_ID.get(id);
    if (t === undefined) continue;
    for (const [k, v] of Object.entries(t.effects)) {
      m[k as keyof GsModifiers] += v as number;
    }
  }
}

const AI_RESEARCH_ORDER: Record<AiPersonality, readonly TechID[]> = {
  // Combat technologies early: production alone does not hold land
  // (45-seed check, 2026-10-26: production-first left industrialists -12 pts).
  industrialist: [
    "infantry_weapons",
    "basic_machine_tools",
    "firepower_doctrine",
    "improved_workshops",
    "improved_artillery",
    "assembly_lines",
    "concentrated_fire",
    "field_fortifications",
    "motorization",
    "propaganda_bureau",
    "automation",
    "mechanized_warfare",
    "civil_administration",
    "total_defense",
  ],
  militarist: [
    "infantry_weapons",
    "maneuver_doctrine",
    "basic_machine_tools",
    "propaganda_bureau",
    "improved_artillery",
    "rapid_exploitation",
    "motorization",
    "assembly_lines",
    "improved_workshops",
    "field_fortifications",
    "mechanized_warfare",
    "automation",
    "civil_administration",
    "total_defense",
  ],
  defender: [
    "field_fortifications",
    "defense_doctrine",
    "basic_machine_tools",
    "improved_workshops",
    "entrenchment",
    "motorization",
    "assembly_lines",
    "infantry_weapons",
    "propaganda_bureau",
    "total_defense",
    "civil_administration",
    "improved_artillery",
    "automation",
    "mechanized_warfare",
  ],
};

/** Next technology an AI nation starts, or null when none fits. */
export function aiResearch(
  s: ResearchState,
  personality: AiPersonality,
): string | null {
  if (s.research.length >= RESEARCH_SLOTS) return null;
  for (const id of AI_RESEARCH_ORDER[personality]) {
    if (canResearch(s, id) === "ok") return id;
  }
  for (const t of TECHS) {
    if (canResearch(s, t.id) === "ok") return t.id;
  }
  return null;
}

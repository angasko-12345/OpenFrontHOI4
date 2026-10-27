/**
 * Grand Strategy, milestone 7 stage B: ideologies. Pure rules, integer
 * maths only, data-driven like FOCUS_TREE.
 *
 * Every nation starts non-aligned. Adopting an ideology (or going back to
 * non-aligned) is a gs_action that costs IDEOLOGY_COST political power and
 * starts an IDEOLOGY_COOLDOWN. Each ideology gives a modest modifier set
 * (through modifiersOf) plus a few rule hooks:
 * - law access (war support needed for laws, +- per-mille),
 * - war-goal justification cost (multiplier),
 * - war weariness gain (multiplier),
 * - AI diplomacy: weariness at which it offers / accepts peace, and how
 *   much stronger it must be before breaking a truce.
 * Two nations sharing an ideology (other than non-aligned) make peace more
 * readily and are slower to break truces with each other.
 *
 * Generic names only (no third-party names or assets).
 */
import {
  IDEOLOGY_IDS,
  IdeologyActionID,
  IdeologyID,
} from "@openfront/engine-api/game/GameTypes";
import type { AiPersonality, GsModifiers } from "./GrandStrategy";

export const DEFAULT_IDEOLOGY: IdeologyID = "nonaligned";
/** Political power (thousandths) to adopt an ideology. */
export const IDEOLOGY_COST = 150_000;
/** Seconds after a change before the next one. */
export const IDEOLOGY_COOLDOWN = 300;
/** Same ideology: AI accepts peace at this much less weariness (per-mille). */
export const SAME_IDEOLOGY_PEACE = 150;
/** Same ideology: AI needs this much more strength (per-mille) to break a truce. */
export const SAME_IDEOLOGY_BREAK = 1000;

export interface IdeologyDef {
  id: IdeologyID;
  name: string;
  description: string;
  effects: Partial<GsModifiers>;
  /** War support needed for laws, per-mille added (negative = easier). */
  lawWarSupport: number;
  /** Justification cost multiplier, per-mille. */
  justifyCost: number;
  /** War weariness gain multiplier, per-mille. */
  wearinessGain: number;
  /** AI offers and accepts peace at this much more weariness (per-mille). */
  aiPeace: number;
  /** AI needs this much more strength (per-mille) before breaking a truce. */
  aiBreak: number;
}

export const IDEOLOGIES: readonly IdeologyDef[] = [
  {
    id: "nonaligned",
    name: "Non-aligned",
    description: "No ideology: no bonuses, no penalties.",
    effects: {},
    lawWarSupport: 0,
    justifyCost: 1000,
    wearinessGain: 1000,
    aiPeace: 0,
    aiBreak: 0,
  },
  {
    id: "assembly",
    name: "Assembly",
    description:
      "Elected government. Political power +10%, enemies attacking you lose 5% more; " +
      "laws need 10% more war support, war goals cost 50% more, weariness grows 10% faster.",
    effects: { politicalPower: 100, defense: 50 },
    lawWarSupport: 100,
    justifyCost: 1500,
    wearinessGain: 1100,
    aiPeace: -100,
    aiBreak: 1500,
  },
  {
    id: "directorate",
    name: "Directorate",
    description:
      "Rule by decree. Attack losses -3%, political power +5%, laws need 10% less war support, " +
      "war goals cost 25% less.",
    effects: { attackLoss: -30, politicalPower: 50 },
    lawWarSupport: -100,
    justifyCost: 750,
    wearinessGain: 1000,
    aiPeace: 100,
    aiBreak: -500,
  },
  {
    id: "commune",
    name: "Commune",
    description:
      "Collective economy. Factory output +8%, troop growth +5%, political power -5%, " +
      "laws need 5% less war support, weariness grows 10% slower.",
    effects: { production: 80, manpower: 50, politicalPower: -50 },
    lawWarSupport: -50,
    justifyCost: 1000,
    wearinessGain: 900,
    aiPeace: 0,
    aiBreak: 0,
  },
];

const BY_ID = new Map<string, IdeologyDef>(IDEOLOGIES.map((d) => [d.id, d]));

if (
  IDEOLOGIES.length !== IDEOLOGY_IDS.length ||
  !IDEOLOGY_IDS.every((id) => BY_ID.has(id))
) {
  throw new Error("IDEOLOGIES and IDEOLOGY_IDS disagree");
}

/** Definition of an ideology id; unknown or absent = non-aligned. */
export function ideologyDef(id: string | undefined): IdeologyDef {
  return BY_ID.get(id ?? DEFAULT_IDEOLOGY) ?? BY_ID.get(DEFAULT_IDEOLOGY)!;
}

/** The ideology a gs_action id adopts, or null if it is not one. */
export function ideologyOfAction(action: string): IdeologyID | null {
  if (!action.startsWith("ideology_")) return null;
  const id = action.slice("ideology_".length);
  return BY_ID.has(id) ? (id as IdeologyID) : null;
}

export function ideologyAction(id: IdeologyID): IdeologyActionID {
  return `ideology_${id}` as IdeologyActionID;
}

/** The part of NationGsState the ideology rules read and write. */
export interface IdeologyHolder {
  politicalPower: number;
  /** Absent = non-aligned (states from before M7 stage B). */
  ideology?: string;
  /** Seconds before the next change; absent = 0. */
  ideologyCooldown?: number;
}

export type IdeologyCheck =
  | "ok"
  | "unknown"
  | "active"
  | "cooldown"
  | "no_political_power";

export function canAdoptIdeology(s: IdeologyHolder, id: string): IdeologyCheck {
  if (!BY_ID.has(id)) return "unknown";
  if (ideologyDef(s.ideology).id === id) return "active";
  if ((s.ideologyCooldown ?? 0) > 0) return "cooldown";
  if (s.politicalPower < IDEOLOGY_COST) return "no_political_power";
  return "ok";
}

export function adoptIdeology(s: IdeologyHolder, id: string): IdeologyCheck {
  const check = canAdoptIdeology(s, id);
  if (check !== "ok") return check;
  s.politicalPower -= IDEOLOGY_COST;
  s.ideology = id;
  s.ideologyCooldown = IDEOLOGY_COOLDOWN;
  return "ok";
}

/** Count the change cooldown down one second. */
export function tickIdeology(s: IdeologyHolder): void {
  if ((s.ideologyCooldown ?? 0) > 0) s.ideologyCooldown! -= 1;
}

/** Whether two ideologies count as the same camp (non-aligned never does). */
export function sameIdeology(
  a: string | undefined,
  b: string | undefined,
): boolean {
  const x = ideologyDef(a).id;
  return x !== DEFAULT_IDEOLOGY && x === ideologyDef(b).id;
}

/** Justification cost (thousandths of PP) under an ideology. */
export function justifyCostFor(base: number, ideology?: string): number {
  return Math.floor((base * ideologyDef(ideology).justifyCost) / 1000);
}

/** Weariness gain multiplier, per-mille. */
export function wearinessGainFor(ideology?: string): number {
  return ideologyDef(ideology).wearinessGain;
}

/** War support (per-mille) added to every law's requirement. */
export function lawWarSupportFor(ideology?: string): number {
  return ideologyDef(ideology).lawWarSupport;
}

/**
 * Weariness offset (per-mille) for an AI's peace thresholds; with `other`,
 * the same-ideology bonus for accepting that nation's offer too.
 */
export function aiPeaceBias(ideology?: string, other?: string): number {
  return (
    ideologyDef(ideology).aiPeace -
    (other !== undefined && sameIdeology(ideology, other)
      ? SAME_IDEOLOGY_PEACE
      : 0)
  );
}

/** Extra strength (per-mille) an AI needs to break a truce with `other`. */
export function aiBreakBias(ideology?: string, other?: string): number {
  return (
    ideologyDef(ideology).aiBreak +
    (sameIdeology(ideology, other) ? SAME_IDEOLOGY_BREAK : 0)
  );
}

/** The ideology each AI personality adopts. */
export const AI_IDEOLOGY: Readonly<Record<AiPersonality, IdeologyID>> = {
  militarist: "directorate",
  industrialist: "commune",
  defender: "assembly",
};

/**
 * Grand Strategy: the attacker's troop-loss multiplier, as one capped number
 * with the reasons behind it.
 *
 * Every attack penalty (an equipment shortage, no war goal, out of supply,
 * an oil shortage, war weariness, low war support) multiplies the classic
 * loss. Stacked they could double or triple it, which drained armies far
 * faster than classic OpenFront. So the product is capped at
 * ATTACK_LOSS_CAP, and attacks on bots (early expansion) take none of the
 * penalties, only the bonuses.
 *
 * Deterministic: integer per-mille math only.
 */

import { WEARY_ATTACK_LOSS } from "./GrandStrategyPeace";

/** Most an attack can cost, per-mille of the classic loss (1.5x). */
export const ATTACK_LOSS_CAP = 1500;

/** One reason the attack costs more (positive) or less (negative). */
export interface AttackCostPart {
  /** shortage, unjustified, supply, coalition, oil, weariness, morale,
   * doctrine, defense, artillery, revanche */
  key: string;
  /** The factor, per-mille (1200 = +20%). */
  permille: number;
}

export interface AttackCostInput {
  /** Each factor, per-mille, by key; 1000 = no effect. */
  parts: AttackCostPart[];
  /** The target is a bot: penalties do not apply, bonuses do. */
  vsBot: boolean;
}

export interface AttackCost {
  /** Final multiplier on the classic attacker loss, per-mille. */
  total: number;
  /** Product before the cap and the bot rule. */
  raw: number;
  /** The cap or the bot rule lowered it. */
  limited: boolean;
  /** Parts that change anything, in input order. */
  parts: AttackCostPart[];
}

/** Multiply the parts, then apply the bot rule and the cap. */
export function attackCost(i: AttackCostInput): AttackCost {
  let raw = 1000;
  for (const p of i.parts) {
    raw = Math.floor((raw * Math.max(0, p.permille)) / 1000);
  }
  raw = Math.max(100, raw);
  let total = raw;
  if (i.vsBot) total = Math.min(total, 1000);
  total = Math.min(total, ATTACK_LOSS_CAP);
  return {
    total,
    raw,
    limited: total < raw,
    parts: i.parts.filter((p) => p.permille !== 1000),
  };
}

/** The share of the attack-loss modifier that war weariness adds. */
export function wearinessAttackLoss(wearyPermille: number): number {
  return Math.trunc((wearyPermille * WEARY_ATTACK_LOSS) / 1000);
}

import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { ATTACK_LOSS_CAP } from "@openfront/engine-lib/game/GrandStrategyCombat";
import { REVANCHE_ATTACK_LOSS } from "@openfront/engine-lib/game/GrandStrategyRevanche";
import {
  COALITION_LOSS_PERMILLE,
  OUT_OF_SUPPLY_LOSS_PERMILLE,
  UNJUSTIFIED_LOSS_PERMILLE,
} from "@openfront/engine-lib/game/GrandStrategyWar";

/**
 * Plain-language "why do my attacks cost so many troops": the multiplier on
 * classic losses right now, each reason with its effect, the situational
 * modifiers, and one tip. Pure, so it is unit-tested without a DOM.
 */
export interface AttackCostView {
  /** "1.25x" */
  multiplier: string;
  /** One short sentence for the headline. */
  summary: string;
  /** "Unequipped troops +18%", most costly first. */
  reasons: string[];
  /** Depends on the target: war goal, supply, coalition, claims, bots. */
  situational: string[];
  /** The most useful next step, or "" when nothing costs extra. */
  tip: string;
}

const LABEL: Record<string, string> = {
  shortage: "Unequipped troops",
  doctrine: "Doctrine, focuses and laws",
  weariness: "War weariness",
  morale: "War support",
  oil: "Oil shortage",
  artillery: "Artillery support",
  defense: "Target's defences",
  supply: "Out of supply",
  unjustified: "No war goal",
  coalition: "Coalition target",
  revanche: "Retaking claimed land",
};

const TIP: Record<string, string> = {
  shortage:
    "Build Factories or pick the infantry production line: every troop needs one equipment.",
  weariness:
    "Make peace or pause attacks: weariness fades in peace and raises every loss.",
  morale: "Raise war support (focuses, defending, winning) to cut losses.",
  oil: "Hold oil deposits or free civilian factories to import oil.",
  doctrine: "A different law or doctrine may cut attack losses.",
};

const signed = (permille: number) => {
  const d = Math.round((permille - 1000) / 10);
  return `${d >= 0 ? "+" : "−"}${Math.abs(d)}%`;
};

export function attackCostView(d: GrandStrategyUpdate): AttackCostView | null {
  const c = d.attackCost;
  if (c === undefined) return null;
  const parts = [...c.parts].sort(
    (x, y) => Math.abs(y.permille - 1000) - Math.abs(x.permille - 1000),
  );
  const reasons = parts.map(
    (p) => `${LABEL[p.key] ?? p.key} ${signed(p.permille)}`,
  );
  const multiplier = `${(c.total / 1000).toFixed(2)}x`;
  const summary =
    c.total > 1000
      ? `Your attacks on nations lose ${multiplier} the troops of a classic game.`
      : c.total < 1000
        ? `Your attacks on nations lose only ${multiplier} the troops of a classic game.`
        : "Your attacks on nations cost the same troops as a classic game.";
  const worst = parts.find((p) => p.permille > 1000);
  const situational = [
    `${signed(1000 + UNJUSTIFIED_LOSS_PERMILLE)} without a war goal on the target (War tab: Justify)`,
    `${signed(1000 + OUT_OF_SUPPLY_LOSS_PERMILLE)} when fighting far from your cities, ports and factories`,
    `${signed(1000 + COALITION_LOSS_PERMILLE)} against the coalition target (the runaway leader)`,
    `${signed(1000 + REVANCHE_ATTACK_LOSS)} when retaking land you lost (claims)`,
    `Never more than ${(ATTACK_LOSS_CAP / 1000).toFixed(1)}x in total, and attacks on bots never cost extra`,
  ];
  return {
    multiplier,
    summary,
    reasons,
    situational,
    tip: worst === undefined ? "" : (TIP[worst.key] ?? ""),
  };
}

import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { renderTroops } from "@openfront/engine-lib/Format";
import { FACTORIES_PER_STRUCTURE_LEVEL } from "@openfront/engine-lib/game/GrandStrategy";

/**
 * Plain-language breakdown of the "Army equipped" figure: what feeds the
 * stockpile, what drains it, why the share is falling, and the one thing
 * most worth doing about it. Pure, so it is unit-tested without a DOM.
 */
export interface EquipmentInsight {
  /** Per-second flow lines (made, lost, troop growth, net). */
  flow: string[];
  /** Why the equipped share is low or falling, most important first. */
  reasons: string[];
  /** The single most useful next step. */
  tip: string;
  /** Short status: "rising", "falling", "steady" or "full". */
  trend: "rising" | "falling" | "steady" | "full";
}

const rate = (n: number) =>
  `${n >= 0 ? "+" : "−"}${renderTroops(Math.abs(n))}/s`;

export function equipmentInsight(
  d: GrandStrategyUpdate,
  troops: number,
): EquipmentInsight {
  const f = d.equipmentFlow;
  const unequipped = Math.max(0, Math.floor(troops) - d.equipment);
  if (f === undefined) {
    return {
      flow: [],
      reasons: [],
      tip: "Build Factories to make more equipment.",
      trend: "steady",
    };
  }
  const net = f.produced - f.lost;
  // The equipped share moves with stock vs troops: stock gains `net`,
  // troops gain `troopGrowth`, so the gap closes by net - growth.
  const closing = net - Math.max(0, f.troopGrowth);
  const trend: EquipmentInsight["trend"] =
    unequipped === 0
      ? "full"
      : closing > 0
        ? "rising"
        : closing < 0 || net < 0
          ? "falling"
          : "steady";

  const flow = [
    `Factories make ${rate(f.produced)}`,
    ...(f.lost > 0 ? [`Combat destroys ${rate(-f.lost)}`] : []),
    ...(f.troopGrowth !== 0
      ? [`Troops change ${rate(f.troopGrowth)} (each new troop needs 1)`]
      : []),
    unequipped > 0
      ? `${renderTroops(unequipped)} troops have no equipment`
      : "Every troop is equipped",
  ];

  const reasons: string[] = [];
  if (f.lost > f.produced) {
    reasons.push("Fighting destroys equipment faster than you make it.");
  }
  if (unequipped > 0 && f.troopGrowth > net && f.troopGrowth > 0) {
    reasons.push("Your troops regrow faster than factories can equip them.");
  }
  if (f.steelPermille < 1000) {
    reasons.push(
      `Short of steel: factories run at ${Math.floor(f.steelPermille / 10)}%.`,
    );
  }
  if (d.artilleryShare > 0 && unequipped > 0) {
    reasons.push(
      `${Math.floor(d.artilleryShare / 10)}% of output goes to artillery, not equipment.`,
    );
  }
  if (d.efficiency < 700) {
    reasons.push(
      `Factory efficiency is still ramping up (${Math.floor(d.efficiency / 10)}%).`,
    );
  }
  if (f.atCap) {
    reasons.push("Stockpile is full (2× max troops); extra output is wasted.");
  }

  let tip: string;
  if (unequipped === 0) {
    tip = f.atCap
      ? "Fully stocked. Switch the production line to Mixed or Artillery."
      : "Fully equipped. Spare output builds a reserve for the next war.";
  } else if (f.lost > f.produced) {
    tip = "Pause attacks for a bit so the stockpile can recover.";
  } else if (f.steelPermille < 700) {
    tip = "Get steel: take a steel deposit or build Cities to import it.";
  } else if (d.artilleryShare > 0) {
    tip = "Switch the production line to Infantry until the army is equipped.";
  } else {
    tip = `Build Factories: each level adds ${FACTORIES_PER_STRUCTURE_LEVEL} military factories.`;
  }
  return { flow, reasons, tip, trend };
}

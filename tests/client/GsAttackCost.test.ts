import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { attackCostView } from "../../src/client/hud/layers/gs/GsAttackCost";

const upd = (attackCost?: GrandStrategyUpdate["attackCost"]) =>
  ({ attackCost }) as GrandStrategyUpdate;

describe("attack cost explanation", () => {
  test("absent in old replays", () => {
    expect(attackCostView(upd())).toBeNull();
  });

  test("names each reason, worst first, with a tip for the worst", () => {
    const v = attackCostView(
      upd({
        total: 1260,
        raw: 1260,
        parts: [
          { key: "weariness", permille: 1080 },
          { key: "shortage", permille: 1200 },
          { key: "doctrine", permille: 950 },
        ],
      }),
    )!;
    expect(v.multiplier).toBe("1.26x");
    expect(v.reasons).toEqual([
      "Unequipped troops +20%",
      "War weariness +8%",
      "Doctrine, focuses and laws −5%",
    ]);
    expect(v.tip).toContain("Factories");
    expect(v.situational.some((s) => s.includes("war goal"))).toBe(true);
    expect(v.situational[v.situational.length - 1]).toContain("1.5x");
  });

  test("nothing extra: no tip", () => {
    const v = attackCostView(upd({ total: 1000, raw: 1000, parts: [] }))!;
    expect(v.tip).toBe("");
    expect(v.summary).toContain("same troops");
  });
});

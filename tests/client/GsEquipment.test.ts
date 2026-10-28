import type { GrandStrategyUpdate } from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import { equipmentInsight } from "../../src/client/hud/layers/gs/GsEquipment";

function update(over: Partial<GrandStrategyUpdate> = {}): GrandStrategyUpdate {
  return {
    equipment: 5000,
    efficiency: 800,
    artilleryShare: 0,
    equipmentFlow: {
      produced: 100,
      lost: 0,
      troopGrowth: 0,
      atCap: false,
      steelPermille: 1000,
    },
    ...over,
  } as GrandStrategyUpdate;
}

describe("equipmentInsight", () => {
  it("explains troop regrowth outpacing factories", () => {
    const ins = equipmentInsight(
      update({
        equipmentFlow: {
          produced: 100,
          lost: 0,
          troopGrowth: 400,
          atCap: false,
          steelPermille: 1000,
        },
      }),
      10000,
    );
    expect(ins.trend).toBe("falling");
    expect(ins.reasons.join(" ")).toMatch(/regrow faster/);
    expect(ins.tip).toMatch(/Build Factories/);
  });

  it("blames combat and suggests pausing when losses beat output", () => {
    const ins = equipmentInsight(
      update({
        equipmentFlow: {
          produced: 100,
          lost: 300,
          troopGrowth: 0,
          atCap: false,
          steelPermille: 1000,
        },
      }),
      10000,
    );
    expect(ins.trend).toBe("falling");
    expect(ins.reasons[0]).toMatch(/Fighting/);
    expect(ins.tip).toMatch(/Pause attacks/);
  });

  it("points at steel, then artillery share", () => {
    const steel = equipmentInsight(
      update({
        equipmentFlow: {
          produced: 50,
          lost: 0,
          troopGrowth: 0,
          atCap: false,
          steelPermille: 500,
        },
      }),
      10000,
    );
    expect(steel.reasons.join(" ")).toMatch(/steel/);
    expect(steel.tip).toMatch(/steel/);
    const guns = equipmentInsight(update({ artilleryShare: 500 }), 10000);
    expect(guns.reasons.join(" ")).toMatch(/artillery/);
    expect(guns.tip).toMatch(/Infantry/);
  });

  it("reports full and rising states", () => {
    expect(equipmentInsight(update(), 4000).trend).toBe("full");
    expect(equipmentInsight(update(), 10000).trend).toBe("rising");
    const capped = equipmentInsight(
      update({
        equipmentFlow: {
          produced: 0,
          lost: 0,
          troopGrowth: 0,
          atCap: true,
          steelPermille: 1000,
        },
      }),
      1000,
    );
    expect(capped.tip).toMatch(/Mixed or Artillery/);
  });

  it("degrades gracefully without flow data (old replays)", () => {
    const ins = equipmentInsight(update({ equipmentFlow: undefined }), 10000);
    expect(ins.flow).toEqual([]);
  });
});

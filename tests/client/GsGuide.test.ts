import { GS_GUIDE } from "../../src/client/hud/layers/gs/GsGuide";

describe("grand strategy guide", () => {
  test("every topic is short and says what to do", () => {
    const ids = new Set(GS_GUIDE.map((t) => t.id));
    expect(ids.size).toBe(GS_GUIDE.length);
    for (const t of GS_GUIDE) {
      expect(t.short.split(" ").length).toBeLessThanOrEqual(60);
      expect(t.todo.length).toBeGreaterThan(0);
      expect(t.short).not.toMatch(/NaN|undefined/);
    }
  });

  test("numbers come from the rules", () => {
    const by = (id: string) => GS_GUIDE.find((t) => t.id === id)!.short;
    expect(by("attack")).toContain("1.5x");
    expect(by("equipment")).toContain("50%");
    expect(by("surrender")).toContain("60 s");
    expect(by("puppets")).toContain("50% autonomy");
  });
});

import {
  AdvisorID,
  DecisionID,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  ActionCheck,
  advanceSecond,
  aiChoose,
  aiPersonalityFor,
  attackerLossMultiplier,
  DEFAULT_CONSCRIPTION_LAW,
  DEFAULT_ECONOMY_LAW,
  BASE_WAR_SUPPORT,
  defenderLossMultiplier,
  equippedPermille,
  FocusCheck,
  GsModifiers,
  militaryFactories,
  modifiersOf,
  LawCheck,
  NationGsState,
  newNationState,
  setLaw,
  startFocus,
  takeAction,
  TimedEntry,
  troopCapModifier,
  ZERO_MODIFIERS,
} from "@openfront/engine-lib/game/GrandStrategy";
import { zInt } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type { ExecRecord, SnapshotReader } from "../snapshot/SnapshotContext";

/**
 * The one Grand Strategy execution of a game. Owns every nation's industry,
 * equipment and focus state (keyed by player small id), advances it once a
 * second, and answers combat and income queries from other executions.
 *
 * Bots (map tribes) take no part: they have no state and every query
 * returns the neutral value.
 */
const registry = new WeakMap<Game, GrandStrategyExecution>();

/** The game's Grand Strategy layer, or null when it is not running. */
export function grandStrategyOf(mg: Game): GrandStrategyExecution | null {
  return registry.get(mg) ?? null;
}

export interface CombatAdjustment {
  attackerTroopLoss: number;
  defenderTroopLoss: number;
}

export class GrandStrategyExecution implements Execution {
  private mg: Game | null = null;
  private states = new Map<number, NationGsState>();

  init(mg: Game, _ticks: number): void {
    this.attach(mg);
  }

  private attach(mg: Game): void {
    this.mg = mg;
    registry.set(mg, this);
    // Laws and focuses move the troop cap. Read-only: never creates state.
    mg.config().setTroopCapModifier((p) => {
      if (p.type() === PlayerType.Bot) return 0;
      const s = this.states.get(p.smallID());
      return s === undefined ? 0 : troopCapModifier(s);
    });
  }

  /** State for a participating player, created on first use. */
  stateOf(player: Player): NationGsState | null {
    if (player.type() === PlayerType.Bot) return null;
    let s = this.states.get(player.smallID());
    if (s === undefined) {
      s = newNationState(player.troops());
      this.states.set(player.smallID(), s);
    }
    return s;
  }

  modifiers(player: Player): GsModifiers {
    const s = this.stateOf(player);
    return s === null ? ZERO_MODIFIERS : modifiersOf(s);
  }

  setFocus(player: Player, focusId: string): FocusCheck {
    const s = this.stateOf(player);
    if (s === null) return "unknown";
    return startFocus(s, focusId);
  }

  setLaw(player: Player, lawId: string): LawCheck {
    const s = this.stateOf(player);
    if (s === null) return "unknown";
    return setLaw(s, lawId);
  }

  takeAction(player: Player, id: DecisionID | AdvisorID): ActionCheck {
    const s = this.stateOf(player);
    if (s === null) return "unknown";
    return takeAction(s, id);
  }

  /** Scale troop growth by manpower focuses, never past the troop cap. */
  adjustTroopGrowth(player: Player, base: number, maxTroops: number): number {
    if (base <= 0) return base;
    const m = this.modifiers(player).manpower;
    if (m === 0) return base;
    const scaled = (base * (1000 + m)) / 1000;
    return Math.max(0, Math.min(scaled, maxTroops - player.troops()));
  }

  adjustGold(player: Player, base: bigint): bigint {
    const g = this.modifiers(player).gold;
    if (g === 0) return base;
    const scaled = (base * BigInt(1000 + g)) / 1000n;
    return scaled < 0n ? 0n : scaled;
  }

  /**
   * Apply equipment and doctrine to one conquered tile's losses, and spend
   * the equipment those losses destroy. Player-vs-player only.
   */
  adjustCombat(
    attacker: Player,
    defender: Player,
    attackTroops: number,
    attackerTroopLoss: number,
    defenderTroopLoss: number,
  ): CombatAdjustment {
    const as = this.stateOf(attacker);
    const ds = this.stateOf(defender);
    const aEquipped =
      as === null ? 1000 : equippedPermille(as.equipment, attackTroops);
    const dEquipped =
      ds === null ? 1000 : equippedPermille(ds.equipment, defender.troops());
    const aMult = attackerLossMultiplier(
      aEquipped,
      as === null ? ZERO_MODIFIERS : modifiersOf(as),
      ds === null ? null : modifiersOf(ds),
      as === null ? BASE_WAR_SUPPORT : as.warSupport,
    );
    const dMult = defenderLossMultiplier(dEquipped);
    const aLoss = (attackerTroopLoss * aMult) / 1000;
    const dLoss = (defenderTroopLoss * dMult) / 1000;
    if (as !== null) {
      as.attackLossesThisSecond += Math.floor(aLoss);
      as.equipment = Math.max(
        0,
        as.equipment - Math.floor((aLoss * aEquipped) / 1000),
      );
    }
    if (ds !== null) {
      ds.defendedThisSecond = true;
      ds.equipment = Math.max(
        0,
        ds.equipment - Math.floor((dLoss * dEquipped) / 1000),
      );
    }
    return { attackerTroopLoss: aLoss, defenderTroopLoss: dLoss };
  }

  tick(ticks: number): void {
    if (ticks % 10 !== 0) return; // once per second
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    if (mg.inSpawnPhase()) return;

    for (const p of mg.players()) {
      if (p.type() === PlayerType.Bot) continue;
      const s = this.stateOf(p)!;
      if (p.type() === PlayerType.Nation) {
        const choice = aiChoose(s, aiPersonalityFor(p.smallID()));
        if (choice.focus !== null) startFocus(s, choice.focus);
        if (choice.law !== null) setLaw(s, choice.law);
        if (choice.action !== null) takeAction(s, choice.action);
      }
      const factoryLevels = p
        .units(UnitType.Factory)
        .filter((u) => !u.isUnderConstruction())
        .reduce((a, u) => a + u.level(), 0);
      advanceSecond(s, {
        factoryStructureLevels: factoryLevels,
        tilesOwned: p.numTilesOwned(),
        maxTroops: mg.config().maxTroops(p),
        troops: Math.floor(p.troops()),
      });
      // Only humans have a HUD to feed; nations would only bloat replays.
      if (p.type() !== PlayerType.Human) continue;
      mg.addUpdate({
        type: GameUpdateType.GrandStrategy,
        player: p.id(),
        equipment: s.equipment,
        equipped: equippedPermille(s.equipment, p.troops()),
        efficiency: s.efficiency,
        factories: militaryFactories(factoryLevels, p.numTilesOwned()),
        focus: s.focus,
        focusProgress: s.focusProgress,
        completed: [...s.completed],
        politicalPower: Math.floor(s.politicalPower / 1000),
        warSupport: s.warSupport,
        conscriptionLaw: s.conscriptionLaw,
        economyLaw: s.economyLaw,
        troopCapModifier: troopCapModifier(s),
        advisors: [...s.advisors],
        activeDecisions: copyTimers(s.activeDecisions),
        decisionCooldowns: copyTimers(s.decisionCooldowns),
      });
    }
    // Dead players keep no state.
    for (const id of [...this.states.keys()]) {
      const p = mg.playerBySmallID(id);
      if (!p.isPlayer() || !p.isAlive()) this.states.delete(id);
    }
  }

  isActive(): boolean {
    return true;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  snapshot(): ExecRecord {
    return GrandStrategyExecutionSnapshot.write({
      // Restored instances skip field initializers, so mg can be undefined.
      initialized: this.mg !== null && this.mg !== undefined,
      states: [...this.states.entries()].map(([id, s]) => ({
        id,
        equipment: s.equipment,
        efficiency: s.efficiency,
        focus: s.focus,
        focusProgress: s.focusProgress,
        completed: [...s.completed],
        politicalPower: s.politicalPower,
        warSupport: s.warSupport,
        conscriptionLaw: s.conscriptionLaw,
        economyLaw: s.economyLaw,
        defendedThisSecond: s.defendedThisSecond,
        attackLossesThisSecond: s.attackLossesThisSecond,
        activeDecisions: copyTimers(s.activeDecisions),
        decisionCooldowns: copyTimers(s.decisionCooldowns),
        advisors: [...s.advisors],
      })),
    });
  }

  restoreSnapshot(s: GrandStrategyState, r: SnapshotReader): void {
    this.mg = null;
    this.states = new Map(
      s.states.map((n) => [
        n.id,
        {
          equipment: n.equipment,
          efficiency: n.efficiency,
          focus: n.focus,
          focusProgress: n.focusProgress,
          completed: [...n.completed],
          politicalPower: n.politicalPower,
          warSupport: n.warSupport,
          conscriptionLaw: n.conscriptionLaw,
          economyLaw: n.economyLaw,
          defendedThisSecond: n.defendedThisSecond,
          attackLossesThisSecond: n.attackLossesThisSecond,
          activeDecisions: copyTimers(n.activeDecisions),
          decisionCooldowns: copyTimers(n.decisionCooldowns),
          advisors: [...n.advisors],
        },
      ]),
    );
    if (s.initialized) this.attach(r.game);
  }
}

function copyTimers(list: readonly TimedEntry[]): TimedEntry[] {
  return list.map((e) => ({ id: e.id, seconds: e.seconds }));
}

const TimedEntrySchema = z.object({ id: z.string(), seconds: zInt() });

const GrandStrategyStateSchema = z.object({
  initialized: z.boolean(),
  states: z.array(
    z.object({
      id: zInt(),
      equipment: zInt(),
      efficiency: zInt(),
      focus: z.string().nullable(),
      focusProgress: zInt(),
      completed: z.array(z.string()),
      politicalPower: zInt(),
      warSupport: zInt(),
      conscriptionLaw: z.string(),
      economyLaw: z.string(),
      defendedThisSecond: z.boolean(),
      attackLossesThisSecond: zInt(),
      activeDecisions: z.array(TimedEntrySchema),
      decisionCooldowns: z.array(TimedEntrySchema),
      advisors: z.array(z.string()),
    }),
  ),
});
type GrandStrategyState = z.infer<typeof GrandStrategyStateSchema>;

export const GrandStrategyExecutionSnapshot = execSnapshotType({
  name: "GrandStrategy",
  version: 3,
  schema: GrandStrategyStateSchema,
  migrations: {
    // v3 added decisions and advisors.
    2: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        activeDecisions: [],
        decisionCooldowns: [],
        advisors: [],
      })),
    }),
    // v2 added political power, war support and laws.
    1: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        politicalPower: 0,
        warSupport: BASE_WAR_SUPPORT,
        conscriptionLaw: DEFAULT_CONSCRIPTION_LAW,
        economyLaw: DEFAULT_ECONOMY_LAW,
        defendedThisSecond: false,
        attackLossesThisSecond: 0,
      })),
    }),
  },
  cls: () => GrandStrategyExecution,
});

import { TileRef } from "@openfront/engine-api/game/GameMap";
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
  AI_PP_RESERVE,
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
import {
  addOccupied,
  advanceWarSecond,
  aiJustifyTarget,
  canJustify,
  capitalSupplyRange,
  combinedCapModifier,
  grantDefensiveGoal,
  hasWarGoal,
  JUSTIFY_COST,
  JustifyCheck,
  NationWarState,
  newWarState,
  nextCoalitionLeader,
  occupationCapModifier,
  startJustify,
  supplyRange,
  WarGoal,
  warLossMultiplier,
} from "@openfront/engine-lib/game/GrandStrategyWar";
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
  private wars = new Map<number, NationWarState>();
  /**
   * Turns the M4 war layer (occupation, supply, war goals, coalition) off.
   * Only the balance harness uses it, to measure M4; not saved in snapshots.
   * Absent means on: restored instances skip field initializers.
   */
  private warLayerOff?: boolean;

  get warLayer(): boolean {
    return this.warLayerOff !== true;
  }

  set warLayer(on: boolean) {
    this.warLayerOff = !on;
  }
  /** Small id of the coalition target, if one nation dominates. */
  private coalitionLeader: number | null = null;

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
      if (s === undefined) return 0;
      const w = this.wars.get(p.smallID());
      return w === undefined
        ? troopCapModifier(s)
        : combinedCapModifier(
            troopCapModifier(s),
            w.occupied,
            p.numTilesOwned(),
          );
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

  /** War state (occupation, war goals) for a participating player. */
  warOf(player: Player): NationWarState | null {
    if (player.type() === PlayerType.Bot) return null;
    let w = this.wars.get(player.smallID());
    if (w === undefined) {
      // War state is saved alongside the nation state, so make sure one exists.
      this.stateOf(player);
      w = newWarState();
      this.wars.set(player.smallID(), w);
    }
    return w;
  }

  coalitionLeaderId(): number | null {
    return this.coalitionLeader;
  }

  /** A valid war-goal target: alive, not a bot, not friendly. */
  private validTarget(player: Player, target: Player): boolean {
    return (
      target !== player &&
      target.isAlive() &&
      target.type() !== PlayerType.Bot &&
      !player.isFriendly(target)
    );
  }

  justifyWar(player: Player, target: Player): JustifyCheck {
    const s = this.stateOf(player);
    const w = this.warOf(player);
    if (s === null || w === null) return "invalid_target";
    const check = canJustify(
      w,
      player.smallID(),
      target.smallID(),
      s.politicalPower,
      this.validTarget(player, target),
    );
    if (check === "ok") {
      s.politicalPower -= JUSTIFY_COST;
      startJustify(w, target.smallID());
    }
    return check;
  }

  /** A tile taken from another player starts out occupied. */
  onConquer(attacker: Player, defender: Player, tiles = 1): void {
    if (!this.warLayer) return;
    const w = this.warOf(attacker);
    if (w !== null) addOccupied(w, tiles);
    // Whoever is attacked holds a war goal against the attacker.
    const dw = this.warOf(defender);
    if (dw !== null && attacker.type() !== PlayerType.Bot) {
      grantDefensiveGoal(dw, attacker.smallID());
    }
  }

  /** Whether `tile` is within `player`'s supply (capital, cities, ports, factories). */
  inSupply(player: Player, tile: TileRef): boolean {
    const mg = this.mg;
    if (mg === null) return true;
    const land = mg.numLandTiles();
    const spawn = player.spawnTile();
    if (spawn !== undefined) {
      const r = capitalSupplyRange(land);
      if (mg.euclideanDistSquared(spawn, tile) <= r * r) return true;
    }
    return mg.anyUnitNearby(
      tile,
      supplyRange(land),
      SUPPLY_HUBS,
      () => true,
      player.id(),
    );
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
    tile?: TileRef,
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
    const aw = this.warOf(attacker);
    const warMult =
      aw === null || !this.warLayer
        ? 1000
        : warLossMultiplier({
            targetIsNation: defender.type() !== PlayerType.Bot,
            justified: hasWarGoal(aw, defender.smallID()),
            targetIsCoalitionLeader:
              this.coalitionLeader === defender.smallID(),
            inSupply: tile === undefined || this.inSupply(attacker, tile),
          });
    const aLoss =
      (attackerTroopLoss * Math.floor((aMult * warMult) / 1000)) / 1000;
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

    const players = mg.players();
    this.coalitionLeader = !this.warLayer
      ? null
      : nextCoalitionLeader(
      this.coalitionLeader,
      players
        .filter((p) => p.type() !== PlayerType.Bot)
        .map((p) => ({ id: p.smallID(), tiles: p.numTilesOwned() })),
      mg.numLandTiles(),
    );
    for (const p of players) {
      if (p.type() === PlayerType.Bot) continue;
      const s = this.stateOf(p)!;
      const w = this.warOf(p)!;
      if (p.type() === PlayerType.Nation) {
        if (this.warLayer) this.aiJustify(p, s, w);
        const choice = aiChoose(s, aiPersonalityFor(p.smallID()));
        if (choice.focus !== null) startFocus(s, choice.focus);
        if (choice.law !== null) setLaw(s, choice.law);
        if (choice.action !== null) takeAction(s, choice.action);
      }
      const war = advanceWarSecond(w, p.numTilesOwned());
      if (war.warSupportDelta !== 0) {
        s.warSupport = Math.max(
          0,
          Math.min(1000, s.warSupport + war.warSupportDelta),
        );
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
        occupied: w.occupied,
        occupationModifier: occupationCapModifier(
          w.occupied,
          p.numTilesOwned(),
        ),
        justifying:
          w.justifying === null ? null : this.goalUpdate(mg, w.justifying),
        warGoals: w.warGoals.map((g) => this.goalUpdate(mg, g)),
        justifiedAgainstMe: this.justifiersOf(p.smallID()),
        coalitionLeader:
          this.coalitionLeader === null
            ? null
            : mg.playerBySmallID(this.coalitionLeader).isPlayer()
              ? (mg.playerBySmallID(this.coalitionLeader) as Player).id()
              : null,
      });
    }
    // Dead players keep no state.
    for (const id of [...this.states.keys(), ...this.wars.keys()]) {
      const p = mg.playerBySmallID(id);
      if (!p.isPlayer() || !p.isAlive()) {
        this.states.delete(id);
        this.wars.delete(id);
      }
    }
  }

  private goalUpdate(
    mg: Game,
    g: WarGoal,
  ): { target: string; seconds: number } {
    const t = mg.playerBySmallID(g.target);
    return {
      target: t.isPlayer() ? (t as Player).id() : "",
      seconds: g.seconds,
    };
  }

  /** Ids of players justifying, or holding, a war goal against `smallId`. */
  private justifiersOf(smallId: number): string[] {
    const mg = this.mg!;
    const out: string[] = [];
    for (const [id, w] of this.wars) {
      if (w.justifying?.target === smallId || hasWarGoal(w, smallId)) {
        const p = mg.playerBySmallID(id);
        if (p.isPlayer()) out.push((p as Player).id());
      }
    }
    return out;
  }

  /** AI nations justify against whoever they fight, else their largest neighbour. */
  private aiJustify(p: Player, s: NationGsState, w: NationWarState): void {
    if (w.justifying !== null || s.politicalPower < JUSTIFY_COST) return;
    const attacking = new Set<number>();
    for (const a of p.outgoingAttacks()) {
      const t = a.target();
      if (t.isPlayer()) attacking.add(t.smallID());
    }
    const mg = this.mg!;
    const seen = new Set<number>();
    const nbuf: TileRef[] = [0, 0, 0, 0];
    for (const t of p.borderTiles()) {
      const n = mg.neighbors4(t, nbuf);
      for (let i = 0; i < n; i++) {
        const o = mg.ownerID(nbuf[i]);
        if (o !== 0 && o !== p.smallID()) seen.add(o);
      }
    }
    const candidates = [...seen]
      .sort((x, y) => x - y)
      .map((id) => mg.playerBySmallID(id))
      .filter((n): n is Player => n.isPlayer())
      .filter((n) => this.validTarget(p, n as Player))
      .map((n) => ({
        id: n.smallID(),
        tiles: n.numTilesOwned(),
        attacking: attacking.has(n.smallID()),
      }));
    const urgent = candidates.some((c) => c.attacking && !hasWarGoal(w, c.id));
    // Only justify ahead of time out of spare political power.
    if (!urgent && (w.warGoals.length > 0 || s.politicalPower < AI_PP_RESERVE))
      return;
    const target = aiJustifyTarget(w, candidates);
    if (target === null) return;
    const t = mg.playerBySmallID(target);
    if (t.isPlayer()) this.justifyWar(p, t as Player);
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
        ...warSnapshot(this.wars.get(id)),
      })),
      coalitionLeader: this.coalitionLeader,
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
    this.wars = new Map(
      s.states.map((n) => [
        n.id,
        {
          occupied: n.occupied,
          justifying: n.justifying === null ? null : { ...n.justifying },
          warGoals: n.warGoals.map((g) => ({ ...g })),
        },
      ]),
    );
    this.coalitionLeader = s.coalitionLeader;
    if (s.initialized) this.attach(r.game);
  }
}

const SUPPLY_HUBS: readonly UnitType[] = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
];

function copyTimers(list: readonly TimedEntry[]): TimedEntry[] {
  return list.map((e) => ({ id: e.id, seconds: e.seconds }));
}

function warSnapshot(w: NationWarState | undefined) {
  return {
    occupied: w?.occupied ?? 0,
    justifying: w?.justifying ? { ...w.justifying } : null,
    warGoals: (w?.warGoals ?? []).map((g) => ({ ...g })),
  };
}

const TimedEntrySchema = z.object({ id: z.string(), seconds: zInt() });
const WarGoalSchema = z.object({
  target: zInt(),
  seconds: zInt(),
  defensive: z.boolean().optional(),
});

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
      occupied: zInt(),
      justifying: WarGoalSchema.nullable(),
      warGoals: z.array(WarGoalSchema),
    }),
  ),
  coalitionLeader: zInt().nullable(),
});
type GrandStrategyState = z.infer<typeof GrandStrategyStateSchema>;

export const GrandStrategyExecutionSnapshot = execSnapshotType({
  name: "GrandStrategy",
  version: 4,
  schema: GrandStrategyStateSchema,
  migrations: {
    // v4 added occupation, war goals and the coalition.
    3: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      coalitionLeader: null,
      states: d.states.map((n) => ({
        ...n,
        occupied: 0,
        justifying: null,
        warGoals: [],
      })),
    }),
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

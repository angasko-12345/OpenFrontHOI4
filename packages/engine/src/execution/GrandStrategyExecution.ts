import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GsActionID,
  MessageType,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  GrandStrategyUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import {
  ActionCheck,
  advanceSecond,
  aiProductionLine,
  artilleryLossPermille,
  LINE_SHARE,
  aiChoose,
  AI_PP_RESERVE,
  aiPersonalityFor,
  DEFAULT_CONSCRIPTION_LAW,
  DEFAULT_ECONOMY_LAW,
  BASE_WAR_SUPPORT,
  defenderLossMultiplier,
  equippedPermille,
  shortageLossPermille,
  WAR_SUPPORT_LOSS_SWING,
  STOCKPILE_CAP_MULTIPLE,
  FocusCheck,
  GsModifiers,
  militaryFactories,
  modifiersOf,
  LawCheck,
  NationGsState,
  newNationState,
  PP_CAP,
  setLaw,
  startFocus,
  takeAction,
  TimedEntry,
  troopCapModifier,
  ZERO_MODIFIERS,
} from "@openfront/engine-lib/game/GrandStrategy";
import {
  AttackCost,
  AttackCostPart,
  attackCost,
  wearinessAttackLoss,
} from "@openfront/engine-lib/game/GrandStrategyCombat";
import {
  civGoldPermille,
  civilianFactories,
  depositAt,
  IMPORT_UNITS_PER_CIV,
  oilLossPermille,
  planTrade,
  resourceBalance,
  ResourceBalance,
  steelProductionPermille,
} from "@openfront/engine-lib/game/GrandStrategyEconomy";
import {
  advanceFactionCalls,
  AI_FOUND_SHARE,
  CALL_TO_ARMS_RELATION,
  canFoundFaction,
  canJoinFaction,
  type Faction,
  FACTION_CREATE_PP,
  FACTION_DISSOLVE_SHARE,
  FACTION_AI_PERIOD,
  FACTION_RENEW_TICKS,
  factionCap,
  type FactionCheck,
  factionName,
  factionOf,
  leaveFaction,
  mayCallToArms,
  recordCall,
} from "@openfront/engine-lib/game/GrandStrategyFaction";
import {
  aiBreakBias,
  aiPeaceBias,
  DEFAULT_IDEOLOGY,
  ideologyDef,
  ideologyOfAction,
  justifyCostFor,
  wearinessGainFor,
} from "@openfront/engine-lib/game/GrandStrategyIdeology";
import {
  addOffer,
  addTruce,
  advancePeaceTimers,
  advanceWeariness,
  aiAcceptsPeace,
  aiBreaksTruce,
  aiPeaceTarget,
  BREAK_PP_COST,
  BREAK_WAR_SUPPORT,
  canBreakTruce,
  capitulationTarget,
  enemyEntry,
  hasOffered,
  hasSurrendered,
  OFFER_SECONDS,
  hasTruce,
  longWars,
  losingTo,
  NationPeaceState,
  newPeaceState,
  recordConquest,
  removeTruce,
  TimedTarget,
  truceLockSeconds,
  wearinessPermille,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import {
  addWindow,
  advanceAutonomy,
  advanceWindows,
  aiPrefersPuppet,
  canDeclareIndependence,
  canPuppet,
  INDEPENDENCE_LOCK,
  INDEPENDENCE_PP,
  type IndependenceCheck,
  PUPPET_MAX_PER_OVERLORD,
  PUPPET_MIN_LOST,
  PUPPET_PP,
  type PuppetCheck,
  puppetJoinsWar,
  tributeOf,
  tributePermille,
} from "@openfront/engine-lib/game/GrandStrategyPuppet";
import {
  advanceResearch,
  aiResearch,
  ATOMIC_PROJECT,
  eraOf,
  hasAtomicProject,
  RESEARCH_SLOTS,
  secondsLeft,
  techById,
  techCost,
} from "@openfront/engine-lib/game/GrandStrategyResearch";
import {
  addRevanche,
  advanceRevanche,
  aiSeeksRevanche,
  canRevancheBreak,
  payRevanche,
  RECOVERY_WEARINESS,
  recovering,
  REVANCHE_ATTACK_LOSS,
  REVANCHE_BREAK_PP,
  revancheOf,
  revancheOn,
  revancheWait,
} from "@openfront/engine-lib/game/GrandStrategyRevanche";
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
  OUT_OF_SUPPLY_LOSS_PERMILLE,
  UNJUSTIFIED_LOSS_PERMILLE,
  COALITION_LOSS_PERMILLE,
} from "@openfront/engine-lib/game/GrandStrategyWar";
import { zInt } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type { ExecRecord, SnapshotReader } from "../snapshot/SnapshotContext";
import { cancelNukesBetween } from "./alliance/AllianceRequestExecution";

/**
 * The whole army a stockpile must equip: troops at home plus troops out in
 * every attack (they left p.troops() when the attack launched).
 */
export function armyTroops(p: Player): number {
  let n = Math.floor(p.troops());
  for (const a of p.outgoingAttacks()) n += Math.floor(a.troops());
  return n;
}

/** Seconds the HUD equipment flow averages over. */
const FLOW_WINDOW = 10;

interface EquipmentFlow {
  window: { produced: number; lost: number; growth: number }[];
  lostThisSecond: number;
  troopsBefore: number | null;
}

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

export type PeaceCheck =
  | "offered"
  | "accepted"
  | "already_offered"
  | "not_at_war"
  | "truce"
  | "invalid_target"
  | "disabled"
  | "broken"
  | "no_truce"
  | "locked"
  | "no_political_power";

export interface CombatAdjustment {
  attackerTroopLoss: number;
  defenderTroopLoss: number;
}

export class GrandStrategyExecution implements Execution {
  private mg: Game | null = null;
  private states = new Map<number, NationGsState>();
  /**
   * HUD-only equipment flow per human player: the last ten seconds of
   * production, combat losses and troop growth. Never read by the rules
   * and never snapshotted (optional, so restored executions start empty).
   */
  private flow?: Map<number, EquipmentFlow>;
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

  /**
   * M5 stage B ablation switches for the balance harness, like warLayer:
   * absent = on, never saved. "civgold" = gold from free civilian
   * factories, "trade" = automatic imports, "artillery" = production lines,
   * "research" = M6 research, "atomic" = the M6 stage C nuclear gate
   * (nukes buildable without the atomic project; AI skips the project),
   * "weariness" = M7 stage A (war weariness, capitulation, peace, truces),
   * "ideology" = M7 stage B (no ideology changes; everyone non-aligned),
   * "revanche" = M7C stage 2 (no revanche claims, recovery or revanche
   * breaks), "faction" = M7C stage 3 (no factions), "puppet" = M7 stage D
   * (no puppets).
   */
  private ablated?: Set<string>;

  ablate(
    part:
      | "civgold"
      | "trade"
      | "artillery"
      | "research"
      | "atomic"
      | "weariness"
      | "ideology"
      | "revanche"
      | "faction"
      | "puppet",
  ): void {
    (this.ablated ??= new Set()).add(part);
  }

  private on(part: string): boolean {
    return this.ablated?.has(part) !== true;
  }
  /** M5 deposit tiles, derived from the map (rebuilt after a restore). */
  private steelTiles?: Uint32Array;
  private oilTiles?: Uint32Array;
  /** Small id of the coalition target, if one nation dominates. */
  private coalitionLeader: number | null = null;
  /** M7 stage A: wars, truces, peace offers and peak land, by small id. */
  private peace = new Map<number, NationPeaceState>();
  /** M7C stage 3: factions (absent on restored pre-v13 instances = none). */
  private factions?: Faction[];

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
    // M6 stage C: nuclear weapons wait for the atomic project.
    mg.config().setUnitLock((p, type) => this.nukeLocked(p, type));
    // M7 stage A: truces forbid attacks between the pair. Read-only.
    mg.config().setAttackLock((a, b) => this.truceLocked(a, b));
  }

  /** Whether a truce forbids `a` and `b` from attacking each other. */
  private truceLocked(
    a: { type(): PlayerType; smallID(): number },
    b: { type(): PlayerType; smallID(): number },
  ): boolean {
    if (!this.on("weariness")) return false;
    if (a.type() === PlayerType.Bot || b.type() === PlayerType.Bot) {
      return false;
    }
    const pa = this.peace.get(a.smallID());
    if (pa !== undefined && hasTruce(pa, b.smallID())) return true;
    const pb = this.peace.get(b.smallID());
    if (pb !== undefined && hasTruce(pb, a.smallID())) return true;
    // M7 stage D: a puppet and its overlord never fight.
    return this.bonded(a.smallID(), b.smallID());
  }

  /** Whether one of the two is the other's puppet. */
  private bonded(a: number, b: number): boolean {
    if (!this.puppetsOn()) return false;
    return (
      this.states.get(a)?.overlord === b || this.states.get(b)?.overlord === a
    );
  }

  /**
   * Whether `p` may not build `type` yet: atom bombs, hydrogen bombs and
   * MIRVs before the atomic project. Silos, SAMs and warheads are free.
   * Bots (tribes) never build nukes, so they are left alone. Read-only.
   */
  private nukeLocked(
    p: { type(): PlayerType; smallID(): number },
    type: UnitType,
  ): boolean {
    if (!GATED_NUKES.has(type)) return false;
    if (!this.on("atomic") || !this.on("research")) return false;
    if (p.type() === PlayerType.Bot) return false;
    const s = this.states.get(p.smallID());
    return s === undefined || !hasAtomicProject(s.researched);
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

  /** M7 stage A state (wars, truces, offers) for a participating player. */
  peaceOf(player: Player): NationPeaceState | null {
    if (player.type() === PlayerType.Bot) return null;
    let s = this.peace.get(player.smallID());
    if (s === undefined) {
      this.stateOf(player);
      s = newPeaceState();
      this.peace.set(player.smallID(), s);
    }
    return s;
  }

  /**
   * Offer peace to `target`, or accept its offer. Needs a war between the
   * two (land changed hands lately) and no truce already.
   */
  offerPeace(player: Player, target: Player): PeaceCheck {
    if (!this.on("weariness")) return "disabled";
    if (
      target === player ||
      !target.isAlive() ||
      !player.isAlive() ||
      target.type() === PlayerType.Bot ||
      player.type() === PlayerType.Bot
    ) {
      return "invalid_target";
    }
    const mine = this.peaceOf(player)!;
    const theirs = this.peaceOf(target)!;
    if (
      hasTruce(mine, target.smallID()) ||
      hasTruce(theirs, player.smallID())
    ) {
      return "truce";
    }
    if (hasOffered(theirs, player.smallID())) {
      // Accepting a surrender seals the capitulation; otherwise a peace.
      if (hasSurrendered(theirs, player.smallID())) {
        // The land lost counts from the peak at the surrender.
        const offer = theirs.offers.find((o) => o.target === player.smallID());
        theirs.peakTiles = Math.max(theirs.peakTiles, offer?.peak ?? 0);
        this.makePeace(target, player, "capitulation");
        theirs.peakTiles = target.numTilesOwned();
      } else {
        this.makePeace(player, target, "peace");
      }
      return "accepted";
    }
    if (
      enemyEntry(mine, target.smallID()) === undefined &&
      enemyEntry(theirs, player.smallID()) === undefined
    ) {
      return "not_at_war";
    }
    if (hasOffered(mine, target.smallID())) return "already_offered";
    addOffer(mine, target.smallID());
    if (target.type() === PlayerType.Human) {
      this.mg?.displayMessage(
        "events_display.gs_peace_offered",
        MessageType.GS_DIPLOMACY,
        target.id(),
        undefined,
        { name: player.displayName() },
      );
    }
    return "offered";
  }

  /**
   * Truce between two nations, from a peace deal or a capitulation (`a`
   * capitulates). The minimum lock follows truceLockSeconds.
   */
  private makePeace(a: Player, b: Player, why: "peace" | "capitulation"): void {
    const pa = this.peaceOf(a)!;
    const pb = this.peaceOf(b)!;
    const ea = enemyEntry(pa, b.smallID());
    const eb = enemyEntry(pb, a.smallID());
    const aLost = ea?.lost ?? 0;
    const bLost = eb?.lost ?? 0;
    // The capitulating side lost; in a peace, the side that lost more land
    // (a draw: the smaller side).
    const aLoses =
      why === "capitulation" ||
      aLost > bLost ||
      (aLost === bLost && a.numTilesOwned() <= b.numTilesOwned());
    const [loser, winner, loserState, lost] = aLoses
      ? [a, b, pa, aLost]
      : [b, a, pb, bLost];
    const peak = Math.max(1, loserState.peakTiles, loser.numTilesOwned());
    const lostPermille =
      why === "capitulation"
        ? Math.floor(
            (Math.max(lost, peak - loser.numTilesOwned()) * 1000) / peak,
          )
        : Math.floor((lost * 1000) / peak);
    const lock = truceLockSeconds({
      capitulation: why === "capitulation",
      loserLostPermille: lostPermille,
      loserTiles: loser.numTilesOwned(),
      winnerTiles: winner.numTilesOwned(),
      warSeconds: Math.max(ea?.seconds ?? 0, eb?.seconds ?? 0),
      wearinessA: wearinessPermille(this.states.get(a.smallID())?.weariness),
      wearinessB: wearinessPermille(this.states.get(b.smallID())?.weariness),
    });
    addTruce(pa, a.smallID(), pb, b.smallID(), lock);
    if (this.mg) cancelNukesBetween(this.mg, a, b);
    if (this.on("revanche")) {
      // An older claim never speeds up the break of this new truce: only
      // a claim refreshed by this peace (below) carries this truce's lock.
      for (const r of revancheOf(pa)) if (r.target === b.smallID()) r.lock = 0;
      for (const r of revancheOf(pb)) if (r.target === a.smallID()) r.lock = 0;
      const lostTiles =
        why === "capitulation"
          ? Math.max(lost, peak - loser.numTilesOwned())
          : lost;
      addRevanche(loserState, winner.smallID(), lostTiles, peak, lock);
    }
    if (this.puppetsOn() && lostPermille >= PUPPET_MIN_LOST) {
      this.offerPuppetWindow(winner, loser);
    }
    this.mg?.displayMessage(
      why === "peace"
        ? "events_display.gs_peace_signed"
        : "events_display.gs_capitulated",
      MessageType.GS_DIPLOMACY,
      null,
      undefined,
      {
        name: a.displayName(),
        other: b.displayName(),
        minutes: Math.ceil(lock / 60),
      },
      undefined,
      a.id(),
    );
  }

  /**
   * Break the truce with `target` in its breakable window (its last
   * TRUCE_BREAKABLE_SECONDS): costs political power and war support, marks
   * the breaker a traitor (upstream markTraitor, 30 s) unless the victim
   * already is one, and hands the victim a defensive war goal against the
   * breaker. Told to every player.
   */
  breakTruce(player: Player, target: Player): PeaceCheck {
    if (!this.on("weariness")) return "disabled";
    if (
      target === player ||
      !target.isAlive() ||
      !player.isAlive() ||
      target.type() === PlayerType.Bot ||
      player.type() === PlayerType.Bot
    ) {
      return "invalid_target";
    }
    const mine = this.peaceOf(player)!;
    if (
      this.on("revanche") &&
      canRevancheBreak(mine, target.smallID()) === "ok"
    ) {
      return this.revancheBreak(player, target);
    }
    const check = canBreakTruce(mine, target.smallID());
    if (check !== "ok") return check;
    const s = this.stateOf(player)!;
    if (s.politicalPower < BREAK_PP_COST) return "no_political_power";
    s.politicalPower -= BREAK_PP_COST;
    s.warSupport = Math.max(
      0,
      Math.min(1000, s.warSupport + BREAK_WAR_SUPPORT),
    );
    // Upstream's alliance-betrayal rule: betraying a traitor is not treason.
    if (!target.isTraitor()) player.markTraitor();
    removeTruce(
      mine,
      player.smallID(),
      this.peaceOf(target)!,
      target.smallID(),
    );
    if (this.warLayer)
      grantDefensiveGoal(this.warOf(target)!, player.smallID());
    this.mg?.displayMessage(
      "events_display.gs_truce_broken",
      MessageType.GS_DIPLOMACY,
      null,
      undefined,
      { name: player.displayName(), other: target.displayName() },
      undefined,
      player.id(),
    );
    return "broken";
  }

  /**
   * M7C stage 2: a claimant breaks its truce with the nation that took its
   * land, early and cheaply: REVANCHE_BREAK_PP only, no war-support or
   * weariness cost, no war goal for the old winner; the claimant gets one.
   */
  private revancheBreak(player: Player, target: Player): PeaceCheck {
    const s = this.stateOf(player)!;
    if (s.politicalPower < REVANCHE_BREAK_PP) return "no_political_power";
    s.politicalPower -= REVANCHE_BREAK_PP;
    removeTruce(
      this.peaceOf(player)!,
      player.smallID(),
      this.peaceOf(target)!,
      target.smallID(),
    );
    if (this.warLayer) {
      grantDefensiveGoal(this.warOf(player)!, target.smallID());
    }
    this.mg?.displayMessage(
      "events_display.gs_revanche",
      MessageType.GS_DIPLOMACY,
      null,
      undefined,
      { name: player.displayName(), other: target.displayName() },
      undefined,
      player.id(),
    );
    return "broken";
  }

  // ---- M7C stage 3: factions ----

  private factionsOn(): boolean {
    return (
      this.on("faction") &&
      this.on("ideology") &&
      this.mg !== null &&
      !this.mg.config().disableAlliances()
    );
  }

  factionList(): readonly Faction[] {
    return this.factions ?? [];
  }

  factionOfPlayer(p: Player): Faction | undefined {
    return factionOf(this.factions ?? [], p.smallID());
  }

  private livePlayer(id: number): Player | null {
    const p = this.mg?.playerBySmallID(id);
    return p !== undefined && p.isPlayer() && (p as Player).isAlive()
      ? (p as Player)
      : null;
  }

  /**
   * Land share of a set of small ids, per-mille of the world's land. M7
   * stage D: each id's puppets count with it (puppets are in no faction,
   * so nothing is counted twice).
   */
  private shareOf(ids: readonly number[]): number {
    const mg = this.mg!;
    let tiles = 0;
    for (const id of ids) tiles += this.blocTiles(id);
    return Math.floor((tiles * 1000) / Math.max(1, mg.numLandTiles()));
  }

  /** Land of a nation and its puppets (just its own land if puppets are off). */
  private blocTiles(id: number): number {
    let tiles = this.livePlayer(id)?.numTilesOwned() ?? 0;
    for (const pid of this.puppetsOf(id)) {
      tiles += this.livePlayer(pid)?.numTilesOwned() ?? 0;
    }
    return tiles;
  }

  private nationsAlive(): number {
    return this.mg!.players().filter(
      (p) => p.type() !== PlayerType.Bot && p.isAlive(),
    ).length;
  }

  /** Found a faction (needs an ideology and FACTION_CREATE_PP). */
  foundFaction(player: Player): FactionCheck {
    if (!this.factionsOn()) return "disabled";
    if (player.type() === PlayerType.Bot || !player.isAlive()) {
      return "disabled";
    }
    const s = this.stateOf(player)!;
    if (this.overlordOf(player) !== undefined) return "puppet";
    const check = canFoundFaction({
      ideology: s.ideology,
      politicalPower: s.politicalPower,
      inFaction: this.factionOfPlayer(player) !== undefined,
      share: this.shareOf([player.smallID()]),
      factions: (this.factions ?? []).length,
      nations: this.nationsAlive(),
    });
    if (check !== "ok") return check;
    s.politicalPower -= FACTION_CREATE_PP;
    (this.factions ??= []).push({
      leader: player.smallID(),
      members: [player.smallID()],
      calls: [],
    });
    this.factionMessage("events_display.gs_faction_created", player, player);
    return "ok";
  }

  /** Whether `player` may join the faction led by `leader` now. */
  joinCheck(player: Player, leader: Player): FactionCheck {
    if (!this.factionsOn()) return "disabled";
    const f = (this.factions ?? []).find((x) => x.leader === leader.smallID());
    if (f === undefined) return "no_faction";
    if (player.type() === PlayerType.Bot || !player.isAlive()) {
      return "disabled";
    }
    if (this.overlordOf(player) !== undefined) return "puppet";
    // Joining allies the joiner with every member at once. An AI nation
    // must not force an alliance on a human (e.g. a losing nation switching
    // to the human's ideology to stop the war), so factions with a human
    // member take only humans.
    if (
      player.type() !== PlayerType.Human &&
      f.members.some((m) => this.livePlayer(m)?.type() === PlayerType.Human)
    ) {
      return "invite_only";
    }
    const mine = this.peaceOf(player)!;
    const check = canJoinFaction({
      ideology: this.states.get(player.smallID())?.ideology,
      leaderIdeology: this.states.get(f.leader)?.ideology,
      inFaction: this.factionOfPlayer(player) !== undefined,
      members: f.members.length,
      nations: this.nationsAlive(),
      leaderShare: this.shareOf([f.leader]),
      factionShare: this.shareOf(f.members),
      share: this.shareOf([player.smallID()]),
      atWarWithMember: f.members.some((m) => enemyEntry(mine, m) !== undefined),
    });
    if (check !== "ok") return check;
    for (const m of f.members) {
      const mp = this.livePlayer(m);
      if (mp === null) continue;
      if (!player.isAlliedWith(mp) && !player.canSendAllianceRequest(mp)) {
        return "alliance_blocked";
      }
    }
    return "ok";
  }

  /**
   * Join the faction led by `leader`: forms an upstream alliance with
   * every member that is not an ally yet (request + accept).
   */
  joinFaction(player: Player, leader: Player): FactionCheck {
    const check = this.joinCheck(player, leader);
    if (check !== "ok") return check;
    const f = this.factions!.find((x) => x.leader === leader.smallID())!;
    for (const m of f.members) {
      const mp = this.livePlayer(m);
      if (mp === null || player.isAlliedWith(mp)) continue;
      player.createAllianceRequest(mp)?.accept();
      if (!player.isAlliedWith(mp)) return "alliance_blocked";
      // The same side effects as an accepted upstream alliance request.
      player.updateRelation(mp, 100);
      mp.updateRelation(player, 100);
      if (player.hasEmbargoAgainst(mp)) player.endTemporaryEmbargo(mp);
      if (mp.hasEmbargoAgainst(player)) mp.endTemporaryEmbargo(player);
      if (this.mg) cancelNukesBetween(this.mg, player, mp);
    }
    f.members.push(player.smallID());
    this.factionMessage("events_display.gs_faction_joined", player, leader);
    return "ok";
  }

  /** Leave one's faction (alliances run out on their own; no traitor). */
  leaveFaction(player: Player): FactionCheck {
    if (!this.factionsOn()) return "disabled";
    const f = this.factionOfPlayer(player);
    if (f === undefined) return "no_faction";
    const leader = this.livePlayer(f.leader) ?? player;
    this.factions = leaveFaction(this.factions!, player.smallID());
    this.factionMessage("events_display.gs_faction_left", player, leader);
    return "ok";
  }

  private factionMessage(key: string, p: Player, leader: Player): void {
    this.mg?.displayMessage(
      key,
      MessageType.GS_DIPLOMACY,
      null,
      undefined,
      { name: p.displayName(), faction: factionName(leader.displayName()) },
      undefined,
      p.id(),
    );
  }

  /**
   * A member lost land to an outsider: the rest of its faction gets a war
   * goal on the attacker and turns hostile to it; an AI defender marks it
   * as its target so upstream allies assist. Bounded by mayCallToArms.
   */
  private callToArms(attacker: Player, defender: Player): void {
    const f = this.factionOfPlayer(defender);
    if (f === undefined || f.members.includes(attacker.smallID())) return;
    if (!mayCallToArms(f, attacker.smallID(), this.shareOf(f.members))) return;
    recordCall(f, attacker.smallID());
    for (const m of f.members) {
      if (m === defender.smallID()) continue;
      const mp = this.livePlayer(m);
      if (mp === null) continue;
      if (this.warLayer)
        grantDefensiveGoal(this.warOf(mp)!, attacker.smallID());
      if (mp.type() === PlayerType.Nation) {
        mp.updateRelation(attacker, CALL_TO_ARMS_RELATION);
      }
      if (mp.type() === PlayerType.Human) {
        this.mg?.displayMessage(
          "events_display.gs_call_to_arms",
          MessageType.GS_DIPLOMACY,
          mp.id(),
          undefined,
          { name: defender.displayName(), other: attacker.displayName() },
          undefined,
          defender.id(),
        );
      }
    }
    if (defender.type() === PlayerType.Nation && defender.canTarget(attacker)) {
      defender.target(attacker);
    }
  }

  /**
   * Once a second: drop dead or un-allied members, break up factions that
   * grew too big, renew nation-nation alliances inside a faction, then let
   * AI nations found, join or leave.
   */
  private factionSecond(mg: Game, players: readonly Player[]): void {
    let list = this.factions ?? [];
    for (const f of [...list]) {
      for (const m of [...f.members]) {
        if (this.livePlayer(m) === null) list = leaveFaction(list, m);
      }
    }
    // Every pair must stay allied: the later joiner of a broken pair goes.
    for (const f of [...list]) {
      const cur = list.find((x) => x.leader === f.leader);
      if (cur === undefined) continue;
      for (let j = cur.members.length - 1; j > 0; j--) {
        const pj = this.livePlayer(cur.members[j]);
        if (pj === null) continue;
        const broken = cur.members.slice(0, j).some((m) => {
          const pm = this.livePlayer(m);
          return pm !== null && !pj.isAlliedWith(pm);
        });
        if (broken) {
          list = leaveFaction(list, cur.members[j]);
          this.factions = list;
          this.factionMessage(
            "events_display.gs_faction_left",
            pj,
            this.livePlayer(cur.leader) ?? pj,
          );
          break;
        }
      }
    }
    const land = Math.max(1, mg.numLandTiles());
    for (const f of [...list]) {
      if (this.shareOf(f.members) > FACTION_DISSOLVE_SHARE) {
        const leader = this.livePlayer(f.leader);
        list = list.filter((x) => x !== f);
        if (leader !== null) {
          this.factions = list;
          this.factionMessage(
            "events_display.gs_faction_dissolved",
            leader,
            leader,
          );
        }
      }
    }
    this.factions = list;
    for (const f of list) {
      advanceFactionCalls(f);
      for (let i = 0; i < f.members.length; i++) {
        const a = this.livePlayer(f.members[i]);
        if (a === null || a.type() !== PlayerType.Nation) continue;
        for (let j = i + 1; j < f.members.length; j++) {
          const b = this.livePlayer(f.members[j]);
          if (b === null || b.type() !== PlayerType.Nation) continue;
          const al = a.allianceWith(b);
          if (
            al !== null &&
            al.expiresAt() - mg.ticks() < FACTION_RENEW_TICKS
          ) {
            al.extend();
          }
        }
      }
    }
    const second = Math.floor(mg.ticks() / 10);
    for (const p of players) {
      if (p.type() !== PlayerType.Nation || !p.isAlive()) continue;
      if ((second + p.smallID()) % FACTION_AI_PERIOD !== 0) continue;
      this.aiFaction(p, land);
    }
  }

  /** AI: leave a faction led by the coalition target; else join, else found. */
  private aiFaction(p: Player, land: number): void {
    const f = this.factionOfPlayer(p);
    if (f !== undefined) {
      if (
        this.warLayer &&
        f.leader !== p.smallID() &&
        f.leader === this.coalitionLeader
      ) {
        this.leaveFaction(p);
      }
      return;
    }
    const s = this.stateOf(p)!;
    if (ideologyDef(s.ideology).id === DEFAULT_IDEOLOGY) return;
    const leaders = (this.factions ?? [])
      .map((x) => x.leader)
      .sort((x, y) => x - y);
    for (const id of leaders) {
      const leader = this.livePlayer(id);
      if (leader === null) continue;
      if (this.joinFaction(p, leader) === "ok") return;
    }
    const share = Math.floor((p.numTilesOwned() * 1000) / land);
    if (share >= AI_FOUND_SHARE[aiPersonalityFor(p.smallID())]) {
      this.foundFaction(p);
    }
  }

  /** HUD view of factions: ours, and the ones we could join. */
  private factionUpdate(p: Player) {
    if (!this.factionsOn()) return {};
    const mg = this.mg!;
    const idOf = (small: number) => {
      const t = mg.playerBySmallID(small);
      return t.isPlayer() ? (t as Player).id() : "";
    };
    const mine = this.factionOfPlayer(p);
    const nations = this.nationsAlive();
    return {
      faction:
        mine === undefined
          ? null
          : {
              leader: idOf(mine.leader),
              members: mine.members.map(idOf),
              cap: factionCap(nations),
              share: this.shareOf(mine.members),
            },
      factions: [...(this.factions ?? [])]
        .sort((x, y) => x.leader - y.leader)
        .map((x) => {
          const leader = this.livePlayer(x.leader);
          return {
            leader: idOf(x.leader),
            ideology: ideologyDef(this.states.get(x.leader)?.ideology).id,
            members: x.members.length,
            share: this.shareOf(x.members),
            join:
              mine !== undefined || leader === null
                ? ("in_faction" as FactionCheck)
                : this.joinCheck(p, leader),
          };
        }),
      canFound:
        this.overlordOf(p) !== undefined
          ? ("puppet" as FactionCheck)
          : canFoundFaction({
              ideology: this.states.get(p.smallID())?.ideology,
              politicalPower: this.states.get(p.smallID())?.politicalPower ?? 0,
              inFaction: mine !== undefined,
              share: this.shareOf([p.smallID()]),
              factions: (this.factions ?? []).length,
              nations,
            }),
    };
  }

  // ---- M7 stage D: puppets ----

  private puppetsOn(): boolean {
    return this.on("puppet") && this.on("weariness");
  }

  /** Small id of `p`'s overlord while it is a puppet. */
  overlordOf(p: Player): number | undefined {
    if (!this.puppetsOn() || p.type() === PlayerType.Bot) return undefined;
    return this.states.get(p.smallID())?.overlord;
  }

  /** Small ids of the puppets of `id`, ascending. */
  puppetsOf(id: number): number[] {
    if (!this.puppetsOn()) return [];
    const out: number[] = [];
    for (const [pid, s] of this.states) {
      if (s.overlord === id) out.push(pid);
    }
    return out.sort((x, y) => x - y);
  }

  /**
   * A won peace or capitulation: the winner may puppet the loser for
   * PUPPET_WINDOW seconds. An AI winner decides at once by personality;
   * a human winner is told and decides in the War tab.
   */
  private offerPuppetWindow(winner: Player, loser: Player): void {
    const ws = this.stateOf(winner);
    if (ws === null) return;
    ws.puppetWindows = addWindow(ws.puppetWindows ?? [], loser.smallID());
    if (winner.type() === PlayerType.Nation) {
      if (
        aiPrefersPuppet(
          aiPersonalityFor(winner.smallID()),
          loser.numTilesOwned(),
          winner.numTilesOwned(),
        )
      ) {
        this.demandPuppet(winner, loser);
      }
    } else if (
      winner.type() === PlayerType.Human &&
      this.puppetCheck(winner, loser) === "ok"
    ) {
      this.mg?.displayMessage(
        "events_display.gs_puppet_window",
        MessageType.GS_DIPLOMACY,
        winner.id(),
        undefined,
        { name: loser.displayName() },
      );
    }
  }

  /** Whether `player` may puppet `target` now. */
  puppetCheck(player: Player, target: Player): PuppetCheck {
    if (!this.puppetsOn()) return "disabled";
    if (
      target === player ||
      !target.isAlive() ||
      !player.isAlive() ||
      target.type() === PlayerType.Bot ||
      player.type() === PlayerType.Bot
    ) {
      return "invalid_target";
    }
    const s = this.stateOf(player)!;
    const land = Math.max(1, this.mg!.numLandTiles());
    return canPuppet({
      demanderIsPuppet: s.overlord !== undefined,
      targetIsPuppet: this.states.get(target.smallID())?.overlord !== undefined,
      window: (s.puppetWindows ?? []).some(
        (w) => w.target === target.smallID(),
      ),
      demanderTiles: player.numTilesOwned(),
      targetTiles: target.numTilesOwned(),
      puppets: this.puppetsOf(player.smallID()).length,
      blocShare: this.shareOf([player.smallID()]),
      targetShare: Math.floor((this.blocTiles(target.smallID()) * 1000) / land),
      politicalPower: s.politicalPower,
    });
  }

  /**
   * Make the beaten `target` our puppet (PUPPET_PP): the truce, its
   * revanche claim on us, war goals between us and its faction seat go;
   * its own puppets are released (no chains).
   */
  demandPuppet(player: Player, target: Player): PuppetCheck {
    const check = this.puppetCheck(player, target);
    if (check !== "ok") return check;
    const s = this.stateOf(player)!;
    const ts = this.stateOf(target)!;
    const o = player.smallID();
    const t = target.smallID();
    s.politicalPower -= PUPPET_PP;
    s.puppetWindows = (s.puppetWindows ?? []).filter((w) => w.target !== t);
    for (const sub of this.puppetsOf(t)) {
      const sp = this.livePlayer(sub);
      if (sp !== null)
        this.endBond(sp, target, "events_display.gs_puppet_released");
    }
    const po = this.peaceOf(player)!;
    const pt = this.peaceOf(target)!;
    removeTruce(po, o, pt, t);
    for (const [ps, other] of [
      [po, t],
      [pt, o],
    ] as const) {
      ps.enemies = ps.enemies.filter((e) => e.target !== other);
      ps.offers = ps.offers.filter((x) => x.target !== other);
      if (ps.revanche !== undefined) {
        ps.revanche = ps.revanche.filter((r) => r.target !== other);
      }
    }
    for (const [w, other] of [
      [this.warOf(player)!, t],
      [this.warOf(target)!, o],
    ] as const) {
      w.warGoals = w.warGoals.filter((g) => g.target !== other);
      if (w.justifying?.target === other) w.justifying = null;
    }
    if (this.factionOfPlayer(target) !== undefined) {
      const f = this.factionOfPlayer(target)!;
      const leader = this.livePlayer(f.leader) ?? target;
      this.factions = leaveFaction(this.factions!, t);
      this.factionMessage("events_display.gs_faction_left", target, leader);
    }
    ts.overlord = o;
    ts.autonomy = 0;
    ts.puppetWindows = [];
    if (this.mg) cancelNukesBetween(this.mg, player, target);
    this.mg?.displayMessage(
      "events_display.gs_puppet_created",
      MessageType.GS_DIPLOMACY,
      null,
      undefined,
      { name: target.displayName(), other: player.displayName() },
      undefined,
      target.id(),
    );
    return "ok";
  }

  /** The overlord sets its puppet free (truce INDEPENDENCE_LOCK seconds). */
  releasePuppet(player: Player, target: Player): PuppetCheck {
    if (!this.puppetsOn()) return "disabled";
    if (this.overlordOf(target) !== player.smallID() || !player.isAlive()) {
      return "invalid_target";
    }
    this.endBond(target, player, "events_display.gs_puppet_released");
    return "ok";
  }

  /** Whether `player` (a puppet) may declare independence now. */
  independenceCheck(player: Player): IndependenceCheck {
    if (!this.puppetsOn()) return "disabled";
    const s = this.states.get(player.smallID());
    const o = s?.overlord === undefined ? null : this.livePlayer(s.overlord);
    if (s === undefined || o === null) return "not_puppet";
    return canDeclareIndependence({
      isPuppet: true,
      autonomy: s.autonomy ?? 0,
      overlordWeariness: wearinessPermille(
        this.states.get(o.smallID())?.weariness,
      ),
      puppetTroops: armyTroops(player),
      overlordTroops: armyTroops(o),
      politicalPower: s.politicalPower,
    });
  }

  /** A puppet breaks free (INDEPENDENCE_PP; truce INDEPENDENCE_LOCK). */
  declareIndependence(player: Player): IndependenceCheck {
    const check = this.independenceCheck(player);
    if (check !== "ok") return check;
    const s = this.states.get(player.smallID())!;
    const o = this.livePlayer(s.overlord!)!;
    s.politicalPower -= INDEPENDENCE_PP;
    this.endBond(player, o, "events_display.gs_puppet_independent");
    return "ok";
  }

  /**
   * End a puppet bond. With both alive: a truce locked INDEPENDENCE_LOCK
   * seconds and a world message; a dead overlord just frees the puppet.
   */
  private endBond(puppet: Player, overlord: Player, key: string | null): void {
    const s = this.states.get(puppet.smallID());
    if (s === undefined) return;
    delete s.overlord;
    s.autonomy = 0;
    if (key === null || !overlord.isAlive() || !puppet.isAlive()) return;
    addTruce(
      this.peaceOf(puppet)!,
      puppet.smallID(),
      this.peaceOf(overlord)!,
      overlord.smallID(),
      INDEPENDENCE_LOCK,
    );
    this.mg?.displayMessage(
      key,
      MessageType.GS_DIPLOMACY,
      null,
      undefined,
      {
        name: puppet.displayName(),
        other: overlord.displayName(),
        minutes: Math.ceil(INDEPENDENCE_LOCK / 60),
      },
      undefined,
      puppet.id(),
    );
  }

  /** Tribute share `p` pays this moment, with the overlord receiving it. */
  private tributeTo(p: Player): { overlord: Player; permille: number } | null {
    if (!this.puppetsOn() || p.type() === PlayerType.Bot) return null;
    const s = this.states.get(p.smallID());
    if (s?.overlord === undefined) return null;
    const o = this.livePlayer(s.overlord);
    if (o === null) return null;
    const permille = tributePermille(
      this.shareOf([s.overlord]),
      s.autonomy ?? 0,
    );
    return permille > 0 ? { overlord: o, permille } : null;
  }

  /**
   * Once a second after the diplomacy pass: count puppet windows down,
   * free puppets whose overlord is gone, build autonomy, and let AI
   * puppets break free when they may.
   */
  private puppetSecond(players: readonly Player[]): void {
    const coalition = this.warLayer ? this.coalitionLeader : null;
    for (const p of players) {
      if (p.type() === PlayerType.Bot || !p.isAlive()) continue;
      const s = this.states.get(p.smallID());
      if (s === undefined) continue;
      if ((s.puppetWindows ?? []).length > 0) {
        s.puppetWindows = advanceWindows(s.puppetWindows!);
      }
      if (s.overlord === undefined) continue;
      const o = this.livePlayer(s.overlord);
      if (o === null || this.states.get(s.overlord)?.overlord !== undefined) {
        this.endBond(p, o ?? p, null);
        continue;
      }
      s.autonomy = advanceAutonomy(s.autonomy ?? 0, {
        overlordWeariness: wearinessPermille(
          this.states.get(s.overlord)?.weariness,
        ),
        overlordIsCoalitionTarget: coalition === s.overlord,
        puppetTiles: p.numTilesOwned(),
        overlordTiles: o.numTilesOwned(),
      });
      if (
        p.type() === PlayerType.Nation &&
        this.independenceCheck(p) === "ok"
      ) {
        this.declareIndependence(p);
      }
    }
  }

  /**
   * Land changed hands between two nations: the overlord protects a
   * puppet that is attacked (defensive war goal), and an overlord's
   * puppets join its war against the other side (defensive war goal and,
   * for AI puppets, hostility), bounded by puppetJoinsWar. Needs the war
   * layer: the held goal is what keeps a puppet from joining twice.
   */
  private puppetWars(attacker: Player, defender: Player): void {
    if (!this.warLayer) return;
    const ds = this.states.get(defender.smallID());
    if (ds?.overlord !== undefined && ds.overlord !== attacker.smallID()) {
      const o = this.livePlayer(ds.overlord);
      if (o !== null) {
        const ow = this.warOf(o)!;
        if (!hasWarGoal(ow, attacker.smallID())) {
          grantDefensiveGoal(ow, attacker.smallID());
        }
      }
    }
    for (const [overlord, enemy] of [
      [attacker, defender],
      [defender, attacker],
    ] as const) {
      for (const pid of this.puppetsOf(overlord.smallID())) {
        if (pid === enemy.smallID()) continue;
        const pp = this.livePlayer(pid);
        if (pp === null) continue;
        const pw = this.warOf(pp)!;
        const join = puppetJoinsWar({
          weariness: wearinessPermille(this.states.get(pid)?.weariness),
          wars: this.peace.get(pid)?.enemies.length ?? 0,
          blocked:
            hasWarGoal(pw, enemy.smallID()) || this.truceLocked(pp, enemy),
        });
        if (!join) continue;
        grantDefensiveGoal(pw, enemy.smallID());
        if (pp.type() === PlayerType.Nation) {
          pp.updateRelation(enemy, CALL_TO_ARMS_RELATION);
        } else if (pp.type() === PlayerType.Human) {
          this.mg?.displayMessage(
            "events_display.gs_puppet_war",
            MessageType.GS_DIPLOMACY,
            pp.id(),
            undefined,
            { name: enemy.displayName(), other: overlord.displayName() },
          );
        }
      }
    }
  }

  /** HUD view of our puppet bonds. */
  private puppetUpdate(p: Player) {
    if (!this.puppetsOn()) return {};
    const mg = this.mg!;
    const idOf = (small: number) => {
      const t = mg.playerBySmallID(small);
      return t.isPlayer() ? (t as Player).id() : "";
    };
    const s = this.states.get(p.smallID());
    const mine = this.tributeTo(p);
    return {
      overlord: s?.overlord === undefined ? null : idOf(s.overlord),
      autonomy: s?.autonomy ?? 0,
      tribute: mine?.permille ?? 0,
      independence: this.independenceCheck(p) as string,
      puppets: this.puppetsOf(p.smallID()).map((id) => {
        const pp = this.livePlayer(id);
        return {
          id: idOf(id),
          autonomy: this.states.get(id)?.autonomy ?? 0,
          tribute: pp === null ? 0 : (this.tributeTo(pp)?.permille ?? 0),
        };
      }),
      puppetCap: PUPPET_MAX_PER_OVERLORD,
      puppetWindows: (s?.puppetWindows ?? []).map((w) => {
        const t = this.livePlayer(w.target);
        return {
          target: idOf(w.target),
          seconds: w.seconds,
          check:
            t === null
              ? ("invalid_target" as PuppetCheck)
              : this.puppetCheck(p, t),
        };
      }),
    };
  }

  /** Coalition size of a nation: its bloc; a puppet counts for nothing. */
  private coalitionTiles(p: Player): number {
    if (!this.puppetsOn()) return p.numTilesOwned();
    if (this.states.get(p.smallID())?.overlord !== undefined) return 0;
    return p.isAlive() ? this.blocTiles(p.smallID()) : p.numTilesOwned();
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
      !player.isFriendly(target) &&
      !this.bonded(player.smallID(), target.smallID())
    );
  }

  justifyWar(player: Player, target: Player): JustifyCheck {
    const s = this.stateOf(player);
    const w = this.warOf(player);
    if (s === null || w === null) return "invalid_target";
    const cost = this.on("ideology")
      ? justifyCostFor(JUSTIFY_COST, s.ideology)
      : JUSTIFY_COST;
    const check = canJustify(
      w,
      player.smallID(),
      target.smallID(),
      s.politicalPower,
      this.validTarget(player, target),
      cost,
    );
    if (check === "ok") {
      s.politicalPower -= cost;
      startJustify(w, target.smallID());
    }
    return check;
  }

  /** A tile taken from another player starts out occupied. */
  onConquer(attacker: Player, defender: Player, tiles = 1): void {
    if (
      this.on("weariness") &&
      attacker.type() !== PlayerType.Bot &&
      defender.type() !== PlayerType.Bot
    ) {
      recordConquest(
        this.peaceOf(attacker)!,
        attacker.smallID(),
        this.peaceOf(defender)!,
        defender.smallID(),
        tiles,
      );
      if (this.on("revanche")) {
        payRevanche(this.peaceOf(attacker)!, defender.smallID(), tiles);
      }
    }
    if (
      this.factionsOn() &&
      attacker.type() !== PlayerType.Bot &&
      defender.type() !== PlayerType.Bot
    ) {
      this.callToArms(attacker, defender);
    }
    if (
      this.puppetsOn() &&
      attacker.type() !== PlayerType.Bot &&
      defender.type() !== PlayerType.Bot
    ) {
      this.puppetWars(attacker, defender);
    }
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

  takeAction(player: Player, id: GsActionID): ActionCheck {
    const s = this.stateOf(player);
    if (s === null) return "unknown";
    const ideology = ideologyOfAction(id);
    if (ideology !== null && !this.on("ideology")) return "unavailable";
    const check = takeAction(s, id);
    if (check === "ok" && id === ATOMIC_PROJECT) {
      this.announceAtomic(player, "events_display.atomic_project_started");
    }
    if (check === "ok" && ideology !== null) {
      this.mg?.displayMessage(
        "events_display.gs_ideology_changed",
        MessageType.GS_DIPLOMACY,
        null,
        undefined,
        { name: player.displayName(), ideology: ideologyDef(ideology).name },
        undefined,
        player.id(),
      );
    }
    return check;
  }

  /** Tell every player a nation started or finished its atomic project. */
  private announceAtomic(player: Player, key: string): void {
    this.mg?.displayMessage(
      key,
      MessageType.ATOMIC_PROJECT,
      null,
      undefined,
      { name: player.displayName() },
      undefined,
      player.id(),
    );
  }

  /** Scale troop growth by manpower focuses, never past the troop cap. */
  adjustTroopGrowth(player: Player, base: number, maxTroops: number): number {
    if (base <= 0) return base;
    const m = this.modifiers(player).manpower;
    const grown =
      m === 0
        ? base
        : Math.max(
            0,
            Math.min((base * (1000 + m)) / 1000, maxTroops - player.troops()),
          );
    // M7 stage D: a puppet hands a share of its new manpower to its
    // overlord, as far as the overlord's troop cap has room.
    const t = this.tributeTo(player);
    if (t === null) return grown;
    const o = t.overlord;
    const room = Math.max(
      0,
      Math.floor(this.mg!.config().maxTroops(o) - o.troops()),
    );
    const give = Math.min(tributeOf(Math.floor(grown), t.permille), room);
    if (give <= 0) return grown;
    o.addTroops(give);
    return grown - give;
  }

  adjustGold(player: Player, base: bigint): bigint {
    const s = this.stateOf(player);
    const g =
      this.modifiers(player).gold +
      (s === null || !this.on("civgold")
        ? 0
        : civGoldPermille(freeCivFactories(s)));
    let scaled = g === 0 ? base : (base * BigInt(1000 + g)) / 1000n;
    if (scaled < 0n) scaled = 0n;
    // M7 stage D: a puppet pays a share of its gold income to its overlord.
    const t = this.tributeTo(player);
    if (t === null || scaled <= 0n) return scaled;
    const give = (scaled * BigInt(t.permille)) / 1000n;
    if (give <= 0n) return scaled;
    t.overlord.addGold(give);
    return scaled - give;
  }

  /** Record equipment a human lost in combat, for the HUD flow. */
  private noteLost(p: Player, amount: number): void {
    if (amount <= 0 || p.type() !== PlayerType.Human) return;
    const f = this.flowOf(p);
    f.lostThisSecond += amount;
  }

  private flowOf(p: Player): EquipmentFlow {
    this.flow ??= new Map();
    let f = this.flow.get(p.smallID());
    if (f === undefined) {
      f = { window: [], lostThisSecond: 0, troopsBefore: null };
      this.flow.set(p.smallID(), f);
    }
    return f;
  }

  /**
   * Close one second of a human's equipment flow and return the ten-second
   * averages per second: produced, lost in combat, and troop growth.
   */
  private flowSecond(
    p: Player,
    produced: number,
  ): { produced: number; lost: number; troopGrowth: number } {
    const f = this.flowOf(p);
    const troops = Math.floor(p.troops());
    const growth = f.troopsBefore === null ? 0 : troops - f.troopsBefore;
    f.troopsBefore = troops;
    f.window.push({ produced, lost: f.lostThisSecond, growth });
    f.lostThisSecond = 0;
    if (f.window.length > FLOW_WINDOW) f.window.shift();
    const n = f.window.length;
    const sum = (k: "produced" | "lost" | "growth") =>
      f.window.reduce((a, e) => a + e[k], 0);
    return {
      produced: Math.floor(sum("produced") / n),
      lost: Math.floor(sum("lost") / n),
      troopGrowth: Math.trunc(sum("growth") / n),
    };
  }

  /**
   * The attacker's loss multiplier against `defender` with its reasons
   * (GrandStrategyCombat): equipment, doctrine, weariness, war support,
   * war goal, supply, coalition, oil, artillery, revanche. Capped at 1.5x;
   * bots take no penalties. `defender` null = a justified nation target
   * in supply (the HUD preview).
   */
  attackCostOf(
    attacker: Player,
    defender: Player | null,
    aEquipped: number,
    aGuns: number,
    tile?: TileRef,
  ): AttackCost {
    const as = this.stateOf(attacker);
    const ds = defender === null ? null : this.stateOf(defender);
    const parts: AttackCostPart[] = [];
    if (as !== null) {
      const mods = modifiersOf(as);
      const weary = this.on("weariness")
        ? wearinessAttackLoss(wearinessPermille(as.weariness))
        : 0;
      parts.push({
        key: "shortage",
        permille: shortageLossPermille(aEquipped),
      });
      parts.push({
        key: "doctrine",
        permille: Math.max(100, 1000 + mods.attackLoss - weary),
      });
      parts.push({ key: "weariness", permille: 1000 + weary });
      parts.push({
        key: "morale",
        permille:
          1000 +
          Math.trunc(
            ((BASE_WAR_SUPPORT - Math.max(0, Math.min(1000, as.warSupport))) *
              WAR_SUPPORT_LOSS_SWING) /
              BASE_WAR_SUPPORT,
          ),
      });
      parts.push({ key: "oil", permille: oilLossPermille(balanceOf(as)) });
      parts.push({ key: "artillery", permille: artilleryLossPermille(aGuns) });
    }
    if (ds !== null) {
      parts.push({
        key: "defense",
        permille: Math.max(0, 1000 + modifiersOf(ds).defense),
      });
    }
    const aw = this.warOf(attacker);
    const vsBot = defender !== null && defender.type() === PlayerType.Bot;
    if (aw !== null && this.warLayer && defender !== null) {
      if (tile !== undefined && !this.inSupply(attacker, tile)) {
        parts.push({
          key: "supply",
          permille: 1000 + OUT_OF_SUPPLY_LOSS_PERMILLE,
        });
      }
      if (!vsBot) {
        if (this.coalitionLeader === defender.smallID()) {
          parts.push({
            key: "coalition",
            permille: 1000 + COALITION_LOSS_PERMILLE,
          });
        } else if (!hasWarGoal(aw, defender.smallID())) {
          parts.push({
            key: "unjustified",
            permille: 1000 + UNJUSTIFIED_LOSS_PERMILLE,
          });
        }
      }
    }
    if (
      as !== null &&
      defender !== null &&
      !vsBot &&
      this.on("weariness") &&
      this.on("revanche")
    ) {
      const ap = this.peace.get(attacker.smallID());
      if (ap !== undefined && revancheOn(ap, defender.smallID())) {
        parts.push({ key: "revanche", permille: 1000 + REVANCHE_ATTACK_LOSS });
      }
    }
    return attackCost({ parts, vsBot });
  }

  /**
   * HUD: what an attack on a justified nation target in supply costs now,
   * per-mille of classic, with its reasons. HUD-only, never snapshotted.
   */
  private attackCostPreview(p: Player, s: NationGsState) {
    const army = armyTroops(p);
    const c = this.attackCostOf(
      p,
      null,
      equippedPermille(s.equipment, army),
      this.on("artillery") ? equippedPermille(s.artillery, army) : 0,
    );
    return { total: c.total, raw: c.raw, parts: c.parts };
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
    // One stockpile equips the whole army (home plus every attack), so
    // splitting an attack into several cannot dodge a shortage.
    const aArmy = Math.max(armyTroops(attacker), Math.floor(attackTroops));
    const aEquipped =
      as === null ? 1000 : equippedPermille(as.equipment, aArmy);
    const dEquipped =
      ds === null ? 1000 : equippedPermille(ds.equipment, armyTroops(defender));
    const dMult = defenderLossMultiplier(dEquipped);
    const aGuns =
      as === null || !this.on("artillery")
        ? 0
        : equippedPermille(as.artillery, aArmy);
    const cost = this.attackCostOf(attacker, defender, aEquipped, aGuns, tile);
    const aLoss = (attackerTroopLoss * cost.total) / 1000;
    const dLoss = (defenderTroopLoss * dMult) / 1000;
    if (
      as !== null &&
      defender.type() !== PlayerType.Bot &&
      this.on("weariness")
    ) {
      this.peaceOf(attacker)!.lossesThisSecond += Math.floor(aLoss);
    }
    if (as !== null) {
      as.attackLossesThisSecond += Math.floor(aLoss);
      const spent = Math.min(
        as.equipment,
        Math.floor((aLoss * aEquipped) / 1000),
      );
      as.equipment -= spent;
      this.noteLost(attacker, spent);
      as.artillery = Math.max(
        0,
        as.artillery - Math.floor((aLoss * aGuns) / 1000),
      );
    }
    if (ds !== null) {
      ds.defendedThisSecond = true;
      const spent = Math.min(
        ds.equipment,
        Math.floor((dLoss * dEquipped) / 1000),
      );
      ds.equipment -= spent;
      this.noteLost(defender, spent);
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
            .map((p) => ({ id: p.smallID(), tiles: this.coalitionTiles(p) })),
          mg.numLandTiles(),
        );
    const held = this.countDeposits(mg);
    // Filled in after the per-player loop, then sent with each human update.
    const humanUpdates: GrandStrategyUpdate[] = [];
    const knownBy = this.on("research") ? this.techSpread(players) : () => 0;
    if (this.on("weariness")) this.diplomacySecond(mg, players);
    if (this.factionsOn()) this.factionSecond(mg, players);
    if (this.puppetsOn()) this.puppetSecond(players);
    for (const p of players) {
      if (p.type() === PlayerType.Bot) continue;
      const s = this.stateOf(p)!;
      const w = this.warOf(p)!;
      if (p.type() === PlayerType.Nation) {
        if (this.warLayer) this.aiJustify(p, s, w);
        const choice = aiChoose(
          s,
          aiPersonalityFor(p.smallID()),
          this.on("ideology"),
        );
        if (choice.focus !== null) startFocus(s, choice.focus);
        if (choice.law !== null) setLaw(s, choice.law);
        if (choice.action !== null) this.takeAction(p, choice.action);
        if (this.on("research")) {
          // Fill free slots; bounded so a rule bug can never spin forever.
          for (let i = 0; i < RESEARCH_SLOTS; i++) {
            const next = aiResearch(
              s,
              aiPersonalityFor(p.smallID()),
              !this.on("atomic"),
            );
            if (
              next === null ||
              this.takeAction(p, next as GsActionID) !== "ok"
            )
              break;
          }
        }
      }
      if (this.on("research")) {
        const done = advanceResearch(s, knownBy);
        if (done.includes(ATOMIC_PROJECT)) {
          this.announceAtomic(p, "events_display.atomic_project_completed");
        }
      } else {
        s.research = [];
        s.researched = [];
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
      const h = held.get(p.smallID());
      s.steelDeposits = h?.steel ?? 0;
      s.oilDeposits = h?.oil ?? 0;
      s.milFactories = militaryFactories(factoryLevels, p.numTilesOwned());
      if (p.type() === PlayerType.Nation) {
        s.artilleryShare = this.on("artillery")
          ? (LINE_SHARE[
              aiProductionLine(
                s,
                aiPersonalityFor(p.smallID()),
                mg.config().maxTroops(p),
              )
            ] ?? 0)
          : 0;
      }
      const cityLevels = p
        .units(UnitType.City)
        .filter((u) => !u.isUnderConstruction())
        .reduce((a, u) => a + u.level(), 0);
      s.civFactories = civilianFactories(
        cityLevels,
        p.numTilesOwned(),
        s.economyLaw,
      );
      const trade = planTrade(
        resourceBalance(s.steelDeposits, s.oilDeposits, s.milFactories),
        s.civFactories,
      );
      s.importSteel = this.on("trade") ? trade.steel : 0;
      s.importOil = this.on("trade") ? trade.oil : 0;
      const res = balanceOf(s);
      const ppBefore = s.politicalPower;
      const made = advanceSecond(s, {
        factoryStructureLevels: factoryLevels,
        tilesOwned: p.numTilesOwned(),
        maxTroops: mg.config().maxTroops(p),
        troops: Math.floor(p.troops()),
        productionPermille: steelProductionPermille(res),
      });
      // M7 stage D: a puppet pays a share of this second's political power.
      const ppTribute = this.tributeTo(p);
      if (ppTribute !== null && s.politicalPower > ppBefore) {
        const os = this.stateOf(ppTribute.overlord)!;
        const give = Math.min(
          tributeOf(s.politicalPower - ppBefore, ppTribute.permille),
          Math.max(0, PP_CAP - os.politicalPower),
        );
        s.politicalPower -= give;
        os.politicalPower += give;
      }
      // Only humans have a HUD to feed; nations would only bloat replays.
      if (p.type() !== PlayerType.Human) continue;
      const flow = this.flowSecond(p, made.produced);
      humanUpdates.push({
        type: GameUpdateType.GrandStrategy,
        player: p.id(),
        equipment: s.equipment,
        equipped: equippedPermille(s.equipment, armyTroops(p)),
        equipmentFlow: {
          produced: flow.produced,
          lost: flow.lost,
          troopGrowth: flow.troopGrowth,
          atCap:
            s.equipment >=
            Math.floor(mg.config().maxTroops(p) * STOCKPILE_CAP_MULTIPLE),
          steelPermille: steelProductionPermille(res),
          army: armyTroops(p),
        },
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
        civFactories: s.civFactories,
        civFree: freeCivFactories(s),
        importSteel: s.importSteel,
        importOil: s.importOil,
        artillery: s.artillery,
        artilleryShare: s.artilleryShare,
        artillerySupport: equippedPermille(s.artillery, armyTroops(p)),
        attackCost: this.attackCostPreview(p, s),
        era: eraOf(s.researched),
        researched: [...s.researched],
        research: s.research.map((r) => {
          const t = techById(r.id);
          return {
            id: r.id,
            progress: r.progress,
            cost: t === undefined ? 1 : techCost(t, knownBy(r.id)),
          };
        }),
        steel: res.steel,
        steelNeeded: res.steelNeeded,
        oil: res.oil,
        oilNeeded: res.oilNeeded,
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
        atomicProjects: [],
        atomicPowers: [],
        ideology: ideologyDef(s.ideology).id,
        ideologyCooldown: s.ideologyCooldown ?? 0,
        ...this.peaceUpdate(mg, p),
        ...this.factionUpdate(p),
        ...this.puppetUpdate(p),
      });
    }
    if (humanUpdates.length > 0) {
      const world = this.atomicWorld(players);
      for (const u of humanUpdates) {
        u.atomicProjects = world.projects;
        u.atomicPowers = world.powers;
        mg.addUpdate(u);
      }
    }
    // Dead players keep no state.
    for (const id of [
      ...this.states.keys(),
      ...this.wars.keys(),
      ...this.peace.keys(),
    ]) {
      const p = mg.playerBySmallID(id);
      if (!p.isPlayer() || !p.isAlive()) {
        this.flow?.delete(id);
        this.states.delete(id);
        this.wars.delete(id);
        this.peace.delete(id);
      }
    }
    this.pruneDead(mg);
  }

  /**
   * Drop every reference to a player who is gone: war goals and
   * justifications against them (they would hold goal slots), and truces,
   * claims, enemy entries and offers (a rally or war weariness against
   * nobody). Live sides only; the dead side was deleted above.
   */
  private pruneDead(mg: Game): void {
    const live = (id: number) => {
      const p = mg.playerBySmallID(id);
      return p.isPlayer() && p.isAlive();
    };
    for (const w of this.wars.values()) {
      if (w.warGoals.some((g) => !live(g.target))) {
        w.warGoals = w.warGoals.filter((g) => live(g.target));
      }
      if (w.justifying !== null && !live(w.justifying.target)) {
        w.justifying = null;
      }
    }
    for (const ps of this.peace.values()) {
      if (ps.truces.some((t) => !live(t.target))) {
        ps.truces = ps.truces.filter((t) => live(t.target));
      }
      if (ps.enemies.some((e) => !live(e.target))) {
        ps.enemies = ps.enemies.filter((e) => live(e.target));
      }
      if (ps.offers.some((o) => !live(o.target))) {
        ps.offers = ps.offers.filter((o) => live(o.target));
      }
      if (ps.revanche?.some((r) => !live(r.target))) {
        ps.revanche = ps.revanche.filter((r) => live(r.target));
      }
    }
  }

  /**
   * M7 stage A, once a second before the nation loop: war and truce timers,
   * peak land, war weariness, capitulations, then AI peace offers and
   * answers. Players in game order, so every client agrees.
   */
  private diplomacySecond(mg: Game, players: readonly Player[]): void {
    const land = mg.numLandTiles();
    const live = players.filter(
      (p) => p.type() !== PlayerType.Bot && p.isAlive(),
    );
    for (const p of live) {
      const s = this.stateOf(p)!;
      const ps = this.peaceOf(p)!;
      advancePeaceTimers(ps, p.numTilesOwned());
      const rallying = this.on("revanche") && this.rally(ps);
      s.weariness = advanceWeariness(s.weariness ?? 0, {
        attackLosses: ps.lossesThisSecond,
        maxTroops: mg.config().maxTroops(p),
        tilesLost: ps.tilesLostThisSecond,
        peakTiles: ps.peakTiles,
        tilesOwned: p.numTilesOwned(),
        numLandTiles: land,
        occupied: this.wars.get(p.smallID())?.occupied ?? 0,
        longWars: longWars(ps),
        atWar: ps.enemies.length > 0,
        gainPermille: this.on("ideology")
          ? wearinessGainFor(s.ideology)
          : undefined,
        extraRecovery: rallying ? RECOVERY_WEARINESS : undefined,
      });
      if (this.on("revanche")) s.recovering = rallying;
      ps.lossesThisSecond = 0;
      ps.tilesLostThisSecond = 0;
    }
    for (const p of live) {
      const ps = this.peaceOf(p)!;
      const t = capitulationTarget(ps, p.numTilesOwned(), land);
      if (t === null) continue;
      const winner = mg.playerBySmallID(t);
      if (!winner.isPlayer() || !(winner as Player).isAlive()) {
        ps.enemies = ps.enemies.filter((e) => e.target !== t);
        continue;
      }
      if ((winner as Player).type() === PlayerType.Human) {
        // A human winner chooses: accept the surrender (truce, puppet
        // window) or keep fighting. An automatic truce mid-victory felt
        // like the game taking the win away.
        addOffer(ps, t, Math.max(ps.peakTiles, p.numTilesOwned()));
        this.mg?.displayMessage(
          "events_display.gs_surrender_offered",
          MessageType.GS_DIPLOMACY,
          (winner as Player).id(),
          undefined,
          { name: p.displayName(), seconds: OFFER_SECONDS },
        );
      } else {
        this.makePeace(p, winner as Player, "capitulation");
      }
      // A second capitulation needs another large loss from here.
      ps.peakTiles = p.numTilesOwned();
    }
    const coalition = this.warLayer ? this.coalitionLeader : null;
    const ideologies = this.on("ideology");
    for (const p of live) {
      if (p.type() !== PlayerType.Nation) continue;
      const s = this.stateOf(p)!;
      const ps = this.peaceOf(p)!;
      const personality = aiPersonalityFor(p.smallID());
      for (const o of live) {
        if (o === p) continue;
        const os = this.peace.get(o.smallID());
        if (os === undefined || !hasOffered(os, p.smallID())) continue;
        const e = enemyEntry(ps, o.smallID());
        const accept =
          o.smallID() === coalition
            ? losingTo(e)
            : aiAcceptsPeace(
                personality,
                s.weariness ?? 0,
                e,
                ideologies
                  ? aiPeaceBias(
                      s.ideology,
                      this.states.get(o.smallID())?.ideology,
                    )
                  : 0,
              );
        if (accept) this.offerPeace(p, o);
      }
      const target = aiPeaceTarget(
        ps,
        personality,
        s.weariness ?? 0,
        coalition,
        ideologies ? aiPeaceBias(s.ideology) : 0,
      );
      if (target !== null) {
        const t = mg.playerBySmallID(target);
        if (t.isPlayer() && (t as Player).isAlive()) {
          this.offerPeace(p, t as Player);
        }
      }
      this.aiBreakTruce(p, s, ps);
    }
  }

  /** A strong, fresh AI breaks at most one breakable truce a second. */
  private aiBreakTruce(
    p: Player,
    s: NationGsState,
    ps: NationPeaceState,
  ): void {
    const personality = aiPersonalityFor(p.smallID());
    const troops = Math.floor(p.troops());
    if (this.on("revanche")) {
      for (const r of revancheOf(ps)) {
        if (canRevancheBreak(ps, r.target) !== "ok") continue;
        const o = this.mg!.playerBySmallID(r.target);
        if (!o.isPlayer() || !(o as Player).isAlive()) continue;
        const other = o as Player;
        const input = {
          strengthPermille: Math.floor(
            (troops * 1000) / Math.max(1, Math.floor(other.troops())),
          ),
          weariness: wearinessPermille(s.weariness),
          wars: ps.enemies.length,
          canPay: s.politicalPower >= REVANCHE_BREAK_PP,
          borders: true,
        };
        if (aiSeeksRevanche(personality, input) && p.sharesBorderWith(other)) {
          this.revancheBreak(p, other);
          return;
        }
      }
    }
    for (const t of ps.truces) {
      if (t.lock > 0) continue;
      const o = this.mg!.playerBySmallID(t.target);
      if (!o.isPlayer() || !(o as Player).isAlive()) continue;
      const other = o as Player;
      const theirs = Math.max(1, Math.floor(other.troops()));
      const input = {
        strengthPermille: Math.floor((troops * 1000) / theirs),
        weariness: wearinessPermille(s.weariness),
        wars: ps.enemies.length,
        borders: true,
        canPay: s.politicalPower >= BREAK_PP_COST,
        traitor: p.isTraitor(),
        strengthBias: this.on("ideology")
          ? aiBreakBias(s.ideology, this.states.get(t.target)?.ideology)
          : 0,
      };
      // The border walk last: it is the only costly input.
      if (aiBreaksTruce(personality, input) && p.sharesBorderWith(other)) {
        this.breakTruce(p, other);
        return;
      }
    }
  }

  /** Count claims down; whether the nation is recovering this second. */
  private rally(ps: NationPeaceState): boolean {
    advanceRevanche(ps);
    return recovering(ps);
  }

  /** HUD view of a nation's wars, offers and truces. */
  private peaceUpdate(mg: Game, p: Player) {
    const ps = this.peace.get(p.smallID());
    const idOf = (small: number) => {
      const t = mg.playerBySmallID(small);
      return t.isPlayer() ? (t as Player).id() : "";
    };
    const timed = (list: readonly TimedTarget[]) =>
      list.map((t) => ({ target: idOf(t.target), seconds: t.seconds }));
    const truces = (ps?.truces ?? []).map((t) => ({
      target: idOf(t.target),
      seconds: t.seconds,
      lock: t.lock,
    }));
    const offersToMe: string[] = [];
    const surrendersToMe: string[] = [];
    // Small-id order: map order differs after a snapshot restore.
    const ids = [...this.peace.keys()].sort((x, y) => x - y);
    for (const id of ids) {
      const os = this.peace.get(id)!;
      if (id !== p.smallID() && hasOffered(os, p.smallID())) {
        offersToMe.push(idOf(id));
        if (hasSurrendered(os, p.smallID())) surrendersToMe.push(idOf(id));
      }
    }
    return {
      weariness: wearinessPermille(this.states.get(p.smallID())?.weariness),
      wars: (ps?.enemies ?? []).map((e) => ({
        target: idOf(e.target),
        seconds: e.seconds,
        won: e.won,
        lost: e.lost,
      })),
      peaceOffers: timed(ps?.offers ?? []),
      peaceOffersToMe: offersToMe,
      surrendersToMe,
      truces,
      peakTiles: ps?.peakTiles ?? 0,
      revanche:
        ps === undefined
          ? []
          : revancheOf(ps).map((r) => ({
              target: idOf(r.target),
              tiles: r.tiles,
              seconds: r.seconds,
              wait: revancheWait(ps, r.target),
            })),
      recovering: this.states.get(p.smallID())?.recovering === true,
      traitorSeconds: Math.ceil(p.getTraitorRemainingTicks() / 10),
    };
  }

  /**
   * M6 stage C, world-visible: nations running the atomic project (seconds
   * left) and those that finished it, in small-id order.
   */
  private atomicWorld(players: readonly Player[]): {
    projects: { player: string; seconds: number }[];
    powers: string[];
  } {
    const projects: { player: string; seconds: number }[] = [];
    const powers: string[] = [];
    const def = techById(ATOMIC_PROJECT);
    if (def === undefined || !this.on("research")) return { projects, powers };
    const sorted = [...players].sort((x, y) => x.smallID() - y.smallID());
    for (const p of sorted) {
      if (p.type() === PlayerType.Bot || !p.isAlive()) continue;
      const s = this.states.get(p.smallID());
      if (s === undefined) continue;
      if (hasAtomicProject(s.researched)) {
        powers.push(p.id());
        continue;
      }
      const slot = s.research.find((r) => r.id === ATOMIC_PROJECT);
      if (slot !== undefined) {
        projects.push({
          player: p.id(),
          seconds: secondsLeft(slot.progress, techCost(def, 0)),
        });
      }
    }
    return { projects, powers };
  }

  /**
   * Per technology, the per-mille of Grand Strategy players (other than the
   * asker, who does not know it yet) that already know it.
   */
  private techSpread(players: readonly Player[]): (id: string) => number {
    const counts = new Map<string, number>();
    let total = 0;
    for (const p of players) {
      if (p.type() === PlayerType.Bot || !p.isAlive()) continue;
      const s = this.states.get(p.smallID());
      if (s === undefined) continue;
      total++;
      for (const id of s.researched) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const others = Math.max(1, total - 1);
    return (id) => Math.floor(((counts.get(id) ?? 0) * 1000) / others);
  }

  /** Deposit tiles on the map: built once from terrain, never saved. */
  depositTiles(): { steel: Uint32Array; oil: Uint32Array } {
    if (this.steelTiles === undefined || this.oilTiles === undefined) {
      const mg = this.mg!;
      const steel: number[] = [];
      const oil: number[] = [];
      const n = mg.width() * mg.height();
      for (let t = 0; t < n; t++) {
        if (!mg.isLand(t)) continue;
        const d = depositAt(t, mg.terrainType(t));
        if (d === "steel") steel.push(t);
        else if (d === "oil") oil.push(t);
      }
      this.steelTiles = Uint32Array.from(steel);
      this.oilTiles = Uint32Array.from(oil);
    }
    return { steel: this.steelTiles, oil: this.oilTiles };
  }

  /** Deposit tiles each player owns right now, by small id. */
  private countDeposits(mg: Game): Map<number, { steel: number; oil: number }> {
    const out = new Map<number, { steel: number; oil: number }>();
    const { steel, oil } = this.depositTiles();
    const bump = (owner: number, k: "steel" | "oil") => {
      if (owner === 0) return;
      let c = out.get(owner);
      if (c === undefined) {
        c = { steel: 0, oil: 0 };
        out.set(owner, c);
      }
      c[k]++;
    };
    for (const t of steel) bump(mg.ownerID(t), "steel");
    for (const t of oil) bump(mg.ownerID(t), "oil");
    return out;
  }

  private goalUpdate(
    mg: Game,
    g: WarGoal,
  ): { target: string; seconds: number; defensive?: boolean } {
    const t = mg.playerBySmallID(g.target);
    return {
      target: t.isPlayer() ? (t as Player).id() : "",
      seconds: g.seconds,
      ...(g.defensive === true ? { defensive: true } : {}),
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
    const cost = this.on("ideology")
      ? justifyCostFor(JUSTIFY_COST, s.ideology)
      : JUSTIFY_COST;
    if (w.justifying !== null || s.politicalPower < cost) return;
    const truces = this.peace.get(p.smallID())?.truces ?? [];
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
      // A goal on a truce partner would mostly expire unused.
      .filter((n) => !truces.some((t) => t.target === n.smallID()))
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
        steelDeposits: s.steelDeposits,
        oilDeposits: s.oilDeposits,
        milFactories: s.milFactories,
        civFactories: s.civFactories,
        importSteel: s.importSteel,
        importOil: s.importOil,
        artillery: s.artillery,
        artilleryShare: s.artilleryShare,
        researched: [...s.researched],
        research: s.research.map((r) => ({ ...r })),
        weariness: s.weariness ?? 0,
        ideology: ideologyDef(s.ideology).id,
        ideologyCooldown: s.ideologyCooldown ?? 0,
        recovering: s.recovering === true,
        overlord: s.overlord ?? null,
        autonomy: s.autonomy ?? 0,
        puppetWindows: (s.puppetWindows ?? []).map((w) => ({ ...w })),
        ...warSnapshot(this.wars.get(id)),
        ...peaceSnapshot(this.peace.get(id)),
      })),
      coalitionLeader: this.coalitionLeader,
      factions: (this.factions ?? []).map((f) => ({
        leader: f.leader,
        members: [...f.members],
        calls: f.calls.map((c) => ({ ...c })),
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
          steelDeposits: n.steelDeposits,
          oilDeposits: n.oilDeposits,
          milFactories: n.milFactories,
          civFactories: n.civFactories,
          importSteel: n.importSteel,
          importOil: n.importOil,
          artillery: n.artillery,
          artilleryShare: n.artilleryShare,
          researched: [...n.researched],
          research: n.research.map((r) => ({ ...r })),
          weariness: n.weariness,
          ideology: n.ideology,
          ideologyCooldown: n.ideologyCooldown,
          recovering: n.recovering,
          ...(n.overlord === null ? {} : { overlord: n.overlord }),
          autonomy: n.autonomy,
          puppetWindows: n.puppetWindows.map((w) => ({ ...w })),
        },
      ]),
    );
    this.peace = new Map(
      s.states.map((n) => [
        n.id,
        {
          peakTiles: n.peakTiles,
          tilesLostThisSecond: n.tilesLostThisSecond,
          lossesThisSecond: n.lossesThisSecond,
          enemies: n.enemies.map((e) => ({ ...e })),
          truces: n.truces.map((t) => ({ ...t })),
          offers: n.offers.map((t) => ({ ...t })),
          revanche: n.revanche.map((r) => ({ ...r })),
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
    this.factions = s.factions.map((f) => ({
      leader: f.leader,
      members: [...f.members],
      calls: f.calls.map((c) => ({ ...c })),
    }));
    if (s.initialized) this.attach(r.game);
  }
}

const GATED_NUKES: ReadonlySet<UnitType> = new Set([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
]);

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

function peaceSnapshot(p: NationPeaceState | undefined) {
  return {
    peakTiles: p?.peakTiles ?? 0,
    tilesLostThisSecond: p?.tilesLostThisSecond ?? 0,
    lossesThisSecond: p?.lossesThisSecond ?? 0,
    enemies: (p?.enemies ?? []).map((e) => ({ ...e })),
    truces: (p?.truces ?? []).map((t) => ({ ...t })),
    offers: (p?.offers ?? []).map((t) => ({ ...t })),
    revanche: (p?.revanche ?? []).map((r) => ({ ...r })),
  };
}

const TimedEntrySchema = z.object({ id: z.string(), seconds: zInt() });
const TimedTargetSchema = z.object({ target: zInt(), seconds: zInt() });
const OfferSchema = TimedTargetSchema.extend({
  surrender: z.boolean().optional(),
  peak: zInt().optional(),
});
const TruceSchema = z.object({
  target: zInt(),
  seconds: zInt(),
  lock: zInt(),
});
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
      steelDeposits: zInt(),
      oilDeposits: zInt(),
      milFactories: zInt(),
      civFactories: zInt(),
      importSteel: zInt(),
      importOil: zInt(),
      artillery: zInt(),
      artilleryShare: zInt(),
      researched: z.array(z.string()),
      research: z.array(z.object({ id: z.string(), progress: zInt() })),
      occupied: zInt(),
      justifying: WarGoalSchema.nullable(),
      warGoals: z.array(WarGoalSchema),
      weariness: zInt(),
      ideology: z.string(),
      ideologyCooldown: zInt(),
      recovering: z.boolean(),
      overlord: zInt().nullable(),
      autonomy: zInt(),
      puppetWindows: z.array(TimedTargetSchema),
      peakTiles: zInt(),
      tilesLostThisSecond: zInt(),
      lossesThisSecond: zInt(),
      enemies: z.array(
        z.object({
          target: zInt(),
          seconds: zInt(),
          idle: zInt(),
          won: zInt(),
          lost: zInt(),
        }),
      ),
      truces: z.array(TruceSchema),
      offers: z.array(OfferSchema),
      revanche: z.array(
        z.object({
          target: zInt(),
          tiles: zInt(),
          seconds: zInt(),
          lock: zInt(),
        }),
      ),
    }),
  ),
  coalitionLeader: zInt().nullable(),
  factions: z.array(
    z.object({
      leader: zInt(),
      members: z.array(zInt()),
      calls: z.array(TimedTargetSchema),
    }),
  ),
});
type GrandStrategyState = z.infer<typeof GrandStrategyStateSchema>;

export const GrandStrategyExecutionSnapshot = execSnapshotType({
  name: "GrandStrategy",
  version: 14,
  schema: GrandStrategyStateSchema,
  migrations: {
    // v14 added puppets (M7 stage D): everyone independent.
    13: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        overlord: null,
        autonomy: 0,
        puppetWindows: [],
      })),
    }),
    // v13 added factions (M7C stage 3): none yet.
    12: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      factions: [],
    }),
    // v12 added revanche claims and recovery (M7C stage 2): none yet.
    11: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        recovering: false,
        revanche: [],
      })),
    }),
    // v11 added ideologies (M7 stage B): everyone starts non-aligned.
    10: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        ideology: "nonaligned",
        ideologyCooldown: 0,
      })),
    }),
    // v10 (M7 stage A.2) gave truces a minimum lock; older truces could
    // never be broken, so they stay locked until they expire.
    9: (d: {
      initialized: boolean;
      states: { truces: { target: number; seconds: number }[] }[];
    }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        truces: n.truces.map((t) => ({ ...t, lock: t.seconds })),
      })),
    }),
    // v9 added war weariness, wars, truces and peace offers (M7 stage A).
    8: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        weariness: 0,
        peakTiles: 0,
        tilesLostThisSecond: 0,
        lossesThisSecond: 0,
        enemies: [],
        truces: [],
        offers: [],
      })),
    }),
    // v8 added research.
    7: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({ ...n, researched: [], research: [] })),
    }),
    // v7 added artillery and production lines.
    6: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({ ...n, artillery: 0, artilleryShare: 0 })),
    }),
    // v6 added civilian factories and trade (recomputed at the next second).
    5: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        civFactories: 0,
        importSteel: 0,
        importOil: 0,
      })),
    }),
    // v5 added strategic resources (counted again at the next second).
    4: (d: { initialized: boolean; states: object[] }) => ({
      ...d,
      states: d.states.map((n) => ({
        ...n,
        steelDeposits: 0,
        oilDeposits: 0,
        milFactories: 0,
      })),
    }),
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

/** Steel and oil available to a nation last second, imports included. */
function balanceOf(s: NationGsState): ResourceBalance {
  const b = resourceBalance(s.steelDeposits, s.oilDeposits, s.milFactories);
  return { ...b, steel: b.steel + s.importSteel, oil: b.oil + s.importOil };
}

/** Civilian factories not spent on imports last second. */
function freeCivFactories(s: NationGsState): number {
  const used =
    Math.ceil(s.importSteel / IMPORT_UNITS_PER_CIV) +
    Math.ceil(s.importOil / IMPORT_UNITS_PER_CIV);
  return Math.max(0, s.civFactories - used);
}

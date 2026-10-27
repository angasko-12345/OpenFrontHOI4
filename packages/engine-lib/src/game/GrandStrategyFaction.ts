/**
 * Grand Strategy, M7C stage 3: factions. Pure rules, integer maths only.
 *
 * A faction is a group of nations sharing an ideology, built on upstream
 * alliances: every pair of members is allied (the execution forms those
 * alliances through the normal alliance request/accept path when a nation
 * joins, and keeps nation-nation alliances inside a faction renewed). It
 * adds no attack rules of its own; upstream alliances already stop
 * members attacking each other.
 *
 * What a faction adds:
 * - call to arms: when a member loses land to an outsider, the other
 *   members get a war goal on the attacker and turn hostile to it (which
 *   the upstream nation AI acts on), and an AI defender marks it as its
 *   target (upstream allies assist targets);
 * - bounds, so a faction cannot become the new snowball: a member cap that
 *   grows with the number of nations, a leader too big to take members, a
 *   combined land cap for joining, no call to arms once the faction is
 *   large, and a faction that grows past FACTION_DISSOLVE_SHARE breaks up.
 */
import type { AiPersonality } from "./GrandStrategy";
import { DEFAULT_IDEOLOGY } from "./GrandStrategyIdeology";

/** PP (milli) to found a faction. */
export const FACTION_CREATE_PP = 100_000;
/** Seconds between AI faction decisions (staggered by small id). */
export const FACTION_AI_PERIOD = 10;
/** Leader's land share (per-mille) above which nobody may join. */
export const FACTION_LEADER_MAX_SHARE = 250;
/** Combined land share (per-mille) a join may not push a faction past. */
export const FACTION_MAX_SHARE = 400;
/** No call to arms while the faction holds more than this (per-mille). */
export const FACTION_CALL_MAX_SHARE = 350;
/** A faction holding more than this (per-mille) breaks up. */
export const FACTION_DISSOLVE_SHARE = 500;
/** Seconds before the same faction may call to arms against the same nation. */
export const CALL_TO_ARMS_SECONDS = 60;
/** Relation change toward the attacker for each called member. */
export const CALL_TO_ARMS_RELATION = -60;
/** Ticks before expiry at which alliances inside a faction are renewed. */
export const FACTION_RENEW_TICKS = 300;

export interface Faction {
  /** Small id of the leader (also the faction's id). */
  leader: number;
  /** Small ids, leader first, then in join order. */
  members: number[];
  /** Recent calls to arms: attacker small id, seconds before another. */
  calls: { target: number; seconds: number }[];
}

/** Most members (leader included) a faction may have in a world of `nations`. */
export function factionCap(nations: number): number {
  return Math.max(2, Math.min(4, 2 + Math.floor(Math.max(0, nations) / 12)));
}

/** Most factions at once in a world of `nations` living nations. */
export function maxFactions(nations: number): number {
  return Math.max(1, Math.floor(Math.max(0, nations) / 8));
}

export function factionOf(
  factions: readonly Faction[],
  id: number,
): Faction | undefined {
  return factions.find((f) => f.members.includes(id));
}

export type FactionCheck =
  | "ok"
  | "disabled"
  | "in_faction"
  | "no_faction"
  | "no_ideology"
  | "ideology"
  | "no_political_power"
  | "too_many"
  | "full"
  | "leader_too_big"
  | "too_big"
  | "at_war"
  | "alliance_blocked"
  /** M7 stage D: puppets are in no faction. */
  | "puppet";

export interface FounderInput {
  ideology: string | undefined;
  politicalPower: number;
  inFaction: boolean;
  /** Land share, per-mille. */
  share: number;
  factions: number;
  nations: number;
}

/** Whether a nation may found a faction. */
export function canFoundFaction(i: FounderInput): FactionCheck {
  if (i.inFaction) return "in_faction";
  if ((i.ideology ?? DEFAULT_IDEOLOGY) === DEFAULT_IDEOLOGY) {
    return "no_ideology";
  }
  if (i.share > FACTION_LEADER_MAX_SHARE) return "leader_too_big";
  if (i.factions >= maxFactions(i.nations)) return "too_many";
  if (i.politicalPower < FACTION_CREATE_PP) return "no_political_power";
  return "ok";
}

export interface JoinInput {
  ideology: string | undefined;
  leaderIdeology: string | undefined;
  inFaction: boolean;
  members: number;
  nations: number;
  /** Shares per-mille: the leader's, the faction's and the joiner's. */
  leaderShare: number;
  factionShare: number;
  share: number;
  /** At war (land changing hands) with a member. */
  atWarWithMember: boolean;
}

/** Whether a nation may join a faction (alliances checked separately). */
export function canJoinFaction(i: JoinInput): FactionCheck {
  if (i.inFaction) return "in_faction";
  if (
    (i.ideology ?? DEFAULT_IDEOLOGY) === DEFAULT_IDEOLOGY ||
    i.ideology !== i.leaderIdeology
  ) {
    return "ideology";
  }
  if (i.members >= factionCap(i.nations)) return "full";
  if (i.leaderShare > FACTION_LEADER_MAX_SHARE) return "leader_too_big";
  if (i.factionShare + i.share > FACTION_MAX_SHARE) return "too_big";
  if (i.atWarWithMember) return "at_war";
  return "ok";
}

/** Whether a faction holding `share` (per-mille) may call to arms. */
export function mayCallToArms(f: Faction, target: number, share: number) {
  return (
    share <= FACTION_CALL_MAX_SHARE && !f.calls.some((c) => c.target === target)
  );
}

export function recordCall(f: Faction, target: number): void {
  f.calls = f.calls.filter((c) => c.target !== target);
  f.calls.push({ target, seconds: CALL_TO_ARMS_SECONDS });
}

export function advanceFactionCalls(f: Faction): void {
  f.calls = f.calls
    .map((c) => ({ target: c.target, seconds: c.seconds - 1 }))
    .filter((c) => c.seconds > 0);
}

/**
 * Remove `id` from its faction. The next member in join order leads when
 * the leader goes; a faction left with one member stays (a founder alone
 * is a valid faction) unless its leader left. Returns the factions.
 */
export function leaveFaction(factions: Faction[], id: number): Faction[] {
  const out: Faction[] = [];
  for (const f of factions) {
    if (!f.members.includes(id)) {
      out.push(f);
      continue;
    }
    const members = f.members.filter((m) => m !== id);
    if (members.length === 0) continue;
    if (f.leader === id && members.length < 2) continue;
    out.push({ leader: members[0], members, calls: f.calls });
  }
  return out;
}

/**
 * Smallest land share (per-mille) at which an AI founds a faction when no
 * faction of its ideology will take it: militarists found readily,
 * defenders only when sizeable. Every personality joins first.
 */
export const AI_FOUND_SHARE: Readonly<Record<AiPersonality, number>> = {
  militarist: 10,
  industrialist: 15,
  defender: 25,
};

/** Generic display name of a faction. */
export function factionName(leaderName: string): string {
  return `${leaderName} Pact`;
}

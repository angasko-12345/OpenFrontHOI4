import { UNEQUIPPED_LOSS_PENALTY } from "@openfront/engine-lib/game/GrandStrategy";
import { ATTACK_LOSS_CAP } from "@openfront/engine-lib/game/GrandStrategyCombat";
import {
  BREAK_PP_COST,
  CAPITULATE_PERMILLE,
  OFFER_SECONDS,
  TRUCE_BREAKABLE_SECONDS,
  TRUCE_MAX_LOCK,
  TRUCE_MIN_LOCK,
  WEARY_ATTACK_LOSS,
} from "@openfront/engine-lib/game/GrandStrategyPeace";
import {
  AUTONOMY_MAX,
  INDEPENDENCE_EARLY_AUTONOMY,
  PUPPET_PP,
  PUPPET_TRIBUTE,
  PUPPET_WINDOW,
} from "@openfront/engine-lib/game/GrandStrategyPuppet";
import {
  JUSTIFY_COST,
  JUSTIFY_SECONDS,
  OUT_OF_SUPPLY_LOSS_PERMILLE,
  UNJUSTIFIED_LOSS_PERMILLE,
} from "@openfront/engine-lib/game/GrandStrategyWar";
import { html, TemplateResult } from "lit";

/**
 * Plain-language guide to Grand Strategy: one topic per mechanic, each a
 * one-line "in short" and a "what to do". Numbers come from the engine's
 * constants, so the guide can't drift from the rules.
 */
export interface GsGuideTopic {
  id: string;
  title: string;
  short: string;
  todo: string;
}

const pct = (permille: number) => `${Math.round(permille / 10)}%`;
const min = (s: number) => `${Math.round(s / 60)} min`;

export const GS_GUIDE: readonly GsGuideTopic[] = [
  {
    id: "idea",
    title: "The big idea",
    short:
      "It's still OpenFront: grab land with troops. On top, you run a country: factories arm your troops, wars need a reason, and long wars wear you down.",
    todo: "Expand as usual early, build Factories, then pick fights you have a war goal for.",
  },
  {
    id: "equipment",
    title: "Equipment",
    short: `Every troop needs one equipment, made by military Factories. Unequipped troops lose up to ${pct(UNEQUIPPED_LOSS_PENALTY)} more when they attack. Troops out attacking count too.`,
    todo: "Build Factories early. The Economy tab shows what makes and drains equipment.",
  },
  {
    id: "attack",
    title: "Why attacks cost more",
    short: `Shortages, no war goal, poor supply, oil and weariness add up, but an attack never costs more than ${(ATTACK_LOSS_CAP / 1000).toFixed(1)}x classic losses. Attacking bots never costs extra.`,
    todo: "The War tab's Attack cost line shows your multiplier and what's behind it.",
  },
  {
    id: "pp",
    title: "Political power (PP)",
    short:
      "You earn it every second. It pays for laws, focuses, war goals, decisions and diplomacy.",
    todo: "Start a focus early and keep some PP for a war goal.",
  },
  {
    id: "goals",
    title: "War goals",
    short: `Attacking a nation without a war goal costs ${pct(UNJUSTIFIED_LOSS_PERMILLE)} more troops. Justifying one takes ${JUSTIFY_SECONDS} s and ${JUSTIFY_COST / 1000} PP.`,
    todo: "War tab: pick a neighbour and Justify before you attack.",
  },
  {
    id: "supply",
    title: "Supply",
    short: `Fighting far from your cities, ports and factories costs ${pct(OUT_OF_SUPPLY_LOSS_PERMILLE)} more troops.`,
    todo: "Push in steps: build a city or port near the front.",
  },
  {
    id: "weariness",
    title: "War weariness",
    short: `Long, costly wars raise it. At its worst, attacks cost ${pct(WEARY_ATTACK_LOSS)} more and you earn less PP. It fades in peace.`,
    todo: "Win fast, or make peace and recover.",
  },
  {
    id: "surrender",
    title: "Capitulation and surrender",
    short: `A nation at war that falls below ${pct(CAPITULATE_PERMILLE)} of its biggest size gives up. If you beat it, it surrenders to you: accept within ${OFFER_SECONDS} s for a truce, or ignore it and keep fighting. When an AI beats you, the truce is automatic.`,
    todo: "Accept to lock in your gains and maybe take a puppet. Ignore to finish them off.",
  },
  {
    id: "truce",
    title: "Truces",
    short: `After peace, neither side can attack or nuke the other for ${min(TRUCE_MIN_LOCK)} to ${min(TRUCE_MAX_LOCK)}. In the last ${min(TRUCE_BREAKABLE_SECONDS)} either side can break it for ${BREAK_PP_COST / 1000} PP, but is branded a traitor.`,
    todo: "Use the truce to rebuild, or to fight someone else.",
  },
  {
    id: "puppets",
    title: "Puppets",
    short: `For ${PUPPET_WINDOW} s after a win you can make the loser a puppet for ${PUPPET_PP / 1000} PP. It pays up to ${pct(PUPPET_TRIBUTE)} tribute and joins your wars. It can't leave before ${pct(INDEPENDENCE_EARLY_AUTONOMY)} autonomy, and only then if you're weary or weaker (anytime at ${pct(AUTONOMY_MAX)}).`,
    todo: "Puppet small losers for tribute. Avoid long, exhausting wars or they'll break free.",
  },
  {
    id: "politics",
    title: "Ideology and factions",
    short:
      "An ideology changes your bonuses. Nations with the same ideology can form a faction: allies who answer calls to arms.",
    todo: "Decisions tab: pick an ideology. War tab: create or join a faction.",
  },
  {
    id: "research",
    title: "Research and nukes",
    short:
      "Research gives permanent bonuses and new eras. Under grand strategy, nukes need the atomic project first.",
    todo: "Keep both research slots busy.",
  },
];

/** The guide as tap-to-open topics. */
export function renderGsGuide(): TemplateResult {
  return html`<div class="space-y-0.5" data-testid="gs-guide">
    <div class="mb-0.5 font-semibold">How it works (tap a topic)</div>
    ${GS_GUIDE.map(
      (t) =>
        html`<details
          class="rounded bg-black/20 px-1"
          data-testid="gs-guide-${t.id}"
        >
          <summary class="cursor-pointer py-0.5">${t.title}</summary>
          <div class="pb-1">
            <div>${t.short}</div>
            <div class="text-sky-300">Do: ${t.todo}</div>
          </div>
        </details>`,
    )}
  </div>`;
}

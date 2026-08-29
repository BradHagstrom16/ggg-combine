/**
 * THE GOLDEN FIXTURE — a complete, hand-computed 2026 weekend.
 *
 * This is the primary correctness gate for the whole engine. Every number in `EXPECTED` below
 * was computed by hand from `combine-2026-spec.md`, not read off the implementation. If a
 * change to scoring.js makes this file fail, the change is wrong until proven otherwise.
 *
 * (Last year's sheet is only ever a *sanity check*: the 2026 math may differ from 2025's, so
 * a hand-computed fixture against the current spec is the thing that actually binds.)
 *
 * ── The arithmetic, shown ──────────────────────────────────────────────────────────────
 *
 * Knob = 1.1 (the calibrated default, spec §3.1). Gauntlet is FIXED at ×1.5 and ignores the
 * knob (Brad, 2026-08-28 — spec §3.1).
 *
 * Individual ladders, raw = 100 × (n−r)/(n−1), final = raw × multiplier:
 *   Swim (n=10, ×1.1):     110, 880/9, 770/9, 660/9, 550/9, 440/9, 330/9, 220/9, 110/9, 0
 *                       ≈  110, 97.7778, 85.5556, 73.3333, 61.1111, 48.8889, 36.6667,
 *                          24.4444, 12.2222, 0
 *   Gauntlet (n=10, ×1.5): 150, 1200/9, 1050/9, 100, 750/9, 600/9, 50, 300/9, 150/9, 0
 *                       ≈  150, 133.3333, 116.6667, 100, 83.3333, 66.6667, 50, 33.3333,
 *                          16.6667, 0
 *   Bags / Blackjack (n=11, ×1.1): 110, 99, 88, 77, 66, 55, 44, 33, 22, 11, 0
 *
 * WIFFLE — Team A (Murph, Lucas, Yuyi, Helwig, Wyatt + Tyler on the 6-side) beats Team B
 *   (Stu, Josh, Mitch, ATM, Brad). Winners 100, losers 0.
 *
 * BEER BALL — pairs P1 Yuyi/Stu, P2 Lucas/Murph, P3 Josh/Mitch, P4 ATM/Helwig,
 *   P5 Brad/Wyatt (Tyler's pair — he is its non-playing GM captain, so Brad and Wyatt are
 *   burns 1 and 2). Full round robin, 10 games. P1 wins 4, P2 3, P3 2, P4 1, P5 0
 *   → 100 / 75 / 50 / 25 / 0. Tyler earns P5's 0.
 *
 * SUPER VOLLEY BEER (added mid-combine, Brad 2026-08-28) — the 7th event, scored exactly like
 *   Wiffle: 2 teams, winner-take-all, Tyler PLAYS on the 6-side. Team Murph (Murph, Lucas,
 *   Wyatt, Stu, Yuyi + Tyler) beats Team Mitch (Mitch, Josh, ATM, Helwig, Brad). Winners 100,
 *   losers 0. (Winners chosen so the hand-computed finishing order below is unchanged.)
 *
 * SWIM — Lucas, Wyatt, Murph, Stu, Mitch, Yuyi, ATM, Josh, Brad, Helwig (1st→10th).
 *   Tyler picks Lucas (burn 3) → 110, and Lucas's 1st place is Tyler's §7 placement.
 *
 * BAGS — all 11, HIGHEST score wins (spec §4.4): Tyler, Stu, Wyatt, Murph, Josh, Lucas,
 *   Mitch, ATM, Yuyi, Brad, Helwig (1st→11th).
 *
 * VOLLEYBALL — TM Mitch/Stu/Josh/Brad (4), TH Helwig/Yuyi/ATM (3), TW Wyatt/Murph/Lucas (3).
 *   TM beats TH 2–0; TW beats TM 2–1; TW beats TH 2–0. Wins: TW 2, TM 1, TH 0 → 100/50/0.
 *   Tyler picks TM (burn 4 = its captain Mitch; TW is ineligible, Wyatt is already burned)
 *   → 50.
 *
 * BLACKJACK (added mid-combine, Brad 2026-08-28; spec §4.8) — all 11 play, HIGHEST score wins,
 *   × knob like Bags: Murph, Lucas, Wyatt, Tyler, Stu, Yuyi, Mitch, Josh, ATM, Helwig, Brad
 *   (1st→11th). Played Saturday before the Gauntlet. (Order chosen so the finishing order
 *   below is unchanged from the six-event weekend.)
 *
 * GAUNTLET — Wyatt, Stu, Murph, Lucas, Josh, Mitch, ATM, Yuyi, Brad, Helwig (1st→10th), ×1.5.
 *   Tyler picks Stu (burn 5) → 1200/9 ≈ 133.3333.
 *
 * Burns, all unique per spec §6.1: Brad, Wyatt, Lucas, Mitch, Stu.
 *
 * Cross-check — total points awarded across the weekend:
 *   Wiffle 600 · Beer Ball 500 · Super Volley Beer 600 · Swim 550 + Tyler 110 · Bags 605
 *   · Volleyball 500 + Tyler 50 · Blackjack 605 · Gauntlet 750 + Tyler 1200/9  =  5003.3333,
 *   which is exactly the sum of the 11 totals below. The fixture closes.
 */

import { buildLog } from '../helpers.js';

const WIFFLE_TEAMS = [
  // Spec §4.1/§10.3: Tyler is always on the 6-player side.
  { id: 'A', label: 'Team Murph', captain: 'Murph', members: ['Murph', 'Lucas', 'Yuyi', 'Helwig', 'Wyatt', 'Tyler'] },
  { id: 'B', label: 'Team Stu', captain: 'Stu', members: ['Stu', 'Josh', 'Mitch', 'ATM', 'Brad'] },
];

const SUPERVOLLEY_TEAMS = [
  // Same shape as Wiffle: Tyler plays, on the 6-side (spec §4.7, Brad 2026-08-28).
  { id: 'SA', label: 'Team Murph', captain: 'Murph', members: ['Murph', 'Lucas', 'Wyatt', 'Stu', 'Yuyi', 'Tyler'] },
  { id: 'SB', label: 'Team Mitch', captain: 'Mitch', members: ['Mitch', 'Josh', 'ATM', 'Helwig', 'Brad'] },
];

const BEERBALL_PAIRS = [
  { id: 'P1', label: 'Yuyi + Stu', captain: 'Yuyi', members: ['Yuyi', 'Stu'] },
  { id: 'P2', label: 'Lucas + Murph', captain: 'Lucas', members: ['Lucas', 'Murph'] },
  { id: 'P3', label: 'Josh + Mitch', captain: 'Josh', members: ['Josh', 'Mitch'] },
  { id: 'P4', label: 'ATM + Helwig', captain: 'ATM', members: ['ATM', 'Helwig'] },
  // Tyler captains this pair but does not play (spec §4.2/§6) — both members burn.
  { id: 'P5', label: 'Brad + Wyatt', captain: 'Tyler', members: ['Brad', 'Wyatt'] },
];

const VOLLEYBALL_TEAMS = [
  { id: 'TM', label: 'Team Mitch', captain: 'Mitch', members: ['Mitch', 'Stu', 'Josh', 'Brad'] },
  { id: 'TH', label: 'Team Helwig', captain: 'Helwig', members: ['Helwig', 'Yuyi', 'ATM'] },
  { id: 'TW', label: 'Team Wyatt', captain: 'Wyatt', members: ['Wyatt', 'Murph', 'Lucas'] },
];

/**
 * Full round robin: 5 pairs, 10 games, 4 each. P1 beats everyone, P2 beats all but P1, etc.
 * Beers follow spec §4.2: the winner finishes exactly 2, the loser 1.5 or fewer (0.5 steps).
 * Each game keeps the same beer *differential* it had before — standings rank on the differential
 * (§4.2), so every EXPECTED number below is unchanged.
 */
const BEERBALL_GAMES = [
  { gameSlot: 1, pairs: ['P1', 'P2'], winner: 'P1', beers: { P1: 2, P2: 0 } },
  { gameSlot: 2, pairs: ['P1', 'P3'], winner: 'P1', beers: { P1: 2, P3: 0 } },
  { gameSlot: 3, pairs: ['P1', 'P4'], winner: 'P1', beers: { P1: 2, P4: 0 } },
  { gameSlot: 4, pairs: ['P1', 'P5'], winner: 'P1', beers: { P1: 2, P5: 0 } },
  { gameSlot: 5, pairs: ['P2', 'P3'], winner: 'P2', beers: { P2: 2, P3: 0.5 } }, // 0.5 granularity, spec §10.5
  { gameSlot: 6, pairs: ['P2', 'P4'], winner: 'P2', beers: { P2: 2, P4: 0 } },
  { gameSlot: 7, pairs: ['P2', 'P5'], winner: 'P2', beers: { P2: 2, P5: 0 } },
  { gameSlot: 8, pairs: ['P3', 'P4'], winner: 'P3', beers: { P3: 2, P4: 0 } },
  { gameSlot: 9, pairs: ['P3', 'P5'], winner: 'P3', beers: { P3: 2, P5: 0 } },
  { gameSlot: 10, pairs: ['P4', 'P5'], winner: 'P4', beers: { P4: 2, P5: 0 } },
];

const SWIM_TIMES = [
  ['Lucas', 55.0], ['Wyatt', 57.2], ['Murph', 58.4], ['Stu', 60.1], ['Mitch', 61.0],
  ['Yuyi', 62.5], ['ATM', 64.0], ['Josh', 65.5], ['Brad', 70.2], ['Helwig', 75.0],
];

/** Bags is a SCORE, not a time — highest wins (spec §4.4). */
const BAGS_SCORES = [
  ['Tyler', 21], ['Stu', 19], ['Wyatt', 17], ['Murph', 15], ['Josh', 13], ['Lucas', 12],
  ['Mitch', 10], ['ATM', 9], ['Yuyi', 7], ['Brad', 5], ['Helwig', 3],
];

const VOLLEYBALL_SETS = [
  { matchSlot: 1, setNo: 1, scores: { TM: 21, TH: 15 } },
  { matchSlot: 1, setNo: 2, scores: { TM: 21, TH: 18 } },
  { matchSlot: 2, setNo: 1, scores: { TM: 19, TW: 21 } },
  { matchSlot: 2, setNo: 2, scores: { TM: 21, TW: 17 } },
  { matchSlot: 2, setNo: 3, scores: { TM: 11, TW: 15 } },
  { matchSlot: 3, setNo: 1, scores: { TH: 12, TW: 21 } },
  { matchSlot: 3, setNo: 2, scores: { TH: 19, TW: 21 } },
];

/** Blackjack is a SCORE, highest wins, all 11 (spec §4.8, Brad 2026-08-28). */
const BLACKJACK_SCORES = [
  ['Murph', 25], ['Lucas', 24], ['Wyatt', 23], ['Tyler', 22], ['Stu', 21], ['Yuyi', 20],
  ['Mitch', 19], ['Josh', 18], ['ATM', 17], ['Helwig', 16], ['Brad', 15],
];

const GAUNTLET_TIMES = [
  ['Wyatt', 45.0], ['Stu', 47.5], ['Murph', 48.0], ['Lucas', 49.2], ['Josh', 51.0],
  ['Mitch', 52.5], ['ATM', 54.0], ['Yuyi', 56.0], ['Brad', 60.0], ['Helwig', 65.0],
];

/** The weekend as Brad would enter it, in schedule order (spec §9). */
export const GOLDEN_LOG = buildLog([
  { type: 'knob', value: 1.1 },

  // Friday — Wiffle
  { type: 'draft_assignment', event: 'wiffle', teams: WIFFLE_TEAMS },
  { type: 'wiffle_result', event: 'wiffle', winner: 'A' },
  { type: 'event_final', event: 'wiffle' },

  // Friday — Beer Ball (Tyler's pair is drafted here: burns 1 and 2)
  { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
  ...BEERBALL_GAMES.map((g) => ({ type: 'beerball_game', event: 'beerball', ...g })),
  { type: 'event_final', event: 'beerball' },

  // Friday — Super Volley Beer (the 7th event; reuses the wiffle_result entry, event-scoped)
  { type: 'draft_assignment', event: 'supervolley', teams: SUPERVOLLEY_TEAMS },
  { type: 'wiffle_result', event: 'supervolley', winner: 'SA' },
  { type: 'event_final', event: 'supervolley' },

  // Saturday — Swim (pick locks first, spec §6.1)
  { type: 'tyler_pick', stage: 'swim', target: 'Lucas' },
  ...SWIM_TIMES.map(([player, value]) => ({ type: 'time', event: 'swim', player, value })),
  { type: 'event_final', event: 'swim' },

  // Saturday — Bags (all 11)
  ...BAGS_SCORES.map(([player, value]) => ({ type: 'time', event: 'bags', player, value })),
  { type: 'event_final', event: 'bags' },

  // Saturday — Volleyball (draft, then Tyler's team pick locks before game 1)
  { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
  { type: 'tyler_pick', stage: 'volleyball', target: 'TM' },
  ...VOLLEYBALL_SETS.map((s) => ({ type: 'volleyball_set', event: 'volleyball', ...s })),
  { type: 'event_final', event: 'volleyball' },

  // Saturday — Blackjack (all 11, before the Gauntlet)
  ...BLACKJACK_SCORES.map(([player, value]) => ({ type: 'time', event: 'blackjack', player, value })),
  { type: 'event_final', event: 'blackjack' },

  // Saturday — Gauntlet finale (fixed ×1.5)
  { type: 'tyler_pick', stage: 'gauntlet', target: 'Stu' },
  ...GAUNTLET_TIMES.map(([player, value]) => ({ type: 'time', event: 'gauntlet', player, value })),
  { type: 'event_final', event: 'gauntlet' },
]);

/** Displayed totals (1 decimal), and the exact per-event points behind them. */
export const EXPECTED = {
  champion: 'Murph',
  championResolvedBy: 'total',
  burns: ['Brad', 'Wyatt', 'Lucas', 'Mitch', 'Stu'],
  order: ['Murph', 'Lucas', 'Wyatt', 'Tyler', 'Stu', 'Yuyi', 'Mitch', 'Josh', 'ATM', 'Helwig', 'Brad'],
  totals: {
    // Wiffle + Beer Ball + SVB + Swim + Bags + Volleyball + Blackjack + Gauntlet(×1.5)
    Murph: 764.2,   // 100 + 75 + 100 + 770/9 + 77 + 100 + 110 + 1050/9
    Lucas: 739.0,   // 100 + 75 + 100 + 110   + 55 + 100 +  99 + 100
    Wyatt: 723.8,   // 100 +  0 + 100 + 880/9 + 88 + 100 +  88 + 150
    Tyler: 680.3,   // 100 +  0 + 100 + 110   + 110 + 50 +  77 + 1200/9   (Wiffle, SVB, Bags, Blackjack his own, the rest backed)
    Stu: 621.7,     //   0 + 100 + 100 + 660/9 + 99 +  50 +  66 + 1200/9
    Yuyi: 459.2,    // 100 + 100 + 100 + 440/9 + 22 +   0 +  55 + 300/9
    Mitch: 315.8,   //   0 +  50 +   0 + 550/9 + 44 +  50 +  44 + 600/9
    Josh: 306.8,    //   0 +  50 +   0 + 220/9 + 66 +  50 +  33 + 750/9
    ATM: 166.7,     //   0 +  25 +   0 + 330/9 + 33 +   0 +  22 + 50
    Helwig: 136.0,  // 100 +  25 +   0 +     0 +  0 +   0 +  11 + 0
    Brad: 89.9,     //   0 +   0 +   0 + 110/9 + 11 +  50 +   0 + 150/9
  },
  /** Wiffle points prove the winner-take-all split including Tyler, who plays. */
  wiffle: {
    Murph: 100, Lucas: 100, Yuyi: 100, Helwig: 100, Wyatt: 100, Tyler: 100,
    Stu: 0, Josh: 0, Mitch: 0, ATM: 0, Brad: 0,
  },
  /** Super Volley Beer: winner-take-all again, Tyler playing — no backing, no burn. */
  supervolley: {
    Murph: 100, Lucas: 100, Wyatt: 100, Stu: 100, Yuyi: 100, Tyler: 100,
    Mitch: 0, Josh: 0, ATM: 0, Helwig: 0, Brad: 0,
  },
  /** Beer Ball placement order and Tyler's pass-through of his pair's exact points. */
  beerballPlacements: ['P1', 'P2', 'P3', 'P4', 'P5'],
  /** Volleyball placement order (wins alone separates all three). */
  volleyballPlacements: ['TW', 'TM', 'TH'],
  /** Spec §7: Tyler's Swim/Gauntlet placements are his picked players'; Bags/Blackjack his own. */
  tylerPlacements: { swim: 1, bags: 1, blackjack: 4, gauntlet: 2 },
};

export { WIFFLE_TEAMS, SUPERVOLLEY_TEAMS, BEERBALL_PAIRS, VOLLEYBALL_TEAMS, BEERBALL_GAMES, VOLLEYBALL_SETS, SWIM_TIMES, BAGS_SCORES, BLACKJACK_SCORES, GAUNTLET_TIMES };

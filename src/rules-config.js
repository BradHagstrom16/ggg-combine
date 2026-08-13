/**
 * GGG Combine 2026 — rules configuration.
 *
 * Every constant here traces to a section of `combine-2026-spec.md`, which is the LOCKED
 * source of truth. Section references are inline. Do not change a value here to make a test
 * pass — if the spec and the code disagree, the spec wins and the discrepancy gets flagged
 * to Brad.
 *
 * This file is also the 2027 seam: the eventual goal (see TODOS.md) is that a new year is a
 * new version of THIS file plus a fresh Durable Object namespace. It is deliberately data,
 * not logic — all behaviour lives in scoring.js.
 */

/** Display names, exactly as written in spec §2. Order is the spec's order. */
export const ROSTER = [
  'Stu', 'Murph', 'Tyler', 'Josh', 'Lucas', 'Mitch', 'Yuyi', 'ATM', 'Helwig', 'Brad', 'Wyatt',
];

/** Spec §2: Brad is commissioner, the only non-captain; he enters all data. */
export const COMMISSIONER = 'Brad';

/** Spec §6: Tyler plays Bags + Wiffle and GMs the other four events. */
export const GM = 'Tyler';

/** Spec §2: 10 "able" players + Tyler. "Able" drives every event roster except Bags/Wiffle. */
export const ABLE = ROSTER.filter((p) => p !== GM);

/** Spec §3.1 — the Individual Multiplier ("the knob").
 *  Default 1.1 is CALIBRATED (200k-run Monte Carlo, spec §3.1). Do not re-derive it. */
export const KNOB = { default: 1.1, min: 1.0, max: 2.0, step: 0.05 };

/** Rank directions for individual events.
 *  `lower` = fastest time wins. `higher` = biggest score wins.
 *  Bags is `higher` per spec §4.4 ("Highest score is the goal"), which governs over the
 *  §3 table's "timed" wording. Confirmed with Brad 2026-08-13. */
export const DIRECTION = { LOWER: 'lower', HIGHER: 'higher' };

/**
 * Ordered tie-resolution rules for the round-robin team events.
 *
 * These are applied by a GROUP-WISE resolver (see scoring.js `resolveGroup`), not a pairwise
 * comparator chain: head-to-head is non-transitive, so a 3-way circular knot must be DETECTED
 * and flagged for manual resolution, never silently ordered. When this list is exhausted and
 * a group is still tied, the group is flagged `manual-resolution-required` and Brad enters an
 * `override` (that is how spec §4.2's chug-off and §4.5's play-in are recorded).
 */
export const TIEBREAK_RULES = {
  // Spec §4.2: wins → total beer differential (0.5 granularity) → head-to-head → chug-off.
  beerball: ['wins', 'beerDiff', 'headToHead'],
  // Spec §4.5: wins → point differential → total points → play-in at Brad's discretion.
  volleyball: ['wins', 'pointDiff', 'totalPoints'],
};

/**
 * The six scored events, in schedule order (spec §9). `order` is what the admin forms and the
 * standings columns sort by, and what "picks lock in schedule order" (spec §6.1) means.
 *
 * Golf is deliberately absent: spec §3 makes it an exhibition worth zero points. It lives on
 * the agenda page only and must never appear here.
 */
export const EVENTS = {
  wiffle: {
    id: 'wiffle',
    order: 1,
    label: 'Wiffle Ball',
    short: 'Wiffle',
    type: 'team',
    day: 'Friday',
    // Spec §4.1: all 11 play — 6v5, Tyler always on the 6-side.
    participants: ROSTER,
    captains: ['Murph', 'Stu'],
    // Spec §4.1: winner-take-all.
    placementPoints: [100, 0],
    // Not a round robin — but expressing "the winner placed first" as a one-rule list lets
    // Wiffle reuse the same group-wise placement machinery as the other two team events.
    tiebreakRules: ['wins'],
    teamCount: 2,
    tylerPlays: true,
  },
  beerball: {
    id: 'beerball',
    order: 2,
    label: 'Beer Ball',
    short: 'Beer Ball',
    type: 'team',
    day: 'Friday',
    // Spec §4.2: 10 able players in 5 pairs. Tyler is a non-playing GM captain (§6).
    participants: ABLE,
    captains: ['Yuyi', 'Lucas', 'Josh', 'ATM', 'Tyler'],
    placementPoints: [100, 75, 50, 25, 0],
    teamCount: 5,
    teamSize: 2,
    // Spec §4.2: full round robin, 10 games, 4 per pair.
    gameCount: 10,
    // Spec §10.5: beer differentials accept 0.5 increments.
    beerStep: 0.5,
    tiebreakRules: TIEBREAK_RULES.beerball,
    tylerPlays: false,
  },
  swim: {
    id: 'swim',
    order: 3,
    label: 'Swim',
    short: 'Swim',
    type: 'individual',
    day: 'Saturday',
    // Spec §4.3: 10 able players; Tyler backs a player.
    participants: ABLE,
    direction: DIRECTION.LOWER,
    unit: 'seconds',
    tylerPlays: false,
  },
  bags: {
    id: 'bags',
    order: 4,
    label: 'Bags',
    short: 'Bags',
    type: 'individual',
    day: 'Saturday',
    // Spec §4.4: ALL 11 play, including Tyler. Highest score wins.
    participants: ROSTER,
    direction: DIRECTION.HIGHER,
    unit: 'points',
    tylerPlays: true,
  },
  volleyball: {
    id: 'volleyball',
    order: 5,
    label: 'Volleyball',
    short: 'Volley',
    type: 'team',
    day: 'Saturday',
    // Spec §4.5: 10 able players in 3 teams of 4/3/3.
    participants: ABLE,
    captains: ['Mitch', 'Helwig', 'Wyatt'],
    placementPoints: [100, 50, 0],
    teamCount: 3,
    teamSizes: [4, 3, 3],
    // Brad, 2026-08-13: each of the 3 matchups is best of 3 sets; the match winner takes the
    // standings "win"; point differential sums set margins across ALL sets played.
    matchCount: 3,
    setsToWin: 2,
    maxSets: 3,
    tiebreakRules: TIEBREAK_RULES.volleyball,
    tylerPlays: false,
  },
  gauntlet: {
    id: 'gauntlet',
    order: 6,
    label: 'Gauntlet',
    short: 'Gauntlet',
    type: 'individual',
    day: 'Saturday',
    // Spec §4.6: 10 able players, timed, lower is better.
    participants: ABLE,
    direction: DIRECTION.LOWER,
    unit: 'seconds',
    tylerPlays: false,
  },
};

/** Event ids in schedule order. */
export const EVENT_ORDER = Object.values(EVENTS)
  .sort((a, b) => a.order - b.order)
  .map((e) => e.id);

/** The three knob-multiplied events (spec §3: "individual events are multiplied"). */
export const INDIVIDUAL_EVENTS = EVENT_ORDER.filter((id) => EVENTS[id].type === 'individual');

export const TEAM_EVENTS = EVENT_ORDER.filter((id) => EVENTS[id].type === 'team');

/**
 * Spec §6 — how Tyler earns points in each event he does not play.
 *
 * `pick` events need a `tyler_pick` entry naming the backed player/team. `derived` means the
 * backing is read straight off the draft (his Beer Ball pair is the pair he captains), so
 * there is exactly one source of truth for who he is backing.
 */
export const TYLER_BACKING = {
  wiffle: { mode: 'plays' },
  bags: { mode: 'plays' },
  beerball: { mode: 'derived', unit: 'pair', burns: 'allMembers' },
  swim: { mode: 'pick', unit: 'player', burns: 'target' },
  volleyball: { mode: 'pick', unit: 'team', burns: 'captain' },
  gauntlet: { mode: 'pick', unit: 'player', burns: 'target' },
};

/**
 * Spec §6.1 — the burn ledger: exactly 5 burns, all unique, locking in schedule order.
 *
 * Slots 1 and 2 are Tyler's Beer Ball pair (both members burn). Slot 3 is the Swim pick,
 * slot 4 is the Volleyball team (its CAPTAIN ONLY burns — a roster is diluted exposure,
 * an individual pick is full exposure), slot 5 is the Gauntlet pick.
 */
export const BURN_COUNT = 5;

export const BURN_STAGES = [
  { stage: 'beerball', slots: [1, 2], source: 'draft', label: 'Beer Ball pair' },
  { stage: 'swim', slots: [3], source: 'pick', label: 'Swim pick' },
  { stage: 'volleyball', slots: [4], source: 'pick', label: 'Volleyball team' },
  { stage: 'gauntlet', slots: [5], source: 'pick', label: 'Gauntlet pick' },
];

/** Stages that require an explicit `tyler_pick` entry, in lock order. */
export const PICK_STAGES = BURN_STAGES.filter((s) => s.source === 'pick').map((s) => s.stage);

/** Spec §3.2 — individual points formula. Exposed so tests can assert against the spec
 *  formula itself rather than against a hand-copied table of numbers. */
export function rawPointsForRank(rank, n) {
  return (100 * (n - rank)) / (n - 1);
}

/** Totals and placements are COMPARED and DISPLAYED at 1 decimal so float dust can never
 *  silently defeat the §7 tie detection. A championship tie is a feature, not an artifact. */
export function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** Spec §3.1 / §10.4 — clamp to 1.0–2.0 and snap to the 0.05 step grid. */
export function clampKnob(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return KNOB.default;
  const clamped = Math.min(KNOB.max, Math.max(KNOB.min, n));
  const steps = Math.round((clamped - KNOB.min) / KNOB.step);
  // toFixed(2) because the step is 0.05: it snaps to the grid without leaving float dust
  // (1.0 + 3*0.05 is 1.1500000000000001 in binary floating point).
  return Number((KNOB.min + steps * KNOB.step).toFixed(2));
}

/** The agenda (spec §9). Order only — no clock times anywhere, deliberately.
 *  Golf appears here and ONLY here; it is an exhibition worth zero combine points. */
export const AGENDA = [
  { day: 'Thursday', items: [{ label: 'Arrive · optional rules walkthrough', kind: 'social' }] },
  {
    day: 'Friday',
    items: [
      { label: 'Golf', kind: 'exhibition', note: 'Exhibition — zero combine points' },
      { label: 'Wiffle draft', kind: 'draft' },
      { label: 'Wiffle Ball', kind: 'event', event: 'wiffle', note: 'Combine opener' },
      { label: 'Beer Ball draft', kind: 'draft', note: 'Shithead sets order 2–5 · Tyler snakes 1st/6th · burns 1–2' },
      { label: 'Beer Ball', kind: 'event', event: 'beerball' },
    ],
  },
  {
    day: 'Saturday',
    items: [
      { label: "Tyler's Swim pick locks", kind: 'pick', note: 'burn 3' },
      { label: 'Swim', kind: 'event', event: 'swim', note: 'Locked opener' },
      { label: 'Bags', kind: 'event', event: 'bags', note: 'All 11' },
      { label: 'Volleyball draft', kind: 'draft' },
      { label: "Tyler's team pick locks", kind: 'pick', note: 'burn 4' },
      { label: 'Volleyball', kind: 'event', event: 'volleyball' },
      { label: "Tyler's Gauntlet pick locks", kind: 'pick', note: 'burn 5' },
      { label: 'Gauntlet', kind: 'event', event: 'gauntlet', note: 'Locked finale' },
      { label: 'Champion crowned', kind: 'ceremony', note: 'Tiebreaks per §7' },
      { label: 'Fantasy Draft', kind: 'social', note: 'Evening' },
    ],
  },
];

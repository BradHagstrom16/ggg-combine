/**
 * Scoring engine tests.
 *
 * Structure mirrors the risk: the golden weekend first (it is the gate), then spec §10's eight
 * validation rules, then one section per mechanic that can silently produce a wrong number.
 *
 * Rule for this file: assertions come from `combine-2026-spec.md`, never from what the code
 * currently returns. Where a number is hand-derived, the derivation is in the comment.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { score, effectiveLog, resolveGroup, rankIndividual, entryKey } from '../src/scoring.js';
import { clampKnob, round1, rawPointsForRank, KNOB, ABLE, ROSTER } from '../src/rules-config.js';
import { buildLog, append, row, totals, codes } from './helpers.js';
import {
  GOLDEN_LOG, EXPECTED, WIFFLE_TEAMS, BEERBALL_PAIRS, VOLLEYBALL_TEAMS,
} from './fixtures/golden-weekend.js';

const run = (log) => score(effectiveLog(log));

/** Swim/Gauntlet ladder at the default knob, as exact ninths (n=10). */
const S = (rank) => (rawPointsForRank(rank, 10) * 1.1);
/** Bags ladder at the default knob (n=11). */
const B = (rank) => (rawPointsForRank(rank, 11) * 1.1);

// =======================================================================================
// The golden weekend — the primary gate
// =======================================================================================

describe('golden weekend (hand-computed, spec-derived)', () => {
  const result = run(GOLDEN_LOG);

  test('every total matches the hand-computed value', () => {
    assert.deepEqual(totals(result), EXPECTED.totals);
  });

  test('standings are in the hand-computed order', () => {
    assert.deepEqual(result.players.map((p) => p.player), EXPECTED.order);
  });

  test('champion is Murph, decided on total alone', () => {
    assert.equal(result.championship.player, EXPECTED.champion);
    assert.equal(result.championship.resolvedBy, EXPECTED.championResolvedBy);
  });

  test('the weekend closes: awarded points sum to 3562.7778', () => {
    const sum = result.players.reduce((acc, p) => acc + p.total, 0);
    assert.equal(round1(sum), 3562.8);
  });

  test('Wiffle is winner-take-all and Tyler earns his own 100', () => {
    assert.deepEqual(
      Object.fromEntries(Object.keys(EXPECTED.wiffle).map((p) => [p, result.events.wiffle.points[p]])),
      EXPECTED.wiffle,
    );
  });

  test('Beer Ball and Volleyball placements resolve in the hand-computed order', () => {
    assert.deepEqual(
      result.events.beerball.placements.map((p) => p.id), EXPECTED.beerballPlacements,
    );
    assert.deepEqual(
      result.events.volleyball.placements.map((p) => p.id), EXPECTED.volleyballPlacements,
    );
  });

  test("Tyler's backed points pass through EXACTLY, never recomputed", () => {
    // Spec §6: his pair's / picked player's / picked team's exact final points.
    assert.equal(result.events.beerball.points.Tyler, result.events.beerball.teamPoints.P5);
    assert.equal(result.events.swim.points.Tyler, result.events.swim.points.Lucas);
    assert.equal(result.events.volleyball.points.Tyler, result.events.volleyball.teamPoints.TM);
    assert.equal(result.events.gauntlet.points.Tyler, result.events.gauntlet.points.Stu);
  });

  test('all five burns are recorded, in schedule order, all unique', () => {
    assert.deepEqual(result.burns.slots.map((s) => s.player), EXPECTED.burns);
    assert.equal(result.burns.duplicates.length, 0);
    assert.equal(result.burns.complete, true);
    assert.equal(new Set(EXPECTED.burns).size, 5);
  });

  test('every event is final and nothing needs manual resolution', () => {
    for (const event of Object.values(result.events)) {
      assert.equal(event.status, 'final', `${event.id} should be final`);
      assert.equal(event.manualRequired, false);
    }
    assert.deepEqual(result.issues.filter((i) => i.level === 'error'), []);
  });
});

// =======================================================================================
// Spec §10 — the eight must-have validation rules
// =======================================================================================

describe('spec §10 validation rules', () => {
  test('§10.1 — a duplicate burn is blocked and named', () => {
    // Tyler's pair burns Brad + Wyatt; picking Brad again for Swim is illegal.
    const log = buildLog([
      { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
      { type: 'tyler_pick', stage: 'swim', target: 'Brad' },
    ]);
    const result = run(log);
    assert.ok(codes(result).includes('duplicate-burn'));
    assert.equal(result.burns.duplicates[0].player, 'Brad');
    assert.equal(result.burns.complete, false);
  });

  test('§10.2 — a player on two teams in one event is an error', () => {
    const teams = [
      { id: 'TM', captain: 'Mitch', members: ['Mitch', 'Stu', 'Josh', 'Brad'] },
      { id: 'TH', captain: 'Helwig', members: ['Helwig', 'Yuyi', 'Stu'] }, // Stu twice
      { id: 'TW', captain: 'Wyatt', members: ['Wyatt', 'Murph', 'Lucas'] },
    ];
    const result = run(buildLog([{ type: 'draft_assignment', event: 'volleyball', teams }]));
    const issue = result.issues.find((i) => i.code === 'double-rostered');
    assert.ok(issue, 'expected a double-rostered error');
    assert.equal(issue.player, 'Stu');
  });

  test('§10.2 — Beer Ball pairs are exactly 2', () => {
    const teams = BEERBALL_PAIRS.map((p, i) => (
      i === 0 ? { ...p, members: ['Yuyi', 'Stu', 'Mitch'] } : p
    ));
    const result = run(buildLog([{ type: 'draft_assignment', event: 'beerball', teams }]));
    assert.ok(codes(result).includes('bad-pair-size'));
  });

  test('§10.3 — Tyler must be on the 6-player Wiffle side', () => {
    const teams = [
      { id: 'A', captain: 'Murph', members: ['Murph', 'Lucas', 'Yuyi', 'Helwig', 'Wyatt', 'Josh'] },
      { id: 'B', captain: 'Stu', members: ['Stu', 'Mitch', 'ATM', 'Brad', 'Tyler'] }, // 5-side
    ];
    const result = run(buildLog([{ type: 'draft_assignment', event: 'wiffle', teams }]));
    assert.ok(codes(result).includes('tyler-wrong-side'));
  });

  test('§10.4 — the knob is clamped to 1.0–2.0 and snapped to the 0.05 step', () => {
    assert.equal(clampKnob(0.5), 1.0, 'below range clamps up');
    assert.equal(clampKnob(9), 2.0, 'above range clamps down');
    assert.equal(clampKnob(1.0), 1.0);
    assert.equal(clampKnob(2.0), 2.0);
    assert.equal(clampKnob(1.1), 1.1);
    assert.equal(clampKnob(1.13), 1.15, 'snaps to the nearest step');
    assert.equal(clampKnob(1.12), 1.1);
    assert.equal(clampKnob('nonsense'), KNOB.default, 'garbage falls back to the default');

    // Every legal step round-trips cleanly — no float dust leaking into the displayed knob.
    for (let v = KNOB.min; v <= KNOB.max + 1e-9; v += KNOB.step) {
      const snapped = clampKnob(v);
      assert.equal(clampKnob(snapped), snapped);
    }
  });

  test('§10.4 — an out-of-range knob entry scores clamped, and says so', () => {
    const log = append(GOLDEN_LOG, [{ type: 'knob', value: 5 }]);
    const result = run(log);
    assert.equal(result.knob, 2.0);
    assert.ok(codes(result).includes('knob-clamped'));
  });

  test('§10.5 — beer differentials carry 0.5 granularity', () => {
    const result = run(GOLDEN_LOG);
    // P3 finished 2.5 against P2 (game 5): +2 +2 -2 -1.5 = 0.5
    assert.equal(result.events.beerball.ctx.stats.P3.beerDiff, 0.5);
  });

  test('§10.6 — a blank time after finalize is 0 points and a WARNING, not an error', () => {
    const log = buildLog([
      ...ABLE.filter((p) => p !== 'Helwig').map((player, i) => (
        { type: 'time', event: 'swim', player, value: 50 + i }
      )),
      { type: 'event_final', event: 'swim' },
    ]);
    const result = run(log);
    assert.equal(result.events.swim.points.Helwig, 0);
    const issue = result.issues.find((i) => i.code === 'blank-scored-zero');
    assert.ok(issue, 'expected a blank-scored-zero issue');
    assert.equal(issue.level, 'warn', 'a blank is never an error');
  });

  test('§10.7 — identical times share the average of the positions occupied', () => {
    // Covered in depth below; asserted here as the §10 checklist item.
    const { points } = rankIndividual({
      values: { a: 10, b: 10, c: 12 }, participants: ['a', 'b', 'c'],
      direction: 'lower', knob: 1,
    });
    assert.equal(points.a, points.b);
  });

  test('§10.8 — an override wins over computation and is flagged', () => {
    const log = append(GOLDEN_LOG, [{
      type: 'override', event: 'beerball',
      placements: ['P5', 'P4', 'P3', 'P2', 'P1'], reason: 'chug-off',
    }]);
    const result = run(log);
    assert.deepEqual(result.events.beerball.placements.map((p) => p.id), ['P5', 'P4', 'P3', 'P2', 'P1']);
    assert.equal(result.events.beerball.overridden, true);
    assert.equal(result.events.beerball.overrideReason, 'chug-off');
  });
});

// =======================================================================================
// Individual events (spec §3.2)
// =======================================================================================

describe('individual scoring', () => {
  test('the formula is 100 × (n−r)/(n−1) × knob', () => {
    const result = run(GOLDEN_LOG);
    assert.equal(result.events.swim.points.Lucas, S(1));   // 110
    assert.equal(result.events.swim.points.Wyatt, S(2));   // 880/9
    assert.equal(result.events.swim.points.Helwig, S(10)); // 0
    assert.equal(result.events.bags.points.Tyler, B(1));   // 110
    assert.equal(result.events.bags.points.Brad, B(10));   // 11
  });

  test('tied times share the average of the points for the positions they occupy', () => {
    // Two players tie for 2nd/3rd → each gets the mean of the 2nd- and 3rd-place points.
    const times = [
      ['Lucas', 55], ['Wyatt', 57], ['Murph', 57], ['Stu', 60], ['Mitch', 61],
      ['Yuyi', 62], ['ATM', 64], ['Josh', 65], ['Brad', 70], ['Helwig', 75],
    ];
    const log = buildLog([
      ...times.map(([player, value]) => ({ type: 'time', event: 'swim', player, value })),
      { type: 'event_final', event: 'swim' },
    ]);
    const result = run(log);
    const shared = (S(2) + S(3)) / 2;
    assert.equal(result.events.swim.points.Wyatt, shared);
    assert.equal(result.events.swim.points.Murph, shared);
    // The tie consumes two positions: the next player is 4th, not 3rd.
    assert.equal(result.events.swim.points.Stu, S(4));
    // Placement for §7 is the average of the occupied positions.
    assert.equal(result.events.swim.placement.Wyatt, 2.5);
  });

  test('a three-way tie averages three positions', () => {
    const { points, placement } = rankIndividual({
      values: { a: 5, b: 5, c: 5, d: 9 }, participants: ['a', 'b', 'c', 'd'],
      direction: 'lower', knob: 1,
    });
    const shared = (rawPointsForRank(1, 4) + rawPointsForRank(2, 4) + rawPointsForRank(3, 4)) / 3;
    assert.equal(points.a, shared);
    assert.equal(points.c, shared);
    assert.equal(placement.b, 2);
    assert.equal(points.d, rawPointsForRank(4, 4));
  });

  test('MULTIPLE blanks all get 0 — not the average of the trailing positions', () => {
    // Spec §3.2 is explicit: "if multiple blanks, they all get 0". Averaging 9th and 10th
    // would hand each of them 6.1 points they did not earn (110/9 and 0, halved, at knob 1.1).
    const log = buildLog([
      ...ABLE.slice(0, 8).map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i })),
      { type: 'event_final', event: 'swim' },
    ]);
    const result = run(log);
    const blanks = ABLE.slice(8);
    for (const player of blanks) assert.equal(result.events.swim.points[player], 0);
  });

  test('Bags ranks by HIGHEST score (spec §4.4), not lowest', () => {
    const result = run(GOLDEN_LOG);
    // Tyler threw 21 (the best) and Helwig 3 (the worst).
    assert.equal(result.events.bags.points.Tyler, B(1));
    assert.equal(result.events.bags.points.Helwig, B(11));
    assert.ok(result.events.bags.points.Tyler > result.events.bags.points.Helwig);
    // Swim, by contrast, is lower-is-better: Lucas's 55.0 beats Helwig's 75.0.
    assert.ok(result.events.swim.points.Lucas > result.events.swim.points.Helwig);
  });

  test('n is the configured participant count, not the number of results in hand', () => {
    // Bags has 11 participants, so the raw spacing is 10 per rank — 11 at the default knob.
    const result = run(GOLDEN_LOG);
    assert.equal(round1(result.events.bags.points.Stu - result.events.bags.points.Wyatt), 11);
  });
});

// =======================================================================================
// pending vs blank-zero, across event_final and un-finalize
// =======================================================================================

describe('pending vs blank-zero', () => {
  const partial = buildLog([
    { type: 'time', event: 'swim', player: 'Lucas', value: 55 },
    { type: 'time', event: 'swim', player: 'Wyatt', value: 57 },
  ]);

  test('an incomplete, unfinalized event awards NOBODY points', () => {
    // Awarding partial ranks mid-event would show a slow swimmer who happened to go first
    // sitting in 1st place on the TV.
    const result = run(partial);
    assert.equal(result.events.swim.status, 'pending');
    assert.equal(result.events.swim.pending, true);
    assert.deepEqual(result.events.swim.points, {});
    assert.equal(row(result, 'Lucas').byEvent.swim.points, null);
    assert.equal(row(result, 'Lucas').byEvent.swim.pending, true);
  });

  test('a complete-but-unfinalized event scores, and flags itself for finalizing', () => {
    const log = buildLog([
      ...ABLE.map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i })),
    ]);
    const result = run(log);
    assert.equal(result.events.swim.status, 'unfinalized');
    assert.equal(result.events.swim.complete, true);
    assert.equal(result.events.swim.points[ABLE[0]], S(1));
    assert.equal(row(result, ABLE[0]).byEvent.swim.unfinalized, true);
  });

  test('finalizing an incomplete event turns pending into 0', () => {
    const finalized = append(partial, [{ type: 'event_final', event: 'swim' }]);
    const result = run(finalized);
    assert.equal(result.events.swim.status, 'final');
    assert.equal(result.events.swim.points.Lucas, S(1));
    assert.equal(result.events.swim.points.Helwig, 0, 'no time at finalize = 0 points');
    assert.equal(row(result, 'Helwig').byEvent.swim.pending, false);
  });

  test('UN-finalizing sends the blanks back to pending', () => {
    // Un-finalize is a correction voiding the event_final entry — nothing is deleted.
    const finalized = append(partial, [{ type: 'event_final', event: 'swim' }]);
    const finalId = finalized[finalized.length - 1].id;
    const unfinalized = append(finalized, [{ type: 'correction', targets: finalId }]);
    const result = run(unfinalized);
    assert.equal(result.events.swim.status, 'pending');
    assert.deepEqual(result.events.swim.points, {});
    assert.equal(row(result, 'Helwig').byEvent.swim.pending, true);
  });
});

// =======================================================================================
// Latest-wins: casual re-entry self-heals
// =======================================================================================

describe('latest-wins per logical key', () => {
  test('the key function partitions entries the way the schema says', () => {
    assert.equal(entryKey({ type: 'time', event: 'swim', player: 'Stu' }), 'time:swim:Stu');
    assert.equal(entryKey({ type: 'beerball_game', gameSlot: 3 }), 'beerball_game:3');
    assert.equal(entryKey({ type: 'volleyball_set', matchSlot: 2, setNo: 3 }), 'volleyball_set:2:3');
    assert.equal(entryKey({ type: 'tyler_pick', stage: 'swim' }), 'tyler_pick:swim');
    assert.equal(entryKey({ type: 'knob' }), 'knob');
    assert.equal(entryKey({ type: 'correction', targets: 1 }), null, 'corrections never compete');
  });

  test('re-entering a time replaces it, with no correction needed', () => {
    const log = append(GOLDEN_LOG, [
      { type: 'time', event: 'swim', player: 'Helwig', value: 40 }, // now the fastest
    ]);
    const result = run(log);
    assert.equal(result.events.swim.points.Helwig, S(1));
    assert.equal(result.events.swim.points.Lucas, S(2), 'everyone below shifts down one');
  });

  test('re-entering a game slot fixes a mis-tapped pairing', () => {
    // Game 5 was entered as P2 beating P3; it was actually P3 beating P2.
    const fixed = append(GOLDEN_LOG, [{
      type: 'beerball_game', event: 'beerball', gameSlot: 5,
      pairs: ['P2', 'P3'], winner: 'P3', beers: { P3: 4, P2: 2 },
    }]);
    const result = run(fixed);
    const stats = result.events.beerball.ctx.stats;
    assert.equal(stats.P2.wins, 2, 'P2 loses the win it never had');
    assert.equal(stats.P3.wins, 3);
    assert.equal(result.events.beerball.games.length, 10, 'still ten games, not eleven');
    // P3 now outranks P2 outright.
    assert.deepEqual(result.events.beerball.placements.map((p) => p.id), ['P1', 'P3', 'P2', 'P4', 'P5']);
  });

  test('a re-entered knob wins outright; a re-entered pick still answers to its lock', () => {
    const log = append(GOLDEN_LOG, [
      { type: 'knob', value: 1.5 },
      { type: 'tyler_pick', stage: 'gauntlet', target: 'Josh' },
    ]);
    // The gauntlet pick is re-entered AFTER event_final, so it must be rejected (see below);
    // the knob has no lock and simply wins.
    const result = run(log);
    assert.equal(result.knob, 1.5);
    assert.equal(result.events.swim.points.Lucas, rawPointsForRank(1, 10) * 1.5);
  });

  test('re-entering a draft or an override takes the latest of each', () => {
    // Both keys are (event), so the last statement of each is the one that scores — no
    // correction needed. Here Brad re-drafts volleyball (Brad moves to Team Helwig) and
    // records the chug-off result twice, the second time correctly.
    const redrafted = VOLLEYBALL_TEAMS.map((t) => (
      t.id === 'TM' ? { ...t, members: ['Mitch', 'Stu', 'Josh'] }
        : t.id === 'TH' ? { ...t, members: ['Helwig', 'Yuyi', 'ATM', 'Brad'] }
          : t
    ));
    const log = append(GOLDEN_LOG, [
      { type: 'draft_assignment', event: 'volleyball', teams: redrafted },
      { type: 'override', event: 'beerball', placements: ['P5', 'P4', 'P3', 'P2', 'P1'], reason: 'chug-off' },
      { type: 'override', event: 'beerball', placements: ['P4', 'P5', 'P3', 'P2', 'P1'], reason: 'chug-off, recorded right' },
    ]);
    const result = run(log);

    // Team Mitch still finished 2nd for 50 — but Brad is on last-place Team Helwig now.
    assert.equal(result.events.volleyball.points.Mitch, 50);
    assert.equal(result.events.volleyball.points.Brad, 0);
    assert.equal(codes(result).includes('bad-team-sizes'), false, '4/3/3 is still 4/3/3');

    // The second override is the whole truth: the first is not blended into it.
    assert.equal(result.events.beerball.teamPoints.P4, 100);
    assert.equal(result.events.beerball.teamPoints.P5, 75);
    assert.equal(result.events.beerball.overrideReason, 'chug-off, recorded right');
  });

  test('only the LAST volleyball set for a slot counts', () => {
    const log = append(GOLDEN_LOG, [
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 2, scores: { TM: 18, TH: 21 } },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 3, scores: { TM: 15, TH: 21 } },
    ]);
    const result = run(log);
    // TH now takes match 1 (sets 2 and 3), so TM drops to zero wins.
    assert.equal(result.events.volleyball.ctx.stats.TH.wins, 1);
    assert.equal(result.events.volleyball.ctx.stats.TM.wins, 0);
  });
});

// =======================================================================================
// Corrections and UUID dedupe
// =======================================================================================

describe('corrections', () => {
  const base = buildLog([
    { type: 'time', event: 'swim', player: 'Lucas', value: 55 },
    { type: 'time', event: 'swim', player: 'Wyatt', value: 57 },
  ]);

  test('a void correction removes the target entirely', () => {
    const log = append(base, [{ type: 'correction', targets: 1 }]);
    const effective = effectiveLog(log);
    assert.equal(effective.some((e) => e.type === 'time' && e.player === 'Lucas'), false);
    assert.equal(effective.length, 1);
  });

  test('a replacement correction substitutes a new value', () => {
    const log = append(base, [{
      type: 'correction', targets: 1,
      replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 61 },
    }]);
    const effective = effectiveLog(log);
    const lucas = effective.find((e) => e.type === 'time' && e.player === 'Lucas');
    assert.equal(lucas.value, 61);
    assert.equal(lucas.correctedFrom, 1, 'the replacement remembers what it replaced');
    assert.equal(effective.some((e) => e.value === 55), false, 'the fat-fingered value is gone');
  });

  test('a replacement beats a re-entry made in between (latest intent wins)', () => {
    const log = append(base, [
      { type: 'time', event: 'swim', player: 'Lucas', value: 58 }, // re-entry
      { type: 'correction', targets: 1, replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 61 } },
    ]);
    const effective = effectiveLog(log);
    const latest = effective.filter((e) => e.type === 'time' && e.player === 'Lucas').pop();
    assert.equal(latest.value, 61);
  });

  test('correcting a correction undoes the undo', () => {
    const voided = append(base, [{ type: 'correction', targets: 1 }]);
    const correctionId = voided[voided.length - 1].id;
    const restored = append(voided, [{ type: 'correction', targets: correctionId }]);
    const effective = effectiveLog(restored);
    const lucas = effective.find((e) => e.type === 'time' && e.player === 'Lucas');
    assert.ok(lucas, "Lucas's original time is live again");
    assert.equal(lucas.value, 55);
  });

  test('undoing a replacement restores the original value', () => {
    const replaced = append(base, [{
      type: 'correction', targets: 1,
      replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 61 },
    }]);
    const correctionId = replaced[replaced.length - 1].id;
    const undone = append(replaced, [{ type: 'correction', targets: correctionId }]);
    const effective = effectiveLog(undone);
    const lucas = effective.find((e) => e.type === 'time' && e.player === 'Lucas');
    assert.equal(lucas.value, 55);
  });

  test('TWO corrections targeting one entry resolve deterministically to the later', () => {
    // Brad fixes a time, then fixes his fix. Both corrections are alive and both aim at the
    // same original entry. This must not be undefined behaviour: each surviving replacement
    // enters at its own id, so ordinary latest-wins picks the highest.
    const log = append(base, [
      { type: 'correction', targets: 1, replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 61 } },
      { type: 'correction', targets: 1, replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 63 } },
    ]);
    const effective = effectiveLog(log);
    const lucas = effective.filter((e) => e.type === 'time' && e.player === 'Lucas');
    assert.deepEqual(lucas.map((e) => e.value), [61, 63], 'both survive, in id order');

    const result = score(effective);
    assert.equal(result.events.swim.values.Lucas, 63, 'the later correction is what scores');
    // The original is gone from the effective log but still in the raw log for audit.
    assert.equal(effective.some((e) => e.value === 55), false);
    assert.equal(log.some((e) => e.value === 55), true);
  });

  test('voiding the later of two competing corrections falls back to the earlier', () => {
    const log = append(base, [
      { type: 'correction', targets: 1, replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 61 } },
      { type: 'correction', targets: 1, replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 63 } },
    ]);
    const laterId = log[log.length - 1].id;
    const result = score(effectiveLog(append(log, [{ type: 'correction', targets: laterId }])));
    assert.equal(result.events.swim.values.Lucas, 61);
  });

  test('a correction chain three deep terminates and resolves', () => {
    // void → un-void → re-void. Each correction has a higher id than its target, so the
    // descending resolution pass always terminates.
    let log = append(base, [{ type: 'correction', targets: 1 }]);
    for (let depth = 0; depth < 2; depth += 1) {
      log = append(log, [{ type: 'correction', targets: log[log.length - 1].id }]);
    }
    const effective = effectiveLog(log);
    // Odd number of stacked voids on the chain ⇒ the original is voided again.
    assert.equal(effective.some((e) => e.type === 'time' && e.player === 'Lucas'), false);
  });

  test('a correction targeting an id that does not exist is inert', () => {
    const result = score(effectiveLog(append(base, [{ type: 'correction', targets: 9999 }])));
    assert.equal(result.events.swim.values.Lucas, 55);
  });

  test('corrections are applied BEFORE any replay slice, so replay never shows a typo', () => {
    const log = append(base, [{ type: 'correction', targets: 1 }]);
    const effective = effectiveLog(log);
    for (let i = 0; i <= effective.length; i += 1) {
      const slice = effective.slice(0, i);
      assert.equal(slice.some((e) => e.value === 55), false);
    }
  });

  test('nothing is mutated: the raw log survives untouched', () => {
    const log = append(base, [{ type: 'correction', targets: 1 }]);
    const snapshot = JSON.stringify(log);
    effectiveLog(log);
    assert.equal(JSON.stringify(log), snapshot);
  });
});

describe('UUID dedupe', () => {
  test('a double-tapped save records exactly one entry', () => {
    const log = [
      { id: 1, uuid: 'same', ts: 1, type: 'time', event: 'swim', player: 'Lucas', value: 55 },
      { id: 2, uuid: 'same', ts: 2, type: 'time', event: 'swim', player: 'Lucas', value: 55 },
    ];
    assert.equal(effectiveLog(log).length, 1);
  });

  test('the first arrival wins when a retry carries a changed payload', () => {
    const log = [
      { id: 1, uuid: 'same', ts: 1, type: 'time', event: 'swim', player: 'Lucas', value: 55 },
      { id: 2, uuid: 'same', ts: 2, type: 'time', event: 'swim', player: 'Lucas', value: 99 },
    ];
    assert.equal(effectiveLog(log)[0].value, 55);
  });

  test('an out-of-order log is normalized by id before anything else', () => {
    const log = [
      { id: 3, uuid: 'c', ts: 3, type: 'time', event: 'swim', player: 'Murph', value: 58 },
      { id: 1, uuid: 'a', ts: 1, type: 'time', event: 'swim', player: 'Lucas', value: 55 },
      { id: 2, uuid: 'b', ts: 2, type: 'correction', targets: 1 },
    ];
    const effective = effectiveLog(log);
    assert.deepEqual(effective.map((e) => e.id), [3]);
  });
});

// =======================================================================================
// Round-robin tie resolution
// =======================================================================================

describe('group-wise tie resolution', () => {
  /** Three pairs at 3 wins each with identical beer differentials and circular head-to-head. */
  const CIRCULAR_GAMES = [
    { gameSlot: 1, pairs: ['P1', 'P2'], winner: 'P1', beers: { P1: 4, P2: 2 } },
    { gameSlot: 2, pairs: ['P2', 'P3'], winner: 'P2', beers: { P2: 4, P3: 2 } },
    { gameSlot: 3, pairs: ['P3', 'P1'], winner: 'P3', beers: { P3: 4, P1: 2 } },
    { gameSlot: 4, pairs: ['P1', 'P4'], winner: 'P1', beers: { P1: 4, P4: 2 } },
    { gameSlot: 5, pairs: ['P1', 'P5'], winner: 'P1', beers: { P1: 4, P5: 2 } },
    { gameSlot: 6, pairs: ['P2', 'P4'], winner: 'P2', beers: { P2: 4, P4: 2 } },
    { gameSlot: 7, pairs: ['P2', 'P5'], winner: 'P2', beers: { P2: 4, P5: 2 } },
    { gameSlot: 8, pairs: ['P3', 'P4'], winner: 'P3', beers: { P3: 4, P4: 2 } },
    { gameSlot: 9, pairs: ['P3', 'P5'], winner: 'P3', beers: { P3: 4, P5: 2 } },
    { gameSlot: 10, pairs: ['P4', 'P5'], winner: 'P4', beers: { P4: 4, P5: 2 } },
  ];

  const circularLog = buildLog([
    { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
    ...CIRCULAR_GAMES.map((g) => ({ type: 'beerball_game', event: 'beerball', ...g })),
    { type: 'event_final', event: 'beerball' },
  ]);

  test('a 3-way circular head-to-head is DETECTED, not silently ordered', () => {
    const result = run(circularLog);
    const stats = result.events.beerball.ctx.stats;
    // Precondition: the knot is real — equal wins, equal beer differential.
    assert.deepEqual([stats.P1.wins, stats.P2.wins, stats.P3.wins], [3, 3, 3]);
    assert.deepEqual([stats.P1.beerDiff, stats.P2.beerDiff, stats.P3.beerDiff], [4, 4, 4]);

    assert.equal(result.events.beerball.manualRequired, true);
    assert.deepEqual(result.events.beerball.unresolved, [['P1', 'P2', 'P3']]);
    const issue = result.issues.find((i) => i.code === 'manual-resolution-required');
    assert.ok(issue, 'the knot must surface as an error demanding a chug-off');
    assert.match(issue.message, /chug-off/);
  });

  test('the tied group shares the points for the positions it occupies, and stays flagged', () => {
    const result = run(circularLog);
    const shared = (100 + 75 + 50) / 3;
    for (const pair of ['P1', 'P2', 'P3']) {
      assert.equal(result.events.beerball.teamPoints[pair], shared);
    }
    assert.equal(result.events.beerball.teamPoints.P4, 25);
    assert.equal(result.events.beerball.teamPoints.P5, 0);
    assert.equal(row(result, 'Yuyi').byEvent.beerball.flagged, true);
  });

  test('an override resolves the knot and clears the manual flag', () => {
    const resolved = append(circularLog, [{
      type: 'override', event: 'beerball',
      placements: ['P2', 'P3', 'P1', 'P4', 'P5'], reason: 'chug-off: P2 over P3 over P1',
    }]);
    const result = run(resolved);
    assert.equal(result.events.beerball.manualRequired, false);
    assert.equal(result.events.beerball.teamPoints.P2, 100);
    assert.equal(result.events.beerball.teamPoints.P1, 50);
    assert.equal(result.events.beerball.overridden, true);
  });

  test('head-to-head separates a 2-way tie without needing a chug-off', () => {
    // Rewriting games 2 and 3 leaves P2 and P3 level on wins, with P3 holding the head-to-head
    // (it took game 2). The wins come from the hand-set ctx below, and `headToHeadWins` reads
    // nothing but pairs and winner — no beer counts are involved in this one.
    const games = CIRCULAR_GAMES.map((g) => (
      g.gameSlot === 2 ? { ...g, winner: 'P3' } // P2 loses to P3
        : g.gameSlot === 3 ? { ...g, winner: 'P1' } // P1 beats P3
          : g
    ));
    const ctx = {
      stats: { P1: { wins: 4 }, P2: { wins: 2 }, P3: { wins: 2 }, P4: { wins: 1 }, P5: { wins: 0 } },
      headToHeadWins: (id, group) => games.reduce((w, g) => (
        group.includes(g.pairs[0]) && group.includes(g.pairs[1]) && g.winner === id ? w + 1 : w
      ), 0),
    };
    const groups = resolveGroup(['P1', 'P2', 'P3', 'P4', 'P5'], ['wins', 'headToHead'], ctx);
    assert.ok(groups.every((g) => g.resolved), 'nothing should remain unresolved');
    assert.deepEqual(groups.map((g) => g.members[0]), ['P1', 'P3', 'P2', 'P4', 'P5']);
  });

  test('head-to-head is computed WITHIN the tied subgroup only', () => {
    // A beat B; both lost to an outsider C who is not in the group. Only the A–B game counts.
    const games = [
      { pairs: ['A', 'B'], winner: 'A' },
      { pairs: ['C', 'A'], winner: 'C' },
      { pairs: ['C', 'B'], winner: 'C' },
    ];
    const ctx = {
      stats: { A: { wins: 1 }, B: { wins: 1 } },
      headToHeadWins: (id, group) => games.reduce((w, g) => (
        group.includes(g.pairs[0]) && group.includes(g.pairs[1]) && g.winner === id ? w + 1 : w
      ), 0),
    };
    const groups = resolveGroup(['A', 'B'], ['wins', 'headToHead'], ctx);
    assert.deepEqual(groups.map((g) => g.members[0]), ['A', 'B']);
    assert.ok(groups.every((g) => g.resolved));
  });

  test('a rule that separates nothing falls through to the next one', () => {
    const ctx = { stats: { A: { wins: 2, pointDiff: 5 }, B: { wins: 2, pointDiff: -5 } } };
    const groups = resolveGroup(['A', 'B'], ['wins', 'pointDiff'], ctx);
    assert.deepEqual(groups.map((g) => g.members[0]), ['A', 'B']);
    assert.ok(groups.every((g) => g.resolved));
  });
});

// =======================================================================================
// Volleyball best-of-3
// =======================================================================================

describe('volleyball best-of-3', () => {
  const result = run(GOLDEN_LOG);

  test('a 2-0 sweep is one win, and only two sets count toward the differential', () => {
    const match = result.events.volleyball.matches.find((m) => m.matchSlot === 1);
    assert.equal(match.winner, 'TM');
    assert.deepEqual(match.setWins, { TM: 2 });
    assert.equal(match.sets.length, 2);
  });

  test('a 2-1 match is still exactly one win for the winner', () => {
    const match = result.events.volleyball.matches.find((m) => m.matchSlot === 2);
    assert.equal(match.winner, 'TW');
    assert.deepEqual(match.setWins, { TW: 2, TM: 1 });
    assert.equal(result.events.volleyball.ctx.stats.TW.wins, 2, 'two matches won, not four sets');
  });

  test('point differential sums set margins across ALL sets played', () => {
    // TM: (21−15) + (21−18) + (19−21) + (21−17) + (11−15) = 6 + 3 − 2 + 4 − 4 = 7
    assert.equal(result.events.volleyball.ctx.stats.TM.pointDiff, 7);
    // TH: (15−21) + (18−21) + (12−21) + (19−21) = −6 − 3 − 9 − 2 = −20
    assert.equal(result.events.volleyball.ctx.stats.TH.pointDiff, -20);
    // TW: (21−19) + (17−21) + (15−11) + (21−12) + (21−19) = 2 − 4 + 4 + 9 + 2 = 13
    assert.equal(result.events.volleyball.ctx.stats.TW.pointDiff, 13);
    // The three must cancel out — every point is somebody's gain and somebody's loss.
    const { TM, TH, TW } = result.events.volleyball.ctx.stats;
    assert.equal(TM.pointDiff + TH.pointDiff + TW.pointDiff, 0);
  });

  test('total points is the sum of a team\'s own scores across every set', () => {
    // TM: 21 + 21 + 19 + 21 + 11 = 93
    assert.equal(result.events.volleyball.ctx.stats.TM.totalPoints, 93);
  });

  test('an undecided match keeps the whole event pending', () => {
    const log = buildLog([
      { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 1, scores: { TM: 21, TH: 15 } },
    ]);
    const result2 = run(log);
    assert.equal(result2.events.volleyball.status, 'pending');
  });

  test('a 2/1/0 spread is decided on wins alone, before any tiebreaker runs', () => {
    const sets = [
      { matchSlot: 1, setNo: 1, scores: { TM: 21, TH: 5 } },
      { matchSlot: 1, setNo: 2, scores: { TM: 21, TH: 5 } },
      { matchSlot: 2, setNo: 1, scores: { TM: 19, TW: 21 } },
      { matchSlot: 2, setNo: 2, scores: { TM: 17, TW: 21 } },
      { matchSlot: 3, setNo: 1, scores: { TH: 19, TW: 21 } },
      { matchSlot: 3, setNo: 2, scores: { TH: 19, TW: 21 } },
    ];
    const log = buildLog([
      { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
      ...sets.map((s) => ({ type: 'volleyball_set', event: 'volleyball', ...s })),
      { type: 'event_final', event: 'volleyball' },
    ]);
    const result2 = run(log);
    // TW 2 wins, TM 1, TH 0 — decided on wins alone, no tie needed.
    assert.deepEqual(result2.events.volleyball.placements.map((p) => p.id), ['TW', 'TM', 'TH']);
    assert.equal(result2.events.volleyball.manualRequired, false);
  });

  test('point differential breaks a circular tie on wins (spec §4.5)', () => {
    // Each team wins exactly one match, so `wins` separates nobody and the second rule decides.
    //   M1  TM 21-10, 21-10 TH   → TM +22, TH −22
    //   M2  TW 21-5,  21-5  TM   → TW +32, TM −32
    //   M3  TH 21-19, TW 21-19, TH 21-19  → TH +2, TW −2
    // Differentials: TW +30, TM −10, TH −20 (which sum to 0, as they must).
    const sets = [
      { matchSlot: 1, setNo: 1, scores: { TM: 21, TH: 10 } },
      { matchSlot: 1, setNo: 2, scores: { TM: 21, TH: 10 } },
      { matchSlot: 2, setNo: 1, scores: { TM: 5, TW: 21 } },
      { matchSlot: 2, setNo: 2, scores: { TM: 5, TW: 21 } },
      { matchSlot: 3, setNo: 1, scores: { TH: 21, TW: 19 } },
      { matchSlot: 3, setNo: 2, scores: { TH: 19, TW: 21 } },
      { matchSlot: 3, setNo: 3, scores: { TH: 21, TW: 19 } },
    ];
    const log = buildLog([
      { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
      ...sets.map((s) => ({ type: 'volleyball_set', event: 'volleyball', ...s })),
      { type: 'event_final', event: 'volleyball' },
    ]);
    const result2 = run(log);
    const stats = result2.events.volleyball.ctx.stats;

    // Precondition: the knot is real — one win each.
    assert.deepEqual([stats.TM.wins, stats.TH.wins, stats.TW.wins], [1, 1, 1]);
    assert.deepEqual([stats.TW.pointDiff, stats.TM.pointDiff, stats.TH.pointDiff], [30, -10, -20]);

    assert.deepEqual(result2.events.volleyball.placements.map((p) => p.id), ['TW', 'TM', 'TH']);
    assert.equal(result2.events.volleyball.manualRequired, false, 'point differential settles it');
    assert.equal(result2.events.volleyball.teamPoints.TW, 100);
    assert.equal(result2.events.volleyball.teamPoints.TH, 0);
  });

  test('a 2–2 match has no winner: the extra set is flagged, not silently decisive', () => {
    // A fourth set means a mis-numbered entry. Both teams clear `setsToWin`, and picking the
    // one whose set happened to land first would invent a match result out of key order.
    const log = buildLog([
      { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 1, scores: { TM: 21, TH: 10 } },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 2, scores: { TM: 10, TH: 21 } },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 3, scores: { TM: 21, TH: 10 } },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 4, scores: { TM: 10, TH: 21 } },
    ]);
    const result2 = run(log);
    const match = result2.events.volleyball.matches[0];

    assert.deepEqual(match.setWins, { TM: 2, TH: 2 });
    assert.equal(match.winner, null, 'nobody took the match');
    assert.equal(match.extraSets, true);
    assert.equal(result2.events.volleyball.status, 'pending');
    const issue = result2.issues.find((i) => i.code === 'too-many-sets');
    assert.ok(issue, 'the fourth set must surface');
    assert.equal(issue.level, 'warn');
    // Every set played still counts toward the differential (Brad, 2026-08-13): +11 −11 +11 −11.
    assert.equal(result2.events.volleyball.ctx.stats.TM.pointDiff, 0);
  });

  test('a 3–1 match still resolves, and still flags the extra set', () => {
    const log = buildLog([
      { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 1, scores: { TM: 21, TH: 10 } },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 2, scores: { TM: 10, TH: 21 } },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 3, scores: { TM: 21, TH: 10 } },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 4, scores: { TM: 21, TH: 10 } },
    ]);
    const result2 = run(log);
    const match = result2.events.volleyball.matches[0];
    assert.equal(match.winner, 'TM');
    assert.equal(match.extraSets, true);
    assert.ok(codes(result2).includes('too-many-sets'));
  });
});

// =======================================================================================
// Tyler: burns, pools, and the lock boundary
// =======================================================================================

describe("Tyler's burn ledger", () => {
  test('the pool shrinks as the weekend progresses', () => {
    const log = buildLog([
      { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS }, // burns Brad, Wyatt
      { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
    ]);
    const result = run(log);
    const swimSlot = result.burns.slots.find((s) => s.stage === 'swim');
    assert.equal(swimSlot.eligible.includes('Brad'), false);
    assert.equal(swimSlot.eligible.includes('Wyatt'), false);
    assert.equal(swimSlot.eligible.length, 8);
  });

  test('a volleyball pool can narrow to exactly one eligible team', () => {
    // Burn Wyatt via the Beer Ball pair and Helwig via the Swim pick: of the three volleyball
    // captains (Mitch, Helwig, Wyatt) only Mitch survives, so only Team Mitch may be picked.
    const log = buildLog([
      { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
      { type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS },
      { type: 'tyler_pick', stage: 'swim', target: 'Helwig' },
    ]);
    const result = run(log);
    const volleySlot = result.burns.slots.find((s) => s.stage === 'volleyball');
    assert.deepEqual(volleySlot.eligible, ['TM']);
  });

  test('picking a volleyball team burns its CAPTAIN only, never the whole roster', () => {
    const result = run(GOLDEN_LOG);
    // Team Mitch is Mitch, Stu, Josh, Brad — but only Mitch is burned by the pick.
    assert.deepEqual(result.burns.slots.map((s) => s.player), ['Brad', 'Wyatt', 'Lucas', 'Mitch', 'Stu']);
    // Stu is on the picked team AND is later burned by the Gauntlet pick, which is legal.
    assert.equal(result.burns.duplicates.length, 0);
  });

  test('a team pick made before its draft stays unresolved instead of burning nobody', () => {
    // Brad types Tyler's volleyball pick before entering the volleyball draft. `TM` means
    // nothing yet, so the slot must wait — burning `null` would put a hole in the burn list
    // and cost the slot the eligible pool the admin screen shows.
    const log = buildLog([
      { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
      { type: 'tyler_pick', stage: 'volleyball', target: 'TM' },
    ]);
    const result = run(log);
    const slot = result.burns.slots.find((s) => s.stage === 'volleyball');

    assert.equal(result.burns.burned.includes(null), false, 'nobody is burned by an unknown team');
    assert.equal(slot.player, null);
    assert.equal(slot.unresolvedTarget, 'TM');
    assert.ok(Array.isArray(slot.eligible), 'the slot keeps its eligible pool');
    assert.ok(codes(result).includes('pick-target-unknown'));

    // It heals itself the moment the draft lands — no correction needed.
    const drafted = append(log, [{ type: 'draft_assignment', event: 'volleyball', teams: VOLLEYBALL_TEAMS }]);
    const healed = run(drafted);
    assert.equal(healed.burns.slots.find((s) => s.stage === 'volleyball').player, 'Mitch');
    assert.equal(codes(healed).includes('pick-target-unknown'), false);
  });

  test('correcting a pick before the event recomputes the pool', () => {
    const log = buildLog([
      { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
      { type: 'tyler_pick', stage: 'swim', target: 'Lucas' },
    ]);
    const corrected = append(log, [{
      type: 'correction', targets: 2,
      replacement: { type: 'tyler_pick', stage: 'swim', target: 'Murph' },
    }]);
    const result = run(corrected);
    assert.equal(result.burns.slots.find((s) => s.stage === 'swim').player, 'Murph');
    // Lucas is back in the pool for the Gauntlet.
    assert.ok(result.burns.slots.find((s) => s.stage === 'gauntlet').eligible.includes('Lucas'));
  });

  test('a pick entered AFTER that event is finalized is rejected, not applied', () => {
    // Spec §6.1: picks lock before their event.
    const log = append(GOLDEN_LOG, [{ type: 'tyler_pick', stage: 'gauntlet', target: 'Josh' }]);
    const result = run(log);
    const issue = result.issues.find((i) => i.code === 'pick-after-lock');
    assert.ok(issue, 'a late pick must be rejected loudly');
    assert.match(issue.message, /Un-finalize/);
    // The original pick still stands and still scores.
    assert.equal(result.burns.slots.find((s) => s.stage === 'gauntlet').player, 'Stu');
    assert.equal(result.events.gauntlet.points.Tyler, result.events.gauntlet.points.Stu);
  });

  test('un-finalizing reopens the pick', () => {
    const finalId = GOLDEN_LOG.find((e) => e.type === 'event_final' && e.event === 'gauntlet').id;
    const log = append(GOLDEN_LOG, [
      { type: 'correction', targets: finalId },
      { type: 'tyler_pick', stage: 'gauntlet', target: 'Josh' },
    ]);
    const result = run(log);
    assert.equal(codes(result).includes('pick-after-lock'), false);
    assert.equal(result.burns.slots.find((s) => s.stage === 'gauntlet').player, 'Josh');
  });

  test('Tyler earns nothing for an event he has not picked, and is told so', () => {
    const log = buildLog([
      ...ABLE.map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i })),
      { type: 'event_final', event: 'swim' },
    ]);
    const result = run(log);
    assert.equal(row(result, 'Tyler').byEvent.swim.points, null);
    assert.ok(codes(result).includes('tyler-no-pick'));
  });
});

// =======================================================================================
// Participant validation
// =======================================================================================

describe('participant validation', () => {
  test('a Swim time for Tyler is rejected and never scored', () => {
    // Spec §4.3: Swim is the 10 able players. Tyler backs a swimmer, he does not swim.
    const log = buildLog([
      ...ABLE.map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i })),
      { type: 'time', event: 'swim', player: 'Tyler', value: 1 },
      { type: 'tyler_pick', stage: 'swim', target: 'Stu' },
      { type: 'event_final', event: 'swim' },
    ]);
    const result = run(log);
    const issue = result.issues.find((i) => i.code === 'not-a-participant');
    assert.ok(issue);
    assert.equal(issue.player, 'Tyler');
    // His swim points come from his pick, not from the bogus 1-second time.
    assert.equal(result.events.swim.points.Tyler, result.events.swim.points.Stu);
  });

  test('Tyler DOES play Bags, so a Bags score for him is perfectly valid', () => {
    const result = run(GOLDEN_LOG);
    assert.equal(codes(result).filter((c) => c === 'not-a-participant').length, 0);
    assert.equal(result.events.bags.points.Tyler, B(1));
  });

  test('drafting a non-participant onto a team is flagged', () => {
    const teams = [
      { id: 'TM', captain: 'Mitch', members: ['Mitch', 'Stu', 'Josh', 'Tyler'] }, // Tyler can't play
      { id: 'TH', captain: 'Helwig', members: ['Helwig', 'Yuyi', 'ATM'] },
      { id: 'TW', captain: 'Wyatt', members: ['Wyatt', 'Murph', 'Lucas'] },
    ];
    const result = run(buildLog([{ type: 'draft_assignment', event: 'volleyball', teams }]));
    const issue = result.issues.find((i) => i.code === 'not-a-participant');
    assert.ok(issue);
    assert.equal(issue.player, 'Tyler');
  });

  test('an incomplete draft is a warning, not a hard error', () => {
    const teams = [{ id: 'A', captain: 'Murph', members: ['Murph', 'Lucas'] }];
    const result = run(buildLog([{ type: 'draft_assignment', event: 'wiffle', teams }]));
    const issue = result.issues.find((i) => i.code === 'undrafted');
    assert.ok(issue);
    assert.equal(issue.level, 'warn');
  });
});

// =======================================================================================
// Overrides
// =======================================================================================

describe('override supremacy and flag propagation', () => {
  test('an override supersedes a fully computed result', () => {
    const log = append(GOLDEN_LOG, [{
      type: 'override', event: 'volleyball',
      placements: ['TH', 'TM', 'TW'], reason: 'play-in at Brad\'s discretion',
    }]);
    const result = run(log);
    assert.equal(result.events.volleyball.teamPoints.TH, 100);
    assert.equal(result.events.volleyball.teamPoints.TW, 0);
    // ...even though TW actually won both its matches.
    assert.equal(result.events.volleyball.ctx.stats.TW.wins, 2);
  });

  test('the flag reaches every affected player row', () => {
    const log = append(GOLDEN_LOG, [{
      type: 'override', event: 'beerball',
      placements: ['P5', 'P4', 'P3', 'P2', 'P1'], reason: 'chug-off',
    }]);
    const result = run(log);
    for (const player of ['Yuyi', 'Stu', 'Brad', 'Wyatt']) {
      assert.equal(row(result, player).byEvent.beerball.flagged, true, `${player} should be flagged`);
    }
    assert.equal(row(result, 'Yuyi').byEvent.swim.flagged, false, 'the flag stays on its own event');
  });

  test("Tyler's backed points follow the override too", () => {
    const log = append(GOLDEN_LOG, [{
      type: 'override', event: 'beerball',
      placements: ['P5', 'P4', 'P3', 'P2', 'P1'], reason: 'chug-off',
    }]);
    const result = run(log);
    assert.equal(result.events.beerball.teamPoints.P5, 100);
    assert.equal(result.events.beerball.points.Tyler, 100, "Tyler rides his pair's overridden result");
  });

  test('an override on an individual event follows the §3.2 formula from the stated order', () => {
    const order = ['Helwig', 'Brad', 'Josh', 'ATM', 'Yuyi', 'Mitch', 'Stu', 'Murph', 'Wyatt', 'Lucas'];
    const log = append(GOLDEN_LOG, [{
      type: 'override', event: 'swim', placements: order, reason: 'timing system failure; judged order',
    }]);
    const result = run(log);
    assert.equal(result.events.swim.points.Helwig, S(1));
    assert.equal(result.events.swim.points.Lucas, S(10));
    assert.equal(result.events.swim.overridden, true);
  });

  test('an override makes an otherwise-incomplete event scoreable', () => {
    const log = buildLog([
      { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
      { type: 'override', event: 'beerball', placements: ['P1', 'P2', 'P3', 'P4', 'P5'], reason: 'scorekeeping skipped' },
    ]);
    const result = run(log);
    assert.notEqual(result.events.beerball.status, 'pending');
    assert.equal(result.events.beerball.teamPoints.P1, 100);
  });
});

// =======================================================================================
// Championship: the full §7 chain
// =======================================================================================

describe('championship tiebreak chain (spec §7)', () => {
  /**
   * A perfect reversal: whoever is rank r in the Swim is rank 11−r in the Gauntlet, and Bags is
   * a dead heat where all 11 throw the same score (so everyone shares the whole ladder: 55
   * points, placement 6). Every able player therefore totals exactly 165 in real arithmetic —
   * and exactly 17/3 average placement, over all three individual events — so the §7 chain has
   * to run the whole way to beer pong.
   */
  const reversal = (() => {
    const swim = ABLE.map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i }));
    const bags = ROSTER.map((player) => ({ type: 'time', event: 'bags', player, value: 12 }));
    const gauntlet = [...ABLE].reverse().map((player, i) => (
      { type: 'time', event: 'gauntlet', player, value: 50 + i }
    ));
    return buildLog([
      ...swim, { type: 'event_final', event: 'swim' },
      ...bags, { type: 'event_final', event: 'bags' },
      ...gauntlet, { type: 'event_final', event: 'gauntlet' },
    ]);
  })();

  test('totals differing only in float dust compare as TIED at 1 decimal', () => {
    const result = run(reversal);
    const able = result.players.filter((p) => p.player !== 'Tyler');

    const raw = new Set(able.map((p) => p.total));
    assert.ok(raw.size > 1, 'precondition: the raw float totals are NOT all identical');

    const rounded = new Set(able.map((p) => p.totalRounded));
    assert.deepEqual([...rounded], [165], 'but at 1 decimal every one of them is 165.0');

    for (const player of able) assert.equal(player.rankLabel, 'T1');
  });

  test('with totals AND average placement tied, §7 calls for beer pong', () => {
    const result = run(reversal);
    const able = result.players.filter((p) => p.player !== 'Tyler');
    // (swim r + bags 6 + gauntlet 11−r) / 3 = 17/3, for every one of them.
    for (const player of able) {
      assert.equal(player.avgIndividualPlacement, 17 / 3);
      assert.equal(player.individualPlacements, 3, 'all three placements are in hand');
    }

    assert.equal(result.championship.player, null, 'no champion may be invented');
    assert.equal(result.championship.contenders.length, 10);
    assert.ok(codes(result).includes('championship-tie'));
  });

  test('a championship_tiebreak entry crowns the champion', () => {
    const log = append(reversal, [{ type: 'championship_tiebreak', winner: 'Stu' }]);
    const result = run(log);
    assert.equal(result.championship.player, 'Stu');
    assert.equal(result.championship.resolvedBy, 'championship_tiebreak');
  });

  test('a tiebreak naming someone who is not tied does not crown them', () => {
    const log = append(reversal, [{ type: 'championship_tiebreak', winner: 'Tyler' }]);
    const result = run(log);
    assert.equal(result.championship.player, null);
  });

  /**
   * Middle link: two players tie at exactly 213.9 but on different routes.
   *   X — Swim 1st (110) + Bags 11th (0)  + Gauntlet T1st (103.89) → placements (1 + 11 + 1.5)/3 = 4.5
   *   Y — Swim 10th (0)  + Bags 1st (110) + Gauntlet T1st (103.89) → placements (10 + 1 + 1.5)/3 ≈ 4.17  ← lower wins
   *
   * The Gauntlet dead heat is what keeps them level while handing both of them a complete set
   * of three individual placements, which §7's average-placement step requires. Everyone else
   * is paired to land far below: the best of them is Murph at 108.78 + 85.56 = 194.3.
   */
  test('a tie on total is broken by the lowest average individual placement', () => {
    const swimOrder = ['Stu', 'Murph', 'Josh', 'Lucas', 'Mitch', 'Yuyi', 'ATM', 'Helwig', 'Brad', 'Wyatt'];
    //  X = Stu (swim 1st, bags 11th) · Y = Wyatt (swim 10th, bags 1st)
    const bagsOrder = ['Wyatt', 'Tyler', 'Brad', 'Helwig', 'ATM', 'Yuyi', 'Mitch', 'Lucas', 'Josh', 'Murph', 'Stu'];
    const gauntletOrder = ['Murph', 'Josh', 'Lucas', 'Mitch', 'Yuyi', 'ATM', 'Helwig', 'Brad'];

    const log = buildLog([
      ...swimOrder.map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i })),
      { type: 'tyler_pick', stage: 'swim', target: 'Wyatt' }, // Tyler rides the slowest swimmer: 0
      { type: 'event_final', event: 'swim' },
      ...bagsOrder.map((player, i) => ({ type: 'time', event: 'bags', player, value: 100 - i })),
      { type: 'event_final', event: 'bags' },
      // Stu and Wyatt dead-heat the Gauntlet and split 1st/2nd; the other eight finish behind.
      { type: 'time', event: 'gauntlet', player: 'Stu', value: 40 },
      { type: 'time', event: 'gauntlet', player: 'Wyatt', value: 40 },
      ...gauntletOrder.map((player, i) => ({ type: 'time', event: 'gauntlet', player, value: 50 + i })),
      { type: 'event_final', event: 'gauntlet' },
    ]);
    const result = run(log);

    assert.equal(row(result, 'Stu').totalRounded, 213.9);
    assert.equal(row(result, 'Wyatt').totalRounded, 213.9);
    assert.equal(row(result, 'Stu').avgIndividualPlacement, 13.5 / 3);
    assert.equal(row(result, 'Wyatt').avgIndividualPlacement, 12.5 / 3);
    // Nobody else comes close.
    const others = result.players.filter((p) => !['Stu', 'Wyatt'].includes(p.player));
    for (const player of others) assert.ok(player.totalRounded < 213.9, `${player.player} < 213.9`);

    assert.equal(result.championship.player, 'Wyatt');
    assert.equal(result.championship.resolvedBy, 'avgIndividualPlacement');
  });

  test('an incomplete placement set never decides the title — §7 goes to beer pong instead', () => {
    // Same tie, but Tyler is in it with only two of the three placements: he plays Bags, backs
    // Wyatt in the Swim, and never picked for the Gauntlet. A 2-event average is not the same
    // quantity as a 3-event one, so it cannot be what crowns or dethrones anybody.
    const swimOrder = ['Stu', 'Murph', 'Josh', 'Lucas', 'Mitch', 'Yuyi', 'ATM', 'Helwig', 'Brad', 'Wyatt'];
    const log = buildLog([
      ...swimOrder.map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i })),
      { type: 'tyler_pick', stage: 'swim', target: 'Stu' }, // Tyler rides the winner: 110
      { type: 'event_final', event: 'swim' },
      ...ROSTER.map((player) => ({ type: 'time', event: 'bags', player, value: 12 })), // dead heat: 55 each
      { type: 'event_final', event: 'bags' },
      { type: 'event_final', event: 'gauntlet' }, // finalized with no times at all: 0 for everyone
    ]);
    const result = run(log);

    // Stu and Tyler both hold 110 + 55; Tyler has 2 placements to Stu's 3.
    assert.equal(row(result, 'Stu').totalRounded, 165);
    assert.equal(row(result, 'Tyler').totalRounded, 165);
    assert.equal(row(result, 'Stu').individualPlacements, 3);
    assert.equal(row(result, 'Tyler').individualPlacements, 2);

    assert.notEqual(result.championship.resolvedBy, 'avgIndividualPlacement');
    assert.equal(result.championship.player, null, 'no champion may be invented');
    assert.deepEqual([...result.championship.contenders].sort(), ['Stu', 'Tyler']);
    assert.ok(codes(result).includes('championship-tie'));

    // And beer pong still settles it.
    const crowned = run(append(log, [{ type: 'championship_tiebreak', winner: 'Tyler' }]));
    assert.equal(crowned.championship.player, 'Tyler');
    assert.equal(crowned.championship.resolvedBy, 'championship_tiebreak');
  });

  test("Tyler's Swim/Gauntlet placements are his picked players', his Bags placement his own", () => {
    const result = run(GOLDEN_LOG);
    assert.equal(result.events.swim.placement.Tyler, EXPECTED.tylerPlacements.swim);
    assert.equal(result.events.bags.placement.Tyler, EXPECTED.tylerPlacements.bags);
    assert.equal(result.events.gauntlet.placement.Tyler, EXPECTED.tylerPlacements.gauntlet);
    // Which is exactly Lucas's swim placement and Stu's gauntlet placement.
    assert.equal(result.events.swim.placement.Tyler, result.events.swim.placement.Lucas);
    assert.equal(result.events.gauntlet.placement.Tyler, result.events.gauntlet.placement.Stu);
  });

  test('an outright winner is resolved on total alone', () => {
    const result = run(GOLDEN_LOG);
    assert.equal(result.championship.resolvedBy, 'total');
    assert.equal(result.players[0].rankLabel, '1');
    assert.equal(result.players[0].tied, false);
  });
});

// =======================================================================================
// The knob
// =======================================================================================

describe('the knob', () => {
  test('it multiplies individual events and leaves team events alone', () => {
    const at2 = run(append(GOLDEN_LOG, [{ type: 'knob', value: 2.0 }]));
    const at1 = run(append(GOLDEN_LOG, [{ type: 'knob', value: 1.0 }]));

    assert.equal(at2.events.swim.points.Lucas, rawPointsForRank(1, 10) * 2);
    assert.equal(at1.events.swim.points.Lucas, rawPointsForRank(1, 10));
    assert.equal(at2.events.wiffle.points.Murph, 100, 'Wiffle is never multiplied');
    assert.equal(at2.events.beerball.teamPoints.P1, 100);
    assert.equal(at2.events.volleyball.teamPoints.TW, 100);
  });

  test('turning it reshuffles the board — that is the whole point', () => {
    const low = run(append(GOLDEN_LOG, [{ type: 'knob', value: 1.0 }]));
    const high = run(append(GOLDEN_LOG, [{ type: 'knob', value: 2.0 }]));
    assert.notDeepEqual(low.players.map((p) => p.player), high.players.map((p) => p.player));
  });

  test('the default is the calibrated 1.1 when no knob entry exists', () => {
    const log = buildLog([
      ...ABLE.map((player, i) => ({ type: 'time', event: 'swim', player, value: 50 + i })),
    ]);
    assert.equal(run(log).knob, 1.1);
  });
});

// =======================================================================================
// Replay
// =======================================================================================

describe('replay', () => {
  test('scoring any prefix of the log never throws and never invents points', () => {
    const effective = effectiveLog(GOLDEN_LOG);
    for (let i = 0; i <= effective.length; i += 1) {
      const result = score(effective.slice(0, i));
      assert.equal(result.players.length, 11);
      for (const player of result.players) {
        assert.ok(player.total >= 0, `no negative totals at slice ${i}`);
        assert.ok(player.total <= 3600, `no runaway totals at slice ${i}`);
      }
    }
  });

  test('the last slice equals the full result', () => {
    const effective = effectiveLog(GOLDEN_LOG);
    assert.deepEqual(totals(score(effective.slice(0, effective.length))), EXPECTED.totals);
  });

  test('an empty log scores everyone at zero without complaint', () => {
    const result = score([]);
    assert.equal(result.players.length, 11);
    for (const player of result.players) assert.equal(player.total, 0);
    assert.deepEqual(result.issues.filter((i) => i.level === 'error'), []);
  });
});

// =======================================================================================
// Malformed entries must never take the board down
// =======================================================================================

/**
 * The worker checks that an entry carries a KNOWN TYPE and nothing deeper, and the log is
 * permanent. An entry that threw in here would take the standings, the TV and the admin page
 * down for the rest of the weekend, with no way to get it back out. Every shape below has to
 * degrade into a visible issue instead.
 */
describe('malformed entries fail soft', () => {
  test('an override with no placements list is ignored, and the event scores normally', () => {
    const log = append(GOLDEN_LOG, [{ type: 'override', event: 'swim', reason: 'fat-fingered' }]);
    const result = run(log);
    assert.deepEqual(totals(result), EXPECTED.totals, 'the computed weekend is untouched');
    assert.equal(result.events.swim.overridden, false);
    const issue = result.issues.find((i) => i.code === 'bad-override');
    assert.ok(issue, 'and Brad is told to re-enter it');
    assert.equal(issue.level, 'error');
  });

  test('a malformed override cannot make an incomplete team event scoreable', () => {
    const log = buildLog([
      { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
      { type: 'override', event: 'beerball', placements: 'P1 then the rest', reason: 'wrong box' },
    ]);
    const result = run(log);
    assert.equal(result.events.beerball.status, 'pending');
    assert.deepEqual(result.events.beerball.teamPoints, {});
    assert.ok(codes(result).includes('bad-override'));
  });

  test('a draft with one malformed team drops that team and scores the rest', () => {
    const teams = [
      { id: 'A', captain: 'Murph', members: ['Murph', 'Lucas', 'Yuyi', 'Helwig', 'Wyatt', 'Tyler'] },
      { id: 'B', captain: 'Stu', members: 'Stu' }, // a string iterates into 3 "players" named S, t, u
    ];
    const log = buildLog([
      { type: 'draft_assignment', event: 'wiffle', teams },
      { type: 'wiffle_result', event: 'wiffle', winner: 'A' },
      { type: 'event_final', event: 'wiffle' },
    ]);
    const result = run(log);
    assert.equal(result.events.wiffle.teams.length, 1);
    assert.equal(result.events.wiffle.points.Murph, 100);
    assert.equal(result.events.wiffle.points.S, undefined, 'no player was invented out of letters');
    assert.ok(codes(result).includes('bad-draft-entry'));
  });

  test('a draft whose teams are not a list at all is dropped whole', () => {
    const log = buildLog([{ type: 'draft_assignment', event: 'volleyball', teams: { TM: ['Mitch'] } }]);
    const result = run(log);
    assert.equal(result.events.volleyball.status, 'pending');
    assert.ok(codes(result).includes('bad-draft-entry'));
  });

  test('a pile of junk on top of the golden weekend still renders 11 standings rows', () => {
    const log = append(GOLDEN_LOG, [
      { type: 'override', event: 'bags', reason: 'no placements' },
      { type: 'draft_assignment', event: 'volleyball', teams: 'the usual three' },
      { type: 'volleyball_set', event: 'volleyball', matchSlot: 1, setNo: 1 }, // no scores
      { type: 'time', event: 'swim', player: 'Lucas' }, // no value
    ]);
    const result = run(log);
    assert.equal(result.players.length, 11);
    for (const player of result.players) assert.ok(Number.isFinite(player.total));
    assert.ok(codes(result).includes('bad-override'));
    assert.ok(codes(result).includes('bad-draft-entry'));
  });
});

// =======================================================================================
// Golf must never touch standings
// =======================================================================================

describe('golf is an exhibition', () => {
  test('a stray golf entry contributes nothing to anyone', () => {
    const log = append(GOLDEN_LOG, [
      { type: 'time', event: 'golf', player: 'Brad', value: 72 },
      { type: 'event_final', event: 'golf' },
    ]);
    assert.deepEqual(totals(run(log)), EXPECTED.totals);
  });
});

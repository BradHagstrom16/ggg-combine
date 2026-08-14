/**
 * Tests for src/render.js — the PURE formatting layer behind the standings table.
 *
 * These functions consume the exact shapes score() emits (players[].byEvent cells, events[],
 * issues[], movementSinceLastEvent) and turn them into display strings and view descriptors.
 * The DOM writer (renderStandings) is validated in a real browser; everything decision-bearing
 * lives in the pure helpers tested here so it can be asserted with node:test and mutation-checked.
 *
 * Two invariants get explicit mutation coverage because they are the ones that would silently
 * corrupt the board: pending (no data) must never render as 0 (a real result), and a movement
 * arrow's direction must track the sign of the rank delta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCellPoints,
  formatTotal,
  cellView,
  movementArrow,
  knobChipText,
  ageLabel,
  issueSummary,
  issueText,
  tylerBackingSummary,
  progressSubtitle,
} from '../src/render.js';

test('formatCellPoints: individual points at 1 decimal, integers bare, real zero shown', () => {
  assert.equal(formatCellPoints(73.333), '73.3');
  assert.equal(formatCellPoints(97.777), '97.8');
  assert.equal(formatCellPoints(24.444), '24.4');
  assert.equal(formatCellPoints(110), '110'); // 110.0 shows bare, per the sketch
  assert.equal(formatCellPoints(100), '100'); // team points are integers
  assert.equal(formatCellPoints(0), '0'); // a genuine zero result
});

test('formatTotal: always 1 decimal (float dust must never defeat §7 tie detection)', () => {
  assert.equal(formatTotal(210), '210.0');
  assert.equal(formatTotal(248.3), '248.3');
  assert.equal(formatTotal(0), '0.0');
});

test('cellView: na cell renders blank, no points', () => {
  const v = cellView({ points: null, pending: false, na: true });
  assert.equal(v.kind, 'na');
  assert.equal(v.text, '');
});

test('cellView: pending cell is blank/hatched, NOT a zero', () => {
  const v = cellView({ points: null, pending: true, na: false, flagged: false });
  assert.equal(v.kind, 'pending');
  assert.equal(v.text, ''); // <-- pending ≠ zero
});

test('cellView: a genuine zero (blank scored after event_final / last place) shows "0"', () => {
  const v = cellView({ points: 0, pending: false, na: false, flagged: false, unfinalized: false });
  assert.equal(v.kind, 'scored');
  assert.equal(v.text, '0');
});

test('MUTATION pending-vs-zero: pending and scored-zero are distinguishable', () => {
  const pending = cellView({ points: null, pending: true, na: false });
  const zero = cellView({ points: 0, pending: false, na: false });
  // If a mutation collapsed these (e.g. treated null points as 0), this fails.
  assert.notEqual(pending.kind, zero.kind);
  assert.notEqual(pending.text, zero.text);
  assert.equal(pending.text, '');
  assert.equal(zero.text, '0');
});

test('cellView: flagged and unfinalized flags pass through on a scored cell', () => {
  const flagged = cellView({ points: 25, pending: false, na: false, flagged: true, unfinalized: false });
  assert.equal(flagged.flagged, true);
  const unfin = cellView({ points: 50, pending: false, na: false, flagged: false, unfinalized: true });
  assert.equal(unfin.unfinalized, true);
});

test('movementArrow: up / down / none, with magnitude', () => {
  assert.deepEqual(movementArrow(3), { dir: 'up', text: '▲3' });
  assert.deepEqual(movementArrow(-2), { dir: 'down', text: '▼2' });
  assert.deepEqual(movementArrow(0), { dir: 'none', text: '—' });
  assert.deepEqual(movementArrow(undefined), { dir: 'none', text: '—' });
});

test('MUTATION arrow sign: positive delta is UP, negative is DOWN (positive = moved up)', () => {
  assert.equal(movementArrow(1).dir, 'up');
  assert.equal(movementArrow(-1).dir, 'down');
});

test('knobChipText', () => {
  assert.equal(knobChipText(1.1), 'INDIVIDUAL ×1.1');
  assert.equal(knobChipText(1.0), 'INDIVIDUAL ×1');
  assert.equal(knobChipText(1.05), 'INDIVIDUAL ×1.05');
});

test('ageLabel: seconds/minutes/hours and amber past ~60s', () => {
  assert.deepEqual(ageLabel(12000), { text: 'updated 12s ago', amber: false });
  assert.equal(ageLabel(59000).amber, false);
  assert.equal(ageLabel(60001).amber, true);
  assert.equal(ageLabel(65000).text, 'updated 1m ago');
  assert.equal(ageLabel(3_600_000).text, 'updated 1h ago');
});

test('issueSummary partitions by level; issueText prefers the engine message', () => {
  const issues = [
    { level: 'error', code: 'manual-resolution-required', message: 'Beer Ball needs a manual placement.' },
    { level: 'warn', code: 'blank-scored-zero', message: 'A blank was scored 0.' },
    { level: 'error', code: 'duplicate-burn', message: 'Duplicate burn.' },
  ];
  const s = issueSummary(issues);
  assert.equal(s.errors.length, 2);
  assert.equal(s.warns.length, 1);
  assert.equal(s.hasErrors, true);
  assert.equal(issueText(issues[0]), 'Beer Ball needs a manual placement.');
  assert.equal(issueText({ code: 'x' }), 'x'); // falls back to code
});

test('issueSummary tolerates an empty/absent list', () => {
  assert.equal(issueSummary().hasErrors, false);
  assert.equal(issueSummary([]).errors.length, 0);
});

test('tylerBackingSummary: only backed events with a resolved source, in schedule order', () => {
  const result = {
    events: {
      wiffle: { id: 'wiffle', order: 1, short: 'Wiffle', status: 'final' }, // Tyler plays, no source
      beerball: {
        id: 'beerball', order: 2, short: 'Beer Ball', status: 'final',
        tylerSource: { kind: 'pair', id: 'p1', members: ['Murph', 'Wyatt'] },
      },
      swim: {
        id: 'swim', order: 3, short: 'Swim', status: 'final',
        tylerSource: { kind: 'player', id: 'Lucas' },
      },
      volleyball: { id: 'volleyball', order: 5, short: 'Volley', status: 'pending', tylerSource: null },
      gauntlet: {
        id: 'gauntlet', order: 6, short: 'Gauntlet', status: 'final',
        tylerSource: { kind: 'team', id: 'teamMitch', captain: 'Mitch' },
      },
    },
  };
  const s = tylerBackingSummary(result);
  assert.deepEqual(s.map((e) => e.eventId), ['beerball', 'swim', 'gauntlet']); // ordered, null excluded
  assert.equal(s[0].label, 'Murph & Wyatt');
  assert.equal(s[1].label, 'Lucas');
  assert.equal(s[2].label, 'Mitch'); // team backing surfaces the burned captain
});

test('progressSubtitle: after-swim, not-started, and complete states', () => {
  const mk = (statuses) => ({
    events: {
      wiffle: { id: 'wiffle', order: 1, short: 'Wiffle', day: 'Friday', status: statuses.wiffle },
      beerball: { id: 'beerball', order: 2, short: 'Beer Ball', day: 'Friday', status: statuses.beerball },
      swim: { id: 'swim', order: 3, short: 'Swim', day: 'Saturday', status: statuses.swim },
      bags: { id: 'bags', order: 4, short: 'Bags', day: 'Saturday', status: statuses.bags },
      volleyball: { id: 'volleyball', order: 5, short: 'Volley', day: 'Saturday', status: statuses.volleyball },
      gauntlet: { id: 'gauntlet', order: 6, short: 'Gauntlet', day: 'Saturday', status: statuses.gauntlet },
    },
  });
  const afterSwim = progressSubtitle(mk({
    wiffle: 'final', beerball: 'final', swim: 'final',
    bags: 'pending', volleyball: 'pending', gauntlet: 'pending',
  }));
  assert.match(afterSwim, /AFTER SWIM/);
  assert.match(afterSwim, /NEXT UP: BAGS/);

  const notStarted = progressSubtitle(mk({
    wiffle: 'pending', beerball: 'pending', swim: 'pending',
    bags: 'pending', volleyball: 'pending', gauntlet: 'pending',
  }));
  assert.match(notStarted, /NEXT UP: WIFFLE/);

  const done = progressSubtitle(mk({
    wiffle: 'final', beerball: 'final', swim: 'final',
    bags: 'final', volleyball: 'final', gauntlet: 'final',
  }));
  assert.match(done, /COMPLETE/);
});

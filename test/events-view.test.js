/**
 * Tests for src/events-view.js — the pure view-models behind the friends-facing /events page.
 *
 * Everything is asserted against the golden weekend (the same hand-computed fixture that gates the
 * engine), so a view-model that drifts from the real score() output fails here. The boards must
 * DERIVE from result.events[...] / result.players, never re-score; the load-bearing checks are that
 * beer-ball standings fold wins/differential straight from `games`, and that the per-player
 * breakdown reports the right team + placement + scored/pending cell for each event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveLog, score, movementSinceLastEvent } from '../src/scoring.js';
import { buildLog } from './helpers.js';
import { GOLDEN_LOG, BEERBALL_PAIRS, WIFFLE_TEAMS } from './fixtures/golden-weekend.js';
import {
  eventHeadline, eventsByDay, beerballBoard, volleyballBoard, wiffleBoard,
  individualBoard, playerBreakdown,
} from '../src/events-view.js';

const golden = () => score(effectiveLog(GOLDEN_LOG));

test('eventsByDay groups the schedule into day sections in order', () => {
  const groups = eventsByDay();
  assert.deepEqual(groups.map((g) => g.day), ['Friday', 'Saturday']);
  assert.deepEqual(groups[0].ids, ['wiffle', 'beerball']);
  assert.deepEqual(groups[1].ids, ['swim', 'bags', 'volleyball', 'gauntlet']);
});

test('eventHeadline: final / awaiting-finalize / in-progress / not-started', () => {
  const g = golden();
  assert.equal(eventHeadline(g, 'wiffle').statusLabel, 'Final');
  assert.equal(eventHeadline(g, 'wiffle').state, 'final');
  assert.equal(eventHeadline(g, 'wiffle').day, 'Friday');

  const drafted = score(effectiveLog(buildLog([
    { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
  ])));
  assert.equal(eventHeadline(drafted, 'beerball').started, false);
  assert.equal(eventHeadline(drafted, 'beerball').statusLabel, 'Not started');

  const oneGame = score(effectiveLog(buildLog([
    { type: 'draft_assignment', event: 'beerball', teams: BEERBALL_PAIRS },
    { type: 'beerball_game', event: 'beerball', gameSlot: 1, pairs: ['P1', 'P2'], winner: 'P1', beers: { P1: 2, P2: 1.5 } },
  ])));
  assert.equal(eventHeadline(oneGame, 'beerball').statusLabel, 'In progress');

  const complete = score(effectiveLog(buildLog([
    { type: 'draft_assignment', event: 'wiffle', teams: WIFFLE_TEAMS },
    { type: 'wiffle_result', event: 'wiffle', winner: 'A' },
  ])));
  assert.equal(eventHeadline(complete, 'wiffle').statusLabel, 'Complete · awaiting finalize');
});

test('beerballBoard: game-by-game who-beat-whom + wins/differential standings, engine-ordered', () => {
  const { games, standings } = beerballBoard(golden());
  assert.equal(games.length, 10);
  // slot 1: P1 (Yuyi) beats P2 (Lucas), winner finished 4, loser 2 (golden values)
  const g1 = games.find((g) => g.slot === 1);
  assert.equal(g1.winner, 'Yuyi');
  assert.equal(g1.loser, 'Lucas');
  assert.equal(g1.winnerBeers, 4);
  assert.equal(g1.loserBeers, 2);

  // standings follow the resolved placement P1..P5 → Yuyi, Lucas, Josh, ATM, Tyler
  assert.deepEqual(standings.map((s) => s.captain), ['Yuyi', 'Lucas', 'Josh', 'ATM', 'Tyler']);
  assert.deepEqual(standings.map((s) => s.wins), [4, 3, 2, 1, 0]);
  assert.deepEqual(standings.map((s) => s.points), [100, 75, 50, 25, 0]);
  assert.deepEqual(standings.map((s) => s.played), [4, 4, 4, 4, 4]);
  // leader's differential is positive; last place negative
  assert.ok(standings[0].beerDiff > 0);
  assert.ok(standings[4].beerDiff < 0);
});

test('volleyballBoard: per-match set scores + winner, wins-ordered standings', () => {
  const { matches, standings } = volleyballBoard(golden());
  assert.equal(matches.length, 3);
  assert.deepEqual(standings.map((s) => s.captain), ['Wyatt', 'Mitch', 'Helwig']); // TW, TM, TH
  assert.deepEqual(standings.map((s) => s.points), [100, 50, 0]);

  // every match has a decided winner and a set list; the winner took the most sets
  for (const m of matches) {
    assert.ok(m.winner, 'match has a winner');
    assert.ok(m.sets.length >= 2);
    assert.equal(Math.max(m.setWins.a, m.setWins.b), 2);
  }
});

test('wiffleBoard: winner-take-all, winner flagged with 100 / loser 0', () => {
  const { teams, winner, decided } = wiffleBoard(golden());
  assert.equal(decided, true);
  assert.equal(teams.length, 2);
  assert.equal(winner.captain, 'Murph'); // team A
  assert.equal(winner.points, 100);
  const loser = teams.find((t) => !t.isWinner);
  assert.equal(loser.captain, 'Stu');
  assert.equal(loser.points, 0);
});

test('wiffleBoard: a winner id matching no team reads as undecided (no phantom winner)', () => {
  // A stale/malformed winner id must not leave decided=true with winner=null — the page would then
  // dereference winner.captain and blank the whole By-event view.
  const board = wiffleBoard({ events: { wiffle: {
    teams: [{ id: 'A', captain: 'Murph', members: ['Murph'] }],
    winner: 'no-such-team', teamPoints: {},
  } } });
  assert.equal(board.winner, null);
  assert.equal(board.decided, false);
});

test('individualBoard: leaderboard sorted by placement, values + points + config', () => {
  const swim = individualBoard(golden(), 'swim');
  assert.equal(swim.direction, 'lower');
  assert.equal(swim.rows[0].player, 'Lucas'); // 1st, 55.0s
  assert.equal(swim.rows[0].placement, 1);
  assert.equal(swim.rows[0].value, 55);
  assert.equal(Math.round(swim.rows[0].points), 110);
  assert.equal(swim.rows.length, 10); // 10 able

  const bags = individualBoard(golden(), 'bags');
  assert.equal(bags.rows.length, 11); // all 11
  assert.equal(bags.rows[0].player, 'Tyler'); // highest score wins
});

test('playerBreakdown: rank, per-event points, team + placement (how is Murph doing)', () => {
  const g = golden();
  const mv = movementSinceLastEvent(effectiveLog(GOLDEN_LOG));
  const murph = playerBreakdown(g, mv, 'Murph');
  assert.equal(murph.rank, 1); // the champion
  assert.equal(murph.rankLabel, '1');
  assert.equal(murph.total, 523.1);
  assert.equal(murph.rows.length, 6);

  const byId = Object.fromEntries(murph.rows.map((r) => [r.id, r]));
  assert.equal(byId.wiffle.cell.kind, 'scored');
  assert.equal(byId.wiffle.cell.text, '100');
  assert.equal(byId.wiffle.team, 'Murph'); // he leads wiffle team A
  assert.equal(byId.beerball.cell.text, '75');
  assert.equal(byId.beerball.team, 'Lucas'); // his beer-ball pair (P2)
  assert.equal(byId.swim.type, 'individual');
  assert.equal(byId.swim.placement, 3); // golden swim order Lucas, Wyatt, Murph → 3rd
});

test('playerBreakdown returns null for a non-roster name', () => {
  assert.equal(playerBreakdown(golden(), {}, 'Nobody'), null);
});

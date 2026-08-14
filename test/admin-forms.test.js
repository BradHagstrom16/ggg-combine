/**
 * Tests for src/admin-forms.js — the pure admin-side helpers.
 *
 * The risk area is the burn tracker: eligibility must be DERIVED from the engine's ledger
 * (burns.slots[].eligible + who each claimed slot burned), never recomputed from the rules. That
 * exact "recompute the rule a second time" mistake bit the scoring engine three review rounds; the
 * front end must not repeat it. The load-bearing case is Volleyball once two of its three captains
 * are already burned — the engine says exactly one team is eligible, and the chooser must reflect
 * that (with a reason for the disabled two), not re-derive it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveLog, score } from '../src/scoring.js';
import { ROSTER, ABLE } from '../src/rules-config.js';
import { buildLog } from './helpers.js';
import {
  participantsFor,
  captainsFor,
  teamShapeFor,
  availableForDraft,
  buildDraftTeams,
  assignFromTeams,
  burnTracker,
  burnChooser,
  finalizeNudges,
  rankDiff,
  knobRankPreview,
} from '../src/admin-forms.js';

/** A log where Tyler's Beer Ball pair burns two Volleyball captains (Mitch, Helwig) + a Swim pick. */
function burnScenario() {
  return effectiveLog(buildLog([
    { type: 'draft_assignment', event: 'beerball', teams: [
      { id: 'pairTyler', captain: 'Tyler', members: ['Mitch', 'Helwig'] },
      { id: 'pairYuyi', captain: 'Yuyi', members: ['Yuyi', 'Murph'] },
      { id: 'pairLucas', captain: 'Lucas', members: ['Lucas', 'Wyatt'] },
      { id: 'pairJosh', captain: 'Josh', members: ['Josh', 'Stu'] },
      { id: 'pairATM', captain: 'ATM', members: ['ATM', 'Brad'] },
    ] },
    { type: 'tyler_pick', stage: 'swim', target: 'Lucas' },
    { type: 'draft_assignment', event: 'volleyball', teams: [
      { id: 'teamMitch', captain: 'Mitch', members: ['Mitch', 'Stu', 'Josh', 'Brad'] },
      { id: 'teamHelwig', captain: 'Helwig', members: ['Helwig', 'Yuyi', 'ATM'] },
      { id: 'teamWyatt', captain: 'Wyatt', members: ['Wyatt', 'Murph', 'Lucas'] },
    ] },
  ]));
}

test('participant + config lookups', () => {
  assert.deepEqual(participantsFor('bags'), ROSTER); // all 11 play Bags
  assert.deepEqual(participantsFor('swim'), ABLE); // 10 able
  assert.deepEqual(captainsFor('volleyball'), ['Mitch', 'Helwig', 'Wyatt']);
  assert.deepEqual(teamShapeFor('volleyball'), { teamCount: 3, teamSize: null, teamSizes: [4, 3, 3] });
  assert.equal(teamShapeFor('beerball').teamSize, 2);
});

test('availableForDraft offers only unassigned participants', () => {
  const left = availableForDraft('wiffle', ['Murph', 'Stu', 'Tyler']);
  assert.ok(!left.includes('Murph'));
  assert.ok(!left.includes('Tyler'));
  assert.equal(left.length, ROSTER.length - 3);
});

test('buildDraftTeams pins a playing captain to their own team — never onto two', () => {
  // Regression: a playing captain reassigned to another captain's team used to land on BOTH
  // (force-added to their own + filtered onto the selected one). Wiffle captains Murph & Stu both play.
  const captains = captainsFor('wiffle'); // ['Murph', 'Stu']
  const parts = participantsFor('wiffle'); // ROSTER — both captains are participants
  const teamIdFor = (c) => `wiffle-${c}`;
  const assign = { Murph: 'wiffle-Stu', Stu: 'wiffle-Stu', Lucas: 'wiffle-Murph', Josh: 'wiffle-Stu' };

  const teams = buildDraftTeams(captains, parts, assign, teamIdFor);
  const murph = teams.find((t) => t.captain === 'Murph');
  const stu = teams.find((t) => t.captain === 'Stu');

  assert.equal(murph.members.filter((m) => m === 'Murph').length, 1); // on own team exactly once
  assert.equal(murph.members[0], 'Murph'); // and leads it
  assert.ok(!stu.members.includes('Murph')); // NOT on the team the select tried to move him to
  assert.ok(murph.members.includes('Lucas')); // a non-captain member still goes where assigned
  assert.ok(stu.members.includes('Josh'));
  assert.deepEqual(teams.map((t) => t.captain), ['Murph', 'Stu']); // each captain leads their own team
});

test('assignFromTeams recovers each member\'s team, keyed by captain (inverse of buildDraftTeams)', () => {
  const teamIdFor = (c) => `beerball-${c}`;
  const teams = [
    { id: 'beerball-Tyler', captain: 'Tyler', members: ['Mitch', 'Helwig'] }, // non-playing captain
    { id: 'beerball-Yuyi', captain: 'Yuyi', members: ['Yuyi', 'Murph'] },
    { id: 'beerball-Lucas', captain: 'Lucas', members: ['Lucas', 'Wyatt'] },
  ];
  const assign = assignFromTeams(teams, teamIdFor);
  assert.equal(assign.Mitch, 'beerball-Tyler'); // a non-captain member → its team
  assert.equal(assign.Helwig, 'beerball-Tyler');
  assert.equal(assign.Murph, 'beerball-Yuyi');
  assert.equal(assign.Wyatt, 'beerball-Lucas');
  assert.equal(assign.Yuyi, 'beerball-Yuyi'); // a playing captain → their own team
  assert.equal(assign.Lucas, 'beerball-Lucas');
});

test('assignFromTeams round-trips buildDraftTeams for every non-captain member', () => {
  const captains = captainsFor('volleyball'); // ['Mitch','Helwig','Wyatt']
  const parts = participantsFor('volleyball');
  const teamIdFor = (c) => `volleyball-${c}`;
  const assign = {
    Stu: 'volleyball-Mitch', Josh: 'volleyball-Mitch', Brad: 'volleyball-Mitch',
    Yuyi: 'volleyball-Helwig', ATM: 'volleyball-Helwig',
    Murph: 'volleyball-Wyatt', Lucas: 'volleyball-Wyatt',
  };
  const teams = buildDraftTeams(captains, parts, assign, teamIdFor);
  const recovered = assignFromTeams(teams, teamIdFor);
  for (const p of Object.keys(assign)) assert.equal(recovered[p], assign[p], `${p} recovered`);
});

test('assignFromTeams tolerates missing / empty / member-less input', () => {
  assert.deepEqual(assignFromTeams(null, (c) => c), {});
  assert.deepEqual(assignFromTeams([], (c) => c), {});
  assert.deepEqual(assignFromTeams([{ captain: 'X' }], (c) => `t-${c}`), {}); // no members → nothing
});

test('burnTracker: count, filled vs open slots, straight off the ledger', () => {
  const t = burnTracker(score(burnScenario()));
  assert.equal(t.total, 5);
  assert.equal(t.burnedCount, 3); // Mitch, Helwig, Lucas
  assert.equal(t.slots.length, 5);
  assert.equal(t.slots[0].filled, true);
  assert.equal(t.slots[0].player, 'Mitch');
  const volley = t.slots.find((s) => s.stage === 'volleyball');
  assert.equal(volley.filled, false);
  assert.equal(volley.eligibleCount, 1); // only one team left
});

test('burnChooser (volleyball): two captains burned → exactly one eligible team, with reasons', () => {
  const chooser = burnChooser(score(burnScenario()), 'volleyball');
  assert.equal(chooser.unit, 'team');
  assert.equal(chooser.eligibleCount, 1);

  const wyatt = chooser.options.find((o) => o.id === 'teamWyatt');
  const mitch = chooser.options.find((o) => o.id === 'teamMitch');
  const helwig = chooser.options.find((o) => o.id === 'teamHelwig');
  assert.equal(wyatt.eligible, true);
  assert.equal(wyatt.reason, null);
  assert.equal(mitch.eligible, false);
  assert.match(mitch.reason, /Mitch/); // reason names the burned captain
  assert.match(mitch.reason, /Beer Ball/); // ...and which stage burned him
  assert.equal(helwig.eligible, false);
  assert.match(helwig.reason, /Helwig/);
});

test('burnChooser (gauntlet, a player stage): burned players are disabled with a reason', () => {
  const chooser = burnChooser(score(burnScenario()), 'gauntlet');
  assert.equal(chooser.unit, 'player');
  assert.equal(chooser.options.length, ABLE.length);
  assert.equal(chooser.eligibleCount, ABLE.length - 3); // minus Mitch, Helwig, Lucas

  const mitch = chooser.options.find((o) => o.id === 'Mitch');
  assert.equal(mitch.eligible, false);
  assert.match(mitch.reason, /already burned/);
  assert.match(mitch.reason, /Beer Ball/);

  const lucas = chooser.options.find((o) => o.id === 'Lucas');
  assert.equal(lucas.eligible, false);
  assert.match(lucas.reason, /Swim/); // burned by the Swim pick, not Beer Ball

  const wyatt = chooser.options.find((o) => o.id === 'Wyatt');
  assert.equal(wyatt.eligible, true);
});

test('burnChooser reflects a made pick as selected', () => {
  const chooser = burnChooser(score(burnScenario()), 'swim');
  const lucas = chooser.options.find((o) => o.id === 'Lucas');
  assert.equal(lucas.selected, true);
  assert.equal(chooser.currentPick, 'Lucas');
});

test('finalizeNudges: an event with all results in but no event_final is flagged', () => {
  const log = effectiveLog(buildLog([
    { type: 'draft_assignment', event: 'wiffle', teams: [
      { id: 'A', captain: 'Murph', members: ['Murph', 'Lucas', 'Mitch', 'ATM', 'Wyatt', 'Tyler'] },
      { id: 'B', captain: 'Stu', members: ['Stu', 'Josh', 'Yuyi', 'Helwig', 'Brad'] },
    ] },
    { type: 'wiffle_result', event: 'wiffle', winner: 'A' }, // complete, but no event_final
  ]));
  const nudges = finalizeNudges(score(log));
  assert.ok(nudges.some((n) => n.id === 'wiffle'));
});

test('rankDiff reports who moved, sorted by new rank; no changes → clear message', () => {
  const before = { players: [{ player: 'Stu', rank: 1 }, { player: 'Wyatt', rank: 2 }, { player: 'Brad', rank: 3 }] };
  const after = { players: [{ player: 'Wyatt', rank: 1 }, { player: 'Stu', rank: 2 }, { player: 'Brad', rank: 3 }] };
  const d = rankDiff(before, after);
  assert.deepEqual(d.changes, [
    { player: 'Wyatt', from: 2, to: 1 },
    { player: 'Stu', from: 1, to: 2 },
  ]);
  assert.match(d.summary, /Wyatt/);
  assert.equal(rankDiff(before, before).summary, 'no rank changes');
});

test('knobRankPreview: turning the knob up reorders team-heavy vs individual-heavy players', () => {
  // Wiffle winner team A (team points, knob-independent) vs a fast swimmer on losing team B.
  const log = effectiveLog(buildLog([
    { type: 'knob', value: 1.0 },
    { type: 'draft_assignment', event: 'wiffle', teams: [
      { id: 'A', captain: 'Murph', members: ['Murph', 'Lucas', 'Mitch', 'ATM', 'Wyatt', 'Tyler'] },
      { id: 'B', captain: 'Stu', members: ['Stu', 'Josh', 'Yuyi', 'Helwig', 'Brad'] },
    ] },
    { type: 'wiffle_result', event: 'wiffle', winner: 'A' },
    ...['Stu', 'Josh', 'Yuyi', 'Helwig', 'Brad', 'Murph', 'Lucas', 'Mitch', 'ATM', 'Wyatt']
      .map((player, i) => ({ type: 'time', event: 'swim', player, value: 20 + i })),
  ]));

  const bumped = knobRankPreview(log, 2.0);
  assert.equal(bumped.knob, 2.0);
  assert.ok(bumped.changes.length > 0, 'a big knob swing should reorder somebody');
  assert.match(bumped.summary, /×2/);

  const flat = knobRankPreview(log, 1.0); // same as the log's current knob
  assert.match(flat.summary, /no rank changes/);
});

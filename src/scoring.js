/**
 * GGG Combine 2026 — the scoring engine. This is the product.
 *
 *   admin.html ──POST /log (PIN, entry+UUID)──▶ Worker ──▶ Durable Object (SQLite)
 *       │  ▲                                     │           append, assign id,
 *       │  └── offline outbox (queue+flush)      │           drop dup UUIDs
 *       ▼                                        │
 *   index.html / ?tv=1 ◀──GET /log (≤10s poll,───┘  + serves /public (same origin)
 *        │                 visible tabs, 5s edge cache)
 *        ▼
 *   localStorage cache ─▶ effectiveLog (corrections + latest-wins) ─▶ scoring.js ─▶ render.js
 *
 * Two invariants govern everything below:
 *
 *   1. PURE. `score()` is a function of the log and nothing else — no clock, no network, no
 *      DOM, no mutation of its input. That is what makes `score(effectiveLog.slice(0, i))`
 *      a free weekend replay, and what makes this file exhaustively testable.
 *   2. COMPUTED POINTS ARE NEVER STORED. The log holds raw inputs only. Every number this
 *      module returns is derived on the spot from those inputs plus the current knob.
 *
 * All rules and math come from `combine-2026-spec.md` (LOCKED). Section refs are inline.
 */

import {
  ROSTER, ABLE, GM, EVENTS, EVENT_ORDER, INDIVIDUAL_EVENTS,
  KNOB, DIRECTION, BURN_STAGES, BURN_COUNT, TYLER_BACKING,
  rawPointsForRank, round1, clampKnob,
} from './rules-config.js';

// ---------------------------------------------------------------------------------------
// Entry identity: the "latest-wins" key
// ---------------------------------------------------------------------------------------

/**
 * The logical key an entry competes on. Scoring resolves each key to its LATEST non-voided
 * entry, which is what makes casual re-entry self-heal: Brad re-types a time he fat-fingered,
 * the new entry simply wins, and no correction is required. Corrections exist for the times
 * he wants the fix to be *visible and audited* instead.
 *
 * Returns null for entries that never compete (corrections apply to other entries rather
 * than holding a value of their own).
 */
export function entryKey(entry) {
  switch (entry.type) {
    case 'draft_assignment': return `draft_assignment:${entry.event}`;
    case 'time': return `time:${entry.event}:${entry.player}`;
    case 'wiffle_result': return `wiffle_result:${entry.event ?? 'wiffle'}`;
    case 'beerball_game': return `beerball_game:${entry.gameSlot}`;
    case 'volleyball_set': return `volleyball_set:${entry.matchSlot}:${entry.setNo}`;
    case 'tyler_pick': return `tyler_pick:${entry.stage}`;
    case 'override': return `override:${entry.event}`;
    case 'championship_tiebreak': return 'championship_tiebreak';
    case 'knob': return 'knob';
    case 'event_final': return `event_final:${entry.event}`;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------
// Effective log: UUID dedupe, then corrections
// ---------------------------------------------------------------------------------------

/**
 * Collapse the raw append-only log into the log that actually counts.
 *
 * Two passes, in this order:
 *
 *   1. **UUID dedupe.** The client stamps every entry with a UUID before sending, so a
 *      double-tapped save button or a retried offline-outbox flush produces byte-identical
 *      UUIDs. The worker already drops them server-side; doing it here too means a stale
 *      localStorage cache can never resurrect a duplicate. Lowest id wins (it is the one
 *      that actually landed first).
 *
 *   2. **Corrections.** `{targets: id}` voids the target; `{targets: id, replacement: {...}}`
 *      voids it and states a new value. A correction can itself be corrected — undoing an
 *      undo — so activity is resolved in DESCENDING id order: a correction targeting entry N
 *      always has an id greater than N, so by the time we reach N we already know whether
 *      every correction aimed at it survived.
 *
 * A replacement enters the log at the CORRECTION's id, not the target's. It is a new
 * statement of fact made at the moment Brad made it, so it beats anything entered in
 * between under latest-wins. (Replay therefore shows the corrected value appearing when it
 * was actually established, and never shows the fat-fingered original at all.)
 *
 * Nothing is ever mutated or deleted — this function does not touch `rawLog`.
 */
export function effectiveLog(rawLog) {
  const ordered = [...rawLog].sort((a, b) => a.id - b.id);

  const seenUuid = new Set();
  const deduped = [];
  for (const entry of ordered) {
    if (entry.uuid) {
      if (seenUuid.has(entry.uuid)) continue;
      seenUuid.add(entry.uuid);
    }
    deduped.push(entry);
  }

  const correctionsByTarget = new Map();
  for (const entry of deduped) {
    if (entry.type !== 'correction') continue;
    const list = correctionsByTarget.get(entry.targets) ?? [];
    list.push(entry);
    correctionsByTarget.set(entry.targets, list);
  }

  // Descending pass: an entry is void iff at least one correction aimed at it is itself alive.
  const voided = new Set();
  for (let i = deduped.length - 1; i >= 0; i -= 1) {
    const entry = deduped[i];
    const aimed = correctionsByTarget.get(entry.id) ?? [];
    if (aimed.some((c) => !voided.has(c.id))) voided.add(entry.id);
  }

  const effective = [];
  for (const entry of deduped) {
    if (entry.type === 'correction') {
      if (voided.has(entry.id)) continue; // this undo was itself undone
      if (entry.replacement) {
        effective.push({
          ...entry.replacement,
          id: entry.id,
          uuid: entry.uuid,
          ts: entry.ts,
          correctedFrom: entry.targets,
        });
      }
      continue; // corrections never score on their own
    }
    if (voided.has(entry.id)) continue;
    effective.push(entry);
  }

  return effective;
}

/** Resolve every logical key to its latest entry. Input must be id-ascending. */
export function resolveLatest(effective) {
  const latest = new Map();
  for (const entry of effective) {
    const key = entryKey(entry);
    if (key) latest.set(key, entry);
  }
  return latest;
}

// ---------------------------------------------------------------------------------------
// Individual events (spec §3.2)
// ---------------------------------------------------------------------------------------

/**
 * Rank an individual event and award points.
 *
 *   raw = 100 × (n − r) / (n − 1),  final = raw × knob
 *
 * `n` is the CONFIGURED participant count (10 for Swim/Gauntlet, 11 for Bags) — never the
 * number of people who happen to have a time yet. Ties share the average of the points for
 * the positions they occupy (spec §3.2).
 *
 * Blanks are special and deliberately NOT part of the tie-averaging rule: spec §3.2 says a
 * player who should have competed but has no time is "treated as last... if multiple blanks,
 * they all get 0". Two blanks therefore both get 0, not the average of 9th and 10th.
 */
export function rankIndividual({ values, participants, direction, knob }) {
  const n = participants.length;
  const withValue = participants.filter((p) => Number.isFinite(values[p]));
  const blanks = participants.filter((p) => !Number.isFinite(values[p]));

  const sorted = [...withValue].sort((a, b) => (
    direction === DIRECTION.HIGHER ? values[b] - values[a] : values[a] - values[b]
  ));

  const points = {};
  const placement = {};

  let position = 1;
  let index = 0;
  while (index < sorted.length) {
    // Everyone sharing this exact value occupies the next `size` positions.
    const value = values[sorted[index]];
    let size = 1;
    while (index + size < sorted.length && values[sorted[index + size]] === value) size += 1;

    let rawSum = 0;
    let posSum = 0;
    for (let k = 0; k < size; k += 1) {
      rawSum += rawPointsForRank(position + k, n);
      posSum += position + k;
    }
    const sharedRaw = rawSum / size;
    const sharedPlacement = posSum / size;

    for (let k = 0; k < size; k += 1) {
      const player = sorted[index + k];
      points[player] = sharedRaw * knob;
      placement[player] = sharedPlacement;
    }

    position += size;
    index += size;
  }

  for (const player of blanks) {
    points[player] = 0;
    placement[player] = n; // treated as last for §7's average-placement tiebreak
  }

  return { points, placement, ranked: sorted, blanks };
}

// ---------------------------------------------------------------------------------------
// Round-robin tie resolution (spec §4.2, §4.5)
// ---------------------------------------------------------------------------------------

/** All rules are higher-is-better. `headToHead` is the reason this is group-wise: it is only
 *  meaningful *within* the tied subgroup, and it is not transitive. */
const RULE_FNS = {
  wins: (id, _group, ctx) => ctx.stats[id].wins,
  beerDiff: (id, _group, ctx) => ctx.stats[id].beerDiff,
  pointDiff: (id, _group, ctx) => ctx.stats[id].pointDiff,
  totalPoints: (id, _group, ctx) => ctx.stats[id].totalPoints,
  headToHead: (id, group, ctx) => ctx.headToHeadWins(id, group),
};

/**
 * Partition a tied group by the next rule, then recurse into each subgroup with the rules
 * that remain. When the rules run out and a group is still tied, it is returned UNRESOLVED.
 *
 * This is deliberately not a pairwise comparator chain fed to `sort()`. Head-to-head is
 * non-transitive: A beat B, B beat C, C beat A is a perfectly ordinary round-robin outcome,
 * and a comparator would silently invent an order out of whatever the sort algorithm happened
 * to compare first. The group-wise form *detects* the knot instead and hands it to Brad, which
 * is exactly what spec §4.2's chug-off and §4.5's play-in are for.
 */
export function resolveGroup(members, rules, ctx, ruleIndex = 0) {
  if (members.length === 1) return [{ members, resolved: true }];
  if (ruleIndex >= rules.length) return [{ members, resolved: false }];

  const rule = RULE_FNS[rules[ruleIndex]];
  if (!rule) return [{ members, resolved: false }];

  const buckets = new Map();
  for (const id of members) {
    const value = rule(id, members, ctx);
    const list = buckets.get(value) ?? [];
    list.push(id);
    buckets.set(value, list);
  }

  // This rule separated nothing — move to the next one against the same group.
  if (buckets.size === 1) return resolveGroup(members, rules, ctx, ruleIndex + 1);

  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0]) // higher is better, for every rule
    .flatMap(([, group]) => resolveGroup(group, rules, ctx, ruleIndex + 1));
}

/**
 * Turn resolved groups into placements and points.
 *
 * An unresolved group occupies consecutive positions and shares the average of the placement
 * points for those positions, so the board stays sane while it is flagged. It is NOT a silent
 * resolution: `manualRequired` rides along and the UI flags it until Brad enters an override.
 */
function placementsFromGroups(groups, placementPoints) {
  const placements = [];
  const pointsByTeam = {};
  const unresolved = [];
  let position = 1;

  for (const group of groups) {
    const size = group.members.length;
    let sum = 0;
    for (let k = 0; k < size; k += 1) sum += placementPoints[position - 1 + k] ?? 0;
    const shared = sum / size;

    for (const id of group.members) {
      placements.push({ id, position, shared: size > 1, resolved: group.resolved });
      pointsByTeam[id] = shared;
    }
    if (!group.resolved) unresolved.push(group.members);
    position += size;
  }

  return { placements, pointsByTeam, unresolved };
}

// ---------------------------------------------------------------------------------------
// Team event statistics
// ---------------------------------------------------------------------------------------

function beerballStats(teams, games) {
  const stats = {};
  for (const team of teams) stats[team.id] = { wins: 0, beerDiff: 0, played: 0 };

  // A beerball_game reaches the permanent log through the Worker's type-only validation, so a
  // malformed one — no pairing, a winner who never played, non-numeric beers — can and will land
  // there (a fat-fingered entry, a half-flushed outbox, a bulk load). Mirror the bad-draft-entry
  // degrade: skip what can't be trusted, collect it in `bad` for the caller to flag, and NEVER
  // throw. A throw here would black out standings, the TV and admin for the rest of the weekend
  // (CLAUDE.md "score() must never throw").
  const valid = [];
  const bad = [];

  for (const game of games) {
    if (!Array.isArray(game.pairs) || game.pairs.length !== 2) {
      bad.push({ gameSlot: game.gameSlot, id: game.id, reason: 'has no valid pairing' });
      continue;
    }
    const [a, b] = game.pairs;
    if (!stats[a] || !stats[b]) continue; // pairing names a team not in this draft — pre-existing silent skip
    valid.push(game);
    stats[a].played += 1;
    stats[b].played += 1;

    // A win is credited only to a pair that actually played this game. wins is Beer Ball's first
    // tiebreak (spec §4.2), so a valid-but-wrong winner id must never earn a phantom win.
    if (game.winner === a || game.winner === b) {
      stats[game.winner].wins += 1;
    } else if (game.winner != null) {
      bad.push({ gameSlot: game.gameSlot, id: game.id, reason: `names a winner (${game.winner}) who did not play it` });
    }

    // Non-finite beers must never reach the differential — it keys a tiebreak bucket, and one NaN
    // would silently mis-partition the whole group (contrast the time path, which guards likewise).
    const beersA = Number(game.beers?.[a] ?? 0);
    const beersB = Number(game.beers?.[b] ?? 0);
    if (Number.isFinite(beersA) && Number.isFinite(beersB)) {
      stats[a].beerDiff += beersA - beersB;
      stats[b].beerDiff += beersB - beersA;
    } else {
      bad.push({ gameSlot: game.gameSlot, id: game.id, reason: 'has non-numeric beers' });
    }
  }

  // headToHeadWins walks only validated games, so its destructure is always safe.
  const headToHeadWins = (id, group) => valid.reduce((wins, game) => {
    const [a, b] = game.pairs;
    const bothInGroup = group.includes(a) && group.includes(b);
    return bothInGroup && game.winner === id ? wins + 1 : wins;
  }, 0);

  return { stats, headToHeadWins, valid, bad };
}

/** Group volleyball sets into matches and decide each one (best of 3, spec + Brad 2026-08-13). */
function volleyballMatches(sets) {
  const byMatch = new Map();
  for (const set of sets) {
    const list = byMatch.get(set.matchSlot) ?? [];
    list.push(set);
    byMatch.set(set.matchSlot, list);
  }

  const matches = [];
  for (const [matchSlot, played] of byMatch) {
    const ordered = [...played].sort((a, b) => a.setNo - b.setNo);
    const setWins = {};
    const teamIds = new Set();
    for (const set of ordered) {
      const ids = Object.keys(set.scores ?? {});
      ids.forEach((id) => teamIds.add(id));
      if (ids.length !== 2) continue;
      const [a, b] = ids;
      const winner = set.scores[a] > set.scores[b] ? a : set.scores[b] > set.scores[a] ? b : null;
      if (winner) setWins[winner] = (setWins[winner] ?? 0) + 1;
    }
    // The match goes to the team with the most sets — but only when it actually has more than
    // anyone else. If a fourth set gets logged and the match sits 2–2, both teams clear
    // `setsToWin` and `find()` would hand the match to whichever set was entered first. An
    // undecided match keeps the event visibly pending, which is the honest answer.
    const [top, runnerUp] = Object.entries(setWins).sort((a, b) => b[1] - a[1]);
    const decided = top && top[1] >= EVENTS.volleyball.setsToWin && (!runnerUp || runnerUp[1] < top[1]);
    matches.push({
      matchSlot, sets: ordered, setWins, teams: [...teamIds],
      winner: decided ? top[0] : null,
      // Flagged, never truncated: point differential sums margins across ALL sets played
      // (Brad, 2026-08-13), so dropping the extra set would quietly change a rule.
      extraSets: ordered.length > EVENTS.volleyball.maxSets,
    });
  }
  return matches.sort((a, b) => a.matchSlot - b.matchSlot);
}

function volleyballStats(teams, matches) {
  const stats = {};
  for (const team of teams) stats[team.id] = { wins: 0, pointDiff: 0, totalPoints: 0 };

  for (const match of matches) {
    if (match.winner && stats[match.winner]) stats[match.winner].wins += 1;
    for (const set of match.sets) {
      const ids = Object.keys(set.scores ?? {});
      if (ids.length !== 2) continue;
      const [a, b] = ids;
      if (stats[a]) {
        stats[a].totalPoints += set.scores[a];
        stats[a].pointDiff += set.scores[a] - set.scores[b]; // margins summed across all sets
      }
      if (stats[b]) {
        stats[b].totalPoints += set.scores[b];
        stats[b].pointDiff += set.scores[b] - set.scores[a];
      }
    }
  }

  const headToHeadWins = (id, group) => matches.reduce((wins, match) => {
    const bothInGroup = match.teams.length === 2
      && group.includes(match.teams[0]) && group.includes(match.teams[1]);
    return bothInGroup && match.winner === id ? wins + 1 : wins;
  }, 0);

  return { stats, headToHeadWins };
}

// ---------------------------------------------------------------------------------------
// Tyler's burn ledger (spec §6.1)
// ---------------------------------------------------------------------------------------

/**
 * Build the 5-slot burn ledger in schedule order and compute the eligible pool for each
 * upcoming pick.
 *
 * Slots 1–2 are DERIVED from the Beer Ball draft — Tyler's pair is the pair he captains, so
 * there is exactly one source of truth for who is in it. Slots 3–5 come from `tyler_pick`
 * entries. The Volleyball pick burns the captain ONLY (spec §6.1: a roster is diluted
 * exposure, an individual pick is full exposure).
 */
export function buildBurns({ drafts, picks, teamsByEvent }) {
  const slots = [];
  const burned = new Map(); // player -> the stage that burned them

  const claim = (player, stage, slot, label) => {
    const duplicateOf = burned.get(player) ?? null;
    if (!duplicateOf) burned.set(player, stage);
    slots.push({ slot, stage, label, player, duplicateOf });
  };

  for (const stageDef of BURN_STAGES) {
    const eligible = ABLE.filter((p) => !burned.has(p));

    if (stageDef.source === 'draft') {
      const pair = (drafts.beerball ?? []).find((t) => t.captain === GM);
      if (pair) {
        pair.members.forEach((player, i) => {
          claim(player, stageDef.stage, stageDef.slots[i] ?? stageDef.slots[0], stageDef.label);
        });
      } else {
        stageDef.slots.forEach((slot) => slots.push({
          slot, stage: stageDef.stage, label: stageDef.label, player: null, eligible,
        }));
      }
      continue;
    }

    const isTeamPick = TYLER_BACKING[stageDef.stage].unit === 'team';
    const teams = teamsByEvent[stageDef.stage] ?? [];
    const pick = picks[stageDef.stage];
    // Volleyball offers teams whose captain is a real player and still unburned; the others
    // offer players. A team whose captain field is a typo has nobody to burn, so it is not a
    // pick Tyler can make (spec §6.1: the Volleyball pick burns the CAPTAIN only).
    const eligibleTargets = isTeamPick
      ? teams.filter((t) => ABLE.includes(t.captain) && !burned.has(t.captain)).map((t) => t.id)
      : eligible;

    // Which makes both kinds of pick the same question: does this target name somebody who can
    // actually be burned? A team entered before its draft, a team carrying a mistyped captain,
    // a player nobody on the roster answers to — each is an unresolved pick, not a burn of
    // nobody. Claiming the bad target would put a phantom in the ledger and let it report five
    // burns when one of them does not exist. The slot waits instead, keeping the eligible pool
    // the UI shows; a team pick heals itself as soon as the draft is right.
    const team = isTeamPick ? teams.find((t) => t.id === pick?.target) : null;
    const resolved = ABLE.includes(isTeamPick ? team?.captain : pick?.target);
    if (!pick || !resolved) {
      slots.push({
        slot: stageDef.slots[0], stage: stageDef.stage, label: stageDef.label,
        player: null, eligible: eligibleTargets,
        ...(pick ? { unresolvedTarget: pick.target } : {}),
      });
      continue;
    }

    claim(isTeamPick ? team.captain : pick.target, stageDef.stage, stageDef.slots[0], stageDef.label);
    if (isTeamPick) slots[slots.length - 1].team = pick.target;
  }

  const duplicates = slots.filter((s) => s.duplicateOf);
  return {
    slots,
    burned: [...burned.keys()],
    duplicates,
    complete: slots.filter((s) => s.player).length === BURN_COUNT && duplicates.length === 0,
  };
}

// ---------------------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------------------

/**
 * Score an effective log into standings.
 *
 * Event status has three states, and the distinction matters on the TV:
 *   - `pending`    — results are still missing and the event is not final. NO points are
 *                    awarded to anyone; the column renders hatched. (Awarding partial ranks
 *                    mid-event would show a slow swimmer who happened to go first in 1st.)
 *   - `unfinalized`— every expected result is in but Brad has not entered `event_final`.
 *                    Points show, plus a chip nudging him to finalize.
 *   - `final`      — `event_final` exists. Points show, and any still-missing result is 0
 *                    per spec §3.2/§10.6 (a warning, never an error).
 */
export function score(effective, options = {}) {
  const latest = resolveLatest(effective);
  const issues = [];
  const addIssue = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra });

  const knobEntry = latest.get('knob');
  const knob = knobEntry ? clampKnob(knobEntry.value) : KNOB.default;
  if (knobEntry && clampKnob(knobEntry.value) !== Number(knobEntry.value)) {
    addIssue('warn', 'knob-clamped',
      `Knob ${knobEntry.value} clamped/snapped to ${knob} (range ${KNOB.min}–${KNOB.max}, step ${KNOB.step}).`);
  }

  // --- drafts -------------------------------------------------------------------------
  // Shapes are checked here, at the one place drafts enter, because everything downstream
  // (validation, team scoring, the burn ledger, Tyler's backing) walks `teams` and
  // `team.members` without looking first. The worker only checks that an entry has a known
  // `type`, so a malformed draft can reach the log — and the log is permanent. Throwing on it
  // would take the standings, the TV and admin down for the rest of the weekend; dropping it
  // with a loud issue keeps the board alive and tells Brad what to re-enter.
  const teamsByEvent = {};
  for (const eventId of EVENT_ORDER) {
    const draft = latest.get(`draft_assignment:${eventId}`);
    if (!draft) continue;
    const declared = Array.isArray(draft.teams) ? draft.teams : [];
    const usable = declared.filter((team) => team && Array.isArray(team.members));
    if (!Array.isArray(draft.teams)) {
      addIssue('error', 'bad-draft-entry',
        `${EVENTS[eventId].label} draft (entry ${draft.id}) carries no list of teams — the whole draft is ignored. Re-enter it.`,
        { event: eventId, entryId: draft.id });
    } else if (usable.length !== declared.length) {
      addIssue('error', 'bad-draft-entry',
        `${EVENTS[eventId].label} draft (entry ${draft.id}): ${declared.length - usable.length} of ${declared.length} teams have no member list and are ignored. Re-enter the draft.`,
        { event: eventId, entryId: draft.id });
    }
    teamsByEvent[eventId] = usable;
  }
  validateDrafts(teamsByEvent, addIssue);

  // --- Tyler's picks, respecting the lock boundary ------------------------------------
  const picks = {};
  for (const stageDef of BURN_STAGES) {
    if (stageDef.source !== 'pick') continue;
    const finalEntry = latest.get(`event_final:${stageDef.stage}`);
    const candidates = effective.filter((e) => e.type === 'tyler_pick' && e.stage === stageDef.stage);
    // Spec §6.1: picks lock before their event. A pick entered after that stage's
    // event_final is rejected — recorded in the log, but never scored.
    //
    // `event_final` is the boundary on purpose (Brad, 2026-08-13). The spec's wording is
    // "before its event begins", but the log has no signal for an event beginning — the only
    // proxy would be its first result, and rejecting a pick Brad typed a beat after the first
    // heat would cost Tyler the points with no repair short of voiding results mid-event.
    const valid = candidates.filter((e) => !finalEntry || e.id < finalEntry.id);
    const rejected = candidates.filter((e) => finalEntry && e.id >= finalEntry.id);
    for (const entry of rejected) {
      addIssue('error', 'pick-after-lock',
        `${GM}'s ${EVENTS[stageDef.stage].label} pick (entry ${entry.id}) was entered after that event was finalized — rejected. Un-finalize the event first.`,
        { stage: stageDef.stage, entryId: entry.id });
    }
    if (valid.length) picks[stageDef.stage] = valid[valid.length - 1];
  }

  const burns = buildBurns({ drafts: teamsByEvent, picks, teamsByEvent });
  for (const slot of burns.slots) {
    if (!slot.unresolvedTarget) continue;
    addIssue('warn', 'pick-target-unknown',
      TYLER_BACKING[slot.stage].unit === 'team'
        ? `${GM}'s ${EVENTS[slot.stage].label} pick names ${slot.unresolvedTarget}, which does not resolve to a drafted team with a captain on the roster — fix the draft and the pick resolves itself.`
        : `${GM}'s ${EVENTS[slot.stage].label} pick names ${slot.unresolvedTarget}, who is not an eligible player — re-enter the pick.`,
      { stage: slot.stage, target: slot.unresolvedTarget });
  }
  for (const dup of burns.duplicates) {
    addIssue('error', 'duplicate-burn',
      `${dup.player} is already burned (${EVENTS[dup.duplicateOf]?.label ?? dup.duplicateOf}) — spec §6.1 requires all 5 burns to be unique.`,
      { stage: dup.stage, player: dup.player });
  }

  // --- per-event scoring ---------------------------------------------------------------
  const events = {};
  for (const eventId of EVENT_ORDER) {
    events[eventId] = EVENTS[eventId].type === 'individual'
      ? scoreIndividualEvent(eventId, { latest, effective, knob, addIssue })
      : scoreTeamEvent(eventId, { latest, effective, teams: teamsByEvent[eventId], addIssue });
  }

  // --- Tyler's derived points ----------------------------------------------------------
  applyTylerBacking(events, { picks, teamsByEvent, burns, addIssue });

  // --- totals, ranks, champion ---------------------------------------------------------
  const players = buildPlayerRows(events);
  const championship = resolveChampionship(players, latest, addIssue);
  // Ranked order is what every view wants; roster order is never useful downstream.
  players.sort((a, b) => a.rank - b.rank || ROSTER.indexOf(a.player) - ROSTER.indexOf(b.player));

  return {
    knob,
    events,
    players,
    burns,
    issues,
    championship,
    lastEntryId: effective.length ? effective[effective.length - 1].id : 0,
  };
}

// ---------------------------------------------------------------------------------------

function validateDrafts(teamsByEvent, addIssue) {
  for (const [eventId, teams] of Object.entries(teamsByEvent)) {
    const config = EVENTS[eventId];
    const seen = new Map();
    for (const team of teams) {
      for (const member of team.members) {
        if (seen.has(member)) {
          addIssue('error', 'double-rostered',
            `${member} is on two ${config.label} teams (spec §10.2) — each player belongs to exactly one.`,
            { event: eventId, player: member });
        }
        seen.set(member, team.id);
        if (!config.participants.includes(member)) {
          addIssue('error', 'not-a-participant',
            `${member} is not a ${config.label} participant but was drafted onto ${team.id}.`,
            { event: eventId, player: member });
        }
      }
    }

    const missing = config.participants.filter((p) => !seen.has(p));
    if (teams.length && missing.length) {
      addIssue('warn', 'undrafted',
        `${config.label}: ${missing.join(', ')} not yet on a team.`,
        { event: eventId });
    }

    // Spec §10.2: Beer Ball pairs are exactly 2.
    if (eventId === 'beerball') {
      for (const team of teams) {
        if (team.members.length !== config.teamSize) {
          addIssue('error', 'bad-pair-size',
            `Beer Ball pair ${team.id} has ${team.members.length} players; pairs are exactly 2 (spec §10.2).`,
            { event: eventId });
        }
      }
    }

    // Spec §10.3: Tyler is always on the 6-player Wiffle side.
    if (eventId === 'wiffle' && teams.length === 2) {
      const tylerTeam = teams.find((t) => t.members.includes(GM));
      const sizes = teams.map((t) => t.members.length).sort((a, b) => b - a);
      if (tylerTeam && tylerTeam.members.length !== sizes[0]) {
        addIssue('error', 'tyler-wrong-side',
          `${GM} must be on the 6-player Wiffle side (spec §4.1/§10.3).`, { event: eventId });
      }
    }

    // Spec §4.5: volleyball is 4/3/3.
    if (eventId === 'volleyball' && teams.length === config.teamCount) {
      const sizes = teams.map((t) => t.members.length).sort((a, b) => b - a);
      if (sizes.join(',') !== config.teamSizes.join(',')) {
        addIssue('error', 'bad-team-sizes',
          `Volleyball teams are ${sizes.join('/')}; spec §4.5 requires ${config.teamSizes.join('/')}.`,
          { event: eventId });
      }
    }
  }
}

/**
 * An override states a finishing order outright, so a malformed one has nothing to state. Both
 * event scorers walk `placements` without checking, and a stray override missing that list would
 * throw — permanently, since the log is append-only. Treated as absent instead: the event scores
 * normally if it can and renders pending if it cannot, with the bad entry named.
 */
function usableOverride(override, eventId, addIssue, validIds) {
  if (!override) return null;
  if (!Array.isArray(override.placements)) {
    addIssue('error', 'bad-override',
      `${EVENTS[eventId].label} override (entry ${override.id}) has no placements list — it is ignored and the event scores normally. Re-enter it.`,
      { event: eventId, entryId: override.id });
    return null;
  }
  // An override always wins (spec §8), but a placements list that names a competitor not in the
  // event or omits one that is is almost always a typo — and it silently zeroes the omitted player
  // or awards a phantom. Surface it as a warning; the override is still applied.
  if (Array.isArray(validIds) && validIds.length) {
    const valid = new Set(validIds);
    const unknown = override.placements.filter((id) => !valid.has(id));
    const missing = validIds.filter((id) => !override.placements.includes(id));
    if (unknown.length || missing.length) {
      const parts = [];
      if (unknown.length) parts.push(`names ${unknown.join(', ')} (not in this event)`);
      if (missing.length) parts.push(`omits ${missing.join(', ')}`);
      addIssue('warn', 'override-roster-mismatch',
        `${EVENTS[eventId].label} override (entry ${override.id}) ${parts.join(' and ')} — it is still applied; double-check the order.`,
        { event: eventId, entryId: override.id });
    }
  }
  return override;
}

function scoreIndividualEvent(eventId, { latest, effective, knob, addIssue }) {
  const config = EVENTS[eventId];
  const finalized = latest.has(`event_final:${eventId}`);
  const override = usableOverride(latest.get(`override:${eventId}`), eventId, addIssue, config.participants);

  const values = {};
  for (const player of config.participants) {
    const entry = latest.get(`time:${eventId}:${player}`);
    if (entry && Number.isFinite(Number(entry.value))) values[player] = Number(entry.value);
  }

  // Times entered for someone who is not in this event never score (spec §2/§4.3: Tyler
  // does not swim). Flagged loudly rather than silently absorbed.
  for (const entry of effective) {
    if (entry.type !== 'time' || entry.event !== eventId) continue;
    if (!config.participants.includes(entry.player)) {
      addIssue('error', 'not-a-participant',
        `${entry.player} is not a ${config.label} participant — that result is ignored.`,
        { event: eventId, player: entry.player });
    }
  }

  const missing = config.participants.filter((p) => !(p in values));
  const complete = missing.length === 0;
  const status = finalized ? 'final' : (complete || override) ? 'unfinalized' : 'pending';

  const base = {
    id: eventId, label: config.label, short: config.short, order: config.order,
    type: 'individual', status, complete, finalized,
    overridden: Boolean(override), overrideReason: override?.reason ?? null,
    manualRequired: false, missing, values,
  };

  if (status === 'pending') {
    return { ...base, points: {}, placement: {}, pending: true };
  }

  if (override) {
    // An override states the finishing order outright; points follow the §3.2 formula from
    // those positions so the knob still applies exactly as it would have.
    const points = {};
    const placement = {};
    override.placements.forEach((player, i) => {
      points[player] = rawPointsForRank(i + 1, config.participants.length) * knob;
      placement[player] = i + 1;
    });
    for (const player of config.participants) {
      if (!(player in points)) { points[player] = 0; placement[player] = config.participants.length; }
    }
    return { ...base, points, placement, pending: false };
  }

  const { points, placement, blanks } = rankIndividual({
    values, participants: config.participants, direction: config.direction, knob,
  });

  if (finalized && blanks.length) {
    addIssue('warn', 'blank-scored-zero',
      `${config.label}: ${blanks.join(', ')} had no result at finalize — 0 points (spec §3.2).`,
      { event: eventId });
  }

  return { ...base, points, placement, pending: false };
}

function scoreTeamEvent(eventId, { latest, effective, teams, addIssue }) {
  const config = EVENTS[eventId];
  const finalized = latest.has(`event_final:${eventId}`);
  const override = usableOverride(latest.get(`override:${eventId}`), eventId, addIssue,
    teams && teams.length ? teams.map((t) => t.id) : null);

  const base = {
    id: eventId, label: config.label, short: config.short, order: config.order,
    type: 'team', finalized,
    overridden: Boolean(override), overrideReason: override?.reason ?? null,
    manualRequired: false, teams: teams ?? null,
  };

  if (!teams || !teams.length) {
    return {
      ...base, status: 'pending', complete: false, pending: true,
      points: {}, placements: [], teamPoints: {},
    };
  }

  const detail = eventId === 'wiffle'
    ? wiffleDetail(latest, teams)
    : eventId === 'beerball'
      ? beerballDetail(effective, teams)
      : volleyballDetail(effective, teams);

  for (const match of detail.matches ?? []) {
    if (!match.extraSets) continue;
    addIssue('warn', 'too-many-sets',
      `${config.label} match ${match.matchSlot} has ${match.sets.length} sets logged; it is best of ${config.maxSets}. Check the set numbers.`,
      { event: eventId, matchSlot: match.matchSlot });
  }

  for (const bad of detail.badGames ?? []) {
    addIssue('error', 'bad-beerball-entry',
      `${config.label} game ${bad.gameSlot} (entry ${bad.id}) ${bad.reason} — it is ignored. Re-enter it.`,
      { event: eventId, gameSlot: bad.gameSlot, entryId: bad.id });
  }

  const complete = detail.complete || Boolean(override);
  const status = finalized ? 'final' : complete ? 'unfinalized' : 'pending';

  if (status === 'pending') {
    return { ...base, ...detail, status, complete: false, pending: true, points: {}, teamPoints: {} };
  }

  let teamPoints;
  let placements;
  let unresolved = [];

  if (override) {
    teamPoints = {};
    placements = override.placements.map((id, i) => ({ id, position: i + 1, shared: false, resolved: true }));
    override.placements.forEach((id, i) => { teamPoints[id] = config.placementPoints[i] ?? 0; });
    for (const team of teams) if (!(team.id in teamPoints)) teamPoints[team.id] = 0;
  } else {
    const groups = resolveGroup(teams.map((t) => t.id), config.tiebreakRules ?? [], detail.ctx ?? {});
    const resolvedOut = placementsFromGroups(groups, config.placementPoints);
    teamPoints = resolvedOut.pointsByTeam;
    placements = resolvedOut.placements;
    unresolved = resolvedOut.unresolved;
  }

  for (const group of unresolved) {
    const names = group.map((id) => teams.find((t) => t.id === id)?.label ?? id).join(', ');
    addIssue('error', 'manual-resolution-required',
      `${config.label}: ${names} are tied with every tiebreaker exhausted — ${eventId === 'beerball' ? 'chug-off' : 'play-in'} required, then enter an override (spec §${eventId === 'beerball' ? '4.2' : '4.5'}).`,
      { event: eventId, teams: group });
  }

  const points = {};
  for (const team of teams) {
    for (const member of team.members) points[member] = teamPoints[team.id] ?? 0;
  }

  return {
    ...base, ...detail, status, complete: true, pending: false,
    points, teamPoints, placements,
    manualRequired: unresolved.length > 0, unresolved,
  };
}

function wiffleDetail(latest, teams) {
  const result = latest.get('wiffle_result:wiffle');
  const winner = result?.winner ?? null;
  return {
    winner,
    complete: Boolean(winner),
    // Spec §4.1 is winner-take-all, so there is no round robin to resolve: the "stats" are
    // just the result, expressed so the shared placement machinery can consume them.
    ctx: {
      stats: Object.fromEntries(teams.map((t) => [t.id, { wins: t.id === winner ? 1 : 0 }])),
      headToHeadWins: () => 0,
    },
  };
}

function beerballDetail(effective, teams) {
  const config = EVENTS.beerball;
  const bySlot = new Map();
  for (const entry of effective) {
    if (entry.type === 'beerball_game') bySlot.set(entry.gameSlot, entry);
  }
  const games = [...bySlot.values()].sort((a, b) => a.gameSlot - b.gameSlot);
  const { stats, headToHeadWins, valid, bad } = beerballStats(teams, games);
  return {
    // Only well-formed games are exposed to render/complete; malformed ones are flagged (below),
    // never shown — this also keeps the events view from walking a bad game's missing `pairs`.
    games: valid,
    badGames: bad,
    complete: valid.length === config.gameCount,
    ctx: { stats, headToHeadWins },
  };
}

function volleyballDetail(effective, teams) {
  const config = EVENTS.volleyball;
  const byKey = new Map();
  for (const entry of effective) {
    if (entry.type === 'volleyball_set') byKey.set(`${entry.matchSlot}:${entry.setNo}`, entry);
  }
  const sets = [...byKey.values()];
  const matches = volleyballMatches(sets);
  const { stats, headToHeadWins } = volleyballStats(teams, matches);
  const decided = matches.filter((m) => m.winner).length;
  return {
    matches,
    complete: decided === config.matchCount,
    ctx: { stats, headToHeadWins },
  };
}

/**
 * Spec §6: Tyler earns the EXACT final points of whoever he backed — his pair's points, his
 * picked swimmer's (already knob-multiplied) points, his picked volleyball team's points.
 * Pass-through, never recomputed, so his cell always matches theirs to the decimal.
 *
 * A pick only pays if it BURNED somebody. In spec §6 the points and the burn are the same act,
 * so a pick that burned nobody — never made, naming a target that does not resolve, or spending
 * a burn Tyler already spent (§6.1: all five unique) — earns nothing, and his cell renders
 * pending until it is fixed (Brad, 2026-08-13). Showing points from an illegal pick would put a
 * number on the TV that he is not entitled to, and quietly fold it into the §7 championship.
 * The burn ledger is the single source of truth for that: it has already run every check, and
 * each failure has already named itself in `issues`.
 */
function applyTylerBacking(events, { picks, teamsByEvent, burns, addIssue }) {
  for (const [eventId, backing] of Object.entries(TYLER_BACKING)) {
    if (backing.mode === 'plays') continue;
    const event = events[eventId];

    if (event.pending) { event.tylerSource = null; continue; }

    if (backing.mode === 'derived') { // Beer Ball: the pair he captains
      const pair = (teamsByEvent[eventId] ?? []).find((t) => t.captain === GM);
      if (!pair) {
        addIssue('warn', 'tyler-no-backing',
          `${GM} has no ${EVENTS[eventId].label} pair yet — enter the draft to score his points.`,
          { event: eventId });
        continue;
      }
      event.points[GM] = event.teamPoints?.[pair.id] ?? 0;
      event.tylerSource = { kind: 'pair', id: pair.id, members: pair.members };
      continue;
    }

    const pick = picks[eventId];
    if (!pick) {
      addIssue('warn', 'tyler-no-pick',
        `${GM} has not picked for ${EVENTS[eventId].label} — no points until he does.`,
        { event: eventId });
      continue;
    }

    const slot = burns.slots.find((s) => s.stage === eventId);
    if (!slot?.player || slot.duplicateOf) {
      event.tylerSource = null; // the pick burned nobody: unresolved target, or already spent
      continue;
    }

    if (backing.unit === 'team') {
      const team = (teamsByEvent[eventId] ?? []).find((t) => t.id === pick.target);
      event.points[GM] = event.teamPoints?.[pick.target] ?? 0;
      event.tylerSource = { kind: 'team', id: pick.target, captain: team?.captain ?? null };
    } else {
      event.points[GM] = event.points[pick.target] ?? 0;
      // Spec §7: for Swim and Gauntlet, Tyler's PLACEMENT is his picked player's placement.
      if (event.placement) event.placement[GM] = event.placement[pick.target];
      event.tylerSource = { kind: 'player', id: pick.target };
    }
  }
}

function buildPlayerRows(events) {
  const rows = ROSTER.map((player) => {
    const byEvent = {};
    let total = 0;

    for (const eventId of EVENT_ORDER) {
      const event = events[eventId];
      const plays = EVENTS[eventId].participants.includes(player) || player === GM;
      if (!plays) { byEvent[eventId] = { points: null, pending: false, na: true }; continue; }

      if (event.pending || !(player in event.points)) {
        byEvent[eventId] = { points: null, pending: true, na: false, flagged: event.overridden };
        continue;
      }
      const points = event.points[player];
      total += points;
      byEvent[eventId] = {
        points,
        pending: false,
        na: false,
        flagged: event.overridden || event.manualRequired,
        unfinalized: event.status === 'unfinalized',
      };
    }

    // Spec §7 tiebreak column: average placement across the three individual events.
    const placements = INDIVIDUAL_EVENTS
      .map((id) => events[id].placement?.[player])
      .filter((p) => Number.isFinite(p));
    const avgIndividualPlacement = placements.length
      ? placements.reduce((a, b) => a + b, 0) / placements.length
      : null;

    return {
      player, byEvent, total, totalRounded: round1(total),
      avgIndividualPlacement,
      individualPlacements: placements.length,
    };
  });

  return rows;
}

/**
 * Spec §7: champion = highest total. Tie → lowest average placement across the three
 * individual events. Still tied → head-to-head beer pong, recorded as `championship_tiebreak`.
 *
 * Every total comparison happens at 1 decimal (`totalRounded`). Comparing raw floats would let
 * 248.29999999999998 quietly beat 248.3 and rob the weekend of a genuine tie — and a tie for
 * the championship is a feature here, not a rounding artifact.
 */
function resolveChampionship(players, latest, addIssue) {
  const ranked = [...players].sort((a, b) => b.totalRounded - a.totalRounded);

  let position = 1;
  let index = 0;
  while (index < ranked.length) {
    const total = ranked[index].totalRounded;
    let size = 1;
    while (index + size < ranked.length && ranked[index + size].totalRounded === total) size += 1;

    for (let k = 0; k < size; k += 1) {
      ranked[index + k].rank = position;
      ranked[index + k].rankLabel = size > 1 ? `T${position}` : String(position);
      ranked[index + k].tied = size > 1;
    }
    position += size;
    index += size;
  }

  // Write ranks back onto the original row objects (same references).
  const leaders = ranked.filter((r) => r.rank === 1);
  if (leaders.length === 1) {
    return { player: leaders[0].player, resolvedBy: 'total', contenders: leaders.map((l) => l.player) };
  }

  // Tie on total → lowest average placement across THE THREE individual events.
  //
  // All three, from every tied leader, or the rule does not apply (Brad, 2026-08-13). An average
  // over two events is simply not the same quantity as an average over three, so a leader missing
  // one — Tyler, when he never picked for the Gauntlet — can neither win nor lose the title on the
  // comparison. The chain skips straight to beer pong, which is a thing Brad can actually hold.
  let contenders = leaders;
  const comparable = leaders.every((l) => l.individualPlacements === INDIVIDUAL_EVENTS.length);
  if (comparable) {
    const best = Math.min(...leaders.map((l) => l.avgIndividualPlacement));
    const stillTied = leaders.filter((l) => l.avgIndividualPlacement === best);
    if (stillTied.length === 1) {
      return {
        player: stillTied[0].player, resolvedBy: 'avgIndividualPlacement',
        contenders: leaders.map((l) => l.player),
      };
    }
    contenders = stillTied;
  }

  // Still tied → head-to-head beer pong (spec §7).
  const tiebreak = latest.get('championship_tiebreak');
  if (tiebreak && contenders.some((l) => l.player === tiebreak.winner)) {
    return {
      player: tiebreak.winner, resolvedBy: 'championship_tiebreak',
      contenders: contenders.map((l) => l.player),
    };
  }
  // Only worth saying once there is individual-event data to be tied on: early Friday every
  // player sits at 0 and is "tied", and nagging about beer pong then is noise on the TV.
  if (contenders.some((l) => l.individualPlacements > 0)) {
    addIssue('warn', 'championship-tie',
      `${contenders.map((l) => l.player).join(' and ')} are tied on total, with average individual placement unable to separate them — spec §7 calls for head-to-head beer pong.`,
      { players: contenders.map((l) => l.player) });
  }
  return { player: null, resolvedBy: null, contenders: contenders.map((l) => l.player) };
}

// ---------------------------------------------------------------------------------------
// Replay + movement
// ---------------------------------------------------------------------------------------

/** Standings as of the first `count` effective entries. The whole weekend replay is just
 *  calling this in a loop — one of the things the append-only log buys for free. */
export function scoreAt(effective, count, options) {
  return score(effective.slice(0, count), options);
}

/**
 * Movement arrows: current rank vs rank immediately BEFORE the most recent `event_final`.
 * That boundary is the snapshot the TV compares against, so arrows mean "since the last
 * event finished" rather than "since the last keystroke".
 */
export function movementSinceLastEvent(effective, options) {
  const finals = effective
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === 'event_final');
  if (!finals.length) return {};

  const boundary = finals[finals.length - 1].index;
  const before = score(effective.slice(0, boundary), options);
  const now = score(effective, options);

  const previousRank = Object.fromEntries(before.players.map((p) => [p.player, p.rank]));
  const movement = {};
  for (const row of now.players) {
    const was = previousRank[row.player];
    movement[row.player] = Number.isFinite(was) ? was - row.rank : 0;
  }
  return movement;
}

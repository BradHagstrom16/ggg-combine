/**
 * src/events-view.js — pure view-models for the friends-facing /events browse page.
 *
 * Same split as render.js: every decision here is a pure function of score()'s output, unit-tested
 * against the golden weekend; events.html is a thin DOM shell that walks these descriptors. Nothing
 * is re-scored — who-beat-whom, per-team standings, and the per-player breakdown are all derived
 * from result.events[...] / result.players, never recomputed from raw entries.
 *
 * The one thing derived rather than read: beer-ball wins/differential, folded straight from the
 * event's `games` array so the page never reaches into the engine's internal `ctx`.
 */
import { round1, EVENT_ORDER, EVENTS } from './rules-config.js';
import { cellView } from './render.js';

/* ---- Event headline (status the way a viewer reads it) ----------------------------------- */

/** Has this event actually started (results entered), vs merely drafted / not begun? */
function eventStarted(ev) {
  if (!ev) return false;
  if (ev.type === 'individual') return Object.keys(ev.values || {}).length > 0;
  return !!(ev.winner || (ev.games && ev.games.length) || (ev.matches && ev.matches.length));
}

/**
 * The status a friend sees on a card: Final / awaiting-finalize / in-progress / not-started, plus a
 * manual-resolution flag and the override note. `state` is a stable slug for CSS/status-dot reuse.
 */
export function eventHeadline(result, eventId) {
  const ev = (result.events || {})[eventId] || {};
  const cfg = EVENTS[eventId] || {};
  const started = eventStarted(ev);
  let state;
  let label;
  if (ev.overridden) { state = 'final'; label = 'Final · manual'; }
  else if (ev.manualRequired) { state = 'manual'; label = 'Needs manual resolution'; }
  else if (ev.status === 'final') { state = 'final'; label = 'Final'; }
  else if (ev.status === 'unfinalized') { state = 'unfinalized'; label = 'Complete · awaiting finalize'; }
  else { state = started ? 'live' : 'idle'; label = started ? 'In progress' : 'Not started'; }
  return {
    id: eventId,
    short: ev.short || cfg.short || eventId,
    label: ev.label || cfg.label || eventId,
    day: cfg.day || 'Weekend',
    type: ev.type || cfg.type || null,
    state,
    statusLabel: label,
    started,
    overridden: !!ev.overridden,
    overrideReason: ev.overrideReason || null,
  };
}

/** EVENT_ORDER grouped into day sections (Friday, Saturday, …) preserving schedule order. */
export function eventsByDay() {
  const groups = [];
  for (const id of EVENT_ORDER) {
    const day = (EVENTS[id] || {}).day || 'Weekend';
    let g = groups.find((x) => x.day === day);
    if (!g) { g = { day, ids: [] }; groups.push(g); }
    g.ids.push(id);
  }
  return groups;
}

/* ---- Team result boards ------------------------------------------------------------------ */

function captainMaps(ev) {
  const captain = {};
  const members = {};
  for (const t of ev.teams || []) { captain[t.id] = t.captain; members[t.id] = t.members || []; }
  return { captain, members };
}

function placementMap(ev) {
  const pos = {};
  for (const p of ev.placements || []) pos[p.id] = p.position;
  return pos;
}

/**
 * Beer Ball: the game-by-game list (winner beats loser, beer counts) plus a per-pair standings table
 * (wins → beer differential) ordered by the engine's resolved placement. Wins/diff are folded from
 * `games` here rather than read from the engine's internal ctx.
 */
export function beerballBoard(result) {
  const ev = (result.events || {}).beerball || {};
  const { captain, members } = captainMaps(ev);
  const capName = (id) => captain[id] || id;

  const games = (ev.games || []).slice().sort((a, b) => a.gameSlot - b.gameSlot).map((g) => {
    const w = g.winner;
    const l = (g.pairs || []).find((id) => id !== w) ?? null;
    const beers = g.beers || {};
    return {
      slot: g.gameSlot,
      winnerId: w, loserId: l,
      winner: capName(w), loser: l != null ? capName(l) : null,
      winnerBeers: w in beers ? beers[w] : null,
      loserBeers: l != null && l in beers ? beers[l] : null,
    };
  });

  const stats = {};
  for (const t of ev.teams || []) stats[t.id] = { wins: 0, beerDiff: 0, played: 0 };
  for (const g of ev.games || []) {
    const [x, y] = g.pairs || [];
    if (!stats[x] || !stats[y]) continue;
    stats[x].played += 1; stats[y].played += 1;
    if (g.winner === x) stats[x].wins += 1; else if (g.winner === y) stats[y].wins += 1;
    const b = g.beers || {};
    const bx = Number(b[x] || 0); const by = Number(b[y] || 0);
    stats[x].beerDiff += bx - by; stats[y].beerDiff += by - bx;
  }
  const pos = placementMap(ev);
  const pts = ev.teamPoints || {};
  const standings = (ev.teams || []).map((t) => ({
    id: t.id, captain: t.captain, members: members[t.id],
    wins: stats[t.id].wins, beerDiff: round1(stats[t.id].beerDiff), played: stats[t.id].played,
    position: pos[t.id] ?? null, points: pts[t.id] ?? null,
  })).sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || b.wins - a.wins || b.beerDiff - a.beerDiff);

  return { games, standings };
}

/** Volleyball: per-match set scores + winner, plus a wins-ordered standings table. */
export function volleyballBoard(result) {
  const ev = (result.events || {}).volleyball || {};
  const { captain, members } = captainMaps(ev);
  const capName = (id) => captain[id] || id;

  const matches = (ev.matches || []).slice().sort((a, b) => a.matchSlot - b.matchSlot).map((m) => {
    const ids = (m.teams && m.teams.length ? m.teams : Object.keys(m.setWins || {}));
    const [x, y] = ids;
    const setWins = m.setWins || {};
    return {
      slot: m.matchSlot,
      aId: x, bId: y, a: capName(x), b: capName(y),
      sets: (m.sets || []).slice().sort((s, t) => s.setNo - t.setNo)
        .map((s) => ({ setNo: s.setNo, a: (s.scores || {})[x] ?? null, b: (s.scores || {})[y] ?? null })),
      setWins: { a: setWins[x] ?? null, b: setWins[y] ?? null },
      winner: m.winner ? capName(m.winner) : null,
      winnerId: m.winner ?? null,
    };
  });

  const pos = placementMap(ev);
  const pts = ev.teamPoints || {};
  const standings = (ev.teams || []).map((t) => ({
    id: t.id, captain: t.captain, members: members[t.id],
    position: pos[t.id] ?? null, points: pts[t.id] ?? null,
  })).sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  return { matches, standings };
}

/** Wiffle: the two teams with the winner flagged (winner-take-all, no game list). */
export function wiffleBoard(result) {
  const ev = (result.events || {}).wiffle || {};
  const pts = ev.teamPoints || {};
  const teams = (ev.teams || []).map((t) => ({
    id: t.id, captain: t.captain, members: t.members || [],
    points: pts[t.id] ?? null, isWinner: ev.winner === t.id,
  }));
  return { teams, winner: teams.find((t) => t.isWinner) || null, decided: !!ev.winner };
}

/* ---- Individual result board ------------------------------------------------------------- */

/** An individual event as a leaderboard: placement, raw value, points; unplaced (pending) rows last. */
export function individualBoard(result, eventId) {
  const ev = (result.events || {})[eventId] || {};
  const cfg = EVENTS[eventId] || {};
  const values = ev.values || {};
  const placement = ev.placement || {};
  const points = ev.points || {};
  const rows = (cfg.participants || []).map((p) => ({
    player: p,
    value: values[p] ?? null,
    placement: placement[p] ?? null,
    points: p in points ? points[p] : null,
    pending: !(p in values),
  })).sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999) || a.player.localeCompare(b.player));
  return { rows, direction: cfg.direction || null, unit: cfg.unit || null };
}

/* ---- Per-player drill-down --------------------------------------------------------------- */

/** The team captain whose roster includes `name` for a team event, else null. */
function teamCaptainFor(ev, name) {
  if (!ev || ev.type !== 'team') return null;
  const t = (ev.teams || []).find((tt) => (tt.members || []).includes(name));
  return t ? t.captain : null;
}

/** `name`'s placement in an event: their own for individual, their team's for team events. */
function playerPlacement(ev, name) {
  if (!ev) return null;
  if (ev.type === 'individual') return (ev.placement || {})[name] ?? null;
  const t = (ev.teams || []).find((tt) => (tt.members || []).includes(name));
  if (!t) return null;
  const p = (ev.placements || []).find((pp) => pp.id === t.id);
  return p ? p.position : null;
}

/**
 * "How is Murph doing, where is he gaining points?" — rank, movement, and a per-event row carrying
 * the scored/pending/na cell (via render's cellView), the team they're on, and their placement.
 * Returns null when the name isn't on the roster.
 */
export function playerBreakdown(result, movement, name) {
  const row = (result.players || []).find((p) => p.player === name);
  if (!row) return null;
  const rows = EVENT_ORDER.map((id) => {
    const ev = (result.events || {})[id] || {};
    const cfg = EVENTS[id] || {};
    return {
      id,
      short: ev.short || cfg.short || id,
      day: cfg.day || 'Weekend',
      type: ev.type || cfg.type || null,
      cell: cellView((row.byEvent || {})[id]),
      team: teamCaptainFor(ev, name),
      placement: playerPlacement(ev, name),
    };
  });
  return {
    player: name,
    rank: row.rank,
    rankLabel: row.rankLabel,
    tied: !!row.tied,
    total: row.totalRounded,
    movement: (movement || {})[name] ?? 0,
    avgIndividualPlacement: row.avgIndividualPlacement ?? null,
    rows,
  };
}

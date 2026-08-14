/**
 * src/render.js — the standings render layer, shared by index.html (viewer + TV) and admin.html
 * (knob preview). It is split in two on purpose:
 *
 *   - PURE helpers (formatCellPoints, cellView, movementArrow, …) turn score() output into
 *     display strings and small view descriptors. All the decisions live here so they can be
 *     unit-tested with node:test and mutation-checked — no DOM needed.
 *   - renderStandings() is the one DOM writer. It contains no scoring logic; it walks the pure
 *     descriptors and emits table cells. It is validated in a real browser.
 *
 * Every value shown here is DERIVED from the effective log on each render — nothing is stored.
 * Totals are displayed at 1 decimal so float dust can never silently defeat a §7 championship
 * tie; a pending cell (no data yet) is blank, never 0 (0 is a real, scored result).
 */
import { round1, EVENTS, GM } from './rules-config.js';

/* ---- Pure formatters --------------------------------------------------------------------- */

/** A per-event cell's number: integers bare (team points, 110.0), otherwise 1 decimal. */
export function formatCellPoints(points) {
  const r = round1(Number(points));
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** A total: always 1 decimal, including a trailing .0 (the value is already round1'd). */
export function formatTotal(totalRounded) {
  return Number(totalRounded).toFixed(1);
}

/**
 * A view descriptor for one byEvent cell. Distinguishes the three states the board must never
 * confuse: `na` (player isn't in this event) → blank; `pending` (no data yet) → blank/hatched;
 * `scored` → the number (which may legitimately be 0). Carries the override (`flagged`) and
 * finalize-nudge (`unfinalized`) flags straight through from the engine.
 */
export function cellView(cell) {
  if (!cell || cell.na) return { kind: 'na', text: '', flagged: false, unfinalized: false };
  if (cell.pending) return { kind: 'pending', text: '', flagged: !!cell.flagged, unfinalized: false };
  return {
    kind: 'scored',
    text: formatCellPoints(cell.points),
    flagged: !!cell.flagged,
    unfinalized: !!cell.unfinalized,
  };
}

/** Rank movement since the last event_final. Positive delta = moved UP (engine convention). */
export function movementArrow(delta) {
  if (delta == null || delta === 0) return { dir: 'none', text: '—' };
  if (delta > 0) return { dir: 'up', text: `▲${delta}` };
  return { dir: 'down', text: `▼${Math.abs(delta)}` };
}

function formatKnob(knob) {
  return String(Number(Number(knob).toFixed(2)));
}

export function knobChipText(knob) {
  return `INDIVIDUAL ×${formatKnob(knob)}`;
}

/** "updated Xs ago" — amber once it crosses ~60s so a frozen board is obvious on the TV. */
export function ageLabel(ageMs) {
  const s = Math.max(0, Math.floor(Number(ageMs) / 1000));
  let text;
  if (s < 60) text = `updated ${s}s ago`;
  else if (s < 3600) text = `updated ${Math.floor(s / 60)}m ago`;
  else text = `updated ${Math.floor(s / 3600)}h ago`;
  return { text, amber: ageMs > 60000 };
}

/** Partition issues[] by level so the UI can surface errors loudly and warnings quietly. */
export function issueSummary(issues = []) {
  const list = Array.isArray(issues) ? issues : [];
  const errors = list.filter((i) => i && i.level === 'error');
  const warns = list.filter((i) => i && i.level === 'warn');
  return { errors, warns, hasErrors: errors.length > 0, hasWarns: warns.length > 0 };
}

export function issueText(issue) {
  return (issue && (issue.message || issue.code)) || 'issue';
}

function backingLabel(source) {
  if (!source) return null;
  if (source.kind === 'pair') return (source.members || []).join(' & ');
  if (source.kind === 'team') return source.captain || source.id;
  if (source.kind === 'player') return source.id;
  return null;
}

/**
 * The events Tyler is backing (not playing) that have a resolved source, in schedule order.
 * Derived entirely from events[e].tylerSource — the burn/backing decision is the engine's, never
 * recomputed here.
 */
export function tylerBackingSummary(result) {
  const events = (result && result.events) || {};
  return Object.values(events)
    .filter((e) => e && e.tylerSource)
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ eventId: e.id, short: e.short, kind: e.tylerSource.kind, label: backingLabel(e.tylerSource) }))
    .filter((e) => e.label);
}

/** Broadcast subtitle: where the weekend is right now, e.g. "SATURDAY — AFTER SWIM · NEXT UP: BAGS". */
export function progressSubtitle(result) {
  const events = Object.values((result && result.events) || {}).sort((a, b) => a.order - b.order);
  const finals = events.filter((e) => e.status === 'final');
  const upcoming = events.find((e) => e.status !== 'final');
  const last = finals[finals.length - 1];
  // The engine's event objects don't carry `day` — it's static config, so read it from rules.
  const lastDay = last && EVENTS[last.id] ? EVENTS[last.id].day : null;
  const prefix = last
    ? `${lastDay ? `${lastDay.toUpperCase()} — ` : ''}AFTER ${last.short.toUpperCase()}`
    : 'NOT STARTED';
  const suffix = upcoming ? `NEXT UP: ${upcoming.short.toUpperCase()}` : 'COMPLETE';
  return `${prefix} · ${suffix}`;
}

/* ---- DOM writer -------------------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Render the standings table into `root`. Columns follow the engine's event order; rows follow
 * players[] (already sorted by rank). `movement` is the map from movementSinceLastEvent().
 *
 * Contains no scoring logic — it only lays out what the pure helpers describe. Guarded so a
 * malformed result degrades to an empty-but-standing table rather than throwing (score() never
 * throws; neither should its renderer).
 */
export function renderStandings(root, result, movement = {}, opts = {}) {
  root.textContent = '';
  if (!result || !Array.isArray(result.players)) {
    root.appendChild(el('p', 'muted', 'No standings yet.'));
    return;
  }

  const events = Object.values(result.events || {}).sort((a, b) => a.order - b.order);
  const table = el('table', 'standings');

  // Header
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', 'col-rank'));
  hr.appendChild(el('th', 'col-move'));
  hr.appendChild(el('th', 'col-name l', 'Player'));
  for (const ev of events) {
    const th = el('th', `col-event${ev.status === 'pending' ? ' pend' : ''}`, ev.short);
    if (ev.overridden) th.title = ev.overrideReason || 'commissioner override';
    hr.appendChild(th);
  }
  hr.appendChild(el('th', 'col-total', 'Total'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const backing = new Map(tylerBackingSummary(result).map((b) => [b.eventId, b]));
  const tbody = el('tbody');

  // Crown the leader(s) only when someone is actually ahead. On an empty/all-tied board every
  // player is rank 1, and 11 crowns is noise, not a leader.
  const leaderCount = result.players.filter((p) => p.rank === 1).length;
  const hasLeader = leaderCount > 0 && leaderCount < result.players.length;

  for (const row of result.players) {
    const isLeader = hasLeader && row.rank === 1;
    const tr = el('tr', isLeader ? 'leader' : '');

    const rankCell = el('td', 'rank', row.rankLabel);
    if (isLeader) rankCell.classList.add('is-leader');
    tr.appendChild(rankCell);

    const mv = movementArrow(movement[row.player]);
    tr.appendChild(el('td', `mv mv-${mv.dir}`, mv.text));

    const nameCell = el('td', 'name');
    // opts.playerHref, when given, links the name (the /events drill-down); otherwise a plain span.
    if (typeof opts.playerHref === 'function') {
      const a = el('a', 'player-name', row.player);
      a.href = opts.playerHref(row.player);
      nameCell.appendChild(a);
    } else {
      nameCell.appendChild(el('span', 'player-name', row.player));
    }
    if (row.player === GM) {
      const backs = tylerBackingSummary(result);
      const note = backs.length
        ? `GM · backs ${backs.map((b) => `${b.label} (${b.short})`).join(', ')}`
        : 'GM';
      nameCell.appendChild(el('span', 'tyler-note', note));
    }
    tr.appendChild(nameCell);

    for (const ev of events) {
      const view = cellView(row.byEvent && row.byEvent[ev.id]);
      const td = el('td', `cell cell-${view.kind}`);
      if (view.kind === 'scored') {
        td.appendChild(el('span', 'pts', view.text));
        if (view.unfinalized) td.classList.add('is-unfinalized');
      }
      if (view.flagged) {
        const flag = el('span', 'flag', '⚑');
        const b = backing.get(ev.id);
        td.title = ev.overrideReason || (b ? `Tyler backs ${b.label}` : 'flagged');
        td.appendChild(flag);
      }
      tr.appendChild(td);
    }

    tr.appendChild(el('td', 'total', formatTotal(row.totalRounded)));
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  root.appendChild(table);

  if (opts.legend !== false) root.appendChild(buildLegend(result));
}

function buildLegend(result) {
  const legend = el('div', 'legend');
  const overridden = Object.values(result.events || {}).filter((e) => e.overridden);
  if (overridden.length) {
    const reason = overridden.map((e) => `${e.short}${e.overrideReason ? `: ${e.overrideReason}` : ''}`).join(' · ');
    legend.appendChild(el('span', '', `⚑ commissioner override — ${reason}`));
  }
  legend.appendChild(el('span', '', '▲▼ movement since last event'));
  legend.appendChild(el('span', '', 'hatched = not yet played'));
  return legend;
}

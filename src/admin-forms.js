/**
 * src/admin-forms.js — pure helpers behind admin.html.
 *
 * The forms and the burn tracker are data-driven from rules-config + the engine's output, so the
 * decisions live here (testable) and admin.html stays a thin DOM shell. The one that matters is the
 * burn chooser: eligibility comes STRAIGHT from the engine's ledger (burns.slots[].eligible), and
 * the disabled-with-reason text is looked up from who each claimed slot burned. Nothing here
 * re-derives the burn rules — that is the engine's job, and duplicating it is exactly the bug that
 * bit the scoring engine three review rounds running.
 */
import { EVENTS, ABLE, BURN_COUNT, TYLER_BACKING, clampKnob } from './rules-config.js';
import { score } from './scoring.js';

/* ---- Form option sources ----------------------------------------------------------------- */

export function participantsFor(eventId) {
  return (EVENTS[eventId] && EVENTS[eventId].participants) || [];
}

export function captainsFor(eventId) {
  return (EVENTS[eventId] && EVENTS[eventId].captains) || [];
}

export function teamShapeFor(eventId) {
  const e = EVENTS[eventId] || {};
  return {
    teamCount: e.teamCount ?? null,
    teamSize: e.teamSize ?? null,
    teamSizes: e.teamSizes ?? null,
  };
}

/** Participants not yet placed on a team/pair — so the draft builder never offers a taken player. */
export function availableForDraft(eventId, assigned = []) {
  const taken = new Set(assigned);
  return participantsFor(eventId).filter((p) => !taken.has(p));
}

/**
 * Build the `draft_assignment` teams from the per-player assignment map. `assign` maps a
 * participant to the team id they joined; `teamIdFor(captain)` yields a captain's own team id.
 *
 * A PLAYING captain is pinned to their own team and can never be assigned elsewhere — otherwise
 * they'd be force-added to their own team AND land in another captain's filter, appearing on two
 * teams. Non-captain members go where assigned; a non-playing captain leads a team but isn't a
 * member of it.
 */
export function buildDraftTeams(captains, parts, assign, teamIdFor) {
  const own = new Map(captains.map((c) => [c, teamIdFor(c)]));
  const capSet = new Set(captains);
  const teamIdOf = (p) => (capSet.has(p) ? own.get(p) : assign[p]);
  return captains.map((c) => {
    const id = own.get(c);
    const members = parts.filter((p) => p !== c && teamIdOf(p) === id);
    if (parts.includes(c)) members.unshift(c); // a playing captain leads their own team
    return { id, captain: c, members };
  });
}

/* ---- Burn tracker + chooser -------------------------------------------------------------- */

/** The pinned "N of 5 burned" tracker: one entry per slot, in schedule order, straight off the ledger. */
export function burnTracker(result) {
  const burns = (result && result.burns) || { slots: [], burned: [], duplicates: [], complete: false };
  return {
    total: BURN_COUNT,
    burnedCount: (burns.burned || []).length,
    complete: !!burns.complete,
    hasDuplicates: (burns.duplicates || []).length > 0,
    slots: (burns.slots || []).map((s) => ({
      slot: s.slot,
      stage: s.stage,
      label: s.label,
      filled: s.player != null || s.team != null,
      player: s.player ?? null,
      team: s.team ?? null,
      duplicate: !!s.duplicateOf,
      duplicateOf: s.duplicateOf ?? null,
      unresolvedTarget: s.unresolvedTarget ?? null,
      eligibleCount: Array.isArray(s.eligible) ? s.eligible.length : null,
    })),
  };
}

/**
 * Options for one Tyler pick stage (swim / volleyball / gauntlet), each marked eligible-or-not with
 * a reason. Eligibility for an OPEN slot is the engine's own `slot.eligible` list; for a slot that
 * already has a pick (re-pick before lock), it falls back to "not burned by any OTHER stage" — both
 * are ledger-derived, neither re-derives the burn rules. The reason text is looked up from the
 * claimed slots so a disabled option can say who was burned and where.
 */
export function burnChooser(result, stage) {
  const burns = (result && result.burns) || { slots: [] };
  const slot = (burns.slots || []).find((s) => s.stage === stage);
  const unit = (TYLER_BACKING[stage] && TYLER_BACKING[stage].unit) || 'player';

  const engineEligible = slot && Array.isArray(slot.eligible) ? new Set(slot.eligible) : null;

  // Who was burned by the OTHER stages (so the current stage's own target stays selectable).
  const burnedByOthers = new Map();
  for (const s of burns.slots || []) {
    if (s.stage !== stage && s.player) burnedByOthers.set(s.player, s.label);
  }

  const currentPick = slot ? (slot.team ?? slot.player ?? slot.unresolvedTarget ?? null) : null;

  let options;
  if (unit === 'team') {
    const teams = (result.events && result.events.volleyball && result.events.volleyball.teams) || [];
    options = teams.map((t) => {
      const eligible = engineEligible ? engineEligible.has(t.id) : !burnedByOthers.has(t.captain);
      const burnedAt = burnedByOthers.get(t.captain);
      return {
        id: t.id,
        label: `Team ${t.captain}`,
        detail: (t.members || []).join(', '),
        burns: t.captain,
        eligible,
        selected: t.id === currentPick,
        reason: eligible ? null : (burnedAt ? `${t.captain} already burned — ${burnedAt}` : 'captain unavailable'),
      };
    });
  } else {
    options = ABLE.map((p) => {
      const eligible = engineEligible ? engineEligible.has(p) : !burnedByOthers.has(p);
      const burnedAt = burnedByOthers.get(p);
      return {
        id: p,
        label: p,
        burns: p,
        eligible,
        selected: p === currentPick,
        reason: eligible ? null : (burnedAt ? `already burned — ${burnedAt}` : 'not eligible'),
      };
    });
  }

  return {
    stage,
    label: (slot && slot.label) || stage,
    unit,
    currentPick,
    duplicate: !!(slot && slot.duplicateOf),
    duplicateOf: (slot && slot.duplicateOf) ?? null,
    unresolvedTarget: (slot && slot.unresolvedTarget) ?? null,
    options,
    eligibleCount: options.filter((o) => o.eligible).length,
  };
}

/* ---- Finalize nudge ---------------------------------------------------------------------- */

/** Events whose results are all in but that Brad hasn't finalized yet (status 'unfinalized'). */
export function finalizeNudges(result) {
  return Object.values((result && result.events) || {})
    .filter((e) => e.status === 'unfinalized')
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ id: e.id, short: e.short, label: e.label }));
}

/* ---- Knob live preview ------------------------------------------------------------------- */

/** Which players changed rank between two scored results, sorted by their new rank. */
export function rankDiff(before, after) {
  const wasRank = new Map(before.players.map((p) => [p.player, p.rank]));
  const changes = after.players
    .map((p) => ({ player: p.player, from: wasRank.get(p.player), to: p.rank }))
    .filter((c) => c.from != null && c.from !== c.to)
    .sort((a, b) => a.to - b.to);
  const summary = changes.length
    ? changes.map((c) => `${c.player} ${c.to < c.from ? '▲' : '▼'}${c.from}→${c.to}`).join(', ')
    : 'no rank changes';
  return { changes, summary };
}

/**
 * Preview the rank shuffle a new knob would cause, WITHOUT writing anything: replay score() over the
 * effective log plus a synthetic latest `knob` entry and diff the ranks. Pure and cheap — the
 * append-only, log-only engine makes this a free "what if".
 */
export function knobRankPreview(effective, newKnob) {
  const knob = clampKnob(newKnob);
  const before = score(effective);
  const nextId = effective.length ? Math.max(...effective.map((e) => e.id || 0)) + 1 : 1;
  const hypothetical = [...effective, { id: nextId, uuid: 'knob-preview', ts: 0, type: 'knob', value: knob }];
  const after = score(hypothetical);
  const { changes, summary } = rankDiff(before, after);
  return { knob, changes, summary: `at ×${String(Number(knob.toFixed(2)))} → ${summary}` };
}

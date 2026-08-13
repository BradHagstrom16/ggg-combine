# GGG Combine 2026

Live standings + scoring for the 2nd annual GGG fantasy football combine — 11 players,
6 scored events, Aug 28–29 2026. Brad (commissioner) is the only writer; everyone else views
on a phone, and the standings are projected on a TV.

## Two standing rules

1. **The rules are locked.** `combine-2026-spec.md` is the source of truth for all rules,
   scoring math, burn mechanics, and tiebreakers. **Never change the math or the rules —
   flag the issue to Brad first.** If the spec contradicts itself, flag it; don't pick a side
   silently. (One such contradiction is already resolved: Bags ranks by **highest** score,
   §4.4 governing over the §3 table's "timed" wording.)
2. **Never store computed points.** The log holds raw inputs only. `src/scoring.js` is a pure
   function `(effectiveLog) → standings`, recomputed on every render. Points, ranks, placements,
   and totals are always derived, never persisted.

## Commands

```bash
npm test                   # node:test — scoring engine + worker
npm run test:scoring       # scoring engine only (fast, no wrangler)
npx wrangler dev           # local worker + DO + static assets on :8787
npx wrangler deploy        # ship everything (site + API) to Cloudflare
npx wrangler secret put ADMIN_PIN   # set/rotate the commissioner PIN
```

## Architecture

One Cloudflare Worker serves the static site **and** the API from a single origin — no CORS,
no preflights, no second host. Storage is an **append-only log** in one SQLite-backed Durable
Object. Because the log is append-only, standings at any moment are `score(effectiveLog.slice(0, i))`
— which is where weekend replay, undo, and audit all come from for free.

Note the order in that expression: corrections are applied to the **whole** log first, and the
*effective* log is what gets sliced. That is deliberate. Replay is a Saturday-night broadcast
projected before the fantasy draft, and it should show the weekend as it actually happened —
not re-stage a time Brad fat-fingered at 4pm and fixed at 4:01. If you ever want the other
semantics (each prefix resolved independently, so replay reproduces what was on screen at the
time), that is a *different* feature and needs its own function; don't quietly change this one.

```text
admin.html ──POST /log (PIN, entry+UUID)──▶ Worker ──▶ Durable Object (SQLite)
    │  ▲                                     │           append, assign id,
    │  └── offline outbox (queue+flush)      │           drop dup UUIDs
    ▼                                        │
index.html / ?tv=1 ◀──GET /log (≤10s poll,───┘  + serves /public (same origin)
     │                 visible tabs, 5s edge cache)
     ▼
localStorage cache ─▶ effectiveLog (corrections + latest-wins) ─▶ scoring.js ─▶ render.js
```

| Path | What it is |
|---|---|
| `combine-2026-spec.md` | Locked rules, checked in verbatim. Source of truth. |
| `src/rules-config.js` | Roster, events, point tables, captains, schedule order, rank directions, tie-resolution rule lists, knob config. |
| `src/scoring.js` | Pure `(effectiveLog) → standings`. **The product.** All correctness risk lives here. |
| `src/render.js` | Shared DOM rendering for the standings table. |
| `src/md.js` | Tiny dependency-free markdown renderer (rules page reads the spec directly, so it can't drift). |
| `worker/worker.js` | Worker + `LogDO` Durable Object: static assets, `GET /log`, `POST /log`. |
| `public/*.html` | `index` (standings, `?tv=1` for TV), `admin`, `agenda`, `rules`. |
| `test/` | `node:test`. Golden hand-computed weekend fixture is the primary gate. |

## Entry vocabulary (the system contract)

Every entry carries a server-assigned monotonic `id`, a client-generated `uuid`, and `ts`.
Scoring resolves each **logical key** to its **latest non-voided entry**, so casually re-entering
a value self-heals. `correction {targets: id, replacement?}` voids or replaces an entry for
visible, audited fixes. Nothing is ever mutated or deleted.

### The write contract (what `admin.html` can rely on)

`POST /log` is **idempotent by UUID**, and this is load-bearing for the offline outbox:

- A UUID the log has not seen → `201` with `{entry, duplicate: false}`.
- A UUID it already holds → **`200` with `{entry: <the original>, duplicate: true}`**. This is a
  *success*, not a conflict — the outbox must dequeue on it. A retry whose payload changed
  still returns the original: first arrival wins, and a retry can never rewrite history.
- Wrong/missing PIN → `401`, checked *before* the body is read, so the log is never touched.
- Malformed JSON or an unknown entry type → `400`. The log is permanent; junk that gets in
  never comes out.

### Correction semantics

- **Shape.** `{type: 'correction', uuid, targets: <entry id>, replacement?: <entry payload>}`.
  The `replacement` is a bare entry payload — `type` plus that type's own fields, no `id`/`uuid`
  (it inherits the correction's).
- **Corrections may target corrections.** That is how "undo the undo" works: voiding a
  correction brings its target back to life. Chains resolve in descending id order, which
  terminates because a correction always has a higher id than what it targets.
- **A replacement enters the log at the correction's `id`**, not the target's — it is a new
  statement of fact made at the moment Brad made it, so it beats a re-entry made in between.
- **Multiple corrections targeting one entry** is deterministic, not undefined: each surviving
  replacement enters at its own id, and normal latest-wins picks the highest. Two competing
  replacements therefore resolve to the later one, and the earlier remains visible in the raw
  log for audit.

| Type | Fields | Latest-wins key |
|---|---|---|
| `draft_assignment` | event, teams/pairs with captains | (event) |
| `time` | event, player, value — seconds (Swim/Gauntlet, lower better) or bag score (Bags, higher better) | (event, player) |
| `wiffle_result` | winning team | (event) |
| `beerball_game` | gameSlot 1–10, pairs, winner, beers per side (0.5 steps) | (event, gameSlot) |
| `volleyball_set` | matchSlot 1–3, setNo 1–3, scores | (event, matchSlot, setNo) |
| `tyler_pick` | stage, target | (stage) — correctable until that stage's `event_final` |
| `override` | event, final placements, reason | (event) — supersedes computation, ⚑-flagged |
| `championship_tiebreak` | head-to-head beer pong winner | singleton |
| `knob` | value (clamped 1.0–2.0, step 0.05, default 1.1) | singleton |
| `event_final` | event | (event) — un-finalize = a correction voiding it |
| `correction` | targets id, optional replacement | n/a |

## Things that will bite you

- **Compare and display totals at 1 decimal.** Float dust must never silently defeat the §7
  tie detection — a tie for the championship is a *feature*, not a rounding artifact.
- **Round-robin ties use a group-wise resolver, not a pairwise comparator chain.** Head-to-head
  is non-transitive: a 3-way circular knot must be *detected* and flagged
  `manual-resolution-required` (Brad enters an `override`), never silently ordered.
- **Pending ≠ zero.** A missing result *before* that event's `event_final` renders as pending
  (hatched, no points). *After* `event_final` it is 0 points — a warning chip, **not an error**
  (spec §3.2 / §10.6).
- **Golf is an exhibition.** It may appear on the agenda; it must never touch standings.
- **Display names exactly as written** in spec §2: `Stu, Murph, Tyler, Josh, Lucas, Mitch,
  Yuyi, ATM, Helwig, Brad, Wyatt`.
- **No build step, no framework, no CDN at runtime.** Vanilla ES modules. At the venue the only
  host anything should need to reach is our own Worker.

## Build order (see TODOS.md for post-event work)

Scoring engine + tests → worker/DO + deploy → admin → viewer/TV → **dress rehearsal against
production** → show layer. The show layer (reshuffle animations, weekend bump-chart replay,
Gauntlet clinch scenarios) is built only *after* the rehearsal passes, and every piece of it is
independently cuttable. The event is never hostage to the fun parts.

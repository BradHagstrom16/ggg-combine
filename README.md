# GGG Combine 2026

Live standings and scoring for the 2nd annual GGG fantasy football combine — 11 players,
6 scored events, one lakeside weekend (Aug 28–29, 2026), ending in the league's fantasy draft.

The commissioner enters raw results from his phone. Everything downstream — ranks, the
Individual Multiplier, round-robin standings, Tyler's GM points, tiebreak columns, the champion
— computes automatically and shows up on ~10 phones and a projected TV.

| Page | What it's for |
|---|---|
| `/` | Standings. The centerpiece. |
| `/?tv=1` | Same standings, big type, no chrome — for the projector. |
| `/admin.html` | Commissioner entry (PIN-gated). |
| `/agenda.html` | Weekend order. No clock times. |
| `/rules.html` | The rules, rendered straight from the spec. |

## How it works

Storage is an **append-only log** of raw inputs — times, game results, draft assignments, GM
picks, overrides, knob turns. Computed points are never stored. Standings are a pure function
of the log, recomputed on every render, which means standings at any moment are just
`score(log.slice(0, i))` — so undo, audit, and a full weekend replay all come for free.

One Cloudflare Worker serves both the site and the API from a single origin, backed by one
SQLite-backed Durable Object. No framework, no build step.

**The rules are locked.** [`combine-2026-spec.md`](combine-2026-spec.md) is the source of truth
for all scoring math. See [`CLAUDE.md`](CLAUDE.md) for architecture and contributor guidance.

## Development

```bash
npm install
npm test              # scoring engine + worker (node:test)
npx wrangler dev      # local site + API on :8787
npx wrangler deploy   # ship it
```

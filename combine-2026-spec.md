# 2026 Fantasy Football Combine — Specification & Handoff

**Audience:** Claude Code.
**Scope of this document:** Complete rules, scoring math, data model, and entry workflows for the 2026 Combine. This spec is the source of truth for *what* the system does. All implementation decisions — repo structure, stack, hosting, UI design, how results-entry forms look — are yours. Do not change rules or math without flagging it to Brad.

**Deliverable:** Unless you disagree and believe there is a better option: A GitHub repo containing an interactive HTML site where standings and rules live. Brad (commissioner) enters draft results and game results; standings compute and display automatically.

---

## 1. Context

2nd annual 2-day fantasy football combine at a lakeside property, ending in the league's fantasy draft Saturday night. **11 attendees.** One player, **Tyler**, has an injury limiting lower-body mobility (full upper-body and cognitive function). The format is built on a core principle: **structural inclusion via universal rules, never individual handicaps.** Every Tyler-related mechanic below applies as a symmetric rule for all, or gives him a real competitive role — nothing should read as an accommodation.

## 2. Roster

Display names, exactly as written:

```
Stu, Murph, Tyler, Josh, Lucas, Mitch, Yuyi, ATM, Helwig, Brad, Wyatt
```

- 10 "able" players + Tyler.
- **Brad is commissioner** and the only non-captain. He runs scoring, enters all data, and arbitrates disputes.
- Every other player captains exactly one event (see §5).

## 3. Events & Scoring Overview

Six scored events. Three individual, three team. All events nominally worth 100 points; individual events are multiplied by the live **Individual Multiplier** (the "knob").

| # | Event | Type | Who plays | Points |
|---|-------|------|-----------|--------|
| 1 | Wiffle Ball | Team (2 teams, 6v5) | All 11 (Tyler pitches) | 100 / 0 × 1 |
| 2 | Beer Ball | Team (5 pairs) | 10 able | 100 / 75 / 50 / 25 / 0 × 1 |
| 3 | Swim | Individual, timed | 10 able | rank-based × knob |
| 4 | Bags | Individual, timed | All 11 | rank-based × knob |
| 5 | Volleyball | Team (3 teams: 4/3/3) | 10 able | 100 / 50 / 0 × 1 |
| 6 | Gauntlet | Individual, timed | 10 able | rank-based × knob |

Golf is played Friday morning as an **exhibition — zero combine points**. It may appear on the agenda page but must never touch standings.

### 3.1 The Knob (Individual Multiplier)

- A single adjustable value applied to all three individual events' points.
- **Default: 1.1.** Adjustable range: **1.0 – 2.0**, in steps of at least 0.05.
- Must be changeable live at any time; standings recompute immediately.
- Rationale (do not re-derive, just preserve): a 200,000-run Monte Carlo audit of this exact 6-event structure found the individual-vs-team "who wins" influence crosses 50/50 at ≈1.10 under moderate skill-carryover assumptions (≈1.25 low-carryover, ≈1.00 high-carryover). 1.1 is the calibrated default; the knob exists so Brad can rebalance live.

### 3.2 Individual event points formula

Rank players by time, **lower time = better**. With `n` participants, the player ranked `r` (1 = best) earns:

```
raw_points = 100 × (n − r) / (n − 1)
final_points = raw_points × knob
```

- Swim, Gauntlet: `n = 10` (spacing ≈ 11.11).
- Bags: `n = 11` (spacing = 10).
- **Ties (identical times):** tied players share the average of the points for the positions they occupy. E.g., tie for 2nd/3rd → both get the mean of the 2nd- and 3rd-place points.
- **Blank time for a player who should have competed = 0 points** (treated as last; if multiple blanks, they all get 0).

## 4. Event Rules

### 4.1 Wiffle Ball — Friday combine opener
- 2 teams, 6v5. **Tyler is always on the 6-player team** → effectively 5 able + Tyler vs 5 able.
- **Universal all-time-pitcher rule:** each team designates one stationary pitcher who does not field or run. Tyler pitches for his team (seated); the opposing team designates their own all-time pitcher under the identical constraint.
- If Tyler bats, a **courtesy runner** runs for him. If he doesn't bat, lineups are simply 5 bats vs 5 bats. Either way the rule set is symmetric.
- Winner-take-all: every member of the winning team earns 100; losers earn 0. Tyler plays, so he earns his wiffle points directly.
- Captains: **Murph, Stu**.

### 4.2 Beer Ball — Friday nightcap
- 10 able players in **5 pairs**. 2v2 format (house rules, known to the group — the app does not need to encode gameplay).
- **Full round robin: 10 games total, 4 per pair.** Two games running in parallel (schedule display nicety, not a rules requirement).
- Standings, in order: **wins → total beer differential (tracked to the 0.5 beer) → head-to-head → chug-off**.
- Placement points: **100 / 75 / 50 / 25 / 0** to each member of the pair.
- Captains: **Yuyi, Lucas, Josh, ATM, Tyler**. Tyler is a **non-playing GM captain** — see §6.

### 4.3 Swim — Saturday morning opener (locked slot)
- 10 able players, timed, lower is better. Tyler backs a player (§6).

### 4.4 Bags — after Swim
- **All 11 play**, including Tyler. Individual. 4 throws from all 4 bags throwing positions, 16 total. Highest score is the goal.

### 4.5 Volleyball — after Bags
- 10 able players in **3 teams (4 / 3 / 3)**. Played 3-on-3; the 4-player team rotates a sitter each set.
- Round robin (each team plays each other team).
- Standings: **wins → point differential → total points**; ties beyond that are broken by a play-in at Brad's discretion (allow a manual override — see §8).
- Placement points: **100 / 50 / 0** to each team member.
- Captains: **Mitch, Helwig, Wyatt**. Tyler backs a team (§6).

### 4.6 Gauntlet — Saturday finale (locked slot)
- 10 able players, timed obstacle/relay-style individual event, lower is better. Tyler backs a player (§6).

## 5. Captainships & Drafts

- 10 captain slots = 10 non-Brad players: Wiffle 2 (Murph, Stu) + Volleyball 3 (Mitch, Helwig, Wyatt) + Beer Ball 5 (Yuyi, Lucas, Josh, ATM, Tyler).
- **Drafts happen immediately before each event, not all at once.** Captains draft with full knowledge of current combine standings — reactive drafting is an intended feature.
- **Wiffle draft (Friday):** Murph and Stu alternate picks from the able pool; Tyler is pre-assigned to whichever side has 5 able players (the 6-team).
- **Beer Ball draft (Friday, after Wiffle):** the draftable pool is the 6 able non-captains. **Snake draft. Tyler picks first** (and therefore also last — picks 1 and 6, taking two players). Pick order for slots 2–5 among Yuyi, Lucas, Josh, ATM is decided by a game of **Shithead** (card game; result entered manually, no need to encode it).
- **Volleyball draft (Saturday, after Bags):** Mitch, Helwig, Wyatt draft the able pool into 4/3/3.
- The app should let Brad enter draft results (who's on which team/pair) quickly after each draft.

## 6. Tyler — "The Injured GM"

Tyler **plays** two events (Bags, Wiffle) and **owns/backs** four:

| Event | Mechanism | Points earned | Burns |
|---|---|---|---|
| Bags | Plays | His own | — |
| Wiffle | Plays (pitcher) | His own team result | — |
| Beer Ball | **GM**: drafts his own pair, coaches them | His pair's exact final points | **Both pair members** |
| Swim | Picks one player before the event | That player's exact final (multiplied) points | **That player** |
| Gauntlet | Picks one player before the event | That player's exact final (multiplied) points | **That player** |
| Volleyball | Picks one team before game 1 | That team's exact final points | **That team's captain only** |

### 6.1 The Burn Rule (hybrid)
- Across Tyler's four backed events he "burns" **exactly 5 people, all of whom must be unique**: 2 beer ball pair members + Swim pick + Gauntlet pick + Volleyball team captain.
- Rationale for the hybrid: burn scales with concentration of exposure. Individual picks and pair members are full exposure (burned); a volleyball roster is diluted (captain-only burn).
- **Picks lock in schedule order** (Beer Ball pair Friday → Swim → Volleyball team → Gauntlet), each before its event begins. Tyler's pool shrinks as the weekend progresses — this is intentional strategy.
- **The app must validate uniqueness** across all 5 burns and refuse/flag a duplicate at entry time. Show Tyler's remaining eligible pool for each upcoming pick.
- Note the Volleyball constraint: Tyler cannot pick the team whose captain he has already burned, and picking a team burns its captain for the Gauntlet.

## 7. Championship & Tiebreakers

- Champion = highest total points across all six events.
- **Tie on total:** lowest **average placement across the three individual events** wins. For Swim and Gauntlet, Tyler's placement = his picked player's placement; for Bags, his own.
- **Still tied:** beer pong, head-to-head.

## 8. Data Model & Entry Workflows (guidance, not prescription)

Suggested entities — reshape freely:

- **Player** (name, isCommissioner, isTyler flag or similar)
- **Event** (type: individual/team; knob-eligible flag; scoring config; schedule order)
- **TeamAssignment** (event, team id, members, captain) — entered after each draft
- **Result**
  - Individual events: raw time per player (blank ⇒ 0 pts)
  - Wiffle: winner (A/B)
  - Beer Ball: per-game — pairing, winner, beers finished per side (0.5 granularity)
  - Volleyball: per-set scores
- **TylerPick** (event, person/team picked, burn list, locked timestamp)
- **Settings** (knob value)

**Everything downstream of raw entry computes automatically:** ranks, points, multiplier application, round-robin standings, Tyler's derived points, total standings, tiebreak columns.

**Manual override:** every team event needs an optional final-placement override that supersedes computed standings (for disputes, skipped scorekeeping, or Brad's-discretion tiebreaks). Override must be visibly flagged in the UI.

Only Brad enters data. Everyone else views. Standings page is the centerpiece — it will be projected/shared live, so it should be readable at a glance on a TV and on phones.

## 9. Agenda (display on the site)

**Thursday** — Arrive. Optional rules walkthrough / opening night.

**Friday**
1. Golf (morning) — exhibition, no points
2. Wiffle draft → **WIFFLE BALL** (combine opener)
3. Beer Ball draft (Shithead sets order 2–5; Tyler snakes 1st/6th; burns 2) → **BEER BALL**

**Saturday**
1. Tyler's Swim pick locks (burn 3) → **SWIM** (locked opener)
2. **BAGS** (all 11)
3. Volleyball draft → Tyler's team pick locks (burn 4) → **VOLLEYBALL**
4. Tyler's Gauntlet pick locks (burn 5) → **GAUNTLET** (locked finale)
5. Champion crowned (tiebreaks per §7)
6. Evening: **Fantasy Draft**

No clock times anywhere — order only.

## 10. Validation Rules (must-haves)

1. Tyler's 5 burns all unique; block duplicates at entry.
2. Each able player on exactly one team per team event; beer ball pairs are exactly 2.
3. Tyler auto-assigned to the 6-side in Wiffle.
4. Knob within 1.0–2.0.
5. Beer differentials accept 0.5 increments.
6. Individual blank time ⇒ 0 points, not an error.
7. Tie handling in individual events per §3.2.
8. Overrides always win over computed placements and are visibly flagged.

## 11. Out of Scope for This Spec

- Repo structure, framework/stack, hosting, styling, auth (if any) — your call.
- Golf scoring (exhibition only).
- Encoding Shithead or beer ball gameplay rules.
- The prior Google Sheets template — this app **replaces** it; do not port its layout, only the rules above.

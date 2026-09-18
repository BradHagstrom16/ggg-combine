# Archive — GGG Combine 2026 (final)

`live-2026-final.json` is a verbatim snapshot of `GET /log` from the production
Worker, taken **2026-09-18** after the combine finished. It is the durable record
of the weekend, independent of Cloudflare: the Durable Object instance `live-2026`
could be deleted and this file would still reproduce the final board.

- **113 entries**, ids 1–113, instance `live-2026`.
- First entry: the Wiffle draft (id 1). Last: Gauntlet `event_final` (id 113).

## Final standings (replayed from this file)

Because the log is append-only and scoring is pure, standings are derived, never
stored. Replaying this snapshot through `src/scoring.js` yields **11 players, 0
issues**, champion **Josh**:

| # | Player | Total |
|---|--------|------:|
| 1 | Josh   | 664.6 |
| 2 | Tyler  | 658.3 |
| 3 | Wyatt  | 578.5 |
| 4 | Mitch  | 568.8 |
| 5 | Stu    | 519.4 |
| 6 | Brad   | 464.6 |
| 7 | Yuyi   | 454.2 |
| 8 | Helwig | 413.2 |
| 9 | ATM    | 391.0 |
| 10| Lucas  | 334.7 |
| 11| Murph  | 236.1 |

## Replay it

```bash
node --input-type=module -e "
import { effectiveLog, score } from '../src/scoring.js';
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('./live-2026-final.json','utf8')).entries;
const s = score(effectiveLog(raw));
console.log(s.championship, s.issues.length, 'issues');
"
```

## Off-season note (2026-09-18)

The site is left **running as-is** — SQLite Durable Objects on the free tier cost
nothing idle, so the live board at
<https://ggg-combine.ggg-combine.workers.dev/> stays up as a read-only final-standings
memorial (only the commissioner PIN can write). This file is the backstop in case
that ever changes. Next August, redeploy from this repo for the 2027 combine.

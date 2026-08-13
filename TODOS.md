# TODOs

Deliberately deferred work, approved 2026-08-13. Neither of these blocks the 2026 event.

## Post-event archive

**After Aug 29:** save `GET /log` as `archive/2026-log.json`, commit it, and add a permanent
`/2026/` replay page pointed at that file instead of the live API.

*Why:* the Worker and Durable Object are ephemeral; the repo is forever. The full log — every
entry, every knob turn, every correction — is the league keepsake and the 2027 baseline.

*Depends on:* event completion + the show-layer replay code.

## 2027 parameterization

Post-event, lift anything still hardcoded (year, roster, event structure, Tyler-specific
mechanics) fully into `src/rules-config.js`, so the 3rd annual combine is a config file and a
fresh Durable Object namespace.

*Why:* refactoring while the code is fresh beats archaeology next August.

*Depends on:* 2026 completion. **Deliberately NOT built now** — the 2027 format is unknown, and
abstracting for it today is premature.

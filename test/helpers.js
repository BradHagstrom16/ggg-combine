/**
 * Test helpers. Nothing here knows anything about the rules — it just builds logs that look
 * like what the Durable Object would have produced.
 */

/**
 * Stamp a list of entry payloads with the ids, uuids, and timestamps the server would assign.
 * Ids are 1-based and monotonic, matching the DO's contract.
 */
export function buildLog(entries) {
  return entries.map((entry, i) => ({
    id: i + 1,
    uuid: entry.uuid ?? `uuid-${i + 1}`,
    ts: 1_700_000_000_000 + i * 1000,
    ...entry,
  }));
}

/** Append more entries to an existing log, continuing the id sequence. */
export function append(log, entries) {
  const start = log.length ? Math.max(...log.map((e) => e.id)) : 0;
  return [
    ...log,
    ...entries.map((entry, i) => ({
      id: start + i + 1,
      uuid: entry.uuid ?? `uuid-${start + i + 1}`,
      ts: 1_700_000_000_000 + (start + i) * 1000,
      ...entry,
    })),
  ];
}

/** Look up a player's row by name in a scored result. */
export function row(result, player) {
  return result.players.find((p) => p.player === player);
}

/** Totals as a `{player: displayed-total}` map, rounded the way the board displays them. */
export function totals(result) {
  return Object.fromEntries(result.players.map((p) => [p.player, p.totalRounded]));
}

/** All issue codes present, for concise assertions. */
export function codes(result) {
  return result.issues.map((i) => i.code);
}

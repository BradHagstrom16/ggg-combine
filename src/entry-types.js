/**
 * The canonical set of log entry types — the wire contract between admin.html and the Worker.
 *
 * It lives in its own module so the Worker can validate incoming entries without pulling the
 * whole scoring engine into its bundle, while there is still exactly ONE list. An entry type
 * that is not in here is rejected at the door: the log is append-only and permanent, so junk
 * that gets in never comes out.
 *
 * Adding a type means adding it here AND giving it a latest-wins key in `scoring.js`
 * (`entryKey`). A type with no key would silently never resolve.
 */
export const ENTRY_TYPES = new Set([
  'draft_assignment',
  'time',
  'wiffle_result',
  'beerball_game',
  'volleyball_set',
  'tyler_pick',
  'override',
  'championship_tiebreak',
  'knob',
  'event_final',
  'correction',
]);

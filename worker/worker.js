/**
 * GGG Combine 2026 — Worker + Durable Object.
 *
 *   admin.html ──POST /log (PIN, entry+UUID)──▶ Worker ──▶ Durable Object (SQLite)
 *       │  ▲                                     │           append, assign id,
 *       │  └── offline outbox (queue+flush)      │           drop dup UUIDs
 *       ▼                                        │
 *   index.html / ?tv=1 ◀──GET /log (≤10s poll,───┘  + serves /public (same origin)
 *        │                 visible tabs, 5s edge cache)
 *        ▼
 *   localStorage cache ─▶ effectiveLog (corrections + latest-wins) ─▶ scoring.js ─▶ render.js
 *
 * This file is deliberately small and dumb. It stores raw entries and hands them back; it does
 * not know a swim time from a knob turn. All meaning lives in `src/scoring.js`, client-side,
 * so the log stays a permanent record of what Brad typed rather than of what some version of
 * the rules once thought it meant.
 *
 * Static assets are served by the platform's asset router (see `wrangler.toml`); this Worker
 * is only reached for `/log`, which `run_worker_first` pins to it explicitly.
 */

import { DurableObject } from 'cloudflare:workers';
import { ENTRY_TYPES } from '../src/entry-types.js';

/**
 * The Durable Object instance name — the whole namespace for one log.
 *
 * Configurable (`LOG_INSTANCE` in wrangler.toml) purely so the log can be RESET. The dress
 * rehearsal enters a full fake weekend against production, and those ~40 entries would
 * otherwise still be in the permanent log when the real combine starts. Pointing at a new
 * instance name hands us a guaranteed-empty log while leaving the rehearsal's log intact and
 * inspectable, which is much less frightening the week of the event than deleting the Worker.
 *
 * A typo here would silently serve an empty board mid-Gauntlet, so `GET /log` echoes the
 * instance name back and the fallback is the same default rather than a blank.
 */
const DEFAULT_LOG_INSTANCE = 'log';

function logInstance(env) {
  const configured = env.LOG_INSTANCE;
  return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_LOG_INSTANCE;
}

const PIN_HEADER = 'x-combine-pin';

/** Generous for a draft assignment (11 names), absurd for anything else. */
const MAX_BODY_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** Poll cadence is ≤10s and the freshness budget is 15s, so 5s of staleness is free. */
const GET_CACHE_SECONDS = 5;

// ---------------------------------------------------------------------------------------
// The Durable Object: an append-only log in SQLite
// ---------------------------------------------------------------------------------------

export class LogDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // AUTOINCREMENT, not a bare INTEGER PRIMARY KEY: a plain rowid alias reuses the highest
    // id after a delete, and "ids are monotonic and never reused" is a property the client's
    // correction targets depend on. We never delete, but the guarantee should not rest on that.
    //
    // UNIQUE on uuid is the UUID dedupe, enforced by the database rather than by a code path
    // someone can forget: a double-tapped save or a retried offline flush cannot become two
    // entries even if the append logic is wrong.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT    NOT NULL UNIQUE,
        ts   INTEGER NOT NULL,
        type TEXT    NOT NULL,
        body TEXT    NOT NULL
      )
    `);
  }

  /** The whole log, oldest first. ~30 entries over a weekend — no pagination needed. */
  list() {
    return this.sql
      .exec('SELECT id, uuid, ts, type, body FROM entries ORDER BY id')
      .toArray()
      .map(hydrate);
  }

  /**
   * Append one entry, or return the existing one if this UUID has already landed.
   *
   * Idempotent by construction: the client stamps the UUID before the first send, so a retry
   * carries the same one. Callers can therefore retry freely — which is exactly what the
   * offline outbox does when the wifi comes back.
   */
  append(entry) {
    const existing = this.sql
      .exec('SELECT id, uuid, ts, type, body FROM entries WHERE uuid = ?', entry.uuid)
      .toArray();
    if (existing.length) return { entry: hydrate(existing[0]), duplicate: true };

    // A correction must point at something real. Only the DO knows which ids exist, so this
    // check cannot live in the Worker's shape validation. Because ids are assigned at insert,
    // "the target exists" also proves "the target is older" — you cannot correct the future,
    // and a correction can never target itself.
    //
    // Safe for the offline outbox: a correction can only name an id the server already
    // acknowledged, so a queued correction always refers to an entry that landed before it.
    if (entry.type === 'correction') {
      const target = this.sql
        .exec('SELECT id FROM entries WHERE id = ?', entry.targets)
        .toArray();
      if (!target.length) {
        return { error: `Correction targets entry ${entry.targets}, which does not exist.` };
      }
    }

    const { uuid, type, ts, ...body } = entry;
    this.sql.exec(
      'INSERT INTO entries (uuid, ts, type, body) VALUES (?, ?, ?, ?)',
      uuid,
      Number.isFinite(ts) ? ts : Date.now(),
      type,
      JSON.stringify(body),
    );

    const row = this.sql
      .exec('SELECT id, uuid, ts, type, body FROM entries WHERE uuid = ?', uuid)
      .toArray()[0];
    return { entry: hydrate(row), duplicate: false };
  }
}

/** Rows go back out in the exact shape the client sent, plus the server-assigned id. */
function hydrate(row) {
  return { id: row.id, uuid: row.uuid, ts: row.ts, type: row.type, ...JSON.parse(row.body) };
}

// ---------------------------------------------------------------------------------------
// The Worker
// ---------------------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/log') {
      return new Response('Not found', { status: 404 });
    }

    const instance = logInstance(env);
    const stub = env.LOG.get(env.LOG.idFromName(instance));

    if (request.method === 'GET') return handleGet(request, stub, instance);
    if (request.method === 'POST') return handlePost(request, env, stub);
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET, POST' },
    });
  },
};

async function handleGet(request, stub, instance) {
  const entries = await stub.list();
  const lastId = entries.length ? entries[entries.length - 1].id : 0;

  // The log is append-only, so (count, lastId) identifies its contents exactly — no hashing
  // needed. A poll that finds nothing new costs a 304 with an empty body. The instance is in
  // the ETag too: switching namespaces must invalidate every cached poll, or a viewer holding
  // an old ETag could 304 its way into showing the wrong log entirely.
  const etag = `W/"${instance}-${entries.length}-${lastId}"`;
  const headers = {
    etag,
    'cache-control': `public, max-age=${GET_CACHE_SECONDS}`,
  };

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json({ entries, count: entries.length, lastId, instance }, { headers });
}

async function handlePost(request, env, stub) {
  // PIN first, before the body is even read: a wrong PIN must never reach the log.
  if (!checkPin(request, env)) {
    return problem(401, 'Wrong PIN.');
  }

  const raw = await request.text();
  // Bytes, not characters: `raw.length` counts UTF-16 units, so a body made of multi-byte
  // characters could be three times the size this constant names before it tripped.
  if (encoder.encode(raw).length > MAX_BODY_BYTES) {
    return problem(413, 'Entry too large.');
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return problem(400, 'Malformed JSON.');
  }

  const invalid = validate(entry);
  if (invalid) return problem(400, invalid);

  const result = await stub.append(entry);
  if (result.error) return problem(400, result.error);
  return Response.json(result, {
    status: result.duplicate ? 200 : 201,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * Reject anything that is not a well-formed entry. The log is permanent: junk that gets in
 * never comes out, and a `time` entry misspelled as `tmie` would sit there scoring nothing
 * while Brad wondered why the board was wrong.
 */
function validate(entry) {
  const shape = validateShape(entry, 'Entry');
  if (shape) return shape;

  if (typeof entry.uuid !== 'string' || entry.uuid.length < 8 || entry.uuid.length > 128) {
    return 'Entry needs a client-generated uuid (8–128 characters).';
  }
  if (entry.ts !== undefined && !Number.isFinite(entry.ts)) {
    return 'Entry ts must be a number.';
  }

  if (entry.type === 'correction') {
    if (!Number.isInteger(entry.targets) || entry.targets < 1) {
      return 'A correction must target an entry id.';
    }
    if (entry.replacement !== undefined) {
      // A replacement goes into the permanent log exactly like a first-class entry, so it
      // gets the same scrutiny. Without this, `replacement: "garbage"` spreads into
      // {"0":"g","1":"a",...} and sits in the log forever, scoring nothing and explaining
      // nothing. Note it is NOT checked for a uuid — it inherits the correction's.
      const problem = validateShape(entry.replacement, 'A correction replacement');
      if (problem) return problem;
      if (entry.replacement.type === 'correction') {
        // Replacements are spliced straight into the effective log; they are never
        // re-processed as corrections, so one nested here would silently do nothing.
        return 'A correction replacement cannot itself be a correction.';
      }
      if (Object.hasOwn(entry.replacement, 'id') || Object.hasOwn(entry.replacement, 'uuid')) {
        // A replacement inherits the correction's identity when it is spliced in, so one
        // carrying its own is stating something nothing will honour — and it would sit in the
        // permanent log claiming an id or uuid that is not its own, which is what an audit reads.
        return 'A correction replacement carries no id or uuid of its own — it inherits the correction\'s.';
      }
    }
  }
  return null;
}

/** The shape rules shared by a standalone entry and a correction's replacement payload. */
function validateShape(candidate, label) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return `${label} must be a JSON object.`;
  }
  if (typeof candidate.type !== 'string' || !ENTRY_TYPES.has(candidate.type)) {
    return `Unknown entry type: ${JSON.stringify(candidate.type)}.`;
  }
  return null;
}

/** Fails closed: if the secret was never set, nobody can write. */
function checkPin(request, env) {
  const expected = env.ADMIN_PIN;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return constantTimeEqual(request.headers.get(PIN_HEADER) ?? '', expected);
}

/**
 * The threat model here is a housemate guessing the PIN, not a cryptanalyst — but comparing
 * without early-exit costs four lines, so there is no reason to leak the answer's shape.
 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function problem(status, error) {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

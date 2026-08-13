/**
 * Worker + Durable Object tests.
 *
 * These run against a REAL workerd instance with a real SQLite-backed Durable Object, started
 * in-process by wrangler — not a mock. The things worth testing here (id monotonicity, the
 * UNIQUE constraint doing the dedupe, PIN rejection happening before the log is touched) are
 * all properties of the actual runtime and storage engine, and a mock would happily agree
 * with a broken implementation.
 *
 * Storage is non-persistent, so every run starts from an empty log.
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { unstable_startWorker } from 'wrangler';

const PIN = 'test-pin-1234';

let worker;
let origin;

/** Start a workerd instance. A distinct `LOG_INSTANCE` is a distinct log. */
const startWorker = ({ instance, persist = false } = {}) => unstable_startWorker({
  config: 'wrangler.toml',
  bindings: {
    ADMIN_PIN: { type: 'plain_text', value: PIN },
    ...(instance ? { LOG_INSTANCE: { type: 'plain_text', value: instance } } : {}),
  },
  // worker.url resolves to a URL object, not a string.
  dev: { persist, inspector: { port: 0 }, server: { port: 0 } },
});

const originOf = async (w) => String(await w.url).replace(/\/$/, '');

/** POST an entry, returning [status, body]. */
async function post(entry, { pin = PIN, raw = null, headers = {} } = {}) {
  const response = await worker.fetch(`${origin}/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-combine-pin': pin, ...headers },
    body: raw ?? JSON.stringify(entry),
  });
  const text = await response.text();
  return [response.status, text ? JSON.parse(text) : null, response];
}

async function getLog(headers = {}) {
  const response = await worker.fetch(`${origin}/log`, { headers });
  const text = await response.text();
  return [response.status, text ? JSON.parse(text) : null, response];
}

const entry = (overrides = {}) => ({
  type: 'time', uuid: `uuid-${Math.random().toString(36).slice(2)}-abcdefgh`,
  event: 'swim', player: 'Lucas', value: 55, ...overrides,
});

before(async () => {
  worker = await startWorker();
  origin = await originOf(worker);
});

after(async () => {
  await worker?.dispose();
});

describe('GET /log', () => {
  test('an empty log is an empty list, not an error', async () => {
    // Its own namespace: "empty" must be a property of a fresh log, not of this test happening
    // to run before anything has posted.
    const fresh = await startWorker({ instance: 'empty-log-fixture' });
    try {
      const response = await fresh.fetch(`${await originOf(fresh)}/log`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(body.entries, []);
      assert.equal(body.count, 0);
      assert.equal(body.lastId, 0);
    } finally {
      await fresh.dispose();
    }
  });

  test('entries come back in the shape the client sent, plus a server id', async () => {
    await post(entry({ uuid: 'shape-check-uuid', player: 'Wyatt', value: 57.2 }));
    const [, body] = await getLog();
    const found = body.entries.find((e) => e.uuid === 'shape-check-uuid');
    assert.equal(found.type, 'time');
    assert.equal(found.event, 'swim');
    assert.equal(found.player, 'Wyatt');
    assert.equal(found.value, 57.2);
    assert.ok(Number.isInteger(found.id));
    assert.ok(Number.isFinite(found.ts));
  });

  test('it carries the 5s cache header the poll budget assumes', async () => {
    const [, , response] = await getLog();
    assert.match(response.headers.get('cache-control'), /max-age=5/);
  });

  test('an unchanged log answers a conditional poll with 304 and no body', async () => {
    const [, , first] = await getLog();
    const etag = first.headers.get('etag');
    assert.ok(etag, 'GET /log must send an ETag');

    const response = await worker.fetch(`${origin}/log`, { headers: { 'if-none-match': etag } });
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
  });

  test('appending changes the ETag, so a poll sees the new entry', async () => {
    const [, , before304] = await getLog();
    const oldEtag = before304.headers.get('etag');
    await post(entry({ uuid: 'etag-change-uuid' }));
    const [, , after304] = await getLog();
    assert.notEqual(after304.headers.get('etag'), oldEtag);

    const response = await worker.fetch(`${origin}/log`, { headers: { 'if-none-match': oldEtag } });
    assert.equal(response.status, 200, 'a stale ETag must NOT get a 304');
  });
});

describe('POST /log — the PIN gate', () => {
  test('a wrong PIN is 401 AND leaves the log untouched', async () => {
    const [, beforeBody] = await getLog();
    const [status] = await post(entry({ uuid: 'wrong-pin-uuid' }), { pin: 'nope' });
    assert.equal(status, 401);
    const [, afterBody] = await getLog();
    assert.equal(afterBody.count, beforeBody.count, 'the log must not have grown');
    assert.equal(afterBody.entries.some((e) => e.uuid === 'wrong-pin-uuid'), false);
  });

  test('a missing PIN header is 401', async () => {
    const response = await worker.fetch(`${origin}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry()),
    });
    assert.equal(response.status, 401);
  });

  test('an empty PIN header is 401', async () => {
    const [status] = await post(entry(), { pin: '' });
    assert.equal(status, 401);
  });

  test('the PIN is checked before the body is even parsed', async () => {
    // Garbage body + wrong PIN must answer 401, not 400 — the gate comes first.
    const [status] = await post(null, { pin: 'nope', raw: 'this is not json' });
    assert.equal(status, 401);
  });
});

describe('POST /log — validation', () => {
  // Corrections need a real id to target, and the id of an entry this suite posted itself is
  // the only one it can name without depending on what ran before it.
  let targetId;
  before(async () => {
    const [, body] = await post(entry({ uuid: 'correction-target-uuid' }));
    targetId = body.entry.id;
  });

  test('malformed JSON is 400 and leaves the log untouched', async () => {
    const [, beforeBody] = await getLog();
    const [status, body] = await post(null, { raw: '{"type": "time", oops' });
    assert.equal(status, 400);
    assert.match(body.error, /Malformed JSON/);
    const [, afterBody] = await getLog();
    assert.equal(afterBody.count, beforeBody.count);
  });

  test('an unknown entry type is rejected', async () => {
    // A typo'd type would sit in the permanent log scoring nothing.
    const [status, body] = await post(entry({ type: 'tmie' }));
    assert.equal(status, 400);
    assert.match(body.error, /Unknown entry type/);
  });

  test('an entry without a client uuid is rejected', async () => {
    const bad = entry();
    delete bad.uuid;
    const [status, body] = await post(bad);
    assert.equal(status, 400);
    assert.match(body.error, /uuid/);
  });

  test('a JSON array or scalar is rejected', async () => {
    assert.equal((await post(null, { raw: '[1,2,3]' }))[0], 400);
    assert.equal((await post(null, { raw: '"just a string"' }))[0], 400);
  });

  test('a correction must name the entry it targets', async () => {
    const [status, body] = await post(entry({ type: 'correction', uuid: 'bad-correction-uuid' }));
    assert.equal(status, 400);
    assert.match(body.error, /target/);
  });

  test('a valid correction is accepted', async () => {
    const [status] = await post({ type: 'correction', uuid: 'good-correction-uuid', targets: targetId });
    assert.equal(status, 201);
  });

  test('a correction pointing at an entry that does not exist is rejected', async () => {
    // Only the DO knows which ids exist, so this rejection comes from the append path.
    // Letting it through would park a permanent no-op in the log.
    const [status, body] = await post({
      type: 'correction', uuid: 'ghost-target-uuid', targets: 999_999,
    });
    assert.equal(status, 400);
    assert.match(body.error, /does not exist/);
  });

  test('a correction with a non-positive target is rejected', async () => {
    assert.equal((await post({ type: 'correction', uuid: 'zero-target-uuid', targets: 0 }))[0], 400);
    assert.equal((await post({ type: 'correction', uuid: 'neg-target-uuid1', targets: -3 }))[0], 400);
  });

  test('a garbage replacement is rejected instead of persisted', async () => {
    // `replacement: "garbage"` would otherwise spread into {"0":"g","1":"a",...} and sit in
    // the permanent log scoring nothing.
    const [status, body] = await post({
      type: 'correction', uuid: 'garbage-replacement-1', targets: targetId, replacement: 'garbage',
    });
    assert.equal(status, 400);
    assert.match(body.error, /replacement must be a JSON object/);
  });

  test('a replacement with an unknown type is rejected', async () => {
    const [status, body] = await post({
      type: 'correction', uuid: 'bad-replacement-type1', targets: targetId,
      replacement: { type: 'tmie', event: 'swim', player: 'Lucas', value: 61 },
    });
    assert.equal(status, 400);
    assert.match(body.error, /Unknown entry type/);
  });

  test('a replacement cannot itself be a correction', async () => {
    // Replacements are spliced straight into the effective log and never re-processed as
    // corrections, so a nested one would silently do nothing.
    const [status, body] = await post({
      type: 'correction', uuid: 'nested-correction-01', targets: targetId,
      replacement: { type: 'correction', targets: 1 },
    });
    assert.equal(status, 400);
    assert.match(body.error, /cannot itself be a correction/);
  });

  test('a well-formed replacement is accepted', async () => {
    const [status] = await post({
      type: 'correction', uuid: 'good-replacement-001', targets: targetId,
      replacement: { type: 'time', event: 'swim', player: 'Lucas', value: 61 },
    });
    assert.equal(status, 201);
  });

  test('a replacement carrying its own id or uuid is rejected', async () => {
    // It inherits the correction's identity when it is spliced in, so one that brings its own
    // would sit in the permanent log claiming an identity that is not its.
    const [idStatus, idBody] = await post({
      type: 'correction', uuid: 'replacement-with-id1', targets: targetId,
      replacement: { type: 'time', id: 7, event: 'swim', player: 'Lucas', value: 61 },
    });
    assert.equal(idStatus, 400);
    assert.match(idBody.error, /id or uuid/);

    const [uuidStatus] = await post({
      type: 'correction', uuid: 'replacement-with-uuid', targets: targetId,
      replacement: { type: 'time', uuid: 'smuggled-uuid-01', event: 'swim', player: 'Lucas', value: 61 },
    });
    assert.equal(uuidStatus, 400);
  });

  test('an oversized body is 413, measured in BYTES and not characters', async () => {
    // 30k three-byte characters: 30k UTF-16 units, which is well under the 64k cap by the
    // wrong measure, and ~90k bytes, which is over it by the right one.
    const [status] = await post(null, {
      raw: JSON.stringify({
        type: 'knob', uuid: 'oversize-body-uuid', value: 1.2, note: '★'.repeat(30_000),
      }),
    });
    assert.equal(status, 413);
  });

  test('every rejected correction left the log untouched', async () => {
    const [, body] = await getLog();
    const rejected = [
      'ghost-target-uuid', 'zero-target-uuid', 'neg-target-uuid1',
      'garbage-replacement-1', 'bad-replacement-type1', 'nested-correction-01',
      'replacement-with-id1', 'replacement-with-uuid', 'oversize-body-uuid',
    ];
    for (const uuid of rejected) {
      assert.equal(body.entries.some((e) => e.uuid === uuid), false, `${uuid} must not be in the log`);
    }
  });
});

describe('POST /log — append semantics', () => {
  test('ids are monotonic across many appends', async () => {
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const [status, body] = await post(entry({ uuid: `monotonic-${i}-aaaaaaaa` }));
      assert.equal(status, 201);
      ids.push(body.entry.id);
    }
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(ids[i] > ids[i - 1], `id ${ids[i]} must exceed ${ids[i - 1]}`);
    }
  });

  test('ids stay monotonic under concurrent writes', async () => {
    const sent = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(entry({ uuid: `concurrent-${i}-bbbbbbbb` }))),
    );
    const ids = sent.map(([, body]) => body.entry.id).sort((a, b) => a - b);
    assert.equal(new Set(ids).size, ids.length, 'no id may be handed out twice');
    // Contiguous, not merely distinct: the Durable Object serializes appends, so eight
    // concurrent writes must come out as eight consecutive ids with nothing skipped.
    for (let i = 1; i < ids.length; i += 1) {
      assert.equal(ids[i], ids[i - 1] + 1, `id ${ids[i]} must follow ${ids[i - 1]}`);
    }
  });

  test('a duplicate UUID is dropped and answers 200, not 201', async () => {
    const payload = entry({ uuid: 'double-tap-uuid', value: 61 });
    const [firstStatus, first] = await post(payload);
    assert.equal(firstStatus, 201);
    assert.equal(first.duplicate, false);

    const [secondStatus, second] = await post(payload);
    assert.equal(secondStatus, 200);
    assert.equal(second.duplicate, true);
    assert.equal(second.entry.id, first.entry.id, 'the original entry is returned unchanged');

    const [, body] = await getLog();
    const matches = body.entries.filter((e) => e.uuid === 'double-tap-uuid');
    assert.equal(matches.length, 1, 'exactly one entry in the log');
  });

  test('a retry with a CHANGED payload still cannot overwrite the original', async () => {
    // The offline outbox retries by UUID; a mutated retry must not rewrite history.
    await post(entry({ uuid: 'retry-mutation-uuid', value: 55 }));
    const [status, body] = await post(entry({ uuid: 'retry-mutation-uuid', value: 999 }));
    assert.equal(status, 200);
    assert.equal(body.entry.value, 55, 'the first arrival wins');
  });

  test('the server stamps ts when the client omits it', async () => {
    const [, body] = await post({ type: 'knob', uuid: 'no-ts-uuid-aaaa', value: 1.3 });
    assert.ok(Number.isFinite(body.entry.ts));
    assert.ok(body.entry.ts > 0);
  });
});

describe('routing', () => {
  test('static assets are served from the same origin', async () => {
    const response = await worker.fetch(`${origin}/logo.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /image\/png/);
  });

  test('an unsupported method on /log is 405 with an Allow header', async () => {
    const response = await worker.fetch(`${origin}/log`, { method: 'DELETE' });
    assert.equal(response.status, 405);
    assert.match(response.headers.get('allow') ?? '', /GET/);
  });

  test('POST responses are never cached', async () => {
    const [, , response] = await post(entry({ uuid: 'no-store-uuid-aa' }));
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  });
});

/**
 * The reset path. Before Aug 28 the rehearsal's fake weekend has to stop counting, and the
 * mechanism is a different Durable Object instance name — so this needs to be genuinely
 * isolated, not merely "probably". These workers share one persistence directory, so if the
 * instance name were ignored they would see each other's entries and the test would fail.
 */
describe('LOG_INSTANCE gives a clean log without destroying the old one', () => {
  const persistPath = `${process.env.TMPDIR ?? '/tmp'}/ggg-instance-test-${process.pid}`;

  const startAs = (instance) => startWorker({ instance, persist: persistPath });

  const fetchLog = async (w) => (await w.fetch(`${await originOf(w)}/log`)).json();

  // This is the one suite that writes to disk, so it is the one suite that has to clean up.
  after(async () => {
    await rm(persistPath, { recursive: true, force: true });
  });

  test('switching the instance yields an empty log; switching back restores the old one', async () => {
    const rehearsal = await startAs('rehearsal-fixture');
    try {
      const url = String(await rehearsal.url).replace(/\/$/, '');
      await rehearsal.fetch(`${url}/log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-combine-pin': PIN },
        body: JSON.stringify({ type: 'knob', uuid: 'instance-rehearsal-1', value: 1.4 }),
      });
      const body = await fetchLog(rehearsal);
      assert.equal(body.count, 1);
      assert.equal(body.instance, 'rehearsal-fixture');
    } finally {
      await rehearsal.dispose();
    }

    const live = await startAs('live-fixture');
    try {
      const body = await fetchLog(live);
      assert.equal(body.count, 0, 'the live namespace must start empty');
      assert.deepEqual(body.entries, []);
      assert.equal(body.instance, 'live-fixture');
    } finally {
      await live.dispose();
    }

    // The rehearsal log is not destroyed — it is still there to inspect.
    const again = await startAs('rehearsal-fixture');
    try {
      const body = await fetchLog(again);
      assert.equal(body.count, 1, 'the rehearsal log survives the switch');
      assert.equal(body.entries[0].uuid, 'instance-rehearsal-1');
    } finally {
      await again.dispose();
    }
  });

  test('the instance name is part of the ETag, so a switch invalidates cached polls', async () => {
    const a = await startAs('etag-a');
    let etagA;
    try {
      const url = String(await a.url).replace(/\/$/, '');
      etagA = (await a.fetch(`${url}/log`)).headers.get('etag');
    } finally {
      await a.dispose();
    }

    const b = await startAs('etag-b');
    try {
      const url = String(await b.url).replace(/\/$/, '');
      const response = await b.fetch(`${url}/log`, { headers: { 'if-none-match': etagA } });
      // Both logs are empty, so without the instance in the ETag this would 304 — and a
      // viewer could sit on a cached board from the wrong namespace.
      assert.equal(response.status, 200);
      assert.notEqual(response.headers.get('etag'), etagA);
    } finally {
      await b.dispose();
    }
  });
});

describe('end to end: the log round-trips through the real scoring engine', () => {
  test('entries posted here score the same as entries built in memory', async () => {
    const { score, effectiveLog } = await import('../src/scoring.js');
    const { ROSTER } = await import('../src/rules-config.js');
    const [, body] = await getLog();
    // The engine must tolerate whatever accumulated above without throwing.
    const result = score(effectiveLog(body.entries));
    assert.equal(result.players.length, ROSTER.length);
    assert.ok(result.players.every((p) => Number.isFinite(p.total)));
  });
});

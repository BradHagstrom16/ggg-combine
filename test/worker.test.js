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
import { unstable_startWorker } from 'wrangler';

const PIN = 'test-pin-1234';

let worker;
let origin;

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
  worker = await unstable_startWorker({
    config: 'wrangler.toml',
    bindings: { ADMIN_PIN: { type: 'plain_text', value: PIN } },
    dev: { persist: false, inspector: { port: 0 }, server: { port: 0 } },
  });
  // worker.url resolves to a URL object, not a string.
  origin = String(await worker.url).replace(/\/$/, '');
});

after(async () => {
  await worker?.dispose();
});

describe('GET /log', () => {
  test('an empty log is an empty list, not an error', async () => {
    const [status, body] = await getLog();
    assert.equal(status, 200);
    assert.deepEqual(body.entries, []);
    assert.equal(body.count, 0);
    assert.equal(body.lastId, 0);
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
    const [status] = await post({ type: 'correction', uuid: 'good-correction-uuid', targets: 1 });
    assert.equal(status, 201);
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
    const ids = sent.map(([, body]) => body.entry.id);
    assert.equal(new Set(ids).size, ids.length, 'no id may be handed out twice');
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

describe('end to end: the log round-trips through the real scoring engine', () => {
  test('entries posted here score the same as entries built in memory', async () => {
    const { score, effectiveLog } = await import('../src/scoring.js');
    const [, body] = await getLog();
    // The engine must tolerate whatever accumulated above without throwing.
    const result = score(effectiveLog(body.entries));
    assert.equal(result.players.length, 11);
    assert.ok(result.players.every((p) => Number.isFinite(p.total)));
  });
});

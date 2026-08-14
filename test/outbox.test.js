/**
 * Tests for src/outbox.js — the admin's offline outbox (a named risk area).
 *
 * The load-bearing rule, straight from the write contract: POST /log is idempotent by UUID, and a
 * duplicate UUID returns **200 with {duplicate:true} — a SUCCESS**. So the outbox must dequeue on
 * BOTH 201 (new) and 200 (duplicate). If it only dequeued on 201, a queued entry the server had
 * already accepted (e.g. the response was lost on a flaky link) would resend forever and never
 * drain. A 400/413 is a permanent rejection (junk never comes out of a permanent log) → drop and
 * surface, don't retry. Everything else (network throw, 401, 5xx) is transient → keep and retry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueue,
  dequeue,
  classifyResponse,
  loadQueue,
  saveQueue,
  createOutbox,
} from '../src/outbox.js';

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/** Scripted post: each call consumes the next outcome (a status number, or 'throw'). */
function scriptedPost(outcomes) {
  const calls = [];
  let i = 0;
  const fn = async (entry) => {
    calls.push(entry.uuid);
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (outcome === 'throw') throw new Error('network down');
    return { status: outcome };
  };
  fn.calls = calls;
  return fn;
}

const entry = (uuid, type = 'time') => ({ uuid, type, value: uuid });

/** A single-slot fake timer: at most one one-shot timer, fired on demand, with an arm counter. */
function fakeTimers() {
  const active = new Map(); // id -> { fn, delay }
  let nextId = 1;
  let armed = 0;
  return {
    set: (fn, delay) => { const id = nextId; nextId += 1; active.set(id, { fn, delay }); armed += 1; return id; },
    clear: (id) => { active.delete(id); },
    armedCount: () => armed,
    activeCount: () => active.size,
    pending: () => (active.size ? [...active.values()][0] : null),
    fire: async () => {
      const id = [...active.keys()][0];
      if (id == null) return;
      const { fn } = active.get(id);
      active.delete(id); // a real one-shot timer is consumed when it fires
      await fn();
    },
  };
}

test('enqueue appends and is idempotent by uuid', () => {
  let q = [];
  q = enqueue(q, entry('a'));
  q = enqueue(q, entry('b'));
  q = enqueue(q, entry('a')); // same uuid again — must not double-add
  assert.deepEqual(q.map((e) => e.uuid), ['a', 'b']);
});

test('dequeue removes by uuid, preserves order', () => {
  const q = [entry('a'), entry('b'), entry('c')];
  assert.deepEqual(dequeue(q, 'b').map((e) => e.uuid), ['a', 'c']);
  assert.deepEqual(dequeue(q, 'zzz').map((e) => e.uuid), ['a', 'b', 'c']);
});

test('classifyResponse: 201 and 200 are both success; 400/413 permanent; rest transient', () => {
  assert.equal(classifyResponse(201), 'ok');
  assert.equal(classifyResponse(200), 'ok'); // <-- duplicate is a success
  assert.equal(classifyResponse(400), 'rejected');
  assert.equal(classifyResponse(413), 'rejected');
  assert.equal(classifyResponse(401), 'retry');
  assert.equal(classifyResponse(500), 'retry');
  assert.equal(classifyResponse(0), 'retry');
  assert.equal(classifyResponse(undefined), 'retry');
});

test('MUTATION dequeue-on-200: a duplicate must classify as ok, not retry', () => {
  // If this regressed to 'retry', a queued-but-already-accepted entry would loop forever.
  assert.equal(classifyResponse(200), 'ok');
  assert.notEqual(classifyResponse(200), 'retry');
});

test('loadQueue / saveQueue round-trip; bad JSON degrades to empty', () => {
  const storage = fakeStorage();
  saveQueue(storage, 'k', [entry('a'), entry('b')]);
  assert.deepEqual(loadQueue(storage, 'k').map((e) => e.uuid), ['a', 'b']);
  storage.setItem('bad', 'not json');
  assert.deepEqual(loadQueue(storage, 'bad'), []);
  assert.deepEqual(loadQueue(storage, 'missing'), []);
});

test('send: a 201 succeeds immediately and does not queue', async () => {
  const storage = fakeStorage();
  const post = scriptedPost([201]);
  let count = null;
  const outbox = createOutbox({ post, storage, key: 'k', onChange: (c) => { count = c; } });
  const outcome = await outbox.send(entry('a'));
  assert.equal(outcome, 'ok');
  assert.equal(outbox.count(), 0);
  assert.equal(post.calls.length, 1);
});

test('send: a network failure queues the entry and persists it', async () => {
  const storage = fakeStorage();
  const post = scriptedPost(['throw']);
  const counts = [];
  const outbox = createOutbox({ post, storage, key: 'k', onChange: (c) => counts.push(c) });
  const outcome = await outbox.send(entry('a'));
  assert.equal(outcome, 'retry');
  assert.equal(outbox.count(), 1);
  assert.deepEqual(loadQueue(storage, 'k').map((e) => e.uuid), ['a']); // persisted for next session
  assert.deepEqual(counts, [1]);
});

test('send: a 400 is rejected — not queued, surfaced to the caller', async () => {
  const storage = fakeStorage();
  const rejects = [];
  const outbox = createOutbox({ post: scriptedPost([400]), storage, key: 'k', onReject: (e) => rejects.push(e.uuid) });
  const outcome = await outbox.send(entry('bad'));
  assert.equal(outcome, 'rejected');
  assert.equal(outbox.count(), 0);
  assert.deepEqual(rejects, ['bad']);
});

test('flush drains the queue on 201, FIFO, and clears storage', async () => {
  const storage = fakeStorage();
  const outbox = createOutbox({ post: scriptedPost(['throw', 'throw']), storage, key: 'k' });
  await outbox.send(entry('a'));
  await outbox.send(entry('b'));
  assert.equal(outbox.count(), 2);

  outbox._setPost(scriptedPost([201, 201]));
  await outbox.flush();
  assert.equal(outbox.count(), 0);
  assert.deepEqual(loadQueue(storage, 'k'), []);
});

test('flush drains on 200-duplicate (the server already had it)', async () => {
  const storage = fakeStorage();
  const outbox = createOutbox({ post: scriptedPost(['throw']), storage, key: 'k' });
  await outbox.send(entry('a'));
  outbox._setPost(scriptedPost([200])); // duplicate — a success
  await outbox.flush();
  assert.equal(outbox.count(), 0); // <-- must drain, not loop
});

test('flush stops (and keeps the queue) while the server is still unreachable', async () => {
  const storage = fakeStorage();
  const outbox = createOutbox({ post: scriptedPost(['throw', 'throw']), storage, key: 'k' });
  await outbox.send(entry('a'));
  await outbox.send(entry('b'));
  outbox._setPost(scriptedPost(['throw'])); // still down
  await outbox.flush();
  assert.equal(outbox.count(), 2); // untouched, will retry later
});

test('flush never double-sends: concurrent flushes post each entry once', async () => {
  const storage = fakeStorage();
  const outbox = createOutbox({ post: scriptedPost(['throw', 'throw']), storage, key: 'k' });
  await outbox.send(entry('a'));
  await outbox.send(entry('b'));

  const post = scriptedPost([201, 201, 201, 201]);
  outbox._setPost(post);
  await Promise.all([outbox.flush(), outbox.flush()]); // fire two at once
  assert.equal(post.calls.length, 2); // each queued entry posted exactly once
  assert.equal(outbox.count(), 0);
});

test('flush returns the in-flight drain promise so an overlapping caller awaits it (not undefined)', async () => {
  const storage = fakeStorage();
  let release;
  const gate = new Promise((r) => { release = r; });
  const outbox = createOutbox({ post: scriptedPost(['throw']), storage, key: 'k' });
  await outbox.send(entry('a')); // queue one entry (autoRetry defaults off in Node — no timer)

  outbox._setPost(async () => { await gate; return { status: 201 }; });
  const f1 = outbox.flush();
  const f2 = outbox.flush(); // overlaps the still-gated first drain
  assert.equal(typeof f1.then, 'function'); // a real promise, not undefined
  assert.equal(f1, f2); // the same in-flight drain is reused
  release();
  await Promise.all([f1, f2]);
  assert.equal(outbox.count(), 0);
});

test('autoRetry: a queued entry auto-flushes on a backoff timer once the transport recovers', async () => {
  const timers = fakeTimers();
  const storage = fakeStorage();
  const outbox = createOutbox({
    post: scriptedPost(['throw']),
    storage,
    key: 'k',
    autoRetry: true,
    retryBaseMs: 2000,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await outbox.send(entry('a')); // throws → queued → a retry timer is armed
  assert.equal(outbox.count(), 1);
  assert.equal(timers.pending().delay, 2000);

  outbox._setPost(scriptedPost([201])); // transport recovers WITHOUT any 'online' event
  await timers.fire(); // the backoff timer fires flush()
  assert.equal(outbox.count(), 0); // auto-drained
  assert.equal(timers.activeCount(), 0); // no timer left once the queue is empty
});

test('autoRetry: backoff doubles (capped) while it keeps failing; only one timer is ever pending', async () => {
  const timers = fakeTimers();
  const outbox = createOutbox({
    post: scriptedPost(['throw']), // always down
    storage: fakeStorage(),
    key: 'k',
    autoRetry: true,
    retryBaseMs: 1000,
    retryMaxMs: 8000,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await outbox.send(entry('a'));
  assert.equal(timers.pending().delay, 1000);
  await timers.fire();
  assert.equal(timers.pending().delay, 2000);
  await timers.fire();
  assert.equal(timers.pending().delay, 4000);
  await timers.fire();
  assert.equal(timers.pending().delay, 8000);
  await timers.fire();
  assert.equal(timers.pending().delay, 8000); // capped at retryMaxMs

  // A second send while a timer is already pending must not arm a second timer.
  const armedBefore = timers.armedCount();
  await outbox.send(entry('b'));
  assert.equal(timers.armedCount(), armedBefore);
  assert.equal(timers.activeCount(), 1);
});

test('autoRetry stays off by default in a non-browser context (no timers armed)', async () => {
  let armed = 0;
  const outbox = createOutbox({
    post: scriptedPost(['throw']),
    storage: fakeStorage(),
    key: 'k',
    setTimeoutImpl: () => { armed += 1; return 1; },
  });
  await outbox.send(entry('a'));
  assert.equal(outbox.count(), 1);
  assert.equal(armed, 0); // autoRetry defaults to autoFlushOnline (false under node) — no timer
});

test('a permanent rejection during flush drops that entry and continues', async () => {
  const storage = fakeStorage();
  const outbox = createOutbox({ post: scriptedPost(['throw', 'throw']), storage, key: 'k' });
  await outbox.send(entry('bad'));
  await outbox.send(entry('good'));

  const rejects = [];
  outbox._setPost(scriptedPost([400, 201])); // bad rejected, good accepted
  await outbox.flush({ onReject: (e) => rejects.push(e.uuid) });
  assert.equal(outbox.count(), 0);
  assert.deepEqual(rejects, ['bad']);
});

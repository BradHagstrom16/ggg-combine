/**
 * Tests for src/sync.js — the viewer's poll / visibility / ETag-304 / stale-cache state machine.
 *
 * This is one of the three named risk areas: the interaction between "keep the last-good board on
 * screen", "don't hammer the Worker when the tab is hidden", and "a 304 confirms freshness while a
 * network error must NOT". The transitions are pure (state in → state out) and the fetch wiring is
 * driven here with a fake fetch/storage/clock, so every branch is asserted without a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_CACHE,
  createSyncState,
  applyResponse,
  setVisible,
  shouldPoll,
  requestHeaders,
  syncView,
  loadCache,
  saveCache,
  startSync,
  POLL_MS,
} from '../src/sync.js';

const cacheWith = (entries, etag, fetchedAt) => ({ entries, etag, fetchedAt });

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function fakeResponse({ status = 200, body = null, etag = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'etag' ? etag : null) },
    json: async () => body,
  };
}

test('a fresh state has never loaded and shows no entries', () => {
  const state = createSyncState({ ...EMPTY_CACHE });
  const view = syncView(state, 1000);
  assert.equal(view.everLoaded, false);
  assert.deepEqual(view.entries, []);
  assert.equal(view.ageMs, null);
});

test('applyResponse data: entries + etag stored, age resets to 0, not amber', () => {
  let state = createSyncState({ ...EMPTY_CACHE });
  state = applyResponse(state, { kind: 'data', entries: [{ id: 1 }], etag: 'W/"x-1-1"' }, 5000);
  const view = syncView(state, 5000);
  assert.deepEqual(view.entries, [{ id: 1 }]);
  assert.equal(view.ageMs, 0);
  assert.equal(view.amber, false);
  assert.equal(state.cache.etag, 'W/"x-1-1"');
});

test('applyResponse notModified: keeps entries but refreshes age (304 confirms freshness)', () => {
  let state = createSyncState(cacheWith([{ id: 1 }], 'W/"x-1-1"', 1000));
  state = applyResponse(state, { kind: 'notModified' }, 9000);
  const view = syncView(state, 9000);
  assert.deepEqual(view.entries, [{ id: 1 }]); // unchanged
  assert.equal(view.ageMs, 0); // fetchedAt bumped to 9000
  assert.equal(state.cache.etag, 'W/"x-1-1"'); // etag retained
});

test('applyResponse error: last-good entries stay, but state goes stale + amber; age keeps growing', () => {
  let state = createSyncState(cacheWith([{ id: 1 }], 'W/"x-1-1"', 1000));
  state = applyResponse(state, { kind: 'error', error: 'network down' }, 9000);
  const view = syncView(state, 9000);
  assert.deepEqual(view.entries, [{ id: 1 }]); // still render the last good board
  assert.equal(view.stale, true);
  assert.equal(view.amber, true); // an error is always amber regardless of age
  assert.equal(view.error, 'network down');
  assert.equal(state.cache.fetchedAt, 1000); // NOT refreshed — age keeps climbing
});

test('MUTATION 304-vs-error: a 304 must reset age, an error must not', () => {
  const base = createSyncState(cacheWith([{ id: 1 }], 'e', 1000));
  const after304 = applyResponse(base, { kind: 'notModified' }, 9000);
  const afterErr = applyResponse(base, { kind: 'error', error: 'x' }, 9000);
  assert.equal(syncView(after304, 9000).ageMs, 0); // fresh
  assert.equal(syncView(afterErr, 9000).ageMs, 8000); // stale, still counting
});

test('requestHeaders threads the stored ETag as If-None-Match, omits it when absent', () => {
  assert.deepEqual(requestHeaders(createSyncState({ ...EMPTY_CACHE })), {});
  const withEtag = createSyncState(cacheWith([], 'W/"x-2-2"', 1000));
  assert.deepEqual(requestHeaders(withEtag), { 'if-none-match': 'W/"x-2-2"' });
});

test('syncView amber threshold is ~60s', () => {
  const state = createSyncState(cacheWith([{ id: 1 }], 'e', 0));
  assert.equal(syncView(state, 59_000).amber, false);
  assert.equal(syncView(state, 61_000).amber, true);
});

test('shouldPoll gates on visibility', () => {
  let state = createSyncState({ ...EMPTY_CACHE });
  assert.equal(shouldPoll(setVisible(state, true)), true);
  assert.equal(shouldPoll(setVisible(state, false)), false);
});

test('loadCache / saveCache round-trip through storage; bad JSON degrades to empty', () => {
  const storage = fakeStorage();
  const cache = cacheWith([{ id: 7 }], 'W/"x-7-7"', 4321);
  saveCache(storage, 'k', cache);
  assert.deepEqual(loadCache(storage, 'k'), cache);
  storage.setItem('bad', '{not json');
  assert.deepEqual(loadCache(storage, 'bad'), EMPTY_CACHE);
  assert.deepEqual(loadCache(storage, 'missing'), EMPTY_CACHE);
});

test('startSync.pollOnce: 200 populates, then threads ETag, 304 keeps data, error goes stale', async () => {
  let clock = 1000;
  const now = () => clock;
  const storage = fakeStorage();
  const calls = [];
  let scripted = fakeResponse({ status: 200, body: { entries: [{ id: 1 }] }, etag: 'W/"live-1-1"' });

  const sync = startSync({
    url: '/log',
    fetchImpl: async (url, opts) => {
      calls.push(opts.headers || {});
      return scripted;
    },
    now,
    storage,
    key: 'k',
    isVisible: () => true,
    schedule: () => () => {}, // no background timer in the test
    immediate: false, // drive pollOnce explicitly so call indices are deterministic
    onData: () => {},
  });

  const v1 = await sync.pollOnce();
  assert.deepEqual(v1.entries, [{ id: 1 }]);
  assert.equal(calls[0]['if-none-match'], undefined); // first call had no etag
  assert.deepEqual(loadCache(storage, 'k').entries, [{ id: 1 }]); // persisted

  clock = 9000;
  scripted = fakeResponse({ status: 304, etag: 'W/"live-1-1"' });
  const v2 = await sync.pollOnce();
  assert.equal(calls[1]['if-none-match'], 'W/"live-1-1"'); // etag threaded
  assert.deepEqual(v2.entries, [{ id: 1 }]); // kept
  assert.equal(v2.ageMs, 0); // 304 refreshed age

  clock = 20000;
  scripted = null; // force a throw inside fetch handling
  const v3 = await sync.pollOnce();
  assert.equal(v3.stale, true);
  assert.deepEqual(v3.entries, [{ id: 1 }]); // still the last good board
});

test('startSync.pollOnce serializes overlapping calls: one fetch, same result', async () => {
  let fetched = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const sync = startSync({
    fetchImpl: async () => {
      fetched += 1;
      await gate; // hold the first poll open so the second call overlaps it
      return fakeResponse({ status: 200, body: { entries: [{ id: 1 }] }, etag: 'e' });
    },
    now: () => 1000,
    storage: fakeStorage(),
    isVisible: () => true,
    schedule: () => () => {},
    immediate: false,
  });

  const p1 = sync.pollOnce();
  const p2 = sync.pollOnce(); // while p1 is still in flight
  release();
  const [v1, v2] = await Promise.all([p1, p2]);

  assert.equal(fetched, 1); // the second call did NOT issue its own fetch
  assert.deepEqual(v1.entries, [{ id: 1 }]);
  assert.deepEqual(v2.entries, [{ id: 1 }]);

  // Guard clears after settling — a later poll fetches again.
  await sync.pollOnce();
  assert.equal(fetched, 2);
});

test('startSync.pollOnce does not fetch while hidden', async () => {
  let fetched = 0;
  const sync = startSync({
    fetchImpl: async () => {
      fetched += 1;
      return fakeResponse({ status: 200, body: { entries: [] } });
    },
    now: () => 0,
    storage: fakeStorage(),
    isVisible: () => false,
    schedule: () => () => {},
    immediate: false,
  });
  await sync.pollOnce();
  assert.equal(fetched, 0);
});

test('POLL_MS is a visible-tab cadence no slower than 10s', () => {
  assert.ok(POLL_MS <= 10_000);
});

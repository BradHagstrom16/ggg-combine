/**
 * src/sync.js — the viewer's polling + resilience layer for GET /log.
 *
 * The board must stay honest in both directions: keep the last-good standings on screen through a
 * wifi blip (rendered from localStorage with an amber "updated Xs ago" stamp), and never hammer
 * the Worker while the tab is hidden. The Worker serves GET /log with a weak ETag and a 5s edge
 * cache, so polls are cheap and conditional (If-None-Match → 304).
 *
 * Design: the state transitions are PURE (state in → state out), so every branch — a 200 that
 * refreshes data, a 304 that only confirms freshness, an error that must go stale WITHOUT
 * resetting the age — is unit-tested with a fake clock. startSync() is the thin browser shell that
 * wires fetch/localStorage/visibility to those transitions; its fetch handling is driven in tests
 * with a fake fetch so the wiring is covered too.
 */

/** Visible-tab poll cadence. ≤10s keeps the TV inside the 15s freshness budget (plan §arch). */
export const POLL_MS = 10_000;

export const EMPTY_CACHE = { entries: [], etag: null, fetchedAt: null };

/** @param {{entries:Array, etag:?string, fetchedAt:?number}} cache */
export function createSyncState(cache) {
  return {
    cache: cache || { ...EMPTY_CACHE },
    visible: true,
    consecutiveErrors: 0,
    lastError: null,
  };
}

export function setVisible(state, visible) {
  return { ...state, visible: !!visible };
}

export function shouldPoll(state) {
  return state.visible;
}

/** If-None-Match header from the stored ETag, so an unchanged log answers 304 (no body re-billed). */
export function requestHeaders(state) {
  const etag = state.cache && state.cache.etag;
  return etag ? { 'if-none-match': etag } : {};
}

/**
 * Fold a fetch outcome into the state. `resp.kind` is:
 *   - 'data'         — a 200: replace entries + etag, stamp fetchedAt (age resets), clear errors.
 *   - 'notModified'  — a 304: keep entries + etag, but bump fetchedAt (freshness CONFIRMED).
 *   - 'error'        — network/HTTP failure: keep the last-good cache UNTOUCHED (age keeps
 *                      climbing so the amber stamp grows), and mark the board stale.
 */
export function applyResponse(state, resp, now) {
  switch (resp && resp.kind) {
    case 'data':
      return {
        ...state,
        cache: { entries: resp.entries || [], etag: resp.etag ?? null, fetchedAt: now },
        consecutiveErrors: 0,
        lastError: null,
      };
    case 'notModified':
      return {
        ...state,
        cache: { ...state.cache, fetchedAt: now },
        consecutiveErrors: 0,
        lastError: null,
      };
    case 'error':
      return {
        ...state,
        consecutiveErrors: state.consecutiveErrors + 1,
        lastError: (resp && resp.error) || 'error',
      };
    default:
      return state;
  }
}

/** What the UI renders: the last-good entries, how old they are, and whether to warn. */
export function syncView(state, now) {
  const { cache, consecutiveErrors, lastError } = state;
  const everLoaded = !!(cache && cache.fetchedAt != null);
  const ageMs = everLoaded ? Math.max(0, now - cache.fetchedAt) : null;
  const stale = consecutiveErrors > 0;
  const amber = stale || (ageMs != null && ageMs > 60_000);
  return {
    entries: (cache && cache.entries) || [],
    ageMs,
    amber,
    stale,
    error: lastError,
    everLoaded,
  };
}

export function loadCache(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { ...EMPTY_CACHE };
    const parsed = JSON.parse(raw);
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      etag: parsed.etag ?? null,
      fetchedAt: parsed.fetchedAt ?? null,
    };
  } catch {
    return { ...EMPTY_CACHE };
  }
}

export function saveCache(storage, key, cache) {
  try {
    storage.setItem(key, JSON.stringify(cache));
  } catch {
    // Storage full / disabled — the in-memory state is still authoritative for this session.
  }
}

/**
 * The browser shell. Everything it touches is injectable so tests can drive it deterministically:
 * fetchImpl, now, storage, isVisible, schedule. In production it defaults to the real fetch,
 * Date.now, localStorage, document.visibilityState, and setInterval.
 */
export function startSync(deps = {}) {
  const {
    url = '/log',
    fetchImpl = typeof fetch !== 'undefined' ? fetch : null,
    now = () => (typeof Date !== 'undefined' ? Date.now() : 0),
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    key = 'ggg-log-cache',
    isVisible = () => (typeof document !== 'undefined' ? document.visibilityState === 'visible' : true),
    onData = () => {},
    schedule = (fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    fetchTimeoutMs = POLL_MS,
    immediate = true,
  } = deps;

  let state = createSyncState(storage ? loadCache(storage, key) : { ...EMPTY_CACHE });
  state = setVisible(state, isVisible());
  let inFlight = null;

  function fetchOptions() {
    const opts = { headers: requestHeaders(state), cache: 'no-store' };
    // Bound the request so a stalled socket settles through the error path instead of hanging — and,
    // with the in-flight guard below, wedging every future poll behind one dead fetch.
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(fetchTimeoutMs);
    return opts;
  }

  async function doPoll() {
    state = setVisible(state, isVisible());
    if (!shouldPoll(state)) return syncView(state, now());

    let resp;
    try {
      const res = await fetchImpl(url, fetchOptions());
      if (res.status === 304) {
        resp = { kind: 'notModified' };
      } else if (res.ok) {
        const body = await res.json();
        resp = { kind: 'data', entries: (body && body.entries) || [], etag: res.headers.get('etag') };
      } else {
        resp = { kind: 'error', error: `HTTP ${res.status}` };
      }
    } catch (err) {
      resp = { kind: 'error', error: String((err && err.message) || err) };
    }

    state = applyResponse(state, resp, now());
    if (storage) saveCache(storage, key, state.cache);
    const view = syncView(state, now());
    onData(view);
    return view;
  }

  // Serialize overlapping calls (10s interval vs. visibilitychange vs. an admin refresh()): a second
  // caller awaits the same in-flight poll rather than issuing a racing fetch that double-folds state.
  function pollOnce() {
    if (inFlight) return inFlight;
    inFlight = doPoll();
    return inFlight.finally(() => { inFlight = null; });
  }

  const cancelTimer = schedule(() => { pollOnce(); }, POLL_MS);

  let removeVisibility = () => {};
  if (typeof document !== 'undefined' && document.addEventListener) {
    const handler = () => {
      state = setVisible(state, isVisible());
      if (state.visible) pollOnce(); // poll immediately on returning to the tab
    };
    document.addEventListener('visibilitychange', handler);
    removeVisibility = () => document.removeEventListener('visibilitychange', handler);
  }

  if (immediate) pollOnce(); // don't leave the board blank until the first interval tick

  return {
    pollOnce,
    getView: () => syncView(state, now()),
    getState: () => state,
    stop: () => {
      if (cancelTimer) cancelTimer();
      removeVisibility();
    },
  };
}

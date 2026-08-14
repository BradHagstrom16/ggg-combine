/**
 * src/outbox.js — the admin's offline outbox.
 *
 * Brad enters results at the dock on flaky wifi. A submit must never be silently lost: if the POST
 * can't complete, the entry queues in localStorage with a visible "N queued" badge and flushes on
 * reconnect. This is safe because POST /log is idempotent by UUID — replaying a queued entry the
 * server already accepted just returns the original (200, duplicate:true), which is a SUCCESS.
 *
 * Classification is the whole game:
 *   - 201 (new) / 200 (duplicate)  → 'ok'       : the log has it. Dequeue.
 *   - 400 / 413                    → 'rejected' : it will NEVER be accepted (malformed / too big).
 *                                                 Drop it and surface — the log is permanent, so a
 *                                                 junk entry must not wedge the queue forever.
 *   - network throw / 401 / 5xx    → 'retry'    : transient. Keep it and try again later.
 *
 * The queue mutations are pure (enqueue/dequeue/classifyResponse) and unit-tested; createOutbox is
 * the thin controller that posts, persists, and (in the browser) flushes on the `online` event.
 */

/** Append unless the uuid is already queued (a double-tap must not enqueue twice). */
export function enqueue(queue, entry) {
  if (queue.some((e) => e.uuid === entry.uuid)) return queue;
  return [...queue, entry];
}

export function dequeue(queue, uuid) {
  return queue.filter((e) => e.uuid !== uuid);
}

export function classifyResponse(status) {
  if (status === 201 || status === 200) return 'ok';
  if (status === 400 || status === 413) return 'rejected';
  return 'retry';
}

export function loadQueue(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveQueue(storage, key, queue) {
  try {
    storage.setItem(key, JSON.stringify(queue));
  } catch {
    // Storage full/disabled — the in-memory queue is still authoritative for this session.
  }
}

/**
 * @param {object} deps
 * @param {(entry:object) => Promise<{status:number}>} deps.post  Posts one entry; throws on network failure.
 * @param {Storage} [deps.storage]         localStorage (optional; queue persists across reloads).
 * @param {string}  [deps.key]             storage key.
 * @param {(count:number)=>void} [deps.onChange]  Called with the queue length whenever it changes.
 * @param {(entry:object)=>void} [deps.onReject]  Called when an entry is permanently rejected.
 * @param {boolean} [deps.autoFlushOnline]  Attach a window 'online' listener (default: true in a browser).
 * @param {boolean} [deps.autoRetry]        Self-schedule backoff retries while the queue is non-empty
 *                                           (default: same as autoFlushOnline — on in a browser, off
 *                                           in a plain Node test unless explicitly enabled).
 * @param {number}  [deps.retryBaseMs]       First retry delay (default 2000).
 * @param {number}  [deps.retryMaxMs]        Backoff ceiling (default 30000).
 * @param {Function}[deps.setTimeoutImpl]    Injectable timer (default global setTimeout) — test seam.
 * @param {Function}[deps.clearTimeoutImpl]  Injectable clear (default global clearTimeout).
 */
export function createOutbox(deps) {
  const {
    storage = null,
    key = 'ggg-outbox',
    onChange = () => {},
    onReject = () => {},
    autoFlushOnline = typeof window !== 'undefined',
    autoRetry = autoFlushOnline,
    retryBaseMs = 2000,
    retryMaxMs = 30_000,
    setTimeoutImpl = (typeof setTimeout !== 'undefined' ? setTimeout : null),
    clearTimeoutImpl = (typeof clearTimeout !== 'undefined' ? clearTimeout : null),
  } = deps;

  let post = deps.post;
  let queue = storage ? loadQueue(storage, key) : [];
  let flushing = null; // the in-flight drain promise, or null — so callers can await a running drain
  let retryTimer = null;
  let backoff = retryBaseMs;
  let stopped = false; // once stop()ed, no path (incl. an in-flight flush's finally) may re-arm a timer

  const persist = () => {
    if (storage) saveQueue(storage, key, queue);
    onChange(queue.length);
  };

  async function attempt(entry) {
    try {
      const res = await post(entry);
      return classifyResponse(res && res.status);
    } catch {
      return 'retry';
    }
  }

  function clearRetry() {
    if (retryTimer != null && clearTimeoutImpl) clearTimeoutImpl(retryTimer);
    retryTimer = null;
  }

  /**
   * Arm a single backoff retry while the queue still has entries. The 'online' event covers a
   * network drop→restore, but a transport that recovers WITHOUT one (a 5xx that later 201s, a PIN
   * accepted after 401s) would otherwise strand the queue until Brad's next manual submit. Backoff
   * doubles per arming up to the ceiling and resets to base once the queue drains.
   */
  function scheduleRetry() {
    if (stopped || !autoRetry || !setTimeoutImpl || retryTimer != null || queue.length === 0) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, retryMaxMs);
    // Return the flush promise from the callback: the real setTimeout ignores it, but an injected
    // timer can await the drain (and its own reschedule) to drive this deterministically in tests.
    retryTimer = setTimeoutImpl(() => { retryTimer = null; return flush(); }, delay);
  }

  /** Try to send now; queue it only if the failure is transient. Returns the outcome. */
  async function send(entry) {
    const outcome = await attempt(entry);
    if (outcome === 'retry') {
      queue = enqueue(queue, entry);
      persist();
      scheduleRetry();
    } else if (outcome === 'rejected') {
      onReject(entry);
    }
    return outcome;
  }

  /**
   * Drain the queue FIFO. Stops at the first transient failure (still offline). No double-send: an
   * already-running drain is returned so overlapping callers await the same promise. On a transient
   * stop the queue is left intact and a backoff retry is armed; on a clean drain backoff resets.
   */
  function flush(opts = {}) {
    if (flushing) return flushing;
    const reject = opts.onReject || onReject;
    flushing = (async () => {
      try {
        while (queue.length) {
          const entry = queue[0];
          const outcome = await attempt(entry);
          if (outcome === 'retry') break; // server still unreachable — leave the queue intact
          queue = dequeue(queue, entry.uuid); // 'ok' or 'rejected' both leave the queue
          persist();
          if (outcome === 'rejected') reject(entry);
        }
      } finally {
        flushing = null;
        if (queue.length === 0) { backoff = retryBaseMs; clearRetry(); }
        else scheduleRetry();
      }
    })();
    return flushing;
  }

  let removeOnline = () => {};
  if (autoFlushOnline && typeof window !== 'undefined' && window.addEventListener) {
    const handler = () => { flush(); };
    window.addEventListener('online', handler);
    removeOnline = () => window.removeEventListener('online', handler);
  }

  return {
    send,
    flush,
    count: () => queue.length,
    getQueue: () => queue.slice(),
    // Teardown: latch stopped FIRST so an in-flight flush's finally can't re-arm, then kill the
    // current timer + online listener.
    stop: () => { stopped = true; clearRetry(); removeOnline(); },
    _setPost: (fn) => { post = fn; }, // test seam: swap the transport between offline and online
  };
}

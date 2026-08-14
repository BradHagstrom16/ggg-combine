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
 */
export function createOutbox(deps) {
  const {
    storage = null,
    key = 'ggg-outbox',
    onChange = () => {},
    onReject = () => {},
    autoFlushOnline = typeof window !== 'undefined',
  } = deps;

  let post = deps.post;
  let queue = storage ? loadQueue(storage, key) : [];
  let flushing = false;

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

  /** Try to send now; queue it only if the failure is transient. Returns the outcome. */
  async function send(entry) {
    const outcome = await attempt(entry);
    if (outcome === 'retry') {
      queue = enqueue(queue, entry);
      persist();
    } else if (outcome === 'rejected') {
      onReject(entry);
    }
    return outcome;
  }

  /** Drain the queue FIFO. Stops at the first transient failure (still offline). No double-send. */
  async function flush(opts = {}) {
    if (flushing) return;
    flushing = true;
    const reject = opts.onReject || onReject;
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
      flushing = false;
    }
  }

  if (autoFlushOnline && typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => { flush(); });
  }

  return {
    send,
    flush,
    count: () => queue.length,
    getQueue: () => queue.slice(),
    _setPost: (fn) => { post = fn; }, // test seam: swap the transport between offline and online
  };
}

/**
 * Server reachability, not just the network link.
 *
 * `navigator.onLine` only answers "does this device have a network interface?".
 * Behind Cloudflare the device can be perfectly online while the origin is down,
 * and then every request comes back as Cloudflare's "not working" HTML page. The
 * app used to trust `navigator.onLine` to decide whether to talk to the server
 * (sync, session check, version poll), so in that state it kept posting into a
 * black hole and users got proxy error pages instead of their island.
 *
 * So we probe `GET /health` (tiny, no-store, same-origin) and only count it as
 * up when the *payload* is ours. A proxy error page can arrive with a 200 and
 * `text/html`, which is exactly why the status alone is not enough.
 *
 * Probe moments: boot, link comes back, tab becomes visible, and with exponential
 * backoff while unreachable (4s → 60s). While up, one idle probe every 4 min
 * keeps the proxy/container warm and notices an outage within a few minutes.
 */

export type ServerState = 'unknown' | 'up' | 'down';

const PROBE_URL = '/health';
const PROBE_TIMEOUT_MS = 2500;
const RETRY_MIN_MS = 4_000;
const RETRY_MAX_MS = 60_000;
const KEEPALIVE_MS = 4 * 60_000;
/** Don't re-probe more often than this (visibility flapping, double events). */
const PROBE_DEBOUNCE_MS = 10_000;

const net = $state({
  /** The device has a network link (navigator.onLine). */
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  /** Can the app's server actually be reached? 'unknown' until the first probe. */
  server: 'unknown' as ServerState,
  checking: false,
  lastOkAt: null as number | null,
  lastFailAt: null as number | null,
});

export function getNet() {
  return net;
}

/**
 * True when a server round-trip is worth attempting. 'unknown' counts as
 * reachable so a cold boot never waits on the probe before rendering. The
 * request itself will correct the state if the server is actually gone.
 */
export function serverReachable(): boolean {
  return net.online && net.server !== 'down';
}

/** Every callback registered here runs when the server comes back. */
const recovered: Array<() => void> = [];

/**
 * Run `cb` when the server goes from unreachable to reachable. Used to flush
 * unsynced edits. Returns an unsubscribe function.
 */
export function onServerRecovered(cb: () => void): () => void {
  recovered.push(cb);
  return () => {
    const i = recovered.indexOf(cb);
    if (i >= 0) recovered.splice(i, 1);
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive failed probes; drives the retry backoff. */
let failures = 0;
let lastProbeAt = 0;
let started = false;
/** Last-started probe wins: overlapping probes must not fight over the state. */
let probeSeq = 0;

function schedule(): void {
  if (typeof window === 'undefined' || !started) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const delay =
    net.server === 'down'
      ? Math.min(RETRY_MIN_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS)
      : KEEPALIVE_MS;
  timer = setTimeout(() => {
    timer = null;
    // Hidden tabs don't need to poll; visibilitychange probes on the way back.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedule();
      return;
    }
    void probeServer();
  }, delay);
}

function apply(next: ServerState): void {
  const prev = net.server;
  net.server = next;
  if (next === 'up') {
    net.lastOkAt = Date.now();
    failures = 0;
  } else if (next === 'down') {
    net.lastFailAt = Date.now();
    failures++;
  }
  // Only a genuine down→up transition triggers the resync hooks.
  if (prev === 'down' && next === 'up') {
    for (const cb of recovered.slice()) {
      try {
        cb();
      } catch {
        /* a bad callback must not break the monitor */
      }
    }
  }
  schedule();
}

/** Only our own JSON health payload proves the app's server answered. */
async function isHealthy(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('json')) return false;
  try {
    const body = (await res.json()) as { ok?: unknown };
    return body?.ok === 'true' || body?.ok === true;
  } catch {
    return false;
  }
}

/** Probe /health now, update the shared state, and re-arm the timer. */
export async function probeServer(): Promise<boolean> {
  if (typeof window === 'undefined') return true;
  const seq = ++probeSeq;
  lastProbeAt = Date.now();
  net.checking = true;
  let ok = false;
  const ctrl = new AbortController();
  const cap = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    // Cache-buster: we want to know about the ORIGIN, not the edge cache.
    const res = await fetch(`${PROBE_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    ok = await isHealthy(res);
  } catch {
    ok = false;
  } finally {
    clearTimeout(cap);
  }
  // A newer probe started while this one was in flight, so its answer is the
  // current one; this result is stale.
  if (seq !== probeSeq) return ok;
  net.checking = false;
  apply(ok ? 'up' : 'down');
  return ok;
}

/**
 * Feed the outcome of a request the app already made. Applies only to failures
 * that mean "the server (or the proxy in front of it) is gone"; anything the
 * server itself answered, including 4xx, proves it is up.
 */
export function noteServerStatus(status: number): void {
  const down =
    status === 0 || // transport error (DNS, TLS, reset, timeout)
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 521 || // Cloudflare: origin down
    status === 522 || // Cloudflare: connection timed out
    status === 523 || // Cloudflare: origin unreachable
    status === 530; // Cloudflare: tunnel/Argo error
  if (down) {
    if (net.server !== 'down') apply('down');
    return;
  }
  if (status > 0 && status < 500 && net.server !== 'up') apply('up');
}

/** True when a probe succeeded this recently (a new one can wait). */
export function probedRecently(withinMs = PROBE_DEBOUNCE_MS): boolean {
  return net.lastOkAt !== null && Date.now() - net.lastOkAt < withinMs;
}

/**
 * Start the monitor: boot probe, listen for link changes and tab returns, and
 * keep the backoff/keepalive timer running. Returns a stop function.
 */
export function startNetMonitor(): () => void {
  if (typeof window === 'undefined') return () => {};
  started = true;

  const onOnline = () => {
    net.online = true;
    void probeServer();
  };
  const onOffline = () => {
    net.online = false;
    // Link gone: nothing can be reached, but don't claim the server is down.
    // the next probe decides. Re-arm so a silent link return is still caught.
    schedule();
  };
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastProbeAt < PROBE_DEBOUNCE_MS) return;
    void probeServer();
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);

  void probeServer();

  return () => {
    started = false;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

// Central rate governor (v6, docs/v6-ui.md §Rate governance). Every outbound
// call to a rate-limited service routes through schedule(), which SPACES calls
// to stay under each provider's limit BEFORE the provider throttles us — the
// piece that stops a heavy weekly build from tripping a limit and, per Simkl's
// policy, getting a client_id suspended.
//
// Model: a per-service serialized "next allowed slot". reserve() hands out
// monotonically increasing slots spaced by the service's minimum interval, so
// concurrent callers (the build fires TMDB calls in parallel) are paced instead
// of bursting. A 429 sets a backoff window (honouring Retry-After) that pushes
// every subsequent slot out. Groq key rotation is handled separately by the LLM
// chain (llm.js: custom → Groq primary → Groq backup), so the governor only
// paces here — it does not rotate keys.
//
// Deliberately NOT a retry layer: callers keep their own error handling. A call
// that hits 429 still surfaces to its caller; the governor just makes the NEXT
// call wait. Pacing is the primary defence; backoff is the safety net.

// Minimum ms between calls per service, sized just under each real limit.
//   tmdb        ~40/s   (cap ~50/s, no daily cap)
//   simkl_get   ~8/s    (cap 10 GET/s)
//   simkl_post  <1/s    (HARD 1 POST/s write cap — suspension risk if exceeded)
//   mdblist     ~4/s    (free tier ~1000/day; dayCalls tracked for visibility)
//   jikan       ~57/min (cap 60/min, also 3/s burst) — MAL age lookups
//   anilist     ~30/min — AniList fallback when Jikan is down (cap 90/min, but
//               they degrade it to 30/min under load; pace to the low ceiling)
//   groq        ~28/min (cap ~30 RPM) — honours Retry-After on 429
const LIMITS = {
  tmdb: { minIntervalMs: 25 },
  simkl_get: { minIntervalMs: 120 },
  simkl_post: { minIntervalMs: 1100 },
  // Simkl trending CDN (data.simkl.in) — GE-02. A PUBLIC static file, NOT the
  // authed api.simkl.com (its own lane so a CDN refresh never spends a profile's
  // 10-GET/s Simkl budget). One server-wide fetch/day, so pace it gently.
  simkl_cdn: { minIntervalMs: 1000 },
  mdblist: { minIntervalMs: 250, dailyCap: 1000, breaker: { threshold: 5, cooldownMs: 60000 } },
  // TVDB v4 (AGE-1): country certifications for the TV-14 chain. Free tier is
  // ~5 req/s — pace just under it.
  tvdb: { minIntervalMs: 200 },
  jikan: { minIntervalMs: 1050, breaker: { threshold: 5, cooldownMs: 60000 } },
  anilist: { minIntervalMs: 2000, breaker: { threshold: 5, cooldownMs: 60000 } },
  groq: { minIntervalMs: 2100 },
};

const DEFAULT_BACKOFF_MS = 5000; // when a 429 carries no usable Retry-After
const DAY_MS = 86400e3;

const states = new Map();
// For MDBList, states are partitioned by key fingerprint so equal keys share
// a bucket and distinct keys have independent pacing/backoff/breaker state.
// The state key is `mdblist:<fingerprint>` for mdblist, plain `service` for others.
function stateKey(service, keyFingerprint) {
  if (service === 'mdblist' && keyFingerprint) return 'mdblist:' + keyFingerprint;
  return service;
}

function stateFor(service, keyFingerprint) {
  const k = stateKey(service, keyFingerprint);
  let s = states.get(k);
  if (!s) {
    s = { nextAt: 0, backoffUntil: 0, calls: 0, throttled: 0, lastThrottledAt: 0, day: 0, dayCalls: 0, fails: 0, openUntil: 0, tripped: 0, lastActivity: 0 };
    states.set(k, s);
  }
  return s;
}

// Circuit breaker (opt-in per service via LIMITS.breaker). When a service fails
// N times in a row — connection errors or 5xx, i.e. "it's down", NOT 429 which
// is just rate — the breaker OPENS for a cooldown and schedule() fails fast
// without calling the network or consuming a slot. This stops us from pounding a
// dead endpoint (Jikan behind Cloudflare drops connections under sustained
// retries, which keeps both it and us down) and makes the run fall straight
// through to the fallback. After the cooldown the next call is a half-open
// probe: success closes the breaker, failure re-opens it.
function isOpen(service, keyFingerprint, nowMs = Date.now()) {
  const s = states.get(stateKey(service, keyFingerprint));
  return !!s && s.openUntil > nowMs;
}

function noteOutcome(service, ok, keyFingerprint, nowMs = Date.now()) {
  const lim = LIMITS[service];
  if (!lim || !lim.breaker) return;
  const s = stateFor(service, keyFingerprint);
  if (ok) { s.fails = 0; s.openUntil = 0; return; }
  s.fails += 1;
  if (s.fails >= lim.breaker.threshold && s.openUntil <= nowMs) {
    s.openUntil = nowMs + lim.breaker.cooldownMs;
    s.tripped += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry-After is either delta-seconds (integer) or an HTTP date. Returns ms.
function parseRetryAfter(value, nowMs) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : Math.max(0, t - nowMs);
}

// Reserve the next slot for a service and return the ms to wait before the call
// may run. SYNCHRONOUS on purpose: the slot is claimed before any await, so two
// concurrent callers get distinct, spaced slots. Exported for testing.
function reserve(service, keyFingerprint, nowMs = Date.now()) {
  const lim = LIMITS[service] || { minIntervalMs: 0 };
  const s = stateFor(service, keyFingerprint);
  const at = Math.max(nowMs, s.nextAt, s.backoffUntil);
  s.nextAt = at + lim.minIntervalMs;
  s.calls += 1;
  s.lastActivity = nowMs;
  const day = Math.floor(nowMs / DAY_MS);
  if (s.day !== day) { s.day = day; s.dayCalls = 0; }
  s.dayCalls += 1;
  return Math.max(0, at - nowMs);
}

// Compute the would-be wait for a slot WITHOUT claiming it (no side effects).
// Used by schedule() to check the defer threshold before committing a slot,
// so deferred/cancelled work does not create artificial slots or consume
// request counters.
function pendingWait(service, keyFingerprint, nowMs = Date.now()) {
  const s = stateFor(service, keyFingerprint);
  const at = Math.max(nowMs, s.nextAt, s.backoffUntil);
  return Math.max(0, at - nowMs);
}

// Record a response so a 429 backs off subsequent calls. No-op for non-429 or
// non-Response values. Exported for testing.
function noteResponse(service, res, keyFingerprint, nowMs = Date.now()) {
  if (!res || typeof res.status !== 'number' || res.status !== 429) return;
  const s = stateFor(service, keyFingerprint);
  const retryAfter = res.headers && typeof res.headers.get === 'function'
    ? parseRetryAfter(res.headers.get('retry-after'), nowMs) : 0;
  s.backoffUntil = nowMs + (retryAfter || DEFAULT_BACKOFF_MS);
  s.throttled += 1;
  s.lastThrottledAt = nowMs;
  s.lastActivity = nowMs;
}

// The one entry point: pace, run fn (which returns a fetch Response or
// {res, body} for MDBList), note 429. Also drives the circuit breaker for
// services that opt in: an open breaker fails fast (no slot, no network);
// otherwise the outcome (2xx-4xx reachable vs 5xx/thrown down) is recorded.
// 429 is rate, not down — never a breaker fail.
// `keyFingerprint` partitions MDBList pacing per credential (equal keys share
// a bucket; distinct keys have independent rate limits).
const MDBLIST_MAX_SLOT_WAIT_MS = 30000;

async function schedule(service, fn, keyFingerprint) {
  const lim = LIMITS[service] || {};
  if (lim.breaker && isOpen(service, keyFingerprint)) {
    const err = new Error(`${service} circuit open — skipping (cooldown)`);
    err.circuitOpen = true;
    throw err;
  }
  // Check the defer threshold BEFORE claiming a slot: deferred work must not
  // create artificial slots or consume request counters.
  const wouldWait = pendingWait(service, keyFingerprint);
  if (service === 'mdblist' && wouldWait > MDBLIST_MAX_SLOT_WAIT_MS) {
    const err = new Error(`MDBList slot wait ${wouldWait}ms exceeds 30s — deferring`);
    err.defer = true;
    err.retryAfterMs = wouldWait;
    throw err;
  }
  const wait = reserve(service, keyFingerprint);
  if (wait > 0) await sleep(wait);
  // Recheck cooldown/breaker immediately before send: during the pacing sleep
  // another call may have received a 429 with a long Retry-After, moving the
  // allowed slot beyond the 30s bound. Defer promptly in that case.
  if (service === 'mdblist') {
    if (lim.breaker && isOpen(service, keyFingerprint)) {
      const err = new Error(`MDBList circuit open — skipping (cooldown)`);
      err.circuitOpen = true;
      throw err;
    }
    const reWait = pendingWait(service, keyFingerprint);
    if (reWait > MDBLIST_MAX_SLOT_WAIT_MS) {
      const err = new Error(`MDBList slot wait ${reWait}ms exceeds 30s — deferring`);
      err.defer = true;
      err.retryAfterMs = reWait;
      throw err;
    }
  }
  try {
    const result = await fn();
    // fn may return a Response directly (tmdb, simkl) or {res, body} (mdblist).
    const res = result && result.res ? result.res : result;
    noteResponse(service, res, keyFingerprint);
    noteOutcome(service, !(res && typeof res.status === 'number' && res.status >= 500), keyFingerprint);
    return result;
  } catch (err) {
    noteOutcome(service, false, keyFingerprint); // transport/body timeout = the service is down
    throw err;
  }
}

// Diagnostics snapshot (for the Advanced tab, later): per-service call totals,
// today's count vs any daily cap, and current throttle/backoff state.
// For MDBList, per-fingerprint entries are grouped under `mdblist` with a
// `key_source` label (never the raw key or full fingerprint).
const IDLE_BUCKET_MS = 86400e3; // 24h — idle MDBList buckets are GC'd

// Internal stats (used by portal profile status to query a specific
// credential's bucket). Exposes fingerprints as property names — never
// returned to clients.
function stats(nowMs = Date.now()) {
  const out = {};
  for (const [service, s] of states) {
    // GC idle MDBList buckets: never evict a bucket with an active cooldown
    // (backoffUntil in the future) or an open circuit breaker (openUntil in
    // the future), even if lastActivity is old. A 48h cooldown must survive
    // the 24h idle threshold.
    if (service.startsWith('mdblist:') && s.lastActivity && nowMs - s.lastActivity > IDLE_BUCKET_MS) {
      const active = s.backoffUntil > nowMs || s.openUntil > nowMs;
      if (!active) { states.delete(service); continue; }
    }
    const lim = service.startsWith('mdblist:') ? LIMITS.mdblist : (LIMITS[service] || {});
    const entry = {
      calls: s.calls,
      today: s.day === Math.floor(nowMs / DAY_MS) ? s.dayCalls : 0,
      daily_cap: lim.dailyCap || null,
      throttled: s.throttled,
      backing_off: s.backoffUntil > nowMs,
      backoff_ms_left: Math.max(0, s.backoffUntil - nowMs),
      circuit_open: s.openUntil > nowMs,
      circuit_ms_left: Math.max(0, s.openUntil - nowMs),
      tripped: s.tripped,
    };
    if (service.startsWith('mdblist:')) {
      // Group under the mdblist lane with a fingerprint suffix
      const fp = service.slice(8); // strip 'mdblist:' prefix (8 chars)
      if (!out.mdblist) out.mdblist = {};
      out.mdblist[fp] = entry;
    } else {
      out[service] = entry;
    }
  }
  return out;
}

// Public diagnostics (for GET /api/governor): never exposes raw keys or
// fingerprints. MDBList entries are summarized as aggregate counts without
// per-credential identifiers.
function publicStats(nowMs = Date.now()) {
  const internal = stats(nowMs);
  const out = {};
  for (const [service, entry] of Object.entries(internal)) {
    if (service === 'mdblist') {
      // Aggregate all per-credential MDBList buckets into a single public entry
      const agg = {
        calls: 0, today: 0, daily_cap: LIMITS.mdblist.dailyCap || null,
        throttled: 0, backing_off: false, backoff_ms_left: 0,
        circuit_open: false, circuit_ms_left: 0, tripped: 0,
        credentials: 0,
      };
      for (const cred of Object.values(entry)) {
        agg.calls += cred.calls;
        agg.today += cred.today;
        agg.throttled += cred.throttled;
        agg.backing_off = agg.backing_off || cred.backing_off;
        agg.backoff_ms_left = Math.max(agg.backoff_ms_left, cred.backoff_ms_left);
        agg.circuit_open = agg.circuit_open || cred.circuit_open;
        agg.circuit_ms_left = Math.max(agg.circuit_ms_left, cred.circuit_ms_left);
        agg.tripped += cred.tripped;
        agg.credentials += 1;
      }
      out.mdblist = agg;
    } else {
      out[service] = entry;
    }
  }
  return out;
}

// Internal per-credential lookup: given a fingerprint, return that credential's
// stats entry (or null if no state exists yet). Used by portal profile status
// to query the resolved bucket without exposing fingerprints publicly.
function credentialStats(keyFingerprint, nowMs = Date.now()) {
  const s = states.get('mdblist:' + keyFingerprint);
  if (!s) return null;
  return {
    calls: s.calls,
    today: s.day === Math.floor(nowMs / DAY_MS) ? s.dayCalls : 0,
    daily_cap: LIMITS.mdblist.dailyCap || null,
    throttled: s.throttled,
    backing_off: s.backoffUntil > nowMs,
    backoff_ms_left: Math.max(0, s.backoffUntil - nowMs),
    circuit_open: s.openUntil > nowMs,
    circuit_ms_left: Math.max(0, s.openUntil - nowMs),
    tripped: s.tripped,
  };
}

function _reset() { states.clear(); }

module.exports = { schedule, reserve, pendingWait, noteResponse, noteOutcome, isOpen, stats, publicStats, credentialStats, LIMITS, _reset };

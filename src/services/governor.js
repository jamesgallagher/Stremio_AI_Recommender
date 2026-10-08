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
// MDBList uses a per-credential FIFO admission gate (not reserve): a caller can
// send only when BOTH the provider cooldown has expired AND at least
// minIntervalMs has elapsed since the previous ACTUAL start for that credential.
// Both conditions are re-evaluated after every await (a cooldown extension can
// happen during any wait). Simultaneously awakened callers are serialized via
// the FIFO queue — only the head admits at a time.
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
  // MyAnimeList API v2 (AN-1a): the first source for anime age ratings when a
  // client id is available. Paced at 1 req/s with a breaker.
  mal: { minIntervalMs: 1000, breaker: { threshold: 5, cooldownMs: 60000 } },
  // AniDB HTTP API (AN-1a): one request every 4 s, server-wide (all clients
  // share one queue / IP). The anidb client also enforces a persisted
  // last_request_at so a restart can't burst.
  anidb: { minIntervalMs: 4000 },
};

const DEFAULT_BACKOFF_MS = 5000; // when a 429 carries no usable Retry-After
const DAY_MS = 86400e3;
const MDBLIST_MAX_ADMISSION_WAIT_MS = 30000; // 30s defer threshold
const IDLE_BUCKET_MS = 86400e3; // 24h — idle MDBList buckets are GC'd

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
    s = { nextAt: 0, backoffUntil: 0, calls: 0, throttled: 0, lastThrottledAt: 0, day: 0, dayCalls: 0, fails: 0, openUntil: 0, tripped: 0, lastActivity: 0, lastStart: 0 };
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
// concurrent callers get distinct, spaced slots. Used by non-MDBList services.
// MDBList uses the FIFO admission gate instead (see mdblistSchedule).
function reserve(service, keyFingerprint, nowMs = Date.now(), { count = true } = {}) {
  const lim = LIMITS[service] || { minIntervalMs: 0 };
  const s = stateFor(service, keyFingerprint);
  const at = Math.max(nowMs, s.nextAt, s.backoffUntil);
  s.nextAt = at + lim.minIntervalMs;
  if (count) {
    s.calls += 1;
    const day = Math.floor(nowMs / DAY_MS);
    if (s.day !== day) { s.day = day; s.dayCalls = 0; }
    s.dayCalls += 1;
  }
  s.lastActivity = nowMs;
  return Math.max(0, at - nowMs);
}

// Compute the would-be wait for a slot WITHOUT claiming it (no side effects).
// For MDBList, this reflects the actual admission gate (cooldown + pacing).
function pendingWait(service, keyFingerprint, nowMs = Date.now()) {
  const s = stateFor(service, keyFingerprint);
  if (service === 'mdblist') {
    const lim = LIMITS.mdblist;
    const earliest = Math.max(s.backoffUntil, (s.lastStart || 0) + lim.minIntervalMs);
    return Math.max(0, earliest - nowMs);
  }
  const at = Math.max(nowMs, s.nextAt, s.backoffUntil);
  return Math.max(0, at - nowMs);
}

// Record a response so a 429 backs off subsequent calls. No-op for non-429 or
// non-Response values. A later shorter 429 must NOT shorten an existing longer
// cooldown (invariant 5).
function noteResponse(service, res, keyFingerprint, nowMs = Date.now()) {
  if (!res || typeof res.status !== 'number' || res.status !== 429) return;
  const s = stateFor(service, keyFingerprint);
  const retryAfter = res.headers && typeof res.headers.get === 'function'
    ? parseRetryAfter(res.headers.get('retry-after'), nowMs) : 0;
  const newBackoff = nowMs + (retryAfter || DEFAULT_BACKOFF_MS);
  // Never shorten an existing longer cooldown.
  s.backoffUntil = Math.max(s.backoffUntil, newBackoff);
  s.throttled += 1;
  s.lastThrottledAt = nowMs;
  s.lastActivity = nowMs;
}

// GC idle MDBList buckets on the request/state path (invariant 6). A bucket is
// evicted only when it is idle (no recent activity) AND has no active cooldown,
// no open breaker, and no pending/in-flight work.
function gcIdleBuckets(nowMs = Date.now()) {
  for (const [key, s] of states) {
    if (key.startsWith('mdblist:') && s.lastActivity && nowMs - s.lastActivity > IDLE_BUCKET_MS) {
      const active = s.backoffUntil > nowMs || s.openUntil > nowMs || (s.queue && s.queue.length > 0) || (s.inFlight && s.inFlight > 0);
      if (!active) states.delete(key);
    }
  }
}

// The one entry point: pace, run fn (which returns a fetch Response or
// {res, body} for MDBList), note 429. Also drives the circuit breaker for
// services that opt in: an open breaker fails fast (no slot, no network);
// otherwise the outcome (2xx-4xx reachable vs 5xx/thrown down) is recorded.
// 429 is rate, not down — never a breaker fail.
// `keyFingerprint` partitions MDBList pacing per credential (equal keys share
// a bucket; distinct keys have independent rate limits).
async function schedule(service, fn, keyFingerprint) {
  const lim = LIMITS[service] || {};

  if (service === 'mdblist') {
    return mdblistSchedule(fn, keyFingerprint);
  }

  // Non-MDBList: reserve + sleep + fn (unchanged policy).
  if (lim.breaker && isOpen(service, keyFingerprint)) {
    const err = new Error(`${service} circuit open — skipping (cooldown)`);
    err.circuitOpen = true;
    throw err;
  }
  const wait = reserve(service, keyFingerprint, undefined, { count: true });
  if (wait > 0) await sleep(wait);
  try {
    const result = await fn();
    const res = result && result.res ? result.res : result;
    noteResponse(service, res, keyFingerprint);
    noteOutcome(service, !(res && typeof res.status === 'number' && res.status >= 500), keyFingerprint);
    return result;
  } catch (err) {
    noteOutcome(service, false, keyFingerprint);
    throw err;
  }
}

// MDBList: per-credential FIFO admission gate.
// Admission owns waiting, FIFO ordering, cooldown/breaker checks, and the
// synchronous update of lastStart/counters. It finishes at the instant fn is
// about to start. The network operation (fn) is tracked separately (inFlight)
// and runs AFTER the FIFO head is released, so a held first request does not
// prevent a second from starting once its 250ms slot is available.
//
// Every queued entry has an independent 30-second admission expiry starting
// at enqueue. Expiry settles even while earlier work is pending. Expired
// entries can never call fn later.
async function mdblistSchedule(fn, keyFingerprint) {
  // GC BEFORE acquiring/creating the bucket (Issue 2: prevent GC from
  // deleting the bucket a resumed caller is using).
  gcIdleBuckets();

  const s = stateFor('mdblist', keyFingerprint);
  if (!s.queue) s.queue = [];
  if (s.inFlight === undefined) s.inFlight = 0;

  const entry = { fn, entryTime: Date.now(), promise: null, timer: null };
  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });
  s.queue.push(entry);

  // Independent 30s admission expiry timer (starts at enqueue).
  entry.timer = setTimeout(() => {
    const idx = s.queue.indexOf(entry);
    if (idx >= 0) {
      s.queue.splice(idx, 1);
      const err = new Error(`MDBList admission expired (30s) — deferring`);
      err.defer = true;
      err.retryAfterMs = 0;
      entry.reject(err);
      // Only wake when the removed entry was the head — removing a non-head
      // does not transfer head ownership.
      if (idx === 0 && s.queue.length > 0) wakeNext(s, keyFingerprint);
    }
  }, MDBLIST_MAX_ADMISSION_WAIT_MS);

  // If we're not the head, wait for our turn (admission will be triggered
  // by wakeNext when the previous head releases).
  if (s.queue[0] !== entry) {
    return new Promise((resolve, reject) => {
      entry.promise.then(async () => {
        try {
          resolve(await runMdblistFn(fn, s, keyFingerprint));
        } catch (err) {
          reject(err);
        }
      }).catch(reject);
    });
  }

  // We're the head: run admission (wait for cooldown + pacing), then fn.
  // The try/catch covers admission + removal ONLY. Network outcomes stay
  // exclusively in runMdblistFn and must not shift/wake the admission queue.
  try {
    clearTimeout(entry.timer);
    await mdblistAdmitWait(s, entry.entryTime);

    // Admission complete: update lastStart/counters synchronously.
    recordStart(s);

    // Remove from FIFO and release the next admission BEFORE the network op.
    s.queue.shift();
    wakeNext(s, keyFingerprint);
  } catch (err) {
    // Admission error: remove only this specific entry if still present.
    const idx = s.queue.indexOf(entry);
    if (idx >= 0) s.queue.splice(idx, 1);
    if (s.queue.length > 0) wakeNext(s, keyFingerprint);
    throw err;
  }

  // Network operation (tracked as in-flight). Runs AFTER the admission
  // try/catch so network outcomes never touch the admission queue.
  return await runMdblistFn(fn, s, keyFingerprint);
}

// Wake the next caller in the FIFO queue (if any). Admission only (no fn).
function wakeNext(s, keyFingerprint) {
  if (!s.queue || s.queue.length === 0) return;
  const next = s.queue[0];
  (async () => {
    try {
      clearTimeout(next.timer);
      await mdblistAdmitWait(s, next.entryTime);

      // Admission complete: update lastStart/counters synchronously.
      recordStart(s);

      // Remove from FIFO and release the next admission.
      s.queue.shift();
      next.resolve(); // Signal: admission complete, caller now runs fn.
      wakeNext(s, keyFingerprint);
    } catch (err) {
      // Admission error: remove only this specific entry if still present.
      const idx = s.queue.indexOf(next);
      if (idx >= 0) s.queue.splice(idx, 1);
      next.reject(err);
      if (s.queue.length > 0) wakeNext(s, keyFingerprint);
    }
  })();
}

// The admission wait: re-evaluate cooldown + pacing after every await.
// A single sleep is insufficient — a cooldown extension can happen during any
// wait, so we loop until both conditions are satisfied.
async function mdblistAdmitWait(s, entryTime) {
  const lim = LIMITS.mdblist;

  // Check if already expired (was waiting in queue for >30s).
  if (Date.now() - entryTime > MDBLIST_MAX_ADMISSION_WAIT_MS) {
    const err = new Error(`MDBList admission expired (30s) — deferring`);
    err.defer = true;
    err.retryAfterMs = 0;
    throw err;
  }

  while (true) {
    const now = Date.now();

    // Breaker open → abort admission.
    if (lim.breaker && s.openUntil > now) {
      const err = new Error(`MDBList circuit open — skipping (cooldown)`);
      err.circuitOpen = true;
      throw err;
    }

    // 30s budget: check elapsed admission time.
    if (now - entryTime > MDBLIST_MAX_ADMISSION_WAIT_MS) {
      const err = new Error(`MDBList admission expired (30s) — deferring`);
      err.defer = true;
      err.retryAfterMs = 0;
      throw err;
    }

    // Compute the earliest time we can send:
    //   cooldown: backoffUntil
    //   pacing:   lastStart + minIntervalMs
    const earliest = Math.max(s.backoffUntil, (s.lastStart || 0) + lim.minIntervalMs);

    if (earliest <= now) {
      break; // Both conditions satisfied — we can send now.
    }

    // Check if waiting until earliest would exceed the 30s budget.
    if (earliest - entryTime > MDBLIST_MAX_ADMISSION_WAIT_MS) {
      const waitMs = earliest - now;
      const err = new Error(`MDBList admission wait ${waitMs}ms exceeds 30s — deferring`);
      err.defer = true;
      err.retryAfterMs = waitMs;
      throw err;
    }

    // Sleep until the earliest time, then recheck (cooldown may have extended).
    await sleep(earliest - now);
  }
}

// Record an actual start: update lastStart and counters synchronously.
function recordStart(s) {
  const sendTime = Date.now();
  s.lastStart = sendTime;
  s.calls += 1;
  const day = Math.floor(sendTime / DAY_MS);
  if (s.day !== day) { s.day = day; s.dayCalls = 0; }
  s.dayCalls += 1;
  s.lastActivity = sendTime;
}

// Run the network operation (fn), tracked as in-flight. Response/breaker
// accounting is retained here.
async function runMdblistFn(fn, s, keyFingerprint) {
  s.inFlight += 1;
  try {
    const result = await fn();
    const res = result && result.res ? result.res : result;
    noteResponse('mdblist', res, keyFingerprint);
    noteOutcome('mdblist', !(res && typeof res.status === 'number' && res.status >= 500), keyFingerprint);
    return result;
  } catch (err) {
    noteOutcome('mdblist', false, keyFingerprint);
    throw err;
  } finally {
    s.inFlight -= 1;
  }
}

// Diagnostics snapshot (for the Advanced tab, later): per-service call totals,
// today's count vs any daily cap, and current throttle/backoff state.
// For MDBList, per-fingerprint entries are grouped under `mdblist` with a
// `key_source` label (never the raw key or full fingerprint).

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
      const active = s.backoffUntil > nowMs || s.openUntil > nowMs || (s.queue && s.queue.length > 0) || (s.inFlight && s.inFlight > 0);
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

module.exports = { schedule, reserve, pendingWait, noteResponse, noteOutcome, isOpen, stats, publicStats, credentialStats, LIMITS, _reset, gcIdleBuckets };

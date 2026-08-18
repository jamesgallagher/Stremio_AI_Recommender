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
//   groq        ~28/min (cap ~30 RPM) — honours Retry-After on 429
const LIMITS = {
  tmdb: { minIntervalMs: 25 },
  simkl_get: { minIntervalMs: 120 },
  simkl_post: { minIntervalMs: 1100 },
  mdblist: { minIntervalMs: 250, dailyCap: 1000 },
  jikan: { minIntervalMs: 1050 },
  groq: { minIntervalMs: 2100 },
};

const DEFAULT_BACKOFF_MS = 5000; // when a 429 carries no usable Retry-After
const DAY_MS = 86400e3;

const states = new Map();
function stateFor(service) {
  let s = states.get(service);
  if (!s) {
    s = { nextAt: 0, backoffUntil: 0, calls: 0, throttled: 0, lastThrottledAt: 0, day: 0, dayCalls: 0 };
    states.set(service, s);
  }
  return s;
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
function reserve(service, nowMs = Date.now()) {
  const lim = LIMITS[service] || { minIntervalMs: 0 };
  const s = stateFor(service);
  const at = Math.max(nowMs, s.nextAt, s.backoffUntil);
  s.nextAt = at + lim.minIntervalMs;
  s.calls += 1;
  const day = Math.floor(nowMs / DAY_MS);
  if (s.day !== day) { s.day = day; s.dayCalls = 0; }
  s.dayCalls += 1;
  return Math.max(0, at - nowMs);
}

// Record a response so a 429 backs off subsequent calls. No-op for non-429 or
// non-Response values. Exported for testing.
function noteResponse(service, res, nowMs = Date.now()) {
  if (!res || typeof res.status !== 'number' || res.status !== 429) return;
  const s = stateFor(service);
  const retryAfter = res.headers && typeof res.headers.get === 'function'
    ? parseRetryAfter(res.headers.get('retry-after'), nowMs) : 0;
  s.backoffUntil = nowMs + (retryAfter || DEFAULT_BACKOFF_MS);
  s.throttled += 1;
  s.lastThrottledAt = nowMs;
}

// The one entry point: pace, run fn (which returns a fetch Response), note 429.
async function schedule(service, fn) {
  const wait = reserve(service);
  if (wait > 0) await sleep(wait);
  const res = await fn();
  noteResponse(service, res);
  return res;
}

// Diagnostics snapshot (for the Advanced tab, later): per-service call totals,
// today's count vs any daily cap, and current throttle/backoff state.
function stats(nowMs = Date.now()) {
  const out = {};
  for (const [service, s] of states) {
    const lim = LIMITS[service] || {};
    out[service] = {
      calls: s.calls,
      today: s.day === Math.floor(nowMs / DAY_MS) ? s.dayCalls : 0,
      daily_cap: lim.dailyCap || null,
      throttled: s.throttled,
      backing_off: s.backoffUntil > nowMs,
      backoff_ms_left: Math.max(0, s.backoffUntil - nowMs),
    };
  }
  return out;
}

function _reset() { states.clear(); }

module.exports = { schedule, reserve, noteResponse, stats, LIMITS, _reset };

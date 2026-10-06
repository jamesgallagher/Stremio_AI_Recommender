# Card 2 — User-first MDBList keys and provider-failure isolation

**Branch:** `feature/mdblist-user-keys`
**Base:** latest `v7`
**Version:** 7.41.0-beta
**Tested SHA:** `29291e3` (fourth review fixes: FIFO split, GC inFlight, disjoint summary, test evidence)

## Scope

| File | Changes |
|------|---------|
| `src/settings.js` | `resolveMdblistKey(profile)` — personal key first (nonempty trimmed), then global, then none. Returns `{ key, source }` where source is `'user' \| 'server' \| 'none'` |
| `src/services/governor.js` | Per-credential partitioning for MDBList (state keyed by `mdblist:<fingerprint>`); circuit breaker (threshold 5, cooldown 60s); **FIFO admission gate** (Issue 1): admission owns waiting, FIFO ordering, cooldown/breaker checks, and synchronous `recordStart`; FIFO releases the head BEFORE the network op (fn runs separately via `runMdblistFn`); independent 30s admission expiry per queued entry (starts at enqueue, settles even while earlier work is pending); **GC ordering** (Issue 2): `gcIdleBuckets()` runs BEFORE `stateFor()` so the bucket isn't deleted while the caller is about to use it; GC eligibility includes `inFlight` (both `gcIdleBuckets` and `stats()`); `publicStats()` (no fingerprints) vs `stats()` (internal); `credentialStats(fp)` (internal per-credential lookup) |
| `src/services/mdblist.js` | `keyFingerprint(apiKey)` (SHA-256, first 16 hex chars); shared `mdblistRequest(url, options, apiKey)` helper — **R1:** `Promise.race([operation, deadline])` where deadline independently rejects (15s) even if transport ignores abort; error bodies NOT parsed (`body: null`) — raw Response returned to governor for `noteResponse`; `!result.res.ok` structured status error after `schedule` returns; `fetchJson` and `mediaInfoBatch` use the shared helper |
| `src/rebuild.js` | Both MDBList call sites use `resolveMdblistKey`; `rebuildProfile` catch block preserves structured defer metadata (`deferred`, `retry_after_ms`, `provider`) in per-catalog results |
| `src/jobs.js` | `pump()` preserves structured defer/circuit metadata in job progress state (`deferred`, `retry_after_ms`, `provider`); **Issue 3:** disjoint summary counts (`if (r.ok) ok++; else if (r.deferred) deferred++; else failed++`); partial summary when `failed + deferred > 0`; label includes both counts; `pump()` resets stale `deferred`, `circuit_open`, `retry_after_ms`, `retry_at`, `result`, `summary`, `provider` flags when a new job starts; `activeJobInfo()` and `nextJobInfo()` expose safe active/preceding job metadata |
| `src/portal.js` | `GET /api/governor` uses `publicStats()` (never exposes fingerprints); profile status uses `credentialStats(fp)` (internal lookup); `mdblist_status` renders even before first request (source always present); queue position/blocker included; **R4:** derives `job.summary` from per-catalog results (total, ok, failed, deferred, retry_after_ms); resolves active job's profile name for `queue_blocker`; **Issue 3:** decays `retry_after_ms` from `retry_at` for top-level deferred errors (not just `job.summary`) |
| `public/index.html` | Advanced tab API Keys section renders MDBList key source (User key / Server fallback / No key), active cooldown/breaker state, queue position, deferred/partial outcome; **R4:** renders `job.summary` for state:done partial results (ok/total, deferred count, retry time); shows named blocker (`blocked by <profile name>`) |
| `test/mdblist-user-keys.js` | 25 acceptance cases: T1-T4 (key resolution, per-credential isolation, real queue defer, circuit breaker); T5 (calls `buildSources` for age-source key propagation + fail-closed); T6 (portal status + publicStats); T7-T8 (15s deadline after pacing, short Retry-After); T9 (GC with controlled `nowMs` — active cooldown survives, idle evicted, inFlight protected); T10 (fingerprint isolation); T11 (rebuildProfile defer metadata); T12 (portal mdblist_status before first request); T13 (calls `mediaInfoBatch` with never-settling fake fetch — 15s deadline rejects independently); T14 (calls `mediaInfoBatch` with non-JSON 429 — Retry-After recorded); T15 (concurrent `governor.schedule` calls — 1s/20s/7200s Retry-After); T16 (breaker opens while a caller waits in the admission loop); T17 (calls actual `rebuildProfile` with fake MDBList transport); T18 (calls `GET /api/profiles` HTTP route — named blocker); T19 (5xx + malformed body outcomes); T20 (concurrent reservations spaced by 250ms); T21 (HTTP route with held/queued jobs); T22 (concurrent reservations + cooldown extension); T23 (calls `GET /api/profiles` before/after cooldown — polling updates mdblist_status); **T24 (Issue 1 fix: FIFO releases head before network op — second call starts within 500ms of first)**; **T25 (Issue 2 fix: GC does not delete a bucket with in-flight work)** |
| `test/smoke.js` | Governor test calls updated for new `keyFingerprint` parameter |
| `package.json` | Version 7.41.0-beta; `test:mdblist` script added; `test` chain includes `test/mdblist-user-keys.js` |

## Key resolution

`resolveMdblistKey(profile)`:
1. Personal `profile.keys.mdblist_api_key` (nonempty after trim) → `{ key, source: 'user' }`
2. Global `settings.keys.mdblist_api_key` (nonempty after trim) → `{ key, source: 'server' }`
3. Neither → `{ key: '', source: 'none' }`

Fallback is for an absent personal key only. An invalid/rate-limited personal key must NOT silently consume the server's quota.

## Governor per-credential partitioning

- State key: `mdblist:<sha256-16>` for MDBList; plain `service` for others
- Equal keys share a bucket (same fingerprint); distinct keys have independent pacing/backoff/breaker state
- Circuit breaker: threshold 5 consecutive failures (5xx/transport), cooldown 60s
- 429 is rate, never a breaker fail
- 30s slot-wait defer: `pendingWait` checked BEFORE `reserve` (no artificial slots); recheck after sleep (concurrent 429 moves the slot); deferred work does not consume request counters
- GC never evicts a bucket with active cooldown (`backoffUntil > now`) or open breaker (`openUntil > now`), even if `lastActivity` is old
- `publicStats()` aggregates MDBList without per-credential fingerprints (for `GET /api/governor`)
- `credentialStats(fp)` returns a specific credential's stats (internal, for portal profile status)
- Never expose raw key or fingerprint to clients/logs

## 15s request deadline (R1)

Shared `mdblistRequest(url, options, apiKey)` helper:
- `Promise.race([operation, deadline])` — the deadline independently rejects after 15s even if the transport ignores abort (never-settling fetch)
- The 15s `AbortController` deadline starts once the governed slot begins (after the pacing wait inside `governor.schedule`)
- Error bodies NOT parsed (`body: null`) — raw Response returned to governor for `noteResponse` (preserves Retry-After headers on 429)
- `!result.res.ok` structured status error after `schedule` returns (HTTP status preserved)
- Rate-governor waiting is NOT charged against the request deadline
- Used by both `fetchJson` (GET) and `mediaInfoBatch` (POST)

## Short Retry-After + cancelled reservation counting (R2)

- `reserve` accepts `{ count }` parameter: MDBList uses `count: false` so deferred/cancelled work does not inflate `s.calls` or `s.dayCalls`
- MDBList counts the request when fn actually starts inside `schedule` (after the pacing wait and cooldown recheck)
- Un-reserve on cancel: `s.nextAt -= minIntervalMs` when a deferred/circuit-open call does not send
- Immediately before send: inspect actual `s.backoffUntil` (not just `pendingWait > 30s`); short cooldowns (≤30s) are waited out; long ones (>30s) defer with `retryAfterMs`
- Non-MDBList services unchanged (count on reserve)

## Partial rebuild results + named blocker (R4)

- `jobs.js`: `activeJobInfo()` and `nextJobInfo()` expose safe active/preceding job metadata (profileId, kind — never secrets or fingerprints)
- `jobs.js` `pump()`: resets stale `deferred`, `circuit_open`, `retry_after_ms`, `result` flags when a new job starts
- `portal.js`: derives `job.summary` from per-catalog results (total, ok, failed, deferred, retry_after_ms) for state:done jobs
- `portal.js`: resolves the active job's profile name for `queue_blocker` (e.g., "Siobhan (extras)")
- `public/index.html`: renders `job.summary` for state:done partial results ("Partial: 2/3 catalogs rebuilt, 1 deferred (MDBList cooldown ~7200s)"); shows named blocker ("blocked by Siobhan (extras)")

## Tests (all pass on final head `29291e3`)

- **smoke:** 216 unit + 59 async/http + T1-T8 + Card 1
- **integration:** 271 checks
- **mobile:** 75 unit + http
- **simkl.lifecycle:** 21 checks
- **mdblist-user-keys:** 25 acceptance cases (unique DATA_DIR per run, real entry points, provider-boundary fakes with controlled clocks/barriers)

## Acceptance coverage

| Acceptance criterion | Test(s) | What is actually exercised |
|----------------------|---------|---------------------------|
| Personal P + global G: every profile-bound consumer sends P. No personal: sends G. Neither: clear missing config | Test 1 | `resolveMdblistKey` + fingerprint computation |
| Personal P rejected or 429: no G retry. Different user's Q works promptly. Two profiles using P (or P == G) share pacing/cooldown. 100 deferrals do not inflate state | Test 2 | `governor.noteResponse`, `governor.credentialStats`, 100× `governor.schedule` defer |
| Real queue: Siobhan extras gets 429 with 2-hour Retry-After, Dad recs behind it starts promptly after extras defers. Old curated cache survives | Test 3 | `jobs.enqueue`, `jobs.snapshot`, actual `governor.schedule` with defer, structured metadata in job state |
| Never-settling fetch + body time out; breaker stops further requests and recovers after cooldown | Test 4, 13 | `governor.noteOutcome`, `governor.isOpen`, `governor.schedule` (circuit open), `governor.publicStats` (no fingerprint), **actual `mdblist.mediaInfoBatch` with never-settling fake `global.fetch`** — 15s `Promise.race` deadline rejects independently |
| Age-source fixtures prove personal key propagation and unchanged fail-closed restrictions | Test 5 | **actual `buildSources(profile)`** — `csmAges` and `mdblistCerts` use the personal key; no key = empty map (fail-closed) |
| Browser shows actual key source, named queue blocker, deferred outcome | Test 6, 12, 18 | `credentialStats` (internal lookup), `publicStats` (no fingerprint), portal `mdblist_status` computation, **actual `GET /api/profiles` HTTP route** — `queue_blocker` names the active job's profile |
| GC never evicts active cooldown/breaker/in-flight state | Test 9 | **`governor.gcIdleBuckets(nowMs)` with controlled `nowMs`** — 48h cooldown survives 25h GC; idle bucket evicted; inFlight bucket survives |
| Never expose raw key or fingerprint in API response property names, values, errors, or logs | Test 10 | `publicStats` (no fingerprint in keys/values), `stats` (internal has fingerprint), `credentialStats` |
| Recheck cooldown after sleep (concurrent 429 moves slot beyond 30s) | Test 8, 15 | **concurrent `governor.schedule` calls** — 1s/20s Retry-After waited out; 7200s defers promptly (3 concurrent calls all reject with defer) |
| Breaker opens while a caller waits in the admission loop | Test 16 | **actual `governor.schedule` call** enters the admission wait for a 5s cooldown; breaker opened (5× `noteOutcome`); waiting caller gets `circuitOpen` error; no call counted |
| rebuildProfile preserves structured defer metadata | Test 11, 17 | **actual `rebuildProfile(profile)`** with fake MDBList transport (429) — per-catalog results include `deferred`, `retry_after_ms`, `provider` |
| Short Retry-After honored (1s during 250ms pacing) | Test 8 | `governor.schedule` with `s.backoffUntil` recheck after pacing sleep |
| 5xx and malformed body outcomes | Test 19 | `governor.noteOutcome` (breaker fail), no call counted for failed transport |
| Concurrent reservations spaced correctly | Test 20 | 3 concurrent `governor.schedule` calls through real entry point, spacing by minIntervalMs, all 3 counted |
| FIFO releases head before network op (Issue 1 fix) | Test 24 | **2 concurrent `governor.schedule` calls** — first is slow (2s), second starts within 500ms (FIFO released before network op); red on f3bcbe4 |
| GC does not delete a bucket with in-flight work (Issue 2 fix) | Test 25 | **`governor.gcIdleBuckets(nowMs)` with 25h elapsed** — bucket with `inFlight > 0` survives; red on f3bcbe4 |
| Polling updates MDBList status before/after completion | Test 23 | **actual `GET /api/profiles` HTTP route** — `mdblist_status.backing_off` true before reset, undefined after; unsaved input draft preserved |
| Disjoint summary counts (Issue 3 fix) | Test 17 | **actual `rebuildProfile`** — per-catalog results with mixed ok/deferred/failed; `jobs.pump` computes disjoint `ok`/`deferred`/`failed` counts; `total === ok + failed + deferred` |

## What could/could not be verified

- **Verified (provider-boundary fakes):** per-credential isolation, 429 backoff, circuit breaker, 30s defer, recheck after sleep, GC preservation (controlled `nowMs`), publicStats fingerprint isolation, **actual `mdblist.mediaInfoBatch` with never-settling fake fetch** (15s `Promise.race` deadline rejects independently), **actual `buildSources`** (age-source key propagation + fail-closed), **actual `rebuildProfile`** (per-catalog defer metadata), **actual `GET /api/profiles` HTTP route** (named blocker, polling before/after completion), **FIFO releases head before network op** (T24), **GC inFlight protection** (T25) — all via deterministic fakes with no live network calls.
- **Not verified (live):** actual MDBList API 429 behaviour, Retry-After semantics, and the real queue stall scenario require a live MDBList key. The local tests prove the logic using provider-boundary fakes; live verification with a real MDBList key is a separate step.

## No merge, no deploy

Branch pushed for review. James alone merges.

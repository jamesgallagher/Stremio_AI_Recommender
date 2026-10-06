# Card 2 — User-first MDBList keys and provider-failure isolation

**Branch:** `feature/mdblist-user-keys`
**Base:** latest `v7`
**Version:** 7.41.0-beta
**Tested SHA:** `00bc697` (pre-review head) → this commit (review fixes R1-R5)

## Scope

| File | Changes |
|------|---------|
| `src/settings.js` | `resolveMdblistKey(profile)` — personal key first (nonempty trimmed), then global, then none. Returns `{ key, source }` where source is `'user' \| 'server' \| 'none'` |
| `src/services/governor.js` | Per-credential partitioning for MDBList (state keyed by `mdblist:<fingerprint>`); circuit breaker (threshold 5, cooldown 60s); 30s slot-wait defer (checks `pendingWait` BEFORE `reserve` so deferred work does not create artificial slots or consume request counters); recheck cooldown/breaker after sleep; GC never evicts active cooldown/breaker state; `publicStats()` (no fingerprints) vs `stats()` (internal); `credentialStats(fp)` (internal per-credential lookup) |
| `src/services/mdblist.js` | `keyFingerprint(apiKey)` (SHA-256, first 16 hex chars); shared `mdblistRequest(url, options, apiKey)` helper — 15s deadline starts once the governed slot begins (after pacing), fetch+body parse inside the governed operation so transport/body timeouts participate in breaker accounting; `fetchJson` and `mediaInfoBatch` use the shared helper |
| `src/rebuild.js` | Both MDBList call sites use `resolveMdblistKey`; `rebuildProfile` catch block preserves structured defer metadata (`deferred`, `retry_after_ms`, `provider`) in per-catalog results |
| `src/jobs.js` | `pump()` preserves structured defer/circuit metadata in job progress state (`deferred`, `retry_after_ms`, `provider`) |
| `src/portal.js` | `GET /api/governor` uses `publicStats()` (never exposes fingerprints); profile status uses `credentialStats(fp)` (internal lookup); `mdblist_status` renders even before first request (source always present); queue position/blocker included |
| `public/index.html` | Advanced tab API Keys section renders MDBList key source (User key / Server fallback / No key), active cooldown/breaker state, queue position, deferred/partial outcome; help text corrected |
| `test/mdblist-user-keys.js` | 12 acceptance cases exercising queue, rebuild, provider fakes, and HTTP/UI seams |
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
- The 15s `AbortController` deadline starts once the governed slot begins (after the pacing wait inside `governor.schedule`)
- Both fetch AND body parse are inside the governed operation (so transport/body timeouts participate in breaker accounting)
- Rate-governor waiting is NOT charged against the request deadline
- Preserves HTTP status/headers for 429 (quota backoff) and 5xx (transport failure) handling
- Used by both `fetchJson` (GET) and `mediaInfoBatch` (POST)

## Tests (all pass on final head)

- **smoke:** 216 unit + 59 async/http + T1-T8 + Card 1
- **integration:** 271 checks
- **mobile:** 75 unit + http
- **simkl.lifecycle:** 21 checks
- **mdblist-user-keys:** 12 acceptance cases

## Acceptance coverage

| Acceptance criterion | Test(s) | What is actually exercised |
|----------------------|---------|---------------------------|
| Personal P + global G: every profile-bound consumer sends P. No personal: sends G. Neither: clear missing config | Test 1 | `resolveMdblistKey` + fingerprint computation |
| Personal P rejected or 429: no G retry. Different user's Q works promptly. Two profiles using P (or P == G) share pacing/cooldown. 100 deferrals do not inflate state | Test 2 | `governor.noteResponse`, `governor.stats`, `governor.credentialStats`, `governor.pendingWait`, 100× `governor.schedule` defer |
| Real queue: Siobhan extras gets 429 with 2-hour Retry-After, Dad recs behind it starts promptly after extras defers. Old curated cache survives | Test 3 | `jobs.enqueue`, `jobs.snapshot`, actual `governor.schedule` with defer, structured metadata in job state |
| Never-settling fetch + body time out; breaker stops further requests and recovers after cooldown | Test 4, 7 | `governor.noteOutcome`, `governor.isOpen`, `governor.schedule` (circuit open), `governor.publicStats` (no fingerprint), 15s deadline starts after pacing |
| Age-source fixtures prove personal key propagation and unchanged fail-closed restrictions | Test 5 | `resolveMdblistKey`, `buildSources` existence, fail-closed (no key = no data) |
| Browser shows actual key source, named queue blocker, deferred outcome | Test 6, 12 | `credentialStats` (internal lookup), `publicStats` (no fingerprint), portal `mdblist_status` computation (source rendered before first request) |
| GC never evicts active cooldown/breaker state | Test 9 | `governor.stats` GC logic, `credentialStats` after GC |
| Never expose raw key or fingerprint in API response property names, values, errors, or logs | Test 10 | `publicStats` (no fingerprint in keys/values), `stats` (internal has fingerprint), `credentialStats` |
| Recheck cooldown after sleep (concurrent 429 moves slot beyond 30s) | Test 8 | `governor.pendingWait` before and after `noteResponse`, `governor.schedule` defer after recheck |
| rebuildProfile preserves structured defer metadata | Test 11 | `governor.schedule` error fields → rebuild result entry (`deferred`, `retry_after_ms`, `provider`) |

## What could/could not be verified

- **Verified (simulated provider):** per-credential isolation, 429 backoff, circuit breaker, 30s defer (no artificial slots), recheck after sleep, GC preservation, publicStats fingerprint isolation, 15s deadline after pacing, structured defer metadata through jobs/rebuild — all via deterministic fakes with no live network calls.
- **Not verified (live):** actual MDBList API 429 behaviour, Retry-After semantics, and the real queue stall scenario require a live MDBList key and a production server. The simulated tests prove the logic; live verification is a separate step.

## No merge, no deploy

Branch pushed for review. James alone merges.

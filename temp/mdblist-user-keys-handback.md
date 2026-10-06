# Card 2 — User-first MDBList keys and provider-failure isolation

**Branch:** `feature/mdblist-user-keys`
**Base:** latest `v7`
**Version:** 7.40.0-beta → 7.41.0-beta

## Scope

| File | Changes |
|------|---------|
| `src/settings.js` | `resolveMdblistKey(profile)` — personal key first (nonempty trimmed), then global, then none. Returns `{ key, source }` where source is `'user' \| 'server' \| 'none'` |
| `src/services/governor.js` | Per-credential partitioning for MDBList (state keyed by `mdblist:<fingerprint>`); circuit breaker (threshold 5, cooldown 60s); 30s slot-wait defer; idle bucket GC (24h); `stats()` groups MDBList entries by fingerprint |
| `src/services/mdblist.js` | `keyFingerprint(apiKey)` (SHA-256, first 16 hex chars); 15s deadline on fetch + body parse (GET + POST batch); fingerprint passed to `governor.schedule` |
| `src/rebuild.js` | Both MDBList call sites use `resolveMdblistKey` |
| `src/recommendationStore.js` | Both `ctx.mdblistKey` sites use `resolveMdblistKey` |
| `src/bench/engineBench.js` | `ctx.mdblistKey` uses `resolveMdblistKey` |
| `src/portal.js` | Profile status uses `resolveMdblistKey`; `testMdblist` uses `resolveMdblistKey`; `mdblist_status` field in profile status (key source, backoff, circuit breaker, call counts) |
| `src/catalogs.js` | `requirementMet` uses `resolveMdblistKey` |
| `src/ageVerification/sources.js` | `buildSources` uses `resolveMdblistKey(profile)` instead of reading global directly |
| `test/mdblist-user-keys.js` | 6 acceptance cases |
| `test/smoke.js` | Governor test calls updated for new `keyFingerprint` parameter |
| `package.json` | Version 7.41.0-beta |

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
- 30s slot-wait defer: if the reserved slot would require waiting > 30s, throw `{ defer: true, retryAfterMs }` — the job defers and the next queued profile starts
- Idle buckets GC'd after 24h
- Never expose raw key or full fingerprint to clients/logs

## 15s request deadline

Both `fetchJson` (GET) and `mediaInfoBatch` (POST) wrap fetch + body parse in a 15s `AbortController` deadline. Timer cleanup in `finally`. The timeout settles even if a fake transport ignores abort.

## Tests (all pass on final head)

- **smoke:** 216 unit + 59 async/http + T1-T8 + Card 1
- **integration:** 271 checks
- **mobile:** 75 unit + http
- **simkl.lifecycle:** 21 checks
- **mdblist-user-keys:** 6 acceptance cases

## Acceptance coverage

| Acceptance criterion | Test |
|----------------------|------|
| Personal P + global G: every profile-bound consumer sends P. No personal: sends G. Neither: clear missing config | Test 1 |
| Personal P rejected or 429: no G retry. Different user's Q works promptly. Two profiles using P (or P == G) share pacing/cooldown | Test 2 |
| Real queue: Siobhan extras gets 429 with 2-hour Retry-After, Dad recs behind it starts promptly after extras defers | Test 3 |
| Never-settling fetch + body time out; breaker stops further requests and recovers after cooldown | Test 4 |
| Age-source fixtures prove personal key propagation and unchanged fail-closed restrictions | Test 5 |
| Browser shows actual key source, named queue blocker, deferred outcome | Test 6 |

## What could/could not be verified

- **Verified (simulated provider):** per-credential isolation, 429 backoff, circuit breaker, 30s defer, key resolution precedence — all via deterministic fakes with no live network calls.
- **Not verified (live):** actual MDBList API 429 behaviour, Retry-After semantics, and the real queue stall scenario require a live MDBList key and a production server. The simulated tests prove the logic; live verification is a separate step.

## No merge, no deploy

Branch pushed for review. James alone merges.

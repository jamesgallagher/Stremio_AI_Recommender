# Architecture

How AI Recommender is put together today (v7 line, stable on `main`). This is the
platform reference: the config split, the build/serve model, the safety gates, the
external-service rules. Engine-specific designs live next to their code under
`docs/engine-*`; the setup guide is the [README](../README.md).

Earlier planning documents (v5, v5.2, v6, the mark-watched / catalog-preview /
engine-abstraction build cards) were retired in the October 2026 docs cleanup —
their decisions are folded in here, and the files remain in git history.

---

## 1. Shape of the system

```
 Stremio / Nuvio ──▶ /addon/:token/*  ──▶ serve from the pool (no network)
 Phone (PWA)     ──▶ /mobile/*        ──▶ same serve path + Companion API
 Admin (browser) ──▶ /configure/ + /api/*

 hourly tick ─▶ Simkl sync ─▶ AI schedule ─▶ job queue ─▶ engine ─▶ pipeline ─▶ age gate ─▶ pool (SQLite)
```

- **One Node 22 process** (Express 5), `node:sqlite` (needs `--experimental-sqlite`),
  no native modules. One container, one `/data` volume.
- **Serving never calls out.** Stremio/Nuvio and the Companion only read the
  pre-built pool; every external call happens in a background build. A failed
  build never purges a good list.
- **Per-profile everything personal.** Each family member is a profile with their
  own Simkl account, filters, catalogs and install token. Shared infrastructure
  (keys, LLM) is configured once in **Server Config**.

## 2. Configuration split

| Scope | What | Stored in |
|---|---|---|
| **Server (global)** | LLM chain (custom endpoint → Groq primary → Groq backup), TMDB key, MDBList key, RPDB key, TVDB key, MAL client id, AniDB client, Marquee tuning | `DATA_DIR/settings.json` (secrets sealed) |
| **Profile** | Simkl app + tokens, filters, catalogs, engine choice per lane, auto-scrobble source, personal MDBList/MAL/AniDB keys, install token | `DATA_DIR/profiles.json` (secrets sealed) |
| **Environment** | Port, data dir, public URL, proxy hops, SMTP, `SECRET_KEY` | container env |

- **Setup gating.** Profiles hard-block (no builds, no serving) until Server Config
  is complete: a TMDB key and at least one LLM provider. The portal shows a
  "finish Server Config" state rather than failing silently.
- **Key resolution for MDBList** is personal-first, then the global key.
- **Sealing at rest.** With `SECRET_KEY` set, every stored secret is AES-256-GCM
  encrypted in the two JSON files. If the file holds ciphertext and the key is
  missing or wrong, the app enters **locked mode**: it keeps serving, refuses all
  edits, and never overwrites the ciphertext. The profile install token is left
  plaintext on purpose (it is a capability URL already present in install links).
- **Live status, not stored state.** Simkl "connected" is only shown after a real
  authenticated call; a stored token alone is "token stored".

## 3. Lanes and engines

Titles are built per **lane**: `movie`, `series`, `anime` (`src/lanes.js`). Stremio only
knows `movie|series`, so anime rows are served as series items inside a catalog of
type `anime`. Each lane has an engine; engines are *candidate producers* behind one
contract (`src/engines/types.js`) — given a profile they return normalised
candidates, and the shared pipeline does everything else.

| Lane | Engine | Default | Notes |
|---|---|---|---|
| movie | **Marquee Cinema** (`marquee`) | on, mandatory | [spec](engine-marquee/00-design-spec.md) |
| series | **Marquee TV** (`marquee-tv`) | on, mandatory | [spec](engine-marquee-tv/00-design-spec.md) |
| anime | **Marquee Anime** | **off**, opt-in per profile | personalised + trending; own age chain |

Genesis (TMDB-affinity) and Glass (Simkl-trending) were retired; their shared
modules now live in `src/engines/shared/` and Marquee runs on them. A new engine
plugs in via `src/engines/index.js`; `test/fixtures/fake-engine.js` and
`test/engines-marquee-only.js` show the conformance expectations.

The **pool** (`recommended` table) is the single output contract. Everything
downstream — serve filters, calibration, decay, impressions, age gate, Stremio
metas, Companion DTOs — is engine-agnostic.

### Build path (background)

1. **Trigger** — hourly tick, a settings/engine change, or a manual Build.
   `aiSchedule` decides if a heavy build is due: *daily* if the local watch history
   changed (SHA-256 fingerprint), *weekly* forced on Sunday, on Sydney calendar time.
2. **Queue** — `jobs.js` runs heavy work **one job at a time**, FIFO, deduplicated per
   `(profile, kind)`; settings changes queue *after* a running build so they are never
   dropped.
3. **Engine** produces candidates (Simkl history + ratings + trending, TMDB, MDBList,
   local LLM taste brief and fit scoring).
4. **Pipeline** — subtract watched + "not interested", resolve ids/posters/genres,
   enrich IMDb ratings, purge below the vote-count floor.
5. **Staged promotion** — generate and age-gate in memory, apply the acceptance gate,
   then promote atomically. A failed build never mutates the live pool, and
   `built_at` is stamped only after the gate succeeds.

### Serve path (request time)

`catalogServe.js` is the one function behind the addon route, the portal preview and
the Companion preview ("preview == serve" by construction). It applies the
serve-time filters (rating floor, excluded genres, movie recency, list size) and a
cheap age-band re-check, then **calibrated serving** (`serveCalibration.js`): the
served genre mix is matched to the person's own taste mix via a KL-regularised greedy
pick over a quality window, so a liked genre with no strong candidate is under-filled
rather than padded. Measured: ~0.5 ms server-side per catalog request.

## 4. Safety gates

All gates are **remove-only** (they can veto, never rescue) and **fail-closed** for
age-limited profiles (if a gate cannot run, serve nothing rather than unvetted rows).
Unrestricted (adult) profiles never reach the age-gate LLM from search.

### Age gate (`src/ageVerification/`)
Tiers: **10+, 12+, 14+ (TV-14), 15+**; titles are judged against the profile's tier.
Decision chain, first answer wins, each step batched over still-undecided titles:
hard floor → Common Sense → AU rating → US rating → Simkl / MDBList / GB·IE·NZ·CA /
TVDB → **LLM last**. An LLM-omitted title is re-asked once, then dropped (never
cached as a pass). The anime lane has its own chain (MAL band, Kitsu, AniDB, with the
LLM as last resort). A permanent adult-content (Rx / Hentai / Erotica) blacklist
applies to every profile, adults included, on every surface. Age-limited profiles
only serve rows something positively vetted (`age_vetted_at`).

Applies to: AI lists, every extra catalog, and **search** (Stremio and the Companion
share `src/searchGate.js`). `meta` is deliberately ungated — every discovery surface
is already gated, and gating there would put an LLM call in front of every title open.

Parental controls: on age-limited profiles `min_rating`, `min_year`, `excluded_genres`
and `engine_anime` are admin-managed and read-only on the phone.

### Filter Gate (`src/filterGate/`)
Applies the profile's rating floor, year, vote floor and excluded genres to the
curated MDBList catalogs, before the age gate. See [filter-gate.md](filter-gate.md).

## 5. Data stores

SQLite (`DATA_DIR/store.db`, WAL) holds the relational state: `watched`,
`recommended` (pool), `dont_recommend`, `rec_state`, `ai_schedule`, `serve_targets`,
`age_verdicts`, `filter_verdicts`, the taste-trainer tables (`taste_ratings`,
`taste_ignore`, `taste_changes`, …), anime tables (`anidb_*`, `lane_*`, `anime_*`),
scrobble bookkeeping, `watched_repairs`, and the Companion's `mobile_otp` /
`mobile_session`. JSON files hold profiles, settings and the cache directory.
Writes are atomic (temp file + rename).

## 6. Sign-in and sessions

One shared passwordless **email-OTP** sign-in for the Companion and the admin portal.
A 6-digit code is single-use, hashed at rest (HMAC-SHA256 keyed by `SECRET_KEY` when set, plain SHA-256 otherwise), valid **60 minutes**, with
**5 wrong tries**; **5 requests per email per hour**. The session cookie `air_sid`
lasts a fixed 30 days (not extended by activity). Admin routes (`/api`, `/configure`)
additionally require `is_admin`. Email ↔ profile is strictly 1:1; an email matching 0
or 2+ profiles is refused. First run requires a one-time **setup token** printed in
the container log, so an exposed empty instance cannot be claimed by whoever types an
email first. See [mobile/README.md](../mobile/README.md).

Transport hardening: trust-proxy is a configurable hop count (default 1 for a
Cloudflare Tunnel), CORS only on `/addon`, `nosniff` / `X-Frame-Options` /
`Referrer-Policy` headers, install tokens redacted from request logs, container runs
as the unprivileged `node` user.

## 7. External services and rate rules

Every outbound call goes through `src/services/governor.js`, which **spaces** calls
under each provider's limit before the provider throttles, and honours `Retry-After`
on a 429. It is a pacer, not a retry layer. Stats at `GET /api/governor`.

| Service | Governor pace | Notes |
|---|---|---|
| TMDB | ~40/s | metadata, recommendations, search, release dates |
| Simkl GET | ~8/s | cap 10/s |
| Simkl POST | <1/s | **hard 1 POST/s write cap** |
| Simkl CDN | 1/s | public trending file, separate lane |
| MDBList | ~4/s + daily counter | free tier ~1000/day; circuit breaker |
| TVDB | 5/s | country certifications |
| MAL / Kitsu / AniList / Tenrai | ~1/s – 30/min | anime ratings, with breakers |
| Groq | ~28/min | LLM chain order: custom → Groq primary → Groq backup |

**Simkl compliance (mandatory — Simkl suspends non-compliant client IDs without
appeal).** Every request carries `client_id`, `app-name` and `app-version` query
parameters and a descriptive `User-Agent`. Never call a sync endpoint without checking
`/sync/activities` first; initial sync pulls shows/movies/anime sequentially without
`date_from`; steady state pulls deltas with `date_from` set to the saved timestamp;
no unconditional background polling beyond the activities-gated tick. Bulk writes
(history pushes, batches of ≤50) stay ≥1 s apart and skip anything already in Simkl.

## 8. Testing

`npm test` runs the smoke, integration and mobile suites; the anime, filter-gate,
Simkl-lifecycle, shared-login, hardening and MDBList-key suites live in `test/` and
are chained in `package.json`. Everything is offline and deterministic (injected
network and time). `test/verify-*-live.js` are manual live-API gates; they need real
keys and are never run in CI. `scripts/bench-engines.js` is the offline backtest
harness.

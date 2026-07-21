# Stremio/Nuvio AI Recommender — Design Notes

**Status:** Design phase — no build yet. Last updated 2026-07-03.

## Goal

Self-hosted Stremio/Nuvio catalog addon on Unraid (Docker) generating personalized
movie/series recommendations per family profile, using watch history + Gemini.

## Reference implementation

`reference/` contains a snapshot of https://github.com/rocsx/stremiorecomendacion
(commit b89bf47, 2026-03-15). Treat as reference, not fork base.

- **License:** No LICENSE file; README says MIT, package.json says ISC. Fine for
  private use; ambiguous if ever published.
- **Structure:** Single Express app (`server.js`), not per-route serverless functions.
  Already runs standalone via `node server.js` — Dockerizing is near-zero effort.
- **Reuse verbatim (~250 lines):**
  - `services/gemini.js`: prompt (strict-JSON contract, ≥7.0 rating, last-5-years,
    quality-over-popularity, genre injection) + 429 model fallback chain
    (2.5-flash → 2.5-flash-lite → 2.0-flash-lite → flash-lite-latest → pro-latest).
    Parameterize the hardcoded rating/recency filters per profile.
  - `services/tmdb.js`: search-with-year → retry-without-year → `external_ids` for
    `tt...` IMDb ID → drop if absent; failures cached as `false`.
  - Stremio response cache hints: `cacheMaxAge: 72h` / `staleRevalidate: 24h` on
    success, 5 min on the error card. Error-card meta on total failure (nice UX).
- **Discard:** `stremioAddonsConfig` signature, BYO-keys config page + validation
  endpoints, in-memory Map caches, `skip>0 → empty metas` non-pagination.
- **Known flaws it has (we fix):** movie deny-list built from only last 15 days of
  history (shows use full watched list); exclusion done only inside the Gemini prompt
  (first 50 titles, fuzzy text) — never as post-resolution ID dedupe; taste seed is
  last 15 days capped at 5 titles; no OAuth — uses public
  `/users/{username}/history|watched` with client ID + username only.

## Architecture: stale-while-revalidate, disk-backed

- Serve cached recommendations instantly on every request.
- If cache older than staleness threshold (**24 h, decided 2026-07-03**) → background rebuild
  (Trakt/Plex fetch → Gemini → TMDB resolve) updates cache when done.
- **Disk-backed** cache (SQLite or JSON on mounted volume) — survives container restarts.
- **Staleness-gated:** rebuild only when `generated_at` past threshold; per-profile
  lock so overlapping opens serve stale, never trigger a second job.
- **Failure keeps old cache:** rebuild writes to staging, atomic swap only on full
  success (Gemini responded AND ≥N titles TMDB-resolved — a 2-item "success" must not
  clobber a good 20-item list). On failure, `generated_at` unchanged; record
  `last_attempt_at` with backoff window (~30 min) so opens during an outage serve
  stale silently instead of hammering APIs.
- Per-profile cache keys: list, `generated_at`, rebuild lock all independent.

## Config

- **All keys per profile (decided 2026-07-03):** Trakt client ID + tokens, TMDB key,
  Gemini key — each profile carries its own full set. No global keys.
- Per-profile also: filter settings (see Configure portal), profile token for
  install URL.
- All server-side (env vars/config file) — no BYO-keys-in-URL.
- Side benefit: all rate limits (Trakt, Gemini free tier, TMDB) are isolated per
  profile — one heavy user can't starve the others.
- ~3 profiles to start; design is count-agnostic (profiles are config entries).
- One Trakt API app per profile, registered under each member's own Trakt account.

## Data source: Trakt only (decided 2026-07-03)

Plex and Netflix dropped as sources. One Trakt account = one profile.

- `/sync/history/*` for taste signal; `/sync/watched/movies` +
  `/sync/watched/shows` for exclusion (any watched history excludes a show, even
  partial). Don't derive exclusion from the history event log.
- **Auth: OAuth device flow (decided 2026-07-03).** One-time PIN authorization per
  profile; works with private profiles; unlocks `/sync/*` endpoints. Each profile
  stores its own client ID + tokens; refresh-token handling needed (Trakt access
  tokens expire ~3 months).

## Generation pipeline

1. Build per-profile taste prompt from history → Gemini → suggested titles.
2. Gemini output = suggestions, not ground truth: resolve every title against TMDB
   for canonical ID + IMDb `tt...` ID (Cinemeta needs it). Drop non-resolving.
3. Dedupe against exclusion list **after** resolving to canonical IDs — never
   fuzzy-match Gemini's raw title text.
4. Filters (min rating, recency window, genre excludes) applied per profile —
   enforced three ways: soft in the Gemini prompt, via `without_genres` /
   `vote_average.gte` / date window on the TMDB discover path, and as a hard
   post-resolution filter on resolved TMDB `genre_ids` + rating + release date
   (the guarantee, same principle as the watch-history dedupe).

### Empty/thin-history fallback (cold start)

If profile history has fewer than ~3 titles: **skip Gemini entirely**, use TMDB
`/discover/movie` + `/discover/tv` with `vote_average >= 7`, `vote_count >= X`
(avoids obscure high-rated titles), release-date window, genre filters — driven by
the same per-profile defaults as the Gemini path. Results carry TMDB IDs, so only
the `external_ids` lookup remains. Deterministic, no quota risk. Same cache shape,
so the addon endpoint doesn't care which path produced the list. Optional: tag
catalog name "Popular picks" vs. "Picked for you". Next scheduled rebuild after
history exists upgrades to personalized automatically.

## Addon endpoint

- Thin: reads pre-computed cached list per profile only. Never calls
  Trakt/Gemini/TMDB in the request path.
- Multi-profile via per-profile install URLs:
  `https://yourdomain/addon/<profileToken>/manifest.json` (Stremio has no native
  user concept).
- **Two catalogs (decided 2026-07-03):** "Movies recommended for you" and
  "Series recommended for you".

## Configure portal (decided 2026-07-03)

Web page (behind Cloudflare Access) for per-profile settings, editable anytime.
Changes take effect on next rebuild (or offer a "rebuild now" button per profile).

Per-profile controls:

- **Minimum rating** — selectable (e.g. 0–9 in 0.5 steps). Default **7.0**.
- **Recency window** — selectable in years (e.g. 1/2/5/10/20/no limit). Default
  **5 years**.
- **Genre exclude list** — multi-select checkboxes over the TMDB official genre
  vocabulary (used because all titles resolve against TMDB, making exclusion
  enforceable on real `genre_ids`, not just prompt text). Default: **none excluded**.
  - Movie genres: Action, Adventure, Animation, Comedy, Crime, Documentary, Drama,
    Family, Fantasy, History, Horror, Music, Mystery, Romance, Science Fiction,
    TV Movie, Thriller, War, Western.
  - TV genres: Action & Adventure, Animation, Comedy, Crime, Documentary, Drama,
    Family, Kids, Mystery, News, Reality, Sci-Fi & Fantasy, Soap, Talk,
    War & Politics, Western.
  - UI can present a merged de-duplicated list and map to the per-type TMDB genre
    IDs internally.

Portal is also the natural home for profile onboarding (Trakt device-flow PIN
authorization, key entry) and install-URL display/QR per profile.

## Infra

- Docker on Unraid, exposed via Cloudflare Tunnel (no open ports, free TLS).
- Optional Cloudflare Access on the config page only — NOT the addon endpoints
  (Stremio must hit them without a login prompt).

## Open decisions

None — design is build-ready.

## v4.0.0-beta — Trakt-powered engine (branch `v3-phase1` ONLY)

Supersedes the v3 pool+LLM-ranking engine below (decided 2026-07-22: the LLM
ranking never reached "enjoyable"). New doctrine: **Trakt recommends, code
filters, LLM guards.**

- Lists come from Trakt `/recommendations` (limit 100, extended=full,
  ignore_watchlisted; watched excluded at source). The API takes no filter
  params — the site URL's filter bar is a VIP/site feature — so ALL profile
  filters run locally on the returned objects: Trakt 0-10 rating floor
  (default 6.0 = the site's 60%), statuses (movies must be released; canceled/
  planned/in-production shows dropped; ended kept), vote floor (Trakt votes,
  series 1/5), optional recency, genre exclusions on Trakt slugs (native
  `anime` tag + ja fallback for the Anime filter).
- Cross-type watched verification, CSM kids gate, bench + promote-on-watch,
  Watch Later, extras, scrobble, encryption all unchanged.
- The LLM's only job: a remove-only kids age goalkeeper (ACB standards,
  structured verdicts by id, missing verdict keeps the title, total failure
  keeps the previous list). Groq key required ONLY when age_limit > 0.
- Search catalogs (v4.1, decided 2026-07-22): live TMDB search via
  search-only catalogs (extraRequired). Age-limited profiles get the same
  two-layer protection as their lists (CSM + AI goalkeeper), FAIL-CLOSED —
  gate failure returns zero results, never unfiltered ones. Adult profiles
  ungated. The only request-path external calls in the addon.
- Retired: TMDB discover/similar pool builder, taste-profile prompts,
  genre-weighted trim, distribution guard, cold-start discover path (thin
  history simply yields thin/popular recs — moot if nobody is watching),
  'tmdb' rating source. One-time migration relaxes recency to all-years.

## v3.0.0-beta — inverted pipeline (SUPERSEDED by v4 above)

Everything in this section applies to the beta branch, not the stable v2 line.
Authoritative plan + locked decisions: `docs/phase1-plan.md`.

- **Architecture inverted:** code builds a deterministic candidate pool (TMDB
  discover + `/recommendations`/`/similar` seeded from history, hard-filtered
  server-side, exclusion-subtracted by ID); the LLM's only job is ONE ranking
  call over ~120 pre-approved candidates, returning scored IDs. This replaces
  the v2 generate-then-filter loop (which lost ~70% of suggestions post-filter
  and burned retry rounds).
- **Groq key is a hard requirement** (decided 2026-07-13): no key → the AI
  catalogs do not run at all (cold start included) — the profile is
  effectively disabled until a key is added. Surfaced in the portal badge,
  rebuild results, and the in-app setup card.
- **Rating source: IMDb by default** (MDBList batch), per-profile
  configurable; vote-count floor default 1000 (series use 1/5 — TMDB TV vote
  counts run far lower).
- **Bench:** each list stores an equal-sized hidden reserve; watched items are
  pruned and backfilled from the bench with no LLM call.
- **Ranking model:** `llama-3.3-70b-versatile` primary — `gpt-oss-120b`
  empirically fails this payload on the free tier (empty/400/413); fallback
  only.
- **Kids-mode CSM gate, extra catalogs, auto-scrobble, RPDB, encryption:**
  unchanged from v2.
- Release discipline: tagged `beta v3.0.0`, published without moving
  `:latest` (stable stays v2.6.x).

## Implementation deviations (post-build, 2026-07)

Where the built app deliberately differs from this design:

- **LLM provider is Groq, not Gemini** (2026-07). Switched to Groq's free-tier
  OpenAI-compatible Chat Completions API (`services/groq.js`), primary model
  `openai/gpt-oss-120b` (quality-first) with a fallback chain (override via
  `GROQ_MODELS`).
  The per-profile `gemini_api_key` field migrated to `groq_api_key` (the old
  key is dropped — useless for Groq); the internal catalog source label
  `'gemini'` became `'llm'`. Taste seed raised from 10 to 20 recent titles.
- **Taste seed comes from `/sync/watched/*` (sorted by `last_watched_at`), not
  `/sync/history/*`.** A fixed-size history window counts *plays*, so a binge
  watcher's last 100 plays can collapse to 2–3 unique shows and misclassify a
  heavy account as cold-start. The watched list gives the same recency signal
  with no window, and it's already fetched for exclusion — 2 fewer Trakt calls.
- **Client cache hints are 1 h / 12 h SWR, not 72 h / 24 h** — so serve-time
  watched pruning and rebuilt lists reach clients quickly.
- **Additions beyond this design** (see README): kids mode (strict Common
  Sense age gate via MDBList), RPDB rating posters, per-profile list size,
  rolling avoid-list for daily variety, hourly watched-set pruning with
  `last_activities` change detection, admin login rate limiting, a per-profile
  Diagnose tool, and `GROQ_MODELS` override.
- **Not built:** QR code for install URLs (Copy URL + `stremio://` deep link
  cover the need); caching of failed TMDB resolutions.
- **Title logos on metas** (shipped 2026-07): `toMeta` carries a TMDB logo,
  fetched via `append_to_response=external_ids,images` folded into the existing
  ID lookup (no extra requests), for the logo-over-art look in Stremio/Nuvio.

## Decided

- Trakt-only data source (no Plex/Netflix). One Trakt account = one profile.
- Trakt auth: OAuth device flow per profile (needs refresh-token handling).
- One Trakt API app per profile, registered under each member's own Trakt account —
  fully independent client IDs, tokens, and rate limits (decided 2026-07-03).
- Recommendation lists always de-duped against full watch history on canonical IDs
  post-TMDB-resolution (reaffirmed 2026-07-03).
- All API keys per profile (Trakt, TMDB, Gemini) — no globals.
- Staleness threshold: 24 h.
- Rebuild failure never purges cache; atomic swap on success only.
- Cold start (<~3 history titles): TMDB discover path, no Gemini.
- Two catalogs: "Movies recommended for you" / "Series recommended for you".
- ~3 profiles initially; count-agnostic design.
- Per-profile filters editable in configure portal: min rating (default 7.0),
  recency window (default 5 years), TMDB-genre exclude list (default none).

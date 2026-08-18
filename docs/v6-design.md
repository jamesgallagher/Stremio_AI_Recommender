# v6 — Final Design (consolidated)

**Status:** Design complete. Ready to build on approval.
Consolidates `v6-plan.md` (Simkl research + API rules), `v6-features.md`
(engine, catalogs, AniList), and `v6-ui.md` (config + UI). Those keep the
reasoning/investigation; this is the settled spec.

---

## 1. What v6 is

Trakt is removed. **Simkl** becomes the watch-tracking backbone, **TMDB
`/recommendations`** becomes the recommendation engine, the **LLM is demoted to
an age-gate safeguard**, and config splits into **global infrastructure** vs
**per-profile identity**. The v5.2 age/NSFW/anime stack and the metadata service
carry forward unchanged.

**The philosophical pivot:** v5 had the LLM *generate* recommendations; v6 has
TMDB generate them and the LLM only *judge age*. This kills hallucination and
the knowledge-cutoff problem, and makes a small **local** LLM viable — because
judging is a small-model task, generating was not.

---

## 2. Config model

| Global (Server Config) | Per-profile |
|---|---|
| Custom LLM (name/URI/key) | Simkl (client id/secret + PIN token) |
| Groq primary + Groq backup | Filters |
| TMDB · MDBList · RPDB (single each) | Catalogs |

- **LLM chain:** Custom → Groq primary → Groq backup.
- **Migration:** global keys seed from the **"James"** profile (oldest); per-
  profile copies dropped.
- **Setup gating (hard):** profiles do nothing until Server Config is complete
  and valid.
- **Key pools:** only Groq has two keys; everything else single.
- **Rate governor:** one module all outbound calls route through, seeded with
  each service's real limits — token-bucket pacing, `Retry-After` backoff, Groq
  key rotation on exhaustion. Limits: Groq ~30 RPM + TPM/daily · Simkl 10 GET/s
  & **1 POST/s** · TMDB ~50/s · MDBList ~1000/day · Jikan 3/s & 60/min · AniList
  30/min.

---

## 3. Simkl backbone

- **One app per user** (per-profile client id/secret) + **PIN device flow** for
  the token.
- **Live connection status** — verified by a real authed call on tab open,
  **never** from stored state. (Fixes the v5 bug where dead Trakt apps still
  showed "connected".)
- **History read:** `GET /sync/all-items/{type}/{status}` with `date_from`;
  gate every read behind `/sync/activities` (skip if unchanged).
- **Scrobble:** read Nuvio often (unrestricted), **`POST /sync/history` to Simkl
  only on a real new-watch delta** — avoids the 1 POST/s + no-unconditional-
  polling rules by construction.
- **Watchlist:** `plantowatch` → the "Watch Later" catalog.
- **Compliance is mandatory** — Simkl suspends a client_id for polling without
  `date_from` or activities-gating. Seeding uses Simkl's **native Trakt import**.

---

## 4. Local data (SQLite)

Two tables, per profile; secrets stay in the encrypted JSON store.

- **watched** — `{ tmdb_id, imdb_id, title, primary_genre, age_classification,
  release_year, watched_at }`. Sourced from Simkl `completed`, refreshed
  hourly-ish, **upsert not duplicate**. Age classification computed at ingest
  (front-loaded so nothing re-fetches it).
- **recommended** — the weekly-built candidate table (below).

---

## 5. Recommendation engine (weekly rebuild)

1. For **every** watched title → TMDB `/{type}/{id}/recommendations`.
2. **Rank by `rec_count`** (how many of the user's watched titles recommended
   this candidate — the personal signal) with popularity as tiebreaker; cap
   per-franchise so a binge doesn't dominate.
3. **Filters:** drop if already watched · drop excluded genres · **rating floor
   (default 6, HARD)** applies here (personalized list only).
4. **Age stack** (age-limited profiles): certification/MAL band → **LLM ACB
   second pass**; store the resulting **age classification** as the trusted
   final gate.
5. Write survivors to the **recommended** table with everything the playlist
   needs (ids, title, top genre, popularity, rec_count, year, poster, age).

**Playlist assembly (serve):** take `list_size`, select **genre-balanced**
(equal per available genre), age filter applied. **Never force to quota** — if a
genre is thin, backfill from deeper genres; if still short, **show fewer**, no
padding. "Release date" = optional recency window (`max_age_years`).

---

## 6. Age & NSFW model (carried from v5.2, refined)

- **Anime:** id → MAL rating via Jikan (cached); judged at `age_limit + 1`.
- **Non-anime:** TMDB certification → LLM.
- **LLM ACB second pass always runs** on survivors — remove-only, fail-closed.
- **Porn/hentai blanket ban, ALL profiles incl. adults:** TMDB `adult:true`,
  MAL `rx`, hentai/erotica genre, AniList `isAdult`. Triggered by *porn signals*.
- **A high age certification is an AGE signal, not a PORN signal** — mainstream
  R / NC-17 / MA15+ (Basic Instinct) is allowed for adults, age-gated for
  minors. Not blacklisted.
- **Meta endpoint** runs the porn blacklist (cache-only lookup) but is otherwise
  age-ungated.

---

## 7. Catalogs

Two always-on AI catalogs (Movies/Shows recommended for you) + the extras below.
**All sorted `imdbpopular`.**

| Catalog | Type | Source | Age-gated | De-dupe watched |
|---|---|---|---|---|
| Popular Movies | movie | mdblist `official/movies/popular` † | — | yes |
| Popular Shows | series | mdblist `official/shows/popular` † | — | yes |
| Christmas Movies | movie | mdblist `hdlists/christmas-movies` | — | **NO (exception)** |
| Comedy Movies | movie | mdblist `hdlists/comedy-movies-2001-2020` | — | yes |
| Action Movies | movie | mdblist `hdlists/latest-hd-action-movies-from-1980-to-today` | — | yes |
| Rom-Com Movies | movie | mdblist `abbacarter/rom-com` | — | yes |
| War Movies | movie | mdblist `garycrawfordgc/war` | — | yes |
| Horror Movies | movie | mdblist `hdlists/latest-hd-horror-movies-top-rated-from-1980-to-today` | — | yes |
| Trending Kids Movies | movie | mdblist `tvgeniekodi/trending-kids-movies` | **band 12** | yes |
| Trending Kids Shows | series | mdblist `tvgeniekodi/trending-kids-tv-shows` | **band 12** | yes |
| Anime TV-14 | series | **AniList** (POPULARITY_DESC → MAL band 14) | **band 14** | yes |
| Watch Later | both | **Simkl `plantowatch`** (hide when empty) | — | n/a |

**Rules:** curated lists served **as the curator ordered — no rating floor**
(curation is the quality). **De-dupe against the local watched table on all
except Christmas** (seasonal re-watchables — explicit exception). Kids catalogs
gated once at band 12 and cached, `min(12, profile limit)`. All curated ship
**opt-in**; Watch Later on when Simkl is connected.

† the two `official/…/popular` URLs are a different shape — verify the items API
call against the MDBList key at build.

---

## 8. UI

```
[ Profile ▼ ]  [ + Add profile ]        [ Server Config / Setup new server ]
```

- **Server Config:** LLM (Custom + Groq×2, Test) · API keys (TMDB/MDBList/RPDB,
  test-before-save, masked with eye toggle).
- **Profile — 5 tabs:** Simkl (creds + Connect + live status) · Filters ·
  Catalogs · Install (manifest) · **Advanced** (diagnostics · rebuild · delete ·
  view Recommended Movies/Shows).
- Tabs replace the show/hide accordions.
- **Custom LLM Test** runs OpenAI-shape check **and** our real JSON tasks
  (generation + age-gate parse) — proves usable, not merely reachable.

---

## 9. What changes

**Dies:** Trakt entirely (client, device flow, engine, `engine` setting, lists,
watchlist) · most LLM *generation* code (`generateCandidates`, cross-type
seeding).
**Kept:** MDBList · the v5.2 MAL/NSFW age stack · metadata service · Cinemeta
episode numbering · caching · encryption-at-rest · the `reasoning_effort` fix.

---

## 10. Build order

1. **Server Config** + global settings store + Custom-LLM/Groq chain + live Test.
2. **Simkl** client + PIN + per-profile config; **rip out Trakt**.
3. **SQLite watched** table + Simkl refresh (activities-gated) + Nuvio→Simkl
   delta scrobble.
4. **Recommendation builder** (TMDB recs → rec_count → filters → age stack →
   table).
5. **Genre-balanced playlist** assembly.
6. **Catalogs** re-source (MDBList registry + AniList anime + Simkl plantowatch)
   + de-dupe rule.
7. **Rate governor** across all services.
8. **UI** redesign (profile selector, tabs, Advanced + "Don't recommend"
   button).
9. **Mobile Companion** (later v6 stage) — token-authed mobile web page: manage
   recommendations (shared suppress endpoint) + Simkl search → add to Watch
   Later. Depends on 4–7, so it follows them.
10. Retire dead generation code; docs; **major version bump**.

**Suppress endpoint, one home, three entry points:** the in-app meta link, the
Advanced-tab button, and the Mobile Companion all `POST` the same
`…/suppress/<token>/<id>` → `dont_recommend`. Build it once.

---

## 11. Deferred (build-time calls, non-blocking)

- Stremio scrobble provider retained, or Nuvio-only?
- LLM generation kept as a thin genre gap-filler, or fully retired?
- F3 watched-refresh cadence tuning.
- `official/…/popular` items-API shape (verify at build).

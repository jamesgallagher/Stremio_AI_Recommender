# v6 Feature Specification — Simkl backbone + TMDB-recommends engine

**Status:** DESIGN ONLY, no code. Companion to `docs/v6-plan.md` (which holds
the Simkl API research, the API-compliance rules §6b, and the MediaVoyager
findings). This doc turns James's feature list into a spec with analysis and
open decisions.

---

## The one big idea to name out loud

Feature 5 is not a tweak — it **replaces the recommendation philosophy**, and
the change should be a conscious choice, not a side effect.

- **v5 (today):** the LLM *generates* candidate titles from history, then the
  LLM *age-gates* them.
- **v6 (proposed):** **TMDB's per-title `/recommendations` generates the
  candidates**; the LLM is demoted to the *age-gate second pass only*.

This is a genuinely good pivot given everything we now face, and it fixes real
scars:

- **Kills the knowledge-cutoff problem.** The LLM vetoed 2026 premieres it had
  never heard of (Ciara's Anime TV-14). TMDB always has current titles.
- **Kills hallucination.** Every candidate is a real TMDB row, not a model
  guess that then has to be resolved and often fails.
- **Makes a small LOCAL LLM viable.** If the LLM only age-gates (a judgement
  task) instead of generating (a deep-knowledge task), a 9B like Qwen3.5 can do
  the job — generation was the part that needed a big model's world knowledge.
  This directly enables the local-LLM direction discussed separately.
- **Cheap, deterministic, cacheable.** Heavy work runs weekly; serving is a DB
  read.

**The honest trade:** TMDB `/recommendations` is *collaborative* ("people who
watched X also watched Y"), not holistic taste-reasoning. Results will feel
more mainstream and less surprising than an LLM synthesising your whole
profile. James has already accepted "won't be super fresh, that's OK" — this is
the same trade, and it's the right one under the constraints.

**Note the arc:** this effectively **rebuilds the collaborative-filtering
engine we removed with Trakt in v5 — but sourced from TMDB instead**, which is
free and Trakt-independent. We came full circle, for good reasons.

---

## Feature-by-feature

### F1 — Simkl replaces Trakt entirely
Remove Trakt from config, code, and the list creator. Add a Simkl integration
(Client ID + Secret, Test button, then Save).

**Refinement — it's a TWO-step connect, like Trakt was.** Client ID + Secret
authenticate the *app*; reading a user's watchlist needs that user's
*access token* via Simkl's **PIN device flow** (verified live: `GET /oauth/pin`
→ user enters code at simkl.com/pin → poll for token). So:
- "Test" validates the app credentials (a cheap client-id call).
- A separate **"Connect Simkl account"** step runs the PIN flow per profile and
  stores the token — exactly the shape our Trakt device-flow code already has.

**DECIDED — one Simkl app PER USER.** Each profile registers its own Simkl API
app (own Client ID + Secret) and connects its own account, because every family
member has their own Simkl lists. This is structurally identical to the
per-profile Trakt model we already have, so the migration maps 1:1 — the
config UI, the secret storage, and the per-profile credential fields all carry
over, just re-pointed at Simkl.

### F2 — Auto-scrobble Nuvio/Stremio → Simkl
Config section: provider (Nuvio/Stremio) + username/password; scrobble hourly,
add new items.

**This is mostly a rewiring, not new work.** `scrobble.js` already *reads*
Nuvio/Stremio watched state (`pullProviderWatched`); today it writes the delta
to Trakt. v6 points that write at Simkl **`POST /sync/history`** instead. Nuvio
is the primary/tested provider. *(Open: is the Stremio provider retained as an
option, or Nuvio-only? Confirm before build.)*

**DECIDED — read Nuvio often, write to Simkl only on a real delta.** This is the
key to staying inside Simkl's limits, and it's the right shape:
- **Reading Nuvio is unrestricted** (it's the user's own account, no Simkl rule
  applies), so we can check for new watches frequently and cheaply.
- **We only `POST /sync/history` to Simkl when Nuvio shows a NEW watch** not
  already in our local watched table. No new history → zero Simkl writes → the
  1 POST/sec limit and the no-unconditional-polling rule are avoided *by
  construction*, not by throttling.
- Pace the writes ≥1s apart when a batch of new watches does appear.

This is cleaner than the generic "activities-gated hourly" I sketched earlier:
the local watched table (F3) is the diff source, so the push is inherently
demand-driven.

### F3 — Local SQLite watched table
Per user: title, title ID, primary genre, age classification, release year,
date watched. Hourly refresh, **upsert not duplicate**.

**SQLite is the right call here** — F3/F5/F6 are relational query workloads
(exclude-if-watched, group-by-genre, rank-by-popularity) that the current
disk-JSON store handles awkwardly. This is a justified new dependency.

**Refinements:**
- **Store BOTH ids.** Keep the **TMDB id** (F5 needs it for `/recommendations`)
  *and* the **IMDb `tt` id** (Stremio/our meta service need it). Simkl hands us
  both natively, so this is free at ingest.
- **Source of truth = Simkl** (`/sync/all-items/.../completed` with
  `date_from`, delta-only), not the scrobble reader. The scrobble (F2) feeds
  Simkl; Simkl feeds this table. One direction, no double-counting.
- **Age classification at ingest** = our v5.2 stack (TMDB certification for
  non-anime, MAL rating for anime) — plus **MDBList's Common Sense rating as an
  extra signal** now that MDBList stays (see F7–F9 decision). Front-loading it
  here means F5/F6 never re-fetch it.
- Coexist with the encrypted JSON store for secrets/profiles — don't migrate
  those into SQLite (they need AES-at-rest, not relational queries).
- **Polling cadence:** James to revisit before build. The delta-push logic (F2)
  is the constraint that matters; the exact read frequency is tuning.

### F5 — Weekly rebuild of the local recommendation table
For every watched title, call TMDB `/{type}/{id}/recommendations`. Apply a
rating threshold (filters tab, default 6); drop below it; rank remainder by
popularity desc. Store Title, ID, top genre. Then filter: drop if already
watched; drop if in an excluded genre; if an age limit is set, run age
verification + an LLM ACB second pass. Keep the age rating stored as the final
gate for F6.

**This is the heart of v6.** Analysis and refinements:

- **The pipeline is clean because Simkl gives us TMDB ids** in the watched
  table (F3). So: watched TMDB id → TMDB recommendations → candidate pool.
- **Dedup, and rank on recency-weighted AFFINITY (the key personal signal).**
  200 watched × ~20 recs = ~4,000 raw candidates with heavy overlap. As we
  aggregate, each candidate's score is the **sum of its recommenders' recency
  weights** (`affinity`, below) — a recommendation from something watched today
  counts far more than one from two years ago. Rank by `affinity` desc,
  popularity tiebreaker. Free — a weighted tally over calls we already make —
  and it's what makes the list track *this* user's current taste rather than a
  generic popularity chart. (Full explanation + the recency formula below.)
  - **Franchise cap.** A prolific franchise can inflate `rec_count` (5 watched
    Marvel films → every Marvel title scores 5). Cap the contribution per
    franchise/collection, or lean on F6's genre balance to dilute it.
- **The LLM age-gate at build time is the main cost** — hundreds of survivors
  per rebuild. Mitigations already exist: MAL/cert data resolves most anime and
  many films *without* the LLM (v5.2), so the LLM only judges the residue.
  Batch it. It's weekly and cached, so cost is acceptable.
- **NSFW blacklist — CORRECTED scope (important).** The blanket, all-profiles
  ban is for **pornography and hentai ONLY** — and it is triggered by explicit
  *porn* signals, **never by a high age rating**:
  - **Blanket-banned everywhere, adults included:** TMDB `adult:true`, MAL `rx`
    (hentai), Kitsu hentai/`R18`(=explicit), AniList `isAdult:true`, and
    hentai/erotica genre tags. These assert *pornography*.
  - **NOT banned — allowed for adult profiles:** mainstream adult-rated films.
    An R / NC-17 / MA15+ / R18+ certification on a non-porn film (Basic
    Instinct, Color of Night) is **adult content, not porn.** Adults get it;
    age-limited profiles have it removed by the normal age gate.
  - The principle: **a high age certification is an AGE signal, not a PORN
    signal.** Do not conflate "18+" with "pornographic". This corrects the
    v5.2 wording, which loosely listed "R18" as a blanket-ban trigger — fine
    for Kitsu's hentai-specific R18, wrong if applied to a mainstream cert.
  - So F5's age gate is conditional on `age_limit`; the porn blacklist runs
    regardless of `age_limit`, but fires only on the explicit porn signals
    above.
- **Store enough for F6 to build the playlist without re-fetching:** id (tmdb +
  tt), title, top genre, popularity, recommend-count, release year, poster ref,
  and the **age classification** (the trusted final gate).

### F6 — Playlist assembly (genre-balanced)
From the recommended table, take the requested count (list_size) and select an
equal number from each available (non-filtered) genre, age filter applied.
20 requested, 4 genres → 5 each.

**This elegantly solves the genre-skew problem we fought** (Ciara's 6/20 anime
over-representation) *by construction*. Good.

**DECIDED — never force titles to hit the quota.** The equal-per-genre split is
a *target*, not a mandate:
- If a genre is short, **backfill from the genres that DO have depth** (show
  more of what we have), ranked by `rec_count`/popularity.
- If the total is still under quota, **the list is simply shorter.** We show
  what we have rather than padding with weak matches — consistent with the
  "quality over quantity" principle. No junk titles to hit a number.

**Still to pin down:**
- **"release date" role.** Recency *filter* or in-genre *sort*? I read it as an
  optional recency window reusing the existing `max_age_years` filter, with
  `rec_count`/popularity as the in-genre sort. Confirm.
- The "trusted age filter" claim holds **only if F5 wrote a classification for
  every row.** Rows where age couldn't be determined are marked and **excluded
  for age-limited profiles (fail-closed)**, never assumed safe.

**SHIPPED — v6.9.0-beta.** The AI catalogs (`ai-recs-movies` / `ai-recs-series`)
now serve from the recommendationStore pool instead of the Trakt rebuild — this
is where Trakt leaves the recommendation path.

- **Build vs serve split (decided 2026-08, revised from F5).** Match-STRENGTH is
  baked at build (top-5/title by TMDB relevance + a vote-count noise gate);
  USER PREFERENCES (rating floor, excluded genres, recency) now apply at SERVE
  time over a fuller stored pool. Changing a filter takes effect with **no
  rebuild and no TMDB refetch**. The pool stores `vote_average` + the full genre
  CSV (incl. the `Anime` pseudo-genre, tagged at build) for this.
- **Genre balance = round-robin** across `primary_genre` buckets, strongest
  bucket leading, rows already affinity-DESC. Naturally backfills from deep
  genres once shallow ones exhaust; **never force-fills** past what's available
  (`selectServe` → `balanceByGenre` in recommendationStore).
- **Age.** NSFW blacklist + anime band + LLM ACB stay baked at BUILD (fail-closed
  for kids — the authoritative gate). Serve adds a **cheap band re-check** using
  the stored `age_classification`, a safety net for an age limit *lowered between
  builds*. Unclassified rows are kept at serve because they were already
  LLM-vetted at build.
- **Rebuild trigger.** The pool rebuilds only when watched history moved (new
  seeds) or it's empty — `rec_state.built_at` vs `watchedStore.newestWatchedMs`
  (`ensureBuilt`). Filter changes never trigger a rebuild. Fires from the hourly
  tick (Simkl profiles) and fire-and-forget on catalog open.
- **DEFERRED cleanup:** the Trakt *code* (trakt.js, the Trakt engine in
  rebuild.js, Watch Later, scrobble→Trakt) is still present — it powers the
  MDBList extras, search age-gate helpers, and the meta blacklist. Ripping it
  out fully is its own slice (touches config/portal/UI); AI recs no longer use
  it as of this version.

### F4 — n/a (numbering skip, confirmed intentional)

### F7/F8/F9 — New catalog sources (investigation below)

---

## The recommend-count signal (F5) — worked example

**The problem it solves:** if we rank candidates only by TMDB *popularity*, we
get a generic blockbuster chart — popularity is a *global* signal, identical for
every user. It says nothing about whether a title matches *this* person.

**The signal:** F5 already calls TMDB `/recommendations` for **every** title the
user has watched. The same candidate keeps showing up across many of those
result sets. `rec_count` = how many of the user's watched titles independently
recommended that candidate.

**Worked example.** User watched *Interstellar*, *Inception*, *The Prestige*:

```
Interstellar → recommends:  Arrival, Gravity, Blade Runner 2049, The Martian …
Inception    → recommends:  Arrival, Shutter Island, The Matrix, Tenet …
The Prestige → recommends:  Arrival, The Illusionist, Memento, Shutter Island …

Tallying rec_count across all three:
  Arrival            3   ← recommended by ALL of their watches
  Shutter Island     2
  Blade Runner 2049  1
  Gravity            1
```

*Arrival* sits at the **intersection** of everything they watched — a strong,
central taste match. *Blade Runner 2049* is adjacent to only one film —
peripheral. Popularity alone might rank the biggest blockbuster first regardless
of fit; `rec_count` surfaces the title that's central to *their* library.

**Why it's the right tool here:**
- **Personal, not global.** Derived entirely from this user's own history — it's
  a lightweight collaborative-filtering score computed client-side.
- **Free.** A byproduct of API calls F5 already makes; just a tally. No extra
  requests, no LLM, no randomness — fully deterministic.
- **It's the thing that makes TMDB-recommends feel personal** rather than
  "popular movies, loosely related to you." Rank by `rec_count` desc, tiebreak
  by popularity.

### Recency weighting — CORE (added 2026-08-15)
Promoted from "optional polish" to a core part of the score. Each source title's
contribution is **weighted by how recently it was watched**, so what you're
watching *now* steers the list. We already store `watched_at` (F3), so:

```
weight(watched_title) = 0.5 ^ (days_since_watched / HALF_LIFE)      # exponential half-life
affinity(candidate)   = Σ weight(W)  for each watched title W that recommended it
rank by affinity desc, popularity tiebreaker, franchise-capped
```

`HALF_LIFE` proposed **~90 days** (tunable): watched today = 1.0, 90 days ago =
0.5, 180 = 0.25. **Worked example (James's):** watch *Pirates of the Caribbean
1* today → its weight is ~1.0, so everything it recommends (Pirates 2, 3 …) gets
a full boost *now*; Pirates 2, also recommended by 1 and 3, lands **high on the
list this week** — exactly the "I just started the series, show me the next one"
behaviour. A film watched two years ago still contributes, but faintly.

Keep the raw integer `rec_count` too, for the franchise cap and debugging — but
**`affinity` (recency-weighted) is the primary rank.**

---

## Source investigation (F7 / F8 / F9)

### What we use TODAY
| Catalog | Current source | Fate |
|---|---|---|
| Watch Later (movie/series) | **Trakt** watchlist | **dies with Trakt** |
| Anime TV-14 | **Trakt** list `snoak/trending-anime-shows` | **dies with Trakt** |
| Popular Movies / Series | MDBList `official/justwatch-streaming-charts` | works, but see below |
| Trending Kids Movies / TV | MDBList `snoak`, `tvgeniekodi` | fragile |
| Christmas / Comedy / Action / Thriller | MDBList personal lists (`jbeasley74`, `hdlists`, `garycrawfordgc`) | fragile |

**The real problem isn't just the two Trakt lists dying — it's that the other
eight depend on specific strangers' personal MDBList lists.** If `garycrawfordgc`
renames "action", our catalog breaks silently. These are not first-party
sources. v6 is the moment to fix that.

### Candidate replacements (two first-party sources)

**TMDB Discover** — `/discover/movie` & `/discover/tv`. We already hold TMDB
keys; it's free and first-party. Handles everything by construction:
- popularity sort, rating floor, vote floor, release-date windows;
- **"digitally released"** via `with_release_type=4` + `sort_by=popularity.desc`
  (F7/F8 — "popular digitally released");
- genres by id (Comedy 35, Action 28, War 10752, Horror 27);
- **rom-com** = genre combo `10749,35`;
- **Christmas** = `with_keywords` (Christmas keyword id) — a genre can't express
  this, but a keyword can. *(Not live-tested — no TMDB key to hand; TMDB
  Discover is stable and well-documented, but verify the keyword id at build.)*

**Simkl trending/genre** — LIVE-TESTED this session, client_id only, no user
auth. All 200:
- `/movies/trending/{today|week|month}`, `/tv/trending/...`, `/anime/trending/...`
- `/movies/genres/{genre}/all-types/{period}`, `/tv/genres/...`,
  `/anime/genres/...`
- Payload carries `tmdb` id + inline `ratings.imdb`/`ratings.simkl` — so we can
  rating-filter *and* enrich via our meta service directly.

### DECIDED — keep MDBList; it's a core-strength source, not a liability
James's call, and the right one: curated lists ARE MDBList's core competency,
and it returns **Common Sense ratings for free** — a useful extra age signal
(especially for mainstream, non-anime titles, where CSM coverage is actually
good; recall CSM was retired as an *anime* gate in v5, not because it's
worthless for films). So MDBList **stays**, and remains a first-class catalog
source. The "drop MDBList" idea is withdrawn.

The real fix is narrower than I framed it: only the **two Trakt-backed catalogs
must move** (Watch Later, Anime TV-14). The MDBList genre/kids catalogs can stay
as-is. Where we *want* first-party control or a specific list MDBList lacks, we
have two more options rather than a replacement:

- **TMDB Discover** — for anything needing keyword/combo control (Christmas
  keyword, rom-com genre combo) or precise "digitally released" (
  `with_release_type=4` + popularity). We already hold TMDB keys.
- **Simkl trending/genre** — live-tested, first-party, tmdb ids + ratings
  inline. Good for "hot right now".

So F7/F8/F9 become **"add TMDB Discover + Simkl as available catalog sources
alongside MDBList,"** not "replace MDBList." More sources, more resilience.

### Watch Later (Trakt watchlist) → Simkl plantowatch
Direct swap: the Trakt-watchlist-backed "Watch Later" catalog becomes the
Simkl **plantowatch** list (`/sync/all-items/.../plantowatch`). Same concept,
new backbone.

### Anime TV-14 → strong candidate found: AniList (Crunchyroll ruled out)

**Crunchyroll investigated and ruled out.** The `/videos/popular` page is a JS
SPA with **no title data in the HTML** (nothing to scrape), and its content API
sits behind **Cloudflare bot protection + an auth Bearer token**. Getting the
list means defeating Cloudflare and using an undocumented, auth-gated private
API against Crunchyroll's ToS — not something we'll build. It would also only
yield Crunchyroll's region-locked catalog.

**AniList is the better source, and it's clean — LIVE-TESTED:**
- Public GraphQL API, **no auth, no Cloudflare**, 30 req/min limit.
- `sort: TRENDING_DESC` returns exactly the "popular right now" signal
  Crunchyroll surfaces — the live result was full of currently-airing 2026
  titles (Mushoku Tensei, Grand Blue S3, …).
- Returns **`idMal` inline** → plugs straight into our v5.2 MAL age pipeline, so
  the "TV-14 band" is enforced by machinery we already have.
- Returns **`isAdult`** (the porn-blacklist signal), `genres`, `averageScore`,
  `format`, `seasonYear` — everything needed to filter and rank in one call.
- Broader than Crunchyroll: all anime, not one platform's licensed catalog.

**LOCKED — Anime TV-14 source & pipeline (decided 2026-08-15):**

Use the **AniList GraphQL API** (`graphql.anilist.co`) — NOT the `anilist.co`
web URL, which is a JS SPA with no data in the HTML (same trap as Crunchyroll).

Filters run **cheapest-first**, so most titles never cost a MAL or LLM call.
AniList returns `isAdult`, `genres`, `averageScore` and `idMal` inline in the
one list query, so steps 1–3 are free:

1. **AniList query** — `sort: POPULARITY_DESC`, paginated (perPage 50). One-to-a-
   few calls; 30 req/min limit is ample. Returns the list with all fields below.
2. **Drop `isAdult: true`** — porn blacklist, inline, no lookup.
3. **Drop excluded genres + below the score floor** — inline.
4. **MAL age band** via Jikan (cached ~6 months, paced ~1/s) — only on survivors
   of 1–3. `idMal` comes straight from AniList, so **Fribb's map isn't needed
   here** — the MAL handoff is inline.
5. **LLM ACB second-pass safeguard** — only on survivors of step 4; MAL band
   passed in as evidence.

**Over-fetch.** The popular list is heavy with R/17+ shows (Attack on Titan,
Death Note, Tokyo Ghoul) that the MAL band correctly drops, so pull ~150–200 to
yield 50 TV-14 titles (3–4 paginated AniList calls).

**Build once per band, not per profile.** "Anime TV-14" is a fixed age target
(13+ profiles, judged at 14) — the same for every profile that sees it. Run
MAL + LLM once at band 14 and cache the result; per-profile excluded-genres
apply on top of the cached list. The expensive age work happens once.

**popular vs trending:** using `POPULARITY_DESC` (stable, recognisable list).
`TRENDING_DESC` is the fresher alternative but leans harder on the LLM fallback,
since the newest titles are exactly the ones MAL may not have rated yet.

Simkl `/anime/trending` remains a viable second option (also MAL ids inline),
but AniList is the locked choice. The entire age half of this pipeline is code
already shipped in v5.2 — this catalog just feeds it a new candidate source.

---

## Recommendation decay (added 2026-08-15)

A recommendation the user is repeatedly shown but never engages with is an
**implicit rejection** — it should fall out and stop being recommended. Because
v6 holds the `recommended` table locally, we can track this.

**Architectural change this forces:** the weekly build becomes **upsert-and-age,
not wipe-and-rebuild.** The `recommended` table is now persistent state with a
per-row lifecycle.

### Two tables (James's model — cleaner than columns-on-recommended)
- **`watched`** — "have they seen it?" → de-dupe against.
- **`dont_recommend`** — "do they not want it?" → suppress against. Holds BOTH
  explicit user rejections *and* decay-outs, each row tagged
  `reason` (`user` | `decayed`) + timestamp. Build/serve does
  `NOT IN watched AND NOT IN dont_recommend`.

### Decay measures SUSTAINED visibility + ignore — and resets on natural fall-off
This is the sharp refinement (James): a title only decays if the user **keeps
being shown it and keeps ignoring it.** A title that drops off the visible list
because *other* titles out-scored it was not rejected — it just lost the ranking,
and it deserves a fresh chance if it climbs back. So decay is driven by a
**visible streak**, not wall-clock age:

`recommended` columns:
- `streak_started_at` — when the current *continuous* run of impressions began;
  **reset to null when the title falls off** (no impression for a gap, proposed
  14 days). Out-competed → clean slate on return.
- `times_shown_in_streak` — impressions in the current streak.
- `last_shown_at` — to detect the fall-off gap.
- `engaged_at` — set on a real interest signal (below).

**Decay fires** when, within the *current streak*: `now - streak_started_at >
DECAY_WINDOW` AND `times_shown_in_streak ≥ floor` AND not engaged AND not
watched. → move to `dont_recommend(reason=decayed)` with a cooldown.

So: persistently shown + ignored → decays; flickers on/off from competition →
never accumulates a long enough streak → survives. Recency weighting and decay
work together — as recent watches reshuffle the ranking, natural fall-off resets
clocks, and only the genuinely-ignored-while-persistently-shown titles die.

### Explicit "Don't recommend" (user-driven)
Writes `dont_recommend(reason=user)` directly. Two entry points:
- **In-app** — a **"🚫 Don't recommend"** link in the meta `links` array,
  external URL → our `…/suppress/<token>/<id>` endpoint → records + returns a
  tiny "Removed ✓" page. Clunky (opens a URL) but James accepts it; another of
  his addons does the same. **Nuvio: standard-protocol, high-confidence yes —
  verify click behaviour on-device before depending on it.** Poor on TV (opens a
  browser) — expected.
- **Portal Advanced tab** — a "Don't recommend" button on the recommended-list
  view. Reliable, universal, TV-independent. The dependable primary.
- Reason `user` → **permanent** (they said no); reason `decayed` → cooldown.

### Engagement signals (cancel decay)
| Signal | Source | Effect |
|---|---|---|
| Watched / completed | Simkl `completed` → watched table | removed via exclusion |
| **Started** (in-progress) | Simkl `watching` status | `engaged` — decay off |
| Added to Watch Later | Simkl `plantowatch` | `engaged` — decay off |
| Opened the detail page | our `/meta/:id` hit when the user clicks a title | *soft* — resets the streak clock, not a permanent `engaged` |

### Decisions needed
1. **`DECAY_WINDOW` (X)** — proposed **30 days** of sustained visibility.
   Configurable on the filters tab?
2. **Fall-off gap** that resets a streak — proposed **14 days** without an
   impression.
3. **Decay-out cooldown** length before a title may re-qualify — proposed
   **90 days**. (Explicit `user` rejections are permanent.)
4. **Does opening the detail page count?** *Lean: soft* — resets the streak
   clock (light interest), doesn't permanently mark engaged.

### Honest caveat — "started" detection depends on the scrobble path
Clean signals are *watched* and *watchlisted* (both from Simkl). **"Started"**
needs Simkl reporting a `watching`/in-progress state, which only happens if
playback is scrobbled. Otherwise the `/meta` open is the interest signal — which
is why decision 4 matters.

## Advanced tab — "Don't recommend" (build item, confirmed)

The Advanced tab's "view Recommended Movies / Shows" (already speced) gains a
**"🚫 Don't recommend"** button per title. Click → `POST` to the suppress
endpoint → writes `dont_recommend(reason=user)` (permanent). This is the
reliable, universal path (works from any browser, TV-independent) and it shares
one endpoint with the in-app meta link and the Mobile Companion below.

## Mobile Companion (added 2026-08-15)

A per-profile, mobile-optimised **web page served by the addon** — the good-UX
home for the curation tasks that are clumsy inside Stremio/on a TV. Clean
division of labour: **the TV is for watching; the phone is for curating.** This
is what makes the "don't recommend" and "add to watchlist" flows actually
pleasant, and it retires the TV-limitation caveat on the in-app link.

**Access:** a unique capability URL per profile (carries the profile token, like
the install URL), surfaced in the portal to open/bookmark on a phone. No app to
install; optionally a **PWA** (home-screen icon) as a nice-to-have.

**Section 1 — Manage recommendations.** Renders the profile's current
Recommended Movies + Shows (read from the local `recommended` table), each with a
**remove / "don't recommend"** action → the SAME suppress endpoint as the
Advanced tab (`dont_recommend`, reason=user). It's the mobile face of the same
feature — one endpoint, three entry points (in-app link, Advanced tab, here).

**Section 2 — Search & add to Watch Later.** A search box over **Simkl text
search** (LIVE-VERIFIED: `GET /search/movie?q=` and `/search/tv?q=`, client_id
only) returning title/year/poster + **`simkl_id` and `tmdb` inline**. Results
get an **"Add to Watch Later"** button (movies or shows) → **Simkl write to the
profile's `plantowatch` list**. Because Simkl search already returns the
`simkl_id`, **no id-mapping is needed** — search → add is one hop, and it feeds
straight into the Watch Later catalog (Simkl plantowatch) we already planned.

**Architecture:**
- New token-authed routes on the addon server (a small mobile UI + a couple of
  JSON endpoints). Reads the local `recommended` table; writes `dont_recommend`
  (local) and Simkl `plantowatch` (remote, per-profile token).
- Simkl writes obey **1 POST/s** and route through the rate governor.
- The token grants suppress + watchlist-modify power — same capability-URL model
  as the install link, but note it's more than read-only; treat the URL as
  sensitive.

**To verify at build:** the Simkl **watchlist-write** endpoint (add to
`plantowatch`) — needs a connected account, which doesn't exist yet. Search and
read are already confirmed.

**Staging:** depends on the core v6 recommendation engine + Simkl integration,
so it lands **after** them — a later v6 stage, not a blocker for the first
working build.

## v6 Catalog registry (defined 2026-08-15)

All 10 MDBList URLs verified live (HTTP 200) this session. **All sorted
`imdbpopular`.** MDBList stays as the source for the curated set; Anime TV-14 is
AniList (see above). These are the *extra* catalogs — the two AI
recommendation catalogs are always-on and separate.

| Catalog | Type | Source | user / slug | Age-gated |
|---|---|---|---|---|
| Popular Movies | movie | mdblist | `official/movies/popular` † | — |
| Popular Shows | series | mdblist | `official/shows/popular` † | — |
| Christmas Movies | movie | mdblist | `hdlists/christmas-movies` | — |
| Comedy Movies | movie | mdblist | `hdlists/comedy-movies-2001-2020` | — |
| Action Movies | movie | mdblist | `hdlists/latest-hd-action-movies-from-1980-to-today` | — |
| Rom-Com Movies | movie | mdblist | `abbacarter/rom-com` | — |
| War Movies | movie | mdblist | `garycrawfordgc/war` | — |
| Horror Movies | movie | mdblist | `hdlists/latest-hd-horror-movies-top-rated-from-1980-to-today` | — |
| Trending Kids Movies | movie | mdblist | `tvgeniekodi/trending-kids-movies` | **YES** |
| Trending Kids Shows | series | mdblist | `tvgeniekodi/trending-kids-tv-shows` | **YES** |
| Anime TV-14 | series | anilist | (POPULARITY_DESC → MAL band 14) | **YES** |

† **Flag — the two `official/…/popular` URLs have a different shape** than the
`user/slug` lists (they're MDBList's built-in top-lists). The list-items API
call for them may differ from the user-list endpoint we use today — **verify
against the API with the global MDBList key at build**, don't assume the same
path.

**Kids catalogs — "must pass the age filter + LLM" (James).** Handle exactly
like Anime TV-14: a **catalog-level age band, built once and cached, always
applied** — so "Trending Kids" is trustworthy even on an adult profile, not just
when a profile happens to set an age limit. Effective gate =
`min(catalog_band, profile.age_limit)`, so a stricter profile tightens it
further. The stack is TMDB certification → LLM ACB pass (these are mostly
non-anime, so no MAL). **Decision needed: what band?** Proposal: **12** (covers
G/PG and the softer PG-13). Confirm.

### Catalog rules (locked)

- **Rating floor — DROP for curated, HARD-KEEP for personalized.** The curated
  MDBList catalogs are served **as the curator ordered them, no `min_imdb`
  floor** (the curation *is* the quality signal). The rating threshold stays a
  **hard** rule only on the **personalized** F5 recommendation list (filters
  tab, default 6). Clean split: curated = trust the curator; personalized =
  enforce our floor.

- **Watch Later → Simkl `plantowatch`.** Trakt's watchlist is gone; Simkl's
  plan-to-watch replaces it (verified: `/sync/all-items/.../plantowatch`).
  Per-profile, personal. **Empty → show nothing** (hide the row, as v5 already
  does for an empty Watch Later); **populated → serve it.**

- **De-dupe against the local watched table — ALL curated catalogs EXCEPT
  Christmas.** The lists are long, so pruning already-watched titles improves
  freshness without emptying them. This **reverses the v5 behaviour** (curated
  lists ignored watched status) — in v6, every curated catalog filters out
  titles present in the profile's local watched table (F3), matched on imdb/tmdb
  id, per profile.
  - **Explicit exception: Christmas Movies is NEVER de-duped.** Christmas films
    are seasonal re-watchables — *Elf*, *Home Alone*, *Die Hard* — that people
    deliberately return to every year. Showing the ones they've "watched" is the
    point, not a bug. Model this as a per-catalog `dedupe_watched` flag
    (default **true**; Christmas = **false**).
  - Graceful when there's nothing to de-dupe against (no Simkl / empty watched
    table): no pruning happens, list serves in full.

- **Default-on:** all curated catalogs ship **opt-in** (enabled per profile in
  the Catalogs tab). Watch Later, being personal, defaults on when Simkl is
  connected. *(Minor — flag if you want any genre catalog on by default.)*

## What dies in v6
Trakt client, Trakt device flow, the Trakt engine + `engine` setting, Trakt
lists, the Trakt watchlist catalog. Plus most of v5's LLM *generation* machinery
(`generateCandidates`, cross-type seeding), since TMDB now generates candidates.
**MDBList STAYS** (decided). The LLM age-gate, MAL/NSFW stack, metadata service,
and caching all **carry forward unchanged**.

## Cross-cutting open decisions (remaining)
1. **Anime TV-14 source** — parked, James working on it. Don't default to Simkl.
2. **Stremio scrobble provider** — retained alongside Nuvio, or Nuvio-only?
3. **Is LLM generation fully retired, or kept as a gap-filler** when a genre has
   too few TMDB recommendations to fill F6's quota? (Recommend: keep a thin,
   optional top-up; retire the rest.)
4. **F5 "release date"** — recency filter (reuse `max_age_years`) vs in-genre
   sort. (Leaning: recency filter.)
5. **F3 read cadence** — James to revisit before build (the F2 delta-push is the
   real constraint; read frequency is just tuning).

**Resolved this round:** one Simkl app per user · F4 was a numbering skip · F2
reads Nuvio often / writes Simkl only on delta · F6 never forces titles · MDBList
kept · NSFW = porn/hentai blanket ban only, mainstream 18+ allowed for adults ·
recommend-count adopted.

## Suggested build order (once decisions land)
1. Simkl client + PIN flow + config (F1); rip out Trakt.
2. SQLite watched table + Simkl-sourced hourly refresh, activities-gated (F3),
   redirect scrobble writes to Simkl (F2).
3. Weekly recommendation builder: TMDB recs → filters → age stack → table (F5).
4. Genre-balanced playlist assembly (F6).
5. Catalog re-source to TMDB Discover + Simkl; drop MDBList (F7/F8/F9).
6. Retire dead LLM-generation code; docs; major version bump.

## Build status & remaining work (updated 2026-08-19)

**DONE:** F1 (Simkl replaces Trakt — full code teardown, `trakt.js` deleted),
F2 (scrobble → Simkl `/sync/history`), F3 (SQLite watched store), F5 (recency-
weighted TMDB-recs builder, upsert-not-wipe), F6 (genre-balanced serve + serve-
time filters), Watch Later → Simkl plantowatch, Anime TV-14 → **MDBList** (we
diverged from AniList), global/per-profile config split + LLM chain, explicit
"Don't recommend" (portal), "because you watched X" debug line, and the **rate
governor** (v6-ui.md §Rate governance).

**DONE — Catalog overhaul (v6.17.0 / v6.18.0-beta).** Both parts shipped:
1. **Registry** — re-sourced to the design list + kept Thriller. Every user/slug
   verified against the live MDBList API before committing; IDs kept stable.
   Added Rom-Com/War/Horror. **Popular** = MDBList's `official/popular` — ONE
   combined list (API slug `popular`; the site's `movies/`+`shows/` are just page
   groupings), returned as `{ movies, shows }` and split by type, so both Popular
   catalogs share the slug. Needs the MDBList key (authenticated list).
2. **Behavioural** — serve-time de-dupe against the Simkl watched store for every
   catalog EXCEPT `dedupe_watched:false` (Christmas); `age_band` applied ALWAYS
   (Kids 12, Anime 13), effective `min(band, profile.age_limit)` — so those rows
   need an LLM to build even on an adult profile. Curated fetches already route
   through the rate governor (mdblist wired in v6.16). Rules surfaced in the
   portal (`/api/catalogs` + Catalogs-tab badges: "age-gated N+", "keeps watched").
   *Band values (Kids 12, Anime 13) are the design-proposed defaults — adjust in
   catalogs.js if you want a different bracket.*

**STILL NOT BUILT after that:** recommendation **decay** (streak-based implicit
rejection — columns exist, no logic runs), **Mobile Companion** (needs a Simkl
`plantowatch` *write*), the **in-app meta "🚫 Don't recommend" link**, the
**tabbed profile UI**, and cleanup of the vestigial `engine`/`rating_source`
config fields.

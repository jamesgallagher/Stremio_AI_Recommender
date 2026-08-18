# v6 Plan — life after Trakt

**Status:** DESIGN ONLY. No code. Investigation + architecture for removing
Trakt and replacing what it gave us.
**Trigger:** Trakt's tightened limits make it unviable as a dependency.
Replacement sync backbone will be **Simkl** or **WeTrakr** (to be decided).

---

## 1. What Trakt actually gave us, and what dies with it

Being precise here, because the honest assessment is that this is **less
catastrophic than it first looks** — v5 already built most of the replacement
without us realising it.

| Trakt gave us | Used by | Status without Trakt |
|---|---|---|
| `/recommendations` (the `trakt` engine) | `rebuild.buildCatalog` | **Dies.** The whole collaborative-filtering engine goes. |
| Automatic watch history | taste seed + watched-exclusion | **Survivable** — we already read Nuvio/Stremio watched state directly (see §3). |
| Watchlist (`/sync/watchlist`) | "Watch Later" catalog | Dies unless replaced by Simkl/WeTrakr or a local list. |
| Public list items (`/users/.../lists`) | "Anime TV-14" catalog | Dies; needs a non-Trakt source for that list. |
| OAuth identity per profile | device-flow login | Replaced by Simkl/WeTrakr auth, or dropped. |

Trakt coupling is **contained** — only `rebuild.js` and `portal.js` import the
Trakt client; the scrobble reader is already Trakt-independent. So this is a
bounded refactor, not a rewrite.

## 2. What we learned from MediaVoyager

Studied [DarkKnight1302/MediaVoyager](https://github.com/DarkKnight1302/MediaVoyager)
(C#/.NET). It has **no Trakt and never did** — it's a standalone app, so it
solved the "recommend without Trakt" problem from first principles. Findings:

**A. History is user-owned, not imported.** `UserMovies { favouriteMovies,
watchHistory }` in its own DB, populated by explicit `addFavourites` /
`addWatchHistory` endpoints. There is no automatic ingestion — the user curates
their taste. This is the crux: **without Trakt, someone has to supply the
history.** MediaVoyager makes the user do it by hand. We have a better option
(§3).

**B. Favourites and history play DIFFERENT roles — the best single idea here.**
Their prompt (paraphrased): *"understand taste from the FAVOURITES only, not
the watch history; recommend from favourites; the result must NOT be in watch
history."* So:
- **Favourites = the positive taste signal** (what to be like)
- **Watch history = the exclusion list** (what not to repeat)

We currently conflate these — `watchedByType[type].recent` is both our taste
seed and our exclusion set. Splitting them is a real quality lever, and it maps
onto MediaVoyager's separation exactly.

**C. Plain-text output, not `json_object`.** They ask for "Name\nYear" as two
lines and parse with regex — no strict JSON mode. That **sidesteps the
`json_validate_failed` flakiness** we just fought in v5.2.1. Trade-off: it's
per-title, not batched (see E).

**D. Dual API keys with automatic failover.** Primary + backup Groq key; on 429
they flip to the backup for that request. This is a direct answer to the
resilience gap flagged in v5.2.1 — *"after the Llama decommission we have no
true fallback."* Cheap, and worth adopting regardless of the rest of v6.

**E. One recommendation at a time, escalating temperature 0.9 → 2.0.** Diversity
via temperature climb; retry on empty/unparseable/already-watched. Simple, but
**expensive** — many LLM calls per list. **We should NOT copy this.** Our v5
batch-of-50 approach is far kinder to the free tier. Keep batch.

**F. LLM watch-history hygiene job.** When history exceeds ~130 titles, an LLM
pass finds the single title *least* consistent with the favourites and prunes
it. Keeps the taste signal clean and bounded over time. Interesting, but it
spends tokens; for us a recency/size cap may be enough (see §5).

**G. Confirms our v5.2.1 fix.** They set `reasoning_effort` explicitly
("medium"; we chose "low") and `include_reasoning:false`. Independent
corroboration that reasoning effort is the knob that matters on gpt-oss.

**What we do BETTER and must keep:** batch generation (token-efficient), and
the entire age/NSFW/MAL stack — MediaVoyager has no parental gating at all.

## 3. The thing we already have — Trakt-independent history

`services/scrobble.js` already does `pullProviderWatched(cfg)`: it reads a
profile's watched state **directly from their Nuvio/Stremio account** and today
pushes the delta to Trakt. **The read half is completely Trakt-free.** We built
an automatic history source and then routed it through Trakt unnecessarily.

So v6's foundation is: **stop round-tripping through Trakt.** Read watched state
from Nuvio/Stremio (and/or Simkl) into a **local history store**, and make that
store the source of truth for both the taste seed and watched-exclusion.

## 4. Proposed architecture

**Local history store = source of truth.** A per-profile record:
`{ favourites[], history[], watchlist[] }`, disk-backed like everything else.
Populated by any combination of:

- **Source A — Nuvio/Stremio direct read** (have it). Automatic, no new
  dependency. Limitation unchanged: it's the whole household account's list.
- **Source B — Simkl / WeTrakr sync** (to research). Cloud history + watchlist,
  cross-device. The most direct Trakt replacement. **Decision pending §6.**
- **Source C — manual favourites** (MediaVoyager-style). User marks favourites
  in the portal for a clean *positive* taste signal. Optional but high-value,
  and it's what unlocks the favourites-vs-history split (§2B).

**Engine: `ai` becomes the ONLY engine.** v5's `ai` engine already generates
from history without Trakt — it was built for the kids, but it now becomes the
default and only path. The `trakt` engine and the `engine` per-profile setting
are **removed**. Everything downstream (TMDB resolution, dedupe, deterministic
filters, MAL/NSFW gate, LLM age gate, bench) is **unchanged** — it already
operates on generated candidates, not on Trakt data.

**Net effect:** the pipeline barely changes shape. We swap the *front* (Trakt
recommendations → LLM-from-local-history) and keep the entire *back* (v5/v5.2
gating, metadata service, caching).

## 5. LLM tightening (the "look at our LLM use again" ask)

Prompted by MediaVoyager, and by the fact that the LLM is now our *only*
recommendation source (no Trakt fallback), so it has to be tighter:

1. **Split favourites from history in the generate prompt** (§2B). Favourites
   drive taste; history is exclusion-only. Biggest quality lever.
2. **Adopt dual-key failover** (§2D). With the `ai` engine as the sole source,
   a Groq outage = no recommendations at all. A backup key is the cheapest
   resilience we can buy. Consider a second *provider* (Gemini) as the deeper
   fallback — MediaVoyager already carries a Gemini client for exactly this.
3. **Reconsider `json_object` vs plain-text** (§2C). Our batch design wants
   structure, but the flakiness is real. Option: keep JSON but with a
   plain-text retry as a fallback parse. To be prototyped, not decided.
4. **Bound the history seed.** Cap the seed at N most-recent (and/or the
   favourites set), rather than growing unbounded. Cheaper than MediaVoyager's
   LLM-prune job (§2F) and good enough for a taste signal.
5. **Keep batch generation.** Do not adopt one-at-a-time. Confirmed by the
   free-tier maths.

## 6. Open decisions (for James — research next, decide before build)

- **Simkl vs WeTrakr.** ✅ **Investigated — see §6a. Recommendation: Simkl.**
  Its API is Trakt-shaped (near drop-in for our sync code), limits are generous,
  it imports from Trakt natively for seeding, and it returns MAL/anidb ids that
  strengthen the anime pipeline. It does NOT offer recommendations, which
  confirms the LLM engine stays. WeTrakr deprioritised (unverified; Simkl closes
  the requirement). Remaining Simkl checks are live-API details, not blockers.
- **Do we still need direct Nuvio/Stremio reads if we adopt Simkl?** Possibly
  Simkl becomes Source B and A is retired — but A needs no user account setup,
  so it may be worth keeping as a zero-config default.
- **Watch Later / Anime TV-14 catalogs.** Both were Trakt-list-backed. Replace
  with Simkl watchlist + a Simkl/MAL-backed anime list, a local list, or drop.
- **Favourites UX.** Manual curation (§2C) is powerful but is user effort. Is
  it worth the portal work, or do we derive "favourites" heuristically from
  most-rewatched / highest-rated history?
- **Auth/identity.** Trakt OAuth per profile goes. Simkl OAuth in its place, or
  no third-party auth at all (profiles are already local).

## 6a. Simkl API investigation (done 2026-08-15)

Investigated Simkl's API surface as the scrobble-history and list backbone.
Verdict: **strong fit, and deliberately Trakt-shaped** — the swap is close to a
drop-in for the *sync* role, because Simkl's API mirrors the exact endpoints
our `trakt.js` already uses.

Sources: [SIMKL/API blueprint](https://github.com/SIMKL/API/blob/master/apiary.apib),
[api.simkl.org](https://api.simkl.org/), [Trakt→Simkl import](https://docs.simkl.org/how-to-use-simkl/advanced-usage/import-export-data/importing-to-simkl/supported-platforms/trakt).

**What maps almost 1:1 from our existing Trakt code:**

| Our Trakt use | Simkl equivalent | Notes |
|---|---|---|
| device flow (`/oauth/device/code`) | **`GET /oauth/pin`** + poll `/oauth/pin/{code}` | Same PIN/device pattern. Our device-flow code ports over. |
| `getLastActivities` (what changed) | **`/sync/activities`** | Same tiny-timestamp two-phase check. |
| `getWatchedSets` (full history) | **`GET /sync/all-items/{type}/{status}`** with **`date_from`** | Incremental read. `type` = movies/shows/anime; `status` = watching/completed/plantowatch/hold/dropped. |
| `addToHistory` (scrobble write) | **`POST /sync/history`** | Episode-level (`episode_watched_at`), rewatch sessions supported. |
| watchlist → "Watch Later" | **`plantowatch`** status via all-items | The list replacement the ask was about — viable. |
| id-based items (imdb/tmdb) | `ids{ simkl, imdb, tmdb, tvdb, mal, anidb, anilist, kitsu }` | **Richer than Trakt.** |

**Three findings that matter beyond a like-for-like swap:**

1. **Simkl has NO general recommendations endpoint.** Only `users_recommendations`
   embedded in anime summary responses — nothing equivalent to Trakt
   `/recommendations`. **This confirms the whole v6 thesis:** whichever backbone
   we pick, the LLM `ai` engine is the *only* recommendation source. Not a
   Simkl gap to work around — a settled fact to design around.
2. **Native MAL + anidb ids.** Simkl returns them on every item. This
   *reinforces* the v5.2 anime pipeline — we currently derive `mal_id` via
   Fribb's map; Simkl would hand it to us directly for anything in a user's
   Simkl library. Synergy, not duplication.
3. **Trakt → Simkl migration is a native, solved feature.** Simkl has a
   built-in Trakt importer: one-time OR scheduled auto-import (hourly / daily /
   12h / weekly), one-way Trakt→Simkl. So James's "full Trakt export to seed"
   is even easier than expected — the user can point Simkl at Trakt directly
   and the history/watchlist/ratings arrive without us writing any migration.

**Rate limits: 10 GET/sec, 1 POST/sec** per client_id AND per user token —
generous for reads (history sync is cheap). The 1 POST/sec only bites on **bulk
seeding writes**; pace them. Far more workable than Trakt's tightened limits.

**Live-tested against the real API (client_id provided, no user data yet):**

- ✅ `client_id` public access works; search by `imdb=` and `mal=` resolves.
- ✅ **Full id constellation** on summary endpoints. An anime returns
  `{ simkl, imdb, tmdb, tvdb, mal, anidb, anilist, kitsu, traktslug }` — every
  id we use, plus all four anime DBs, plus the **Trakt slug** (migration aid).
  Simkl is effectively an anime id-mapper in its own right.
- ✅ **Certification inline** on movie summaries (`certification: "PG-13"`) —
  a real cert we can feed the age gate as evidence, reducing LLM guessing for
  *non-anime* too. (Anime age still uses the MAL/Jikan path; Simkl gives us the
  mal id directly to feed it.)
- ✅ **PIN device flow** (`GET /oauth/pin`) returns
  `{ user_code, verification_url: simkl.com/pin, expires_in, interval }` — the
  exact shape our Trakt device-flow code already handles.
- ✅ **Auth contract**: `/sync/all-items` without a token → `401
  user_token_failed`. Reads need the user token, as expected.
- ✅ **No recommendations endpoint**: `/recommendations/movies` → `404`. Final
  confirmation — the LLM engine is the only recommendation source.
- ✅ **Native trending/genre catalogs** (client_id only, no user auth):
  `/anime/trending/today`, `/tv/trending/today`, `/movies/trending/today`,
  `/anime/genres/{genre}/{type}/{year}` all return 200. Payload carries
  `ratings.mal.rating`, `ratings.simkl.rating`, watched / plan-to-watch counts,
  `original_language`, `anime_type`. **This replaces the Trakt-list-backed
  "Anime TV-14" catalog with a first-party Simkl source** — cleaner than the
  public-list scrape we had.
- Reads are Cloudflare-CDN cached (`cf-cache-status: HIT`) — cheap and fast.

**Still needs a logged-in user (no data yet, so untested):**
- Real `/sync/all-items` response body with actual watched items + `date_from`.
- `POST /sync/history` write schema, and adding episodes by show + S/E.
- These are write/read-your-own-data paths — verify once a Simkl account with
  a little history exists. Not blockers for the design.

**Recommendation:** adopt **Simkl** as the sync backbone. It covers history +
scrobble + watchlist cleanly, is API-compatible in shape with what we already
built, seeds itself from Trakt natively, and strengthens the anime work.
**WeTrakr can be deprioritised** — I have not verified it, and Simkl already
closes the requirement; only revisit WeTrakr if Simkl's live checks above
disappoint. Simkl does not change the LLM decision: it is the history/list
layer, not a recommendation source.

## 6b. Simkl API rules & compliance — MANDATORY (from Simkl's sync policy)

Simkl states plainly: **"If you don't follow these rules, your client_id will
be suspended."** These are not best-practices, they are conditions of access,
and they constrain our architecture. Source:
[api.simkl.org/guides/sync](https://api.simkl.org/guides/sync).

**Every request must carry:**
- Query params: `client_id`, **`app-name`**, **`app-version`** — on *every*
  call (we only send client_id today; app-name/version must be added).
- Header: a descriptive **`User-Agent`** (we already send one for Trakt; reuse).

**Rate limits:** 10 GET/sec, **1 POST/sec** per client_id and per user token.
Exceeding triggers throttling. Bulk seeding writes must be paced ≥1s apart.

**The sync protocol is prescribed, not optional:**

- **Never call a sync endpoint without checking `/sync/activities` first.**
- **Phase 1 — initial sync (once per account):** call `/sync/shows`,
  `/sync/movies`, `/sync/anime` **individually and SEQUENTIALLY** (not in
  parallel — parallel spikes their CPU), *without* `date_from`. This is the
  one-time full pull.
- **Phase 2 — steady state:** switch to
  `/sync/all-items/?date_from=SAVED_TIMESTAMP` — one combined request that
  returns only the delta. Always pass `date_from`; Simkl explicitly warns that
  omitting it "overloads the API server" and risks suspension.
- **Continuous loop:** `GET /sync/activities` → compare against our saved
  timestamps → **skip entirely if unchanged** → else pull the delta with
  `date_from` set to exactly the saved value. No saved timestamp → fall back to
  Phase 1.

**The hard constraint for us — no unconditional background polling.** Simkl:
*"Never run unconditional background polling timers without active user
interaction."* Recommended cadence is event-driven (app open / device wake),
throttled to **once per 15–30 min**, with manual pull-to-refresh allowed.

**What this means for our architecture (important):**

- Our v1–v5 model is a *server-side background rebuild on our own schedule*.
  A naked cron that polls Simkl regardless of user activity is **exactly what
  gets a client_id suspended.** This must change.
- The compliant shape is the one our Trakt code already half-implements: the
  sync is **demand-driven and activities-gated.** A catalog request from
  Stremio (a real user action) is the trigger; before any `/sync/all-items`
  pull we call the cheap `/sync/activities`, compare timestamps, and do nothing
  if unchanged. The expensive pull only happens on a genuine delta.
- Add an explicit **throttle** (≥15 min between activity checks per profile,
  matching Simkl's guidance) so rapid catalog reopens can't spam them.
- Persist the last activities timestamp per profile; it is the `date_from`
  cursor and the skip check in one.
- The existing `syncWatched` two-phase logic (last-activities → conditional
  full fetch) is the right skeleton — it must be adapted to Phase 1 (sequential
  per-type, no date_from) vs Phase 2 (combined all-items, with date_from), and
  to the throttle + no-naked-timer rule.
- Seeding (Trakt import) is Simkl-side, so it doesn't count against our POST
  budget; but any writes we do (scrobble push) must respect 1 POST/sec.
- If we ever anticipate high volume, Simkl asks to be contacted on Discord
  first — worth doing before a wide rollout.

**This is now a first-order design driver, not a footnote:** v6's sync layer
must be built activities-first, delta-only, demand-triggered, and throttled —
or we lose API access.

## 7. Risks

- **The LLM is now the ONLY recommendation source.** No Trakt fallback, no
  collaborative filtering. Quality rests entirely on the seed and the prompt.
  This raises the stakes on §5 considerably.
- **Cold start is worse.** Trakt could recommend from a huge collaborative
  graph on thin history. From local history alone, a new profile with little
  history gets weak recommendations until it accumulates. Favourites (§2C)
  partially mitigate.
- **Free-tier pressure rises.** Every list is now LLM-generated (no cached
  Trakt engine for adults). Batch generation + caching + dual keys matter more.
- **New vendor dependency.** Swapping Trakt for Simkl/WeTrakr trades a known
  bad dependency for an unproven one. §6 research is the guard against
  repeating the Trakt mistake.
- **Client_id suspension (§6b).** Simkl will suspend a client_id that polls
  without activities-gating or omits `date_from`. Our historical
  background-rebuild model does not comply as-is; the v6 sync layer MUST be
  demand-triggered, activities-first, delta-only, and throttled. This is the
  single biggest behavioural change v6 forces, and getting it wrong takes the
  whole addon offline, not just one profile.
- **Household-account limitation persists** on Source A — the Nuvio/Stremio
  read is per-account, not per-person. Simkl per-user accounts could actually
  *improve* on Trakt here.

## 8. Rough staging (design only — not committed)

1. **Research Simkl + WeTrakr APIs** (§6), pick the backbone. No code.
2. **Local history store** + populate from existing Nuvio/Stremio reader
   (Source A). Sever the Trakt push.
3. **Make `ai` the only engine**; remove the `trakt` engine, the `engine`
   setting, and the Trakt recommendation/​list code paths.
   → Build the Simkl sync layer to §6b: activities-first, Phase 1 sequential
     init vs Phase 2 delta, demand-triggered, throttled, `app-name`/
     `app-version` on every call. Compliance is a build requirement, not a
     later hardening pass.
4. **Favourites-vs-history split** in the prompt (§2B) + dual-key failover
   (§2D).
5. **Simkl/WeTrakr integration** for history/watchlist (Source B), replacing
   the dead Trakt catalogs.
6. Decommission the Trakt client; docs; version (a major bump — this removes a
   headline feature).

**Nothing is built until §6 research lands and James signs off on the
backbone.**

# Taste Trainer — design spec

**Status:** designed 2026-10-01 (James + Claude). **Engine scope:** Marquee only (movies). The
feedback store and actions are engine-agnostic, so a future engine opts in by reading them; the
other engines (Genesis, Glass) are being deprecated and are deliberately NOT wired.

A per-profile screen listing the profile's watch history, newest watch first, where the user tells
the recommender how each watch should count: **rate it**, **love it**, or **ignore it**. It is the
fix for spec §12 L3 of the Marquee design ("this family doesn't rate films"). Marquee's rating layer
exists but has had no data to work on.

---

## 1. Decisions (fixed)

| # | Decision | Source |
|---|---|---|
| TD-1 | **Ignore is neutral** (weight 0), not a mild negative. "Not interested" stays a separate action for unwatched titles. A watched-and-disliked film is rated 1–4. | James, 2026-10-01 |
| TD-2 | **Marquee only.** Glass and Genesis are not touched. The store + actions live outside `src/engines/` so any engine can read them. | James, 2026-10-01 |
| TD-3 | **One rating system, stored on Simkl.** There is no separate local "super-like" flag. **10/10 = Loved**, a tier the engine treats specially (§3). The ♥ button is a shortcut for "rate 10". A 10 given in the Simkl app counts the same. | James + Claude, 2026-10-01 |
| TD-4 | **Abandoned films are neutral, not negative** (the m2 −1.0 event is removed). They are still never recommended back. A credit roll or a partial **rewatch** must never make a film count as abandoned. | James, 2026-10-01 |
| TD-5 | **Ignore is local only.** Simkl history is never modified, and an ignored film stays in the watched de-dupe set, so it is never recommended back. | Claude |
| TD-6 | **Trainer v1 lists movies only.** The API takes `type` so shows can be added once a series engine reads the store. `type=series` returns 400 `not-supported` in v1. | Claude (follows TD-2) |
| TD-7 | **Transport-agnostic core** (`src/trainer.js`), with thin portal and companion wrappers. This is the same pattern as `dontRecommend.suppress` and `markWatched`, so the phone and portal can't drift apart. | James (mobile-ready) |

## 2. What each state means

**The store records what the user said. The engine decides what that means.** Rating→weight policy
lives in Marquee's config, not in the store.

| Trainer state | Stored where | Marquee effect (T2) |
|---|---|---|
| Watched, no action | `watched` (Simkl sync) | +1.0 base, recency-decayed |
| **Ignored** | `taste_ignore` (local) | Weight 0: excluded from events, seeds, the taste brief input and `historyHash`'s *contributing* set. The hash itself **includes** the ignore set, so the brief regenerates. Still in `watchedIdSets` (never recommended back). |
| Rated 1–4 | Simkl rating → `taste_ratings` | −1.2; never a seed |
| Rated 5–6 | 〃 | +0.4 |
| Rated 7–8 | 〃 | +1.2 |
| Rated 9 | 〃 | +2.0 |
| **Rated 10 = Loved ♥** | 〃 | +3.0; the recency decay **floors at 0.5**; always a seed (pinned ahead of the ranked seeds, max 15 pinned) |
| Unfinished (abandoned) | `marquee_engagement` | Weight 0 (no event). Still excluded from candidates (`sources.js` `drop(c,'abandoned')`). |

**Precedence:** Ignored beats any rating. A title can be both rated and ignored; the rating stays on
Simkl, but Marquee gives it weight 0. Unignoring restores the rating's effect.

## 3. Marquee config changes (T2)

```js
rating_weights: { r10: 3.0, r9: 2.0, r7_8: 1.2, r5_6: 0.4, r1_4: -1.2 },   // r9_10 split
loved: { decay_floor: 0.5, pinned_seed_cap: 15 },
engagement: { ..., weight: 0 /* TD-4: event no longer emitted */, finish_pct: 90, credits_min: 20 },
```

The `ALGORITHM_VERSION` bumps to `marquee-m3`.

## 4. Abandoned — the precise rule (T2)

A movie counts as **abandoned** only if ALL of these hold:

1. Its furthest-known progress is `< abandon_below` (50%).
2. The time remaining is `> credits_min` (20 min). This applies when `duration_ms` is known; without
   a duration, rule 1 alone applies. At a 50% threshold a credit roll can't trigger this anyway; the
   guard exists so a future threshold change can't regress it.
3. It has been untouched for at least `grace_days` (7).
4. It is **not in the watched store under either id, and there is no `pending_watched` row**, at any
   date and in any order. **This is the rewatch rule:** Goonies completed in 2024 and then 30% of a
   2026 rewatch stays a completed, liked (or rated) watch. The partial rewatch is not an event at
   all. `abandonedFor` already checks the watched set independent of order; T2 adds the pending shim
   and a named test.

A furthest progress ≥ `finish_pct` (90%), or ≤ `credits_min` remaining, is **finished** and can
never be abandoned, even if the row's percent later reads lower (the upsert already keeps
`MAX(percent)`).

`marquee_engagement` gains a `duration_ms INTEGER` column (additive `ALTER TABLE` when absent). It is
filled from the Nuvio row's `durationMs`.

## 5. Data model (T1)

```sql
-- Engine-agnostic. Replaces marquee_ratings (movie-only, Marquee-owned). The first
-- sync repopulates it: James's account has no ratings (§12 L3), so nothing is lost.
CREATE TABLE IF NOT EXISTS taste_ratings (
  profile_id TEXT NOT NULL, type TEXT NOT NULL, tmdb_id TEXT NOT NULL,
  imdb_id TEXT, simkl_id INTEGER, rating INTEGER NOT NULL, rated_at TEXT,
  PRIMARY KEY (profile_id, type, tmdb_id));
CREATE TABLE IF NOT EXISTS taste_ratings_sync (
  profile_id TEXT NOT NULL, type TEXT NOT NULL, activity TEXT, synced_at INTEGER,
  degraded_synced_at INTEGER, PRIMARY KEY (profile_id, type));
CREATE TABLE IF NOT EXISTS taste_ignore (
  profile_id TEXT NOT NULL, type TEXT NOT NULL, simkl_id INTEGER,
  tmdb_id TEXT, imdb_id TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, type, tmdb_id));
-- One row per profile: when the user last changed training input (drives the rebuild).
CREATE TABLE IF NOT EXISTS taste_changes (
  profile_id TEXT PRIMARY KEY, changed_at INTEGER, changes_since_build INTEGER);
```

The `marquee_ratings` / `marquee_sync` tables are left in place but unused (no destructive
migration). `simklCache.getRatingsMap` / `syncRatings` delegate to the new store, so Marquee callers
and tests keep working.

## 6. The action module — `src/trainer.js` (T1)

Every function takes a resolved `profile` and returns plain data (no req/res).

- `listHistory(profile, { type, view, q, page, pageSize })` returns
  `{ items, page, pageSize, total, counts, training }`.
  - `view`: one of `all` (default: watched minus ignored), `unrated`, `rated`, `loved`, `ignored`,
    `unfinished`.
  - Sorting: `watched_at DESC, simkl_id DESC` (`unfinished`: `updated_at DESC`). `pageSize` defaults
    to 25, max 100. `q` is a case-insensitive title match.
  - Item:
    `{ key, type, simkl_id, tmdb_id, imdb_id, title, year, genre, poster, watched_at, rating, loved, ignored, status, percent }`.
    - `key` is the tmdb id (unique after dedupe; the stable id for actions).
    - `status` is `'watched' | 'unfinished'`.
    - `loved` is `rating === 10`.
    - `genre` is `watched.primary_genre`, else the first genre from the meta cache, else null.
    - `poster` comes from the meta cache (null if not cached; a page lazily enriches ≤ 25 misses).
  - `counts`: `{ all, unrated, rated, loved, ignored, unfinished, unresolved }` for the filter chips.
  - `training`: `{ changes_since_build, changed_at, rebuild_due_at }` for the "N changes since last
    build" banner.
- `rate(profile, ref, rating)`:
  - `rating` is an integer 1–10, or `null` to clear.
  - Writes to Simkl first (`POST /sync/ratings`, or `/sync/ratings/remove` for null). **Simkl is the
    authority; a failed write changes nothing locally.** On success, the `taste_ratings` row is
    upserted or deleted immediately, and the change is recorded.
- `setIgnored(profile, ref, ignored)`: local only; records the change.
- `markFinished(profile, ref)`: for an `unfinished` row. Delegates to `markWatched.markWatched`
  (the existing shared action).

`ref` is `{ type, simkl_id?, tmdb_id?, imdb_id? }`. It is resolved against this profile's rows only;
an unknown title is rejected with `not-in-history`.
- `rate` resolves against watched rows only, so an unfinished film can't be rated.
- `setIgnored` resolves against watched rows, then against unfinished rows, so an unfinished row can
  be hidden.
- `markFinished` resolves against unfinished rows only.

**Row rules:**
- Watched rows without a `tmdb_id` can't be acted on. They are excluded and counted as
  `counts.unresolved`.
- Watched rows sharing a `tmdb_id` are deduplicated, keeping the newest `watched_at`.
- The `ignored` view includes ignored watched rows AND ignored unfinished rows, so either can be
  un-ignored.

Result shape: `{ ok:true, item }` or `{ ok:false, reason }`. `reason` is one of `bad-type`,
`not-supported`, `bad-rating`, `not-in-history`, `no-simkl`. A Simkl write error throws; the wrapper
maps it to 502.

## 7. HTTP surface (T1)

| Portal (admin, `:id`) | Companion (session) | Core |
|---|---|---|
| `GET /api/profiles/:id/trainer` | `GET /mobile/api/trainer` | `listHistory` |
| `POST /api/profiles/:id/trainer/rate` | `POST /mobile/api/trainer/rate` | `rate` |
| `POST /api/profiles/:id/trainer/ignore` | `POST /mobile/api/trainer/ignore` | `setIgnored` |
| `POST /api/profiles/:id/trainer/finished` | `POST /mobile/api/trainer/finished` | `markFinished` |
| existing `POST …/recommend/build` | `POST /mobile/api/trainer/rebuild` | `jobs.enqueue(buildPool)` |

## 8. Rebuild trigger (T2)

`recommendationStore.needsBuild` gains a second clause: `taste_changes.changed_at > builtAt` **and**
`now − changed_at ≥ 10 min`. The 10-minute debounce lets a rating session finish before one rebuild
runs. A successful build resets `changes_since_build`. "Rebuild now" (T3/T4) bypasses the debounce.
Ratings given directly in the Simkl app are picked up by the ratings sync at the next build; they
do not trigger a build themselves.

## 9. UI (T3 portal, T4 companion)

- **Portal:** a new per-profile **Trainer** tab.
  - Layout: filter chips (with counts), search, a table of Title · Genre · When watched · Your
    rating · Actions, then pager (25 per page).
  - Rating control: 5 stars with half-steps, i.e. 1–10.
  - Actions: ♥ (= 10, toggles to clear) and Ignore. An ignored row fades with **Undo** for ~6 s,
    then only appears under the Ignored filter.
  - Clicks are debounced ~800 ms per row before POSTing: the Simkl write lane is 1 POST/s.
  - The banner shows "N changes since last build · Rebuild now".
- **Companion:** a **Trainer** route with two modes.
  - **List mode:** the same data as cards.
  - **Quick-train mode:** one poster at a time, from the `unrated` view, newest first. Tap stars to
    rate, swipe left to ignore, swipe up to love, swipe right to skip. Reuses `swipe.js`.

## 10. Build packages

| Pkg | Scope | Prompt |
|---|---|---|
| **T1** | Store + Simkl rating writes + `trainer.js` + portal/companion API + live verify script | `prompt_trainer_t1_backend.md` |
| T2 | Marquee semantics: ignore, r10 Loved tier + decay floor + pinned seeds, abandoned neutral + credits/rewatch guards, rebuild trigger, bench snapshot tables, m3 bump | to write after T1 review |
| T3 | Portal Trainer tab | after T2 |
| T4 | Companion Trainer route + quick-train | after T3 |

## 11. T3.1 refinements (2026-10-01, James's feedback)

- Rows never disappear on an action; only view/page/search changes re-fetch rows. Counts and the banner refresh quietly.
- Mark unwatched: Simkl `/sync/history/remove` first (authority), then local watched/pending/ignore/rating rows are removed and an unwatch block stops the Nuvio/Stremio scrobble re-adding the film unless the provider records a newer watch. The film becomes recommendable again.
- Every portal Trainer control has a tooltip (`TrainerUI.TIPS`); the companion (T4) does not use them.
- Star scrub: one Pointer Events implementation (`TrainerUI.bindStarScrub`). Mouse hover previews in half-star steps and click commits; touch previews on tap, follows a sideways drag and commits on release; a vertical drag scrolls the page and cancels the preview (`touch-action: pan-y`). Preview never saves; one save per gesture; keyboard rating unchanged. T4 reuses it unchanged.

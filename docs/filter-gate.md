# FG-1: the Filter Gate

Profile filters (rating floor, release year, vote floor, excluded genres) now apply to the
extra catalogs (MDBList lists), not just the two AI recommendation catalogs.

## What it is

The Filter Gate is an engine shaped like the age gate. You give it a title and a profile; it
answers **good** or **bad** (with a reason). It is wired into the build of the mixed extra
catalogs and sits beside the age gate (filter gate first, then age gate).

## The fact ladder

For each title, per missing fact, the gate resolves facts in this order:

1. **Cached TMDB deep-meta** (`metaStore.get` / `getMany`) — gives genres, year, vote_count, vote_average.
2. **Fetch it** (`metaStore.enrich`) — at most 5 at a time; a title with no TMDB id tries `tmdb.findByImdbId` first.
3. **IMDb rating** (`mdblist.cachedImdbRatings`) — wins over TMDB `vote_average` for rating when present. For other missing facts (genres, year, votes), reads `mdblist.mediaInfoBatch`.
4. **The LLM** (`groq.titleFacts`) — one batched call (max 40 titles) for titles still missing a needed fact.
5. **Still missing** => `no_data` => bad.

It never throws. Every network/LLM failure is caught per title/batch; the facts stay missing and
the title ends at `no_data`. A bad verdict caused ONLY by `no_data` is NOT stored in the verdict
table, so it is retried next build.

## The verdict table

`filter_verdicts` table:

| Column | Description |
|--------|-------------|
| profile_id | the profile's id |
| type | 'movie' or 'series' |
| key | the TMDB id (or IMDb id fallback) |
| fhash | sha1[:12] of { minRating, minYear, voteFloor, excluded sorted } |
| verdict | 'good' or 'bad' |
| reason | null when good; else genre/recency/votes/rating/no_data |
| detail | short human string (e.g. "Horror", "2009 < 2010") |
| source | 'rules' (all facts from APIs) or 'llm' (an LLM fact was used) |
| at | timestamp |

TTL: 14 days for 'rules', 30 days for 'llm'. An expired row counts as absent.

## Where it is wired

- `src/catalogs.js`: `profile_filters: true` on five definitions (Popular Movies, Popular Series,
  Kids Movies, Kids Series, Anime TV-14). Not on Watch Later or the genre lists.
- `src/rebuild.js` `buildExtraCatalog`: when `def.profile_filters` is true, `filterGate.checkMany`
  runs on each page's metas right after `fetchExtraPage`, before the age gate. Bad titles are
  dropped, so paging continues past them to reach the target.

## The pure rules

`compileRules(filters, type, { nowYear })` returns `{ needs, evaluate(facts) }`:

- `needs`: the set of facts the ACTIVE filters require (empty = no-op, no fetches).
- `evaluate(facts)`: returns `{ ok: true }` or `{ ok: false, reason, detail }`. Reasons checked
  in order: genre, recency, votes, rating, then no_data.

Anime in `excluded_genres`: the pure rule treats 'Anime' as an ordinary genre name; `data.js`
adds 'Anime' to a title's genres when the anime detector flags it.

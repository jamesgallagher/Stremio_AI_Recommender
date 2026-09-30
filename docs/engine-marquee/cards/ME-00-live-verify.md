# ME-00 — Live-verify gate

**Depends on:** — · **Blocks:** ME-03 (and confirms ME-01/02 assumptions)

## Why
Three assumptions in the design can't be confirmed from the docs alone. This card follows
the `test/verify-simkl-live.js` pattern: a manual script run against real accounts, not
part of `npm test`.

## Deliverable
`test/verify-marquee-live.js` (Node, uses `.env` + a named profile from `DATA_DIR/profiles.json`).
It prints PASS/FAIL per check and dumps one redacted sample payload per endpoint.

| Check | Call | Record |
|---|---|---|
| V1 Simkl ratings | `GET /sync/ratings/movies` (authed, governed) | Top-level shape, where `user_rating` lives, id fields (`ids.tmdb`, `ids.imdb`, `ids.simkl`), `rated_at` |
| V2 Simkl collab recs | `GET /movies/{simkl_id}` for 3 watched movies | Is `users_recommendations` present by default? Item shape (ids available? tmdb?), typical length |
| V3 TMDB discover certs | `/discover/movie?certification_country=AU&certification.lte=PG&sort_by=popularity.desc` | Are uncertified titles returned? (Compare with each result's `release_dates`.) |
| V4 TMDB home release | same + `with_release_type=4\|5\|6` | Does it exclude cinema-only titles? |
| V5 TMDB trending | `/trending/movie/week` p1–5, `/day` p1–2 | Counts, `id`/`genre_ids`/`vote_*` present |
| V6 Append call | `/movie/{id}?append_to_response=credits,keywords,external_ids,release_dates` | Confirm one request; AU + US certification present for a known title (e.g. tmdb 603) |

## Acceptance
1. The script runs with `node --experimental-sqlite test/verify-marquee-live.js <profileName>`.
2. It makes no writes to Simkl or the DB.
3. Findings are recorded in a new §"Live findings" appended to `00-design-spec.md`,
   **including any shape change ME-03 must follow**. If V3 shows uncertified titles
   slip through, note that the hard filter (not discover) remains the kids guarantee.

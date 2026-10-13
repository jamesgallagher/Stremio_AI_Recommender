# AI Recommender — review of v7.54.1-beta (`origin/v7`), 2026-10-11

Replaces the earlier review of v7.15.3 (that tree was ~40 versions behind `origin/v7`; see "What went wrong" at the end).
Target: `origin/v7` @ `cd2bbc0` (Merge PR #66), the line that becomes `main` after this review.

## Status: hardening MERGED to `v7` as 7.54.2-beta (PR #67) and now on `main`
_Point-in-time review dated 2026-10-11; the findings below describe v7.54.1. Items under "Done" shipped in 7.54.2; "Not done / later" is the open backlog._
Full `npm test` is green (EXIT 0), including two new suites (`test/hardening-p1.js`, `test/hardening-p2.js`).
Done: F3 (re-ask once; unjudged ⇒ dropped, not cached), F4 (age-limited profiles only serve rows something positively
vetted; `built_at` stamped after the gate), F5 (shared `src/searchGate.js` for Stremio + Companion search; adults skip the
chain/LLM), F6 (`min_rating`, `min_year`, `excluded_genres`, `engine_anime` admin-managed on age-limited profiles; read-only in
the UI), F10 (typed TMDB ids via `watchedTmdbFor`), F1 (5 OTP requests/hour, keyed code hash, constant-time compare, pruned
limiter), F2 (one-time setup token printed in the log), F7 (trust proxy = 1 hop / `TRUST_PROXY`, CORS only on `/addon`,
`nosniff`/`X-Frame-Options`/`Referrer-Policy`, install token redacted in logs, bind errors exit), non-root container with a clear
write-permission error, F8 (`npm audit` 0; nodemailer 10.1), parts of F9 (listen error, ZIP inflate cap, stale comments), UI
(Danger zone with typed confirmation for Hard reset + Delete; Companion header/rows/theme-color/ETag; dead code removed).
**Not done / later:** `placehold.co` error-card poster; review of Marquee TV/Anime, trainer, OAuth v2 (round 2); per-lane job
queues; JSON caches → SQLite. **After deploy:** `chown -R 1000:1000` the appdata (or `--user 99:100`), and send one real login code
through Brevo to confirm the nodemailer upgrade. Kids' lists refill only after the next age-gate run records their verdicts.

## How this was done
- Fresh worktree of `origin/v7` (`C:\Users\james\Claude\AI_Recommender-v7review`), `npm ci`, full `npm test`
  (all suites green as far as they had run when this was written: smoke 211+59, integration 263, mobile 75,
  shared-login 8+11, engines-marquee-only 15; the remaining anime/filter-gate/simkl suites were still running).
- Ran a local copy (scratch data, no real keys, SMTP off) and drove Configure + the Companion in the browser.
  Did **not** touch production. Real-data quality findings are therefore from code + the Marquee spec's own backtests,
  not from your pool.
- Read in full: `server.js`, `sessionAuth.js`, `mobile/server/auth.js`, `chain.js` (age chain), `ageGatePool`/`buildPool`,
  `engines/index.js`, mobile handlers (search/settings), the Marquee Cinema spec. **Skimmed only:** Marquee TV/Anime
  internals, trainer, filter-gate, Simkl OAuth v2, `portal.js` beyond the route list, the 2,815-line portal page.
  Treat anything in those areas as unreviewed.

## What v7 already fixed (from my earlier list)
| Earlier finding | State in v7.54.1 |
|---|---|
| Genesis/Glass to be retired | Done. Registry is Marquee Cinema / TV / Anime; Anime defaults to Disabled, Movies+Shows mandatory. |
| Stale pool rows never retired (E1) | Done: `pruneOtherEngines`, plus the staged build path (generate + age-gate in memory, acceptance gate, atomic promotion; a failed build never mutates the live pool). |
| Genre round-robin ignores quality (E2) | Done: calibrated serving (`serveCalibration.js`, spec §16) with a safe fallback. |
| No explicit taste signal (E4) / need harness (E9) | Done: Trainer (ratings, ignore, finished), engagement signal, `scripts/bench-engines.js` backtests. |
| Portal header "not generated yet" | Fixed: "18 shown from 18 (Marquee Cinema, built 0 min ago)". |
| Email inputs white on dark | Fixed. Server Config now collapsed; sticky Save bar; stale copy gone. |
| Basic Auth lockout bypass / fail-open open portal | **Superseded.** `/configure` now uses the shared email-OTP sign-in (`air_sid`, admin flag). No Basic Auth, no `ADMIN_*` env. |
| First-run "create admin" | Exists (setup wizard) but see F2. |

## Still open at v7.54.1 (verified in code; not all reproduced live)

### Security / child safety
**F1 — OTP policy (DECIDED by James): a code is valid 60 minutes and allows 5 wrong tries, then it is invalidated.**
v7 already implements exactly that per code (`OTP_TTL_MIN = 60`, `MAX_ATTEMPTS = 5`; the 6th attempt is refused without
being compared and the code is marked used). **No change needed to the policy.** Residual note, for James to accept or
not: requesting a *new* code starts a fresh 5-try budget, bounded only by the request limiter (5 requests / 15 min / email),
so a persistent guesser gets ~25 tries per 15 min. Because admin == email OTP, a hit means an admin session (all keys in
cleartext). **DECIDED: limit OTP requests to 5 per hour per email** (change `RATE_WINDOW_MS` 15 min → 60 min in
`mobile/server/auth.js`; it also covers the setup-wizard request, and `test` expectations for the window need updating).
That caps a persistent guesser at 25 tries/hour (~0.06%/day against a 1-in-a-million code). A cumulative lockout per email would
close it fully, but goes beyond the stated rule, so it is **not** planned unless James asks. Cheap hygiene that doesn't change the policy: prune the limiter maps, HMAC the stored code.

**F2 — First-run setup can be claimed by anyone who reaches an empty instance (MED, new installs only).**
`requestSetupOtp` mails a code to *whatever email the requester typed* — that proves they own that mailbox, not that
they're authorised. Fix: require a one-time setup token printed in the container log (as the old plan did).

**F3 — Unknown age verdicts are kept (HIGH, kids).** The chain's final step maps an LLM-omitted title to
`verdict:'unknown'`, and no caller blocks `unknown` (`ageGatePool`, Stremio search, TV/anime lanes). Decision: re-ask once,
then **drop** (don't cache).

**F4 — Urgent build path stores rows before the age gate and stamps `built_at` first (HIGH, kids).** The staged path is
safe (M6), but `buildRecommendations` + `ageGatePool` (engine change, manual build, urgent) still upserts into the live pool,
stamps `built_at`, then gates; a gate failure leaves un-vetted rows served and never retried. Decision: unvetted rows are never served.
Implement as `age_vetted_at` on the row (hide when NULL for age-limited profiles) + stamp `built_at` only after the gate succeeds.

**F5 — Companion search is ungated (HIGH, kids).** `mobile/server/handlers.js` `searchHandler` returns raw TMDB results;
the Stremio search runs the age chain, fail-closed. Decision: Companion search age-appropriate; **no LLM for unrestricted profiles**.
Extract the Stremio gate (`addon.handleSearch`) into a shared function and reuse it.

**F6 — Kid-editable filters (MED).** `COMPANION_FILTERS` lets an age-limited profile change `min_rating`, `min_year`,
`excluded_genres`, and `engine_anime` (turn the anime lane on). Decision: these are parental controls — read-only for
age-limited profiles on the phone (admin portal still edits them). Surface only a generic "managed by your admin".

**F7 — Transport/hardening (MED), unchanged from before:** `trust proxy: true` (left-most `X-Forwarded-For`), CORS `*` on
every route incl. `/api` and `/mobile`, no security headers, container runs as root, install token in 4xx/5xx logs,
`placehold.co` error-card poster. Decision: Cloudflare Tunnel only ⇒ `trust proxy` = 1 hop, CORS only on `/addon`, `USER node`.
Note the SameSite=Lax session cookie is what currently protects the portal from cross-site writes; keep it.

**F8 — Dependencies (HIGH):** `npm audit` still shows 3 vulns (nodemailer, proxy-addr critical, qs). Fixed earlier by
`npm audit fix` + `nodemailer@^10.1.0` (needs a real Brevo OTP send to confirm after deploy).

**F9 — Smaller:** `app.listen` ignores bind errors; Trakt ZIP inflate has no output cap; stale comment in
`mobile/server/router.js` ("outside the admin Basic Auth"); `.claude/launch.json` points at port 3000.

### Engine correctness
**F10 — Cross-type TMDB id collisions (MED).** `watchedStore.watchedIdSets()` still returns one untyped `tmdb` Set used by
`pipeline.js`, `marquee/sources.js`, `marquee/engagement.js`, `marqueeTv.js`, `shared/candidates.js`. TMDB movie and TV ids
overlap numerically, so a watched show can exclude an unrelated movie (and vice versa). Key as `type:tmdb_id` (as
`dont_recommend` already does).

**F11 — Marquee quality evidence is thin.** The spec's own backtests are one profile: hit@20 3/30 (m2), and 17 of 30
held-out titles were unreachable under that profile's *own* filters (recency/rating/votes). That is a settings decision,
not an engine bug, but the harness is only useful at ≥3 profiles and >10 targets. Cinema also takes ~165 s per build vs
~35–45 s for the old engines — fine in the background, worth watching on the 1-hourly tick and for the single global queue.

### Speed
- **Serving is fast [measured]:** 15.06 ms per catalog request vs 14.54 ms for `/health` on the same loopback ⇒ ~0.5 ms
  server-side, including calibration. No concern.
- Single global FIFO job queue: a long Trakt import or a 3-minute Cinema build blocks every other profile. Per-lane queues
  would remove head-of-line blocking (`lanes.js` already exists).
- Whole-file JSON caches that grow forever (`age-verdicts`, `released-titles`, …) rewritten on every save → SQLite table.
- Companion assets are `no-store` (every open re-downloads app.js/styles). `no-cache` + ETag gives the same freshness with 304s.

### UI
Configure (desktop) is much better than 7.15.3: shared header (Mobile / Server Config / Log out), explicit engines block,
sticky Save, readable status line, personal-key sources shown. Open items:
- **Hard reset + Delete:** Delete is in a Danger zone but with a bare `confirm()`; **Reset** (wipes pool *and* "don't recommend"
  flags) still sits beside Build/View with a bare `confirm()`. Decision: Danger zone with typed confirmation for both.
- Dead code remaining: `swapCatalog`, `applyCsmGate`, `saveWatchedActivity`/`pruneWatched` family (zero callers).
- Mobile Companion (verified at 375×812): the **header is still cramped** (brand wraps, "Log out" wraps and overflows),
  the **action buttons take ~45% of each row** so the title and the "because you watched…" reason truncate, icon-only
  actions, `theme-color` is a single dark value. Decision: put actions on their own labelled row under the text; one-line
  header; two-line reason; light/dark `theme-color`; ETag instead of `no-store`.
- Not audited: the new Ratings tab, Trainer UI, Anime panels, Catalog preview.

## Decisions already made by James (apply to v7)
Unvetted rows never served · LLM-omitted titles re-asked then dropped · Companion search age-appropriate, no LLM for adults ·
kid filters (genre/rating) are parental controls · first action creates the admin (v7 has the wizard; add a setup token) ·
Cloudflare Tunnel only · 60-min OTP OK · non-root container · ETag for the Companion · hard reset in a Danger zone with
typed confirmation (incl. wiping "don't recommend") · remove dead code · ratings/dropped signal + production-data review go to round 2.

## Porting plan
Do the work on a fresh branch off `origin/v7` (this worktree), not on the stale local `v7`:
1. F4, F3, F5, F6 (child safety) + F10 (typed ids) with tests.
2. F1, F2, F7, F8, F9 (auth/transport/deps/Docker).
3. UI: Danger zone + typed confirms; mobile header/row; ETag; dead-code removal.
4. Re-run the full suite; add `test/security.js`-style tests (kept from the earlier attempt; they port almost as-is).
The earlier attempt's patches (uncommitted in the old tree) are the reference implementation for F3/F4/F5/F6/F8/F9 and the UI CSS;
`adminAuth.js` is **not** to be ported (obsolete).

## What went wrong with the first review
I reviewed the local checkout (v7.15.3) without fetching, so the review and ~25 file edits targeted a base 40 versions behind
`origin/v7`. Everything above was re-derived against `origin/v7` itself. Lesson recorded: always `git fetch` and compare
versions before reviewing.

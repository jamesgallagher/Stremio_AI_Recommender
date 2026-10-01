# Step 6 — Trainer (Quick-train + List)

**Status:** ✅ BUILT (2026-10-01). The phone trains its own profile in two modes —
**Quick** (one big poster card at a time from the profile's *unrated* films) and
**List** (the portal Trainer's filtered, paged history as cards); movies only (the backend rejects series).

**Depends on:** Steps 1–5. **Reuses:** the portal's pure module `public/trainer-ui.js`
(served to the phone at `/mobile/trainer-ui.js` — the same file, no fork) and the
existing session-scoped `/mobile/api/trainer*` routes (no backend changes).

## The two modes

- **Quick** (default): one card at a time from `GET /trainer?view=unrated` (page size 50).
  Rate it with the star scrub (tap, drag, release) or use **♥ Love**, **Ignore**, **Skip**,
  or **Unwatch** — by button or by swipe — then the next card appears. `N left to rate`
  shows `counts.unrated`; when the unrated view is exhausted: *All caught up — everything
  you've watched is rated or ignored. 🎉*, with a **Review in List** button.
- **List**: the portal's chips (All / Unrated / Rated / Loved / Ignored / Unfinished), debounced search, rows via `rowHtml`, and pager.
  After an action the row is redrawn in place; only the chips and banner refresh (`refreshMeta`).

## Gestures

| Gesture | Effect |
|---|---|
| Star tap / drag / release (scrub) | Rate 1–10 in half-star steps; preview never saves; one save per gesture (800 ms rate queue) |
| Swipe card left | Ignore (snackbar with Undo) |
| Swipe card right | Skip (no request; the card won't come back this session) |
| Swipe card up | Love (rating 10) |
| Buttons | ♥ / Ignore / Skip / Unwatch — every action has a button (keyboard/desktop); star halves are keyboard-operable |

The card swipe never starts on the star group (`.tr-stars`) or a button; the star scrub owns horizontal drags on the stars.

## Shared logic

All Trainer logic (row rendering, chips, banner, pager text, the rate queue, the star
scrub, swipe math, quick-batch selection, rating text) lives in `public/trainer-ui.js` —
the portal's pure module, served to the phone as the same file at `/mobile/trainer-ui.js`.
T4 adds four pure helpers there (`ratingText`, `cardSwipeOutcome`, `pickQuickBatch`, `QUICK_ACTIONS`) with tests; no existing export's behaviour changed.
`mobile/public/trainer.js` is only the DOM controller (`window.trainerView = { open }`).

## Session-scoped routes (unchanged)

The phone never sends a profile id — every route acts on `req.profile`: `GET /trainer`
(list), `POST /trainer/rate`, `/trainer/ignore`, `/trainer/unwatched`, `/trainer/finished`,
`/trainer/rebuild` (202, no job polling on the phone). `canRate` comes from `GET /me`
(`simkl_connected`), fetched once per session.

## Themes

Dark-first tokens with a light override (`prefers-color-scheme: light`): `--star`
(#ffd34d / #e0a100), `--star-empty` (#6b7184 / #7a8094 — ≥3:1 against `--card2` in both
themes), `--love` (#f472b6 / #db2777). Every rated card also shows its value as text
(`ratingText`), so state is never conveyed by colour alone.

## Scope notice (P8)

If the profile's `filters.engine_movie` (from `GET /mobile/api/settings`) isn't `marquee`,
the view shows the portal's notice: ratings still save to Simkl, but this profile's movies
come from *<engine name>* (from `settings.engines`), so the Trainer won't change its
recommendations — switch the Movies engine to Marquee in Filters.

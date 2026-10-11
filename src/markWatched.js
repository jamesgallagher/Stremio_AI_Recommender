// MW-00 — Mark-as-watched core. The SINGLE transport-agnostic action every
// "mark watched" surface shares (the recs eye button, the catalog-preview eye,
// trainer "mark finished"), deliberately shaped like dontRecommend.suppress
// (no req/res, no HTML): each wrapper formats the plain result its own way, so
// behaviour can't drift between surfaces.
//
// A watched mark does exactly ONE authoritative thing — write the title to the
// profile's Simkl watched history — and lets the existing activities-gated sync
// pull the consequences through (a watched title becomes a taste seed + a
// de-dupe on the next sync, the same pipeline that already turns Simkl history
// into better recommendations).
//
// WD-1: we stamp the title's release date as watched_at (movies: release_date;
// series/anime: first_air_date) so the taste engines don't treat it as watched
// today. Rules: TMDB full date → use it; TMDB nothing + caller year → year-01-01;
// future date → clamp to now. A date-lookup problem NEVER blocks the mark —
// if the resolver fails, Simkl is still written (Simkl stamps "now").
//
// To leave the served lists IMMEDIATELY rather than after the next sync,
// it also records a local pending-watched shim (watchedStore) that every
// watched-prune path unions in — respecting keep-watched lists (Watch Later /
// Christmas) exactly as a Simkl-synced watch would.
const simkl = require('./services/simkl');
const watchedStore = require('./watchedStore');
const releaseDate = require('./releaseDate');

// PURE: build the /sync/history body for ONE title. A movie →
// movies:[{ids:{imdb|tmdb}}]; a series → shows:[{ids:{…}}] with NO seasons
// (Simkl marks the WHOLE show watched — MW marks whole titles only, never
// per-episode). When watchedAt is a non-empty string, it is added as
// watched_at next to ids; when absent, the body is byte-identical to the
// pre-WD-1 shape (Simkl stamps "now"). Neither id → an empty body.
// Exported for tests.
function buildWatchedHistoryBody({ type, imdbId = null, tmdbId = null, watchedAt = null } = {}) {
  const ids = {};
  if (imdbId) ids.imdb = String(imdbId);
  if (tmdbId != null && tmdbId !== '') ids.tmdb = String(tmdbId);
  if (!ids.imdb && !ids.tmdb) return { movies: [], shows: [] };   // nothing to match on
  const entry = { ids };
  if (watchedAt) entry.watched_at = watchedAt;
  return type === 'series'
    ? { movies: [], shows: [entry] }
    : { movies: [entry], shows: [] };
}

// The shared action. Writes the title to Simkl history (authoritative) and pins
// a pending-watched shim so serve-time watched-pruning drops it now. Returns a
// plain result the caller formats:
//   { ok:true,  type, imdbId, tmdbId, title, watchedAt }                 — marked
//   { ok:false, reason:'bad-type'|'no-id'|'no-simkl', title }              — nothing done
// Throws only if the Simkl write itself throws (token rejected / API error) —
// the caller maps that to a 502.
//
// `useReleaseDate` (default true): when false, skip the release-date lookup
// entirely (watchedAt stays null, Simkl stamps "now"). Used by trainer
// "mark finished" — a film the user was actually watching is a real recent
// watch, so back-dating it to its release date would hide a genuine signal.
async function markWatched(profile, { type, imdbId = null, tmdbId = null, title = null, year = null, useReleaseDate = true } = {}, log = console) {
  // Anime is accepted and mapped to series (fixes a latent 400: the mobile
  // handler allows anime but this function previously rejected it).
  if (type === 'anime') type = 'series';
  if (type !== 'movie' && type !== 'series') return { ok: false, reason: 'bad-type', title };
  if (!imdbId && tmdbId == null) return { ok: false, reason: 'no-id', title };
  if (!profile.keys?.simkl_client_id || !profile.simkl_auth?.access_token) {
    return { ok: false, reason: 'no-simkl', title };
  }

  // WD-1: resolve the release date. A date-lookup problem NEVER blocks the
  // mark — on failure, watchedAt stays null and Simkl stamps "now".
  // Skipped entirely when useReleaseDate is false (trainer "mark finished").
  let watchedAt = null;
  if (useReleaseDate) {
    try {
      watchedAt = await releaseDate.resolveReleaseDate(profile, { type, imdbId, tmdbId, year }, log);
    } catch {
      watchedAt = null;
    }
  }

  const body = buildWatchedHistoryBody({ type, imdbId, tmdbId, watchedAt });
  if (!body.movies.length && !body.shows.length) return { ok: false, reason: 'no-id', title };

  await simkl.addToHistory(profile, body);                               // authoritative Simkl write
  watchedStore.addPendingWatched(profile.id, { type, imdbId, tmdbId });  // immediate serve-prune shim (retired by supersession)
  log.log(`[watched] ${profile.name}: "${title || imdbId || tmdbId}" (${type}) → Simkl history${watchedAt ? ` (watched_at: ${watchedAt})` : ''}`);
  return { ok: true, type, imdbId, tmdbId, title, watchedAt };
}

module.exports = { buildWatchedHistoryBody, markWatched };

// MW-00 — Mark-as-watched core. The SINGLE transport-agnostic action every
// "mark watched" surface shares (the recs eye button, the catalog-preview eye),
// deliberately shaped like dontRecommend.suppress (no req/res, no HTML): each
// wrapper formats the plain result its own way, so behaviour can't drift between
// surfaces.
//
// A watched mark does exactly ONE authoritative thing — write the title to the
// profile's Simkl watched history — and lets the existing activities-gated sync
// pull the consequences through (a watched title becomes a taste seed + a
// de-dupe on the next sync, the same pipeline that already turns Simkl history
// into better recommendations). No date is sent: watched_at is omitted so Simkl
// stamps "now" (James: "do not add a date watched; if required, use current
// date"). To leave the served lists IMMEDIATELY rather than after the next sync,
// it also records a local pending-watched shim (watchedStore) that every
// watched-prune path unions in — respecting keep-watched lists (Watch Later /
// Christmas) exactly as a Simkl-synced watch would.
const simkl = require('./services/simkl');
const watchedStore = require('./watchedStore');

// PURE: build the /sync/history body for ONE title. A movie →
// movies:[{ids:{imdb|tmdb}}]; a series → shows:[{ids:{…}}] with NO seasons
// (Simkl marks the WHOLE show watched — MW marks whole titles only, never
// per-episode). watched_at is intentionally omitted so Simkl stamps "now".
// Neither id → an empty body (nothing for Simkl to match on). Exported for tests.
function buildWatchedHistoryBody({ type, imdbId = null, tmdbId = null } = {}) {
  const ids = {};
  if (imdbId) ids.imdb = String(imdbId);
  if (tmdbId != null && tmdbId !== '') ids.tmdb = String(tmdbId);
  if (!ids.imdb && !ids.tmdb) return { movies: [], shows: [] };   // nothing to match on
  return type === 'series'
    ? { movies: [], shows: [{ ids }] }
    : { movies: [{ ids }], shows: [] };
}

// The shared action. Writes the title to Simkl history (authoritative) and pins
// a pending-watched shim so serve-time watched-pruning drops it now. Returns a
// plain result the caller formats:
//   { ok:true,  type, imdbId, tmdbId, title }                              — marked
//   { ok:false, reason:'bad-type'|'no-id'|'no-simkl', title }              — nothing done
// Throws only if the Simkl write itself throws (token rejected / API error) —
// the caller maps that to a 502.
async function markWatched(profile, { type, imdbId = null, tmdbId = null, title = null } = {}, log = console) {
  if (type !== 'movie' && type !== 'series') return { ok: false, reason: 'bad-type', title };
  if (!imdbId && tmdbId == null) return { ok: false, reason: 'no-id', title };
  if (!profile.keys?.simkl_client_id || !profile.simkl_auth?.access_token) {
    return { ok: false, reason: 'no-simkl', title };
  }
  const body = buildWatchedHistoryBody({ type, imdbId, tmdbId });
  if (!body.movies.length && !body.shows.length) return { ok: false, reason: 'no-id', title };

  await simkl.addToHistory(profile, body);                               // authoritative Simkl write
  watchedStore.addPendingWatched(profile.id, { type, imdbId, tmdbId });  // immediate serve-prune shim (retired by supersession)
  log.log(`[watched] ${profile.name}: "${title || imdbId || tmdbId}" (${type}) → Simkl history`);
  return { ok: true, type, imdbId, tmdbId, title };
}

module.exports = { buildWatchedHistoryBody, markWatched };

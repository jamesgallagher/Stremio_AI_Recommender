// Abstract "do not recommend" action — the SINGLE code path shared by every
// surface that lets a user reject a title:
//   • the in-player link  (Stremio/Nuvio meta chip → GET /addon/:token/dnr/…)
//   • the configure portal (Advanced tab → POST /api/…/recommend/suppress)
//   • the Mobile Companion app (same POST)
//
// Callers hand us a resolved profile and a title identified by imdb id and/or
// tmdb id; we normalise to the tmdb id the pool is keyed by, record the user
// rejection (permanent — reason 'user'), and drop it from the pool so the
// catalog reflects it on the next serve. No rebuild needed: recommendations are
// filtered live from the pool at serve time, so removal is effectively instant
// (a client's own cached catalog row may lag by its cacheMaxAge — inherent to
// Stremio, not something we can force).
//
// Deliberately TRANSPORT-AGNOSTIC: no req/res, no HTML. Each wrapper formats the
// result its own way (the addon renders a confirmation page, the API returns
// JSON); this module is only the logic they share, so the behaviour can't drift
// between surfaces — including the Companion app, which reuses suppress() directly.
const recommendationStore = require('./recommendationStore');
const store = require('./store');
const settings = require('./settings');
const tmdb = require('./services/tmdb');

// Best-effort human title for the confirmation message. Cheapest source first:
// the pool row (no network), then a cached meta. Never fatal — a null title
// just yields a slightly less specific message. Must be read BEFORE suppress()
// deletes the pool row.
function knownTitle(profileId, type, imdbId, tmdbId) {
  const rows = recommendationStore.getRecommended(profileId, { type, limit: 100000 });
  const hit = rows.find((r) => (imdbId && r.imdb_id === imdbId)
    || (tmdbId && String(r.tmdb_id) === String(tmdbId)));
  if (hit?.title) return hit.title;
  if (imdbId) return store.loadMeta(type, imdbId)?.name || null;
  return null;
}

// Resolve to the tmdb id the pool is keyed by. Order, cheapest first:
//   1. Caller already supplied a tmdb id — use it, no work.
//   2. The title is in this profile's pool (rows hold both ids) — no network.
//   3. TMDB find-by-imdb, if a key is configured (covers titles never pooled,
//      e.g. a rejection tapped from a title opened by direct id).
async function resolveTmdbId(profile, type, imdbId, tmdbId, log = console) {
  if (tmdbId) return String(tmdbId);
  if (!imdbId) return null;
  const rows = recommendationStore.getRecommended(profile.id, { type, limit: 100000 });
  const hit = rows.find((r) => r.imdb_id === imdbId);
  if (hit) return String(hit.tmdb_id);
  const key = settings.keyFor(profile, 'tmdb_api_key');
  if (!key) return null;
  try {
    const id = await tmdb.findByImdbId(key, type, imdbId);
    return id ? String(id) : null;
  } catch (err) {
    log.warn(`[dnr] TMDB lookup for ${imdbId} failed: ${err.message}`);
    return null;
  }
}

// The shared action. Records a permanent user rejection and drops the title
// from the pool. Returns a plain result the caller formats:
//   { ok:true,  title, type, tmdbId, imdbId, total }              — recorded
//   { ok:false, reason:'bad-type'|'unresolved', title, imdbId }   — nothing done
async function suppress(profile, { type, imdbId = null, tmdbId = null, title = null } = {}, log = console) {
  if (type !== 'movie' && type !== 'series') {
    return { ok: false, reason: 'bad-type', title, imdbId };
  }
  // Capture the title before the pool row is deleted.
  const resolvedTitle = title || knownTitle(profile.id, type, imdbId, tmdbId);
  const id = await resolveTmdbId(profile, type, imdbId, tmdbId, log);
  if (!id) return { ok: false, reason: 'unresolved', title: resolvedTitle, imdbId };

  recommendationStore.addDontRecommend(profile.id, type, id, 'user');
  const total = recommendationStore.countRecommended(profile.id);
  log.log(`[dnr] ${profile.name}: "${resolvedTitle || imdbId || id}" (${type} tmdb:${id}) → don't recommend (pool now ${total})`);
  return { ok: true, title: resolvedTitle, type, tmdbId: id, imdbId, total };
}

module.exports = { suppress, resolveTmdbId, knownTitle };

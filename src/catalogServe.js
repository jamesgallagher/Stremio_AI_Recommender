// Shared catalog serve (CP-01). One function produces the served titles for a
// catalog + profile, so three surfaces agree by construction:
//   - the addon route (what Nuvio/Stremio actually receive),
//   - the portal preview API (GET /catalogs/:id/preview),
//   - the Mobile Companion preview (CP-02).
// The addon route wraps this with the Stremio envelope (skip pagination,
// cacheMaxAge/staleRevalidate, warming-up cards); everything about WHICH titles
// and in WHAT order lives here. "preview == serve" is not a promise to keep in
// sync — it's the same code path.
const store = require('./store');
const settings = require('./settings');
const catalogs = require('./catalogs');
const recommendationStore = require('./recommendationStore');
const watchedStore = require('./watchedStore');

// Always-on AI catalogs. CP-01 §4: manifest names carry NO type word — the
// client auto-appends "— Movie(s)" on the board, and our own portal/companion
// lists append the type themselves from def.type. Baking it in double-prints it.
const AI_CATALOGS = {
  'ai-recs-movies': { type: 'movie', name: 'Recommended for you' },
  'ai-recs-series': { type: 'series', name: 'Recommended for you' },
};

// RPDB (ratingposterdb.com): poster images with the rating rendered on them.
// Pure URL substitution at serve time — the cache keeps canonical TMDB posters,
// so adding/removing a key applies instantly without a rebuild. fallback=true
// makes RPDB redirect to a plain poster when it doesn't know the title.
function applyRpdb(metas, rpdbKey) {
  if (!rpdbKey) return metas;
  return metas.map((m) => (m.id && m.id.startsWith('tt')
    ? { ...m, poster: `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${m.id}.jpg?fallback=true` }
    : m));
}

// The served list for one catalog + profile, or null for an unknown catalog id.
// Returns { id, name, type, source, requirement_met, state, metas } where metas
// are post-watched-prune and post-RPDB — exactly what the addon returns a client
// (minus the Stremio envelope), same order. `state`:
//   'ok'              -> metas is the served list (may be [] if all were watched)
//   'needs_simkl'     -> AI/Watch Later can't build until Simkl is connected
//   'not_built'       -> buildable but the cache/pool is empty (still warming)
//   'empty'           -> Watch Later's Simkl plan-to-watch list is genuinely empty
//   'needs_mdblist_key' -> a curated list with no MDBList key available
// `record` fuels the recommendation decay lifecycle and must stay OFF for a
// read-only preview — only the addon serve path (record:true) is a real
// impression. Age gating is the caller's job (the cache is already age-filtered;
// the addon route and preview API also refuse an over-band catalog outright).
function servedCatalog(profile, catalogId, { record = false } = {}) {
  const aiCatalog = AI_CATALOGS[catalogId];
  const extraDef = !aiCatalog && catalogs.getExtra(catalogId);
  const def = aiCatalog || extraDef;
  if (!def) return null;
  const rpdbKey = settings.keyFor(profile, 'rpdb_api_key');

  if (aiCatalog) {
    const hasSimkl = !!profile.simkl_auth?.access_token;
    const raw = recommendationStore.serveRecommendations(profile, def.type, { record });
    if (!raw.length) {
      return {
        id: catalogId, name: def.name, type: def.type, source: 'ai',
        requirement_met: hasSimkl, state: hasSimkl ? 'not_built' : 'needs_simkl', metas: [],
      };
    }
    // Serve-time watched prune: the pool excludes watched at build, this catches
    // titles watched since. Union of both types — IMDb ids are global and
    // Simkl/TMDB can disagree on movie vs show.
    const watched = watchedStore.watchedIdSets(profile.id).imdb;
    const metas = applyRpdb(raw.filter((m) => !watched.has(m.id)), rpdbKey);
    return { id: catalogId, name: def.name, type: def.type, source: 'ai', requirement_met: true, state: 'ok', metas };
  }

  // Extras (Watch Later + curated MDBList lists): cache-only.
  const entry = store.loadCache(profile.id).extras?.[extraDef.id];
  const reqMet = catalogs.requirementMet(profile, extraDef);
  if (!entry || !entry.metas.length) {
    const state = extraDef.source === 'simkl_plantowatch'
      ? (reqMet ? 'empty' : 'needs_simkl')
      : (reqMet ? 'not_built' : 'needs_mdblist_key');
    return { id: extraDef.id, name: extraDef.name, type: extraDef.type, source: extraDef.source, requirement_met: reqMet, state, metas: [] };
  }
  // Serve-time watched pruning (v6): de-dupe against the Simkl-backed watched
  // store for every list EXCEPT those flagged dedupe_watched:false (Christmas
  // re-watchables and, since WL-KW, Watch Later). IMDb ids are global.
  let served = entry.metas;
  if (extraDef.dedupe_watched !== false) {
    const watchedImdb = watchedStore.watchedIdSets(profile.id).imdb;
    served = served.filter((m) => !watchedImdb.has(m.id));
  }
  // MW-03: "Not interested" now reaches every curated catalog, not just the AI
  // pool — drop suppressed titles here (imdb-keyed match). EXEMPT the two Watch
  // Later rows (source:'simkl_plantowatch'): the user's own plan-to-watch list
  // supersedes watched/not-interested, and its ✕ is a list-removal (MW-04), not
  // a suppression. The exemption is keyed on SOURCE, not dedupe_watched —
  // Christmas is also dedupe_watched:false but source:'mdblist', so it IS
  // filtered. AI catalogs never reach here (already suppression-clean).
  if (extraDef.source !== 'simkl_plantowatch') {
    const suppressed = recommendationStore.dontRecommendImdbSet(profile.id);
    served = served.filter((m) => !suppressed.has(m.id));
  }
  const metas = applyRpdb(served, rpdbKey);
  return { id: extraDef.id, name: extraDef.name, type: extraDef.type, source: extraDef.source, requirement_met: reqMet, state: 'ok', metas };
}

module.exports = { AI_CATALOGS, applyRpdb, servedCatalog };

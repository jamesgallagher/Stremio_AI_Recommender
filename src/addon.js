// Stremio addon endpoints — deliberately thin. Reads pre-computed cache only;
// never calls Trakt/LLM/TMDB in the request path. Stale cache triggers a
// background rebuild (fire-and-forget) via rebuild.ensureFresh.
const express = require('express');
const config = require('./config');
const store = require('./store');
const rebuild = require('./rebuild');
const catalogs = require('./catalogs');
const tmdb = require('./services/tmdb');
const llm = require('./services/groq');
const { version } = require('../package.json'); // single source of truth for the addon version

const router = express.Router({ mergeParams: true });

// Always-on AI catalogs. Optional extras (per-profile toggles) live in
// ./catalogs and are appended to the manifest dynamically.
const CATALOGS = {
  'ai-recs-movies': { type: 'movie', name: 'Movies recommended for you' },
  'ai-recs-series': { type: 'series', name: 'Series recommended for you' },
};

// Search-only catalogs (extraRequired: search — never shown on the board).
// Live TMDB search; kids profiles get the same two-layer age protection as
// their lists (CSM gate + AI goalkeeper), fail-closed.
const SEARCH_CATALOGS = {
  'ai-search-movies': { type: 'movie' },
  'ai-search-series': { type: 'series' },
};

// RPDB (ratingposterdb.com): poster images with the rating rendered on them.
// Pure URL substitution at serve time — cache keeps canonical TMDB posters, so
// adding/removing a key applies instantly without a rebuild. fallback=true
// makes RPDB redirect to a plain poster when it doesn't know the title.
function applyRpdb(metas, rpdbKey) {
  if (!rpdbKey) return metas;
  return metas.map((m) => (m.id && m.id.startsWith('tt')
    ? { ...m, poster: `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${m.id}.jpg?fallback=true` }
    : m));
}

// Watch Later mirrors the Trakt watchlist, so "empty" is a normal, lasting
// state — not a list still warming up. Advertising it anyway puts a permanent
// placeholder row on the home screen, so an empty one is dropped from the
// manifest entirely. Curated MDBList catalogs are NOT dropped: empty there
// means not-built-yet, and the warming-up card is the right answer.
//
// Trade-off: clients cache the manifest, so a watchlist that later gains its
// first title may not show the row again until the addon is reloaded.
function hasContent(profile, def) {
  if (def.source !== 'trakt_watchlist') return true;
  return (store.loadCache(profile.id).extras?.[def.id]?.metas || []).length > 0;
}

function manifestFor(profile, baseUrl = '') {
  return {
    id: `au.com.jscc.airecommender.${profile.id.substring(0, 8)}`,
    version,
    name: `AI Recommender — ${profile.name}`,
    description: `Personalized movie & series recommendations for ${profile.name}, generated from Trakt watch history via AI.`,
    ...(baseUrl ? { logo: `${baseUrl}/logo.png` } : {}),
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: ['catalog', 'meta'],
    catalogs: [
      { type: 'movie', id: 'ai-recs-movies', name: CATALOGS['ai-recs-movies'].name, extra: [{ name: 'skip', isRequired: false }] },
      { type: 'series', id: 'ai-recs-series', name: CATALOGS['ai-recs-series'].name, extra: [{ name: 'skip', isRequired: false }] },
      ...catalogs.enabledExtras(profile).filter((d) => hasContent(profile, d)).map((d) => (
        { type: d.type, id: d.id, name: d.name, extra: [{ name: 'skip', isRequired: false }] }
      )),
      ...Object.entries(SEARCH_CATALOGS).map(([id, s]) => ({
        type: s.type,
        id,
        name: 'Search',
        extra: [{ name: 'search', isRequired: true }],
        extraSupported: ['search'],
        extraRequired: ['search'],
      })),
    ],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

function errorCard(type, description) {
  return {
    id: `ai-recs-notice-${Date.now()}`,
    type,
    name: 'List warming up',
    poster: 'https://placehold.co/500x750/1a1d24/8b5cf6?text=Warming+up...',
    description,
    releaseInfo: '...',
  };
}

// Resolve profile from token on every request
router.use((req, res, next) => {
  const profile = config.getProfileByToken(req.params.token);
  if (!profile) return res.status(404).json({ error: 'Unknown profile token' });
  req.profile = profile;
  next();
});

const { baseUrl } = require('./baseurl');

router.get('/manifest.json', (req, res) => {
  res.json(manifestFor(req.profile, baseUrl(req)));
});

// Live search. The only request-path external calls in the addon — search
// cannot be precomputed. Kids profiles (age_limit > 0) get the SAME age
// protection as their lists: the remove-only AI goalkeeper (v5: CSM retired,
// so this is now the sole age authority here too — search must never be the
// weakest surface). FAIL-CLOSED: any gate failure (missing key, Groq down)
// returns no results rather than unfiltered ones.
async function handleSearch(profile, type, extraStr, res) {
  const raw = (extraStr.match(/search=([^&]+)/) || [])[1] || '';
  let query = '';
  try { query = decodeURIComponent(raw).trim(); } catch { query = raw.trim(); }
  if (query.length < 2 || !profile.keys.tmdb_api_key) {
    return res.json({ metas: [], cacheMaxAge: 300 });
  }
  const kids = (profile.filters.age_limit || 0) > 0;
  try {
    let metas = await tmdb.searchTitles(profile.keys.tmdb_api_key, type, query, kids ? 10 : 20);
    if (kids) {
      const vetoed = await llm.ageGate(
        profile.keys.groq_api_key, type, rebuild.judgementAge(profile.filters),
        metas.map((m) => ({ id: m.id, title: m.name, year: m.releaseInfo, overview: m.description })),
        console,
      );
      metas = metas.filter((m) => !vetoed.has(m.id));
    }
    console.log(`[search] ${profile.name}/${type} "${query}": ${metas.length} result(s)${kids ? ' (age-gated)' : ''}`);
    return res.json({ metas: applyRpdb(rebuild.cleanMetas(metas), profile.keys.rpdb_api_key), cacheMaxAge: 3600 });
  } catch (err) {
    console.warn(`[search] ${profile.name}/${type} "${query}" failed (${err.message}) — returning no results${kids ? ' (fail-closed)' : ''}`);
    return res.json({ metas: [], cacheMaxAge: 300 });
  }
}

// Metadata service. This exists so a device can run THIS addon plus a stream
// addon and nothing else: before it, a third-party metadata addon was required
// for playback, and that addon answered search UNFILTERED alongside our gated
// results — the kids' age protection was only as strong as the weakest addon
// installed next to it.
//
// Deliberately UNGATED by age: every discovery surface (lists, extras, search)
// is already gated, so nothing un-vetted reaches a child's screen through us,
// and gating here would put an LLM call in front of every title open. Opening
// a title by direct id is not discovery.
router.get('/meta/:type/:id', async (req, res) => {
  const { type } = req.params;
  const id = req.params.id.replace(/\.json$/, '');
  const profile = req.profile;
  if ((type !== 'movie' && type !== 'series') || !id.startsWith('tt')) {
    return res.status(404).json({ error: 'Unknown meta' });
  }
  // Cache first: a cached meta is a fact about the title and needs no API key,
  // so a profile with a broken/absent TMDB key still plays what's already known.
  const cached = store.loadMeta(type, id);
  if (cached) {
    return res.json({ meta: applyRpdb([cached], profile.keys.rpdb_api_key)[0], cacheMaxAge: 43200 });
  }
  if (!profile.keys.tmdb_api_key) return res.status(404).json({ error: 'TMDB key not configured' });
  try {
    const result = await tmdb.fullMeta(profile.keys.tmdb_api_key, type, id, console);
    if (!result) return res.status(404).json({ error: 'Not found' });
    store.saveMeta(type, id, result.meta, result.ttlMs);
    const eps = result.meta.videos ? ` (${result.meta.videos.length} episodes)` : '';
    console.log(`[meta] ${profile.name}/${type} ${id}: built${eps}`);
    return res.json({
      meta: applyRpdb([result.meta], profile.keys.rpdb_api_key)[0],
      cacheMaxAge: Math.floor(result.ttlMs / 1000),
    });
  } catch (err) {
    console.warn(`[meta] ${profile.name}/${type} ${id} failed: ${err.message}`);
    return res.status(404).json({ error: 'Meta unavailable' });
  }
});

// Matches /catalog/movie/ai-recs-movies.json and .../ai-recs-movies/skip=20.json
router.get('/catalog/:type/:catalogId{/:extra}', async (req, res) => {
  const catalogId = req.params.catalogId.replace(/\.json$/, '');
  const profile = req.profile;

  const searchDef = SEARCH_CATALOGS[catalogId];
  if (searchDef) {
    if (searchDef.type !== req.params.type) return res.status(404).json({ error: 'Unknown catalog' });
    const extraStr = (req.params.extra || '').replace(/\.json$/, '');
    return handleSearch(profile, searchDef.type, extraStr, res);
  }

  const aiCatalog = CATALOGS[catalogId];
  const extraDef = !aiCatalog && catalogs.getExtra(catalogId);
  const def = aiCatalog || extraDef;
  // Age-band catalogs are refused outright, not merely hidden — a client
  // holding a cached manifest must not be able to keep pulling a TV-14 list
  // after the profile's age limit was lowered.
  if (!def || def.type !== req.params.type
    || (extraDef && !(catalogs.isEnabled(profile, extraDef) && catalogs.ageAppropriate(profile, extraDef)))) {
    return res.status(404).json({ error: 'Unknown catalog' });
  }

  // Pagination beyond the list: empty (list is a fixed-size daily selection)
  const extra = (req.params.extra || '').replace(/\.json$/, '');
  const skip = parseInt((extra.match(/skip=(\d+)/) || [])[1] || '0', 10);

  rebuild.ensureFresh(profile); // SWR: fire-and-forget; this request serves cache
  rebuild.ensureExclusionsFresh(profile); // hourly watched-set refresh (background)

  const cache = store.loadCache(profile.id);
  const entry = extraDef ? cache.extras?.[extraDef.id] : cache[def.type];

  if (!entry || !entry.metas.length) {
    // An empty Watch Later is a real state, not a pending one — it's dropped
    // from the manifest, but a client with a cached manifest can still ask for
    // it. Answer honestly with nothing rather than a warming-up placeholder.
    if (extraDef?.source === 'trakt_watchlist') {
      return res.json({ metas: [], cacheMaxAge: 5 * 60 });
    }
    // Nothing cached yet (first install / not onboarded) — friendly card, short client cache
    const description = extraDef
      ? (extraDef.source === 'trakt_watchlist'
        ? (!profile.trakt_auth?.access_token
          ? 'Watch Later mirrors your Trakt watchlist — connect Trakt in the configure portal.'
          : 'Your Trakt watchlist is empty — long-press a title in Stremio/Nuvio and add it to your watchlist, or add one on trakt.tv.')
        : (profile.keys.mdblist_api_key
          ? 'This list is being generated — check back in a minute or two.'
          : 'This catalog needs an MDBList API key — add one in the configure portal.'))
      : (!profile.trakt_auth?.access_token
        ? 'This profile has not connected Trakt yet. Open the configure portal to finish setup.'
        : (!profile.keys.groq_api_key
          ? 'This profile has no Groq API key — AI recommendations are disabled until one is added in the configure portal.'
          : 'Your recommendations are being generated — check back in a minute or two.'));
    return res.json({ metas: skip > 0 ? [] : [errorCard(def.type, description)], cacheMaxAge: 5 * 60 });
  }

  // Serve-time watched pruning — AI catalogs AND Watch Later (a watch-later
  // list must not show what's been seen); curated MDBList extras ignore
  // watched status by design. Union of both types: IMDb IDs are global, and
  // Trakt/TMDB sometimes disagree on whether a title is a movie or a show.
  let served = entry.metas;
  if (!extraDef || extraDef.source === 'trakt_watchlist') {
    const watchedImdb = new Set([
      ...(cache.watched?.movie?.imdb || []),
      ...(cache.watched?.series?.imdb || []),
    ]);
    served = served.filter((m) => !watchedImdb.has(m.id));
  }

  const sliced = skip > 0 ? served.slice(skip) : served;
  const metas = applyRpdb(sliced, profile.keys.rpdb_api_key);
  res.json({
    metas,
    cacheMaxAge: 3600, // short client hint so pruned/rebuilt lists appear quickly
    staleRevalidate: 12 * 3600,
  });
});

module.exports = { router, manifestFor };

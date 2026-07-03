// Stremio addon endpoints — deliberately thin. Reads pre-computed cache only;
// never calls Trakt/Gemini/TMDB in the request path. Stale cache triggers a
// background rebuild (fire-and-forget) via rebuild.ensureFresh.
const express = require('express');
const config = require('./config');
const store = require('./store');
const rebuild = require('./rebuild');

const router = express.Router({ mergeParams: true });

const CATALOGS = {
  'ai-recs-movies': { type: 'movie', name: 'Movies recommended for you' },
  'ai-recs-series': { type: 'series', name: 'Series recommended for you' },
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

function manifestFor(profile, baseUrl = '') {
  return {
    id: `au.com.jscc.airecommender.${profile.id.substring(0, 8)}`,
    version: '1.0.0',
    name: `AI Recommender — ${profile.name}`,
    description: `Personalized movie & series recommendations for ${profile.name}, generated from Trakt watch history via Gemini.`,
    ...(baseUrl ? { logo: `${baseUrl}/logo.png` } : {}),
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: ['catalog'],
    catalogs: [
      { type: 'movie', id: 'ai-recs-movies', name: CATALOGS['ai-recs-movies'].name, extra: [{ name: 'skip', isRequired: false }] },
      { type: 'series', id: 'ai-recs-series', name: CATALOGS['ai-recs-series'].name, extra: [{ name: 'skip', isRequired: false }] },
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

// Matches /catalog/movie/ai-recs-movies.json and .../ai-recs-movies/skip=20.json
router.get('/catalog/:type/:catalogId{/:extra}', (req, res) => {
  const catalogId = req.params.catalogId.replace(/\.json$/, '');
  const catalog = CATALOGS[catalogId];
  if (!catalog || catalog.type !== req.params.type) {
    return res.status(404).json({ error: 'Unknown catalog' });
  }

  // Pagination beyond the list: empty (list is a fixed-size daily selection)
  const extra = (req.params.extra || '').replace(/\.json$/, '');
  const skip = parseInt((extra.match(/skip=(\d+)/) || [])[1] || '0', 10);

  const profile = req.profile;
  rebuild.ensureFresh(profile); // SWR: fire-and-forget; this request serves cache

  const cache = store.loadCache(profile.id);
  const entry = cache[catalog.type];

  if (!entry || !entry.metas.length) {
    // Nothing cached yet (first install / not onboarded) — friendly card, short client cache
    const description = profile.trakt_auth?.access_token
      ? 'Your recommendations are being generated — check back in a minute or two.'
      : 'This profile has not connected Trakt yet. Open the configure portal to finish setup.';
    return res.json({ metas: skip > 0 ? [] : [errorCard(catalog.type, description)], cacheMaxAge: 5 * 60 });
  }

  const sliced = skip > 0 ? entry.metas.slice(skip) : entry.metas;
  const metas = applyRpdb(sliced, profile.keys.rpdb_api_key);
  res.json({
    metas,
    cacheMaxAge: 12 * 3600, // client-side hint; server cache refreshes daily
    staleRevalidate: 24 * 3600,
  });
});

module.exports = { router, manifestFor };

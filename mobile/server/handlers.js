// Mobile Companion data handlers (Step 3+). All are session-guarded by the
// router, so they read `req.profile` (the signed-in profile) and NEVER a
// client-supplied profile id — that's the isolation guarantee.
const settings = require('../../src/settings');
const tmdb = require('../../src/services/tmdb');
const simkl = require('../../src/services/simkl');
const recommendationStore = require('../../src/recommendationStore');
const dontRecommend = require('../../src/dontRecommend');

const TYPES = ['movie', 'series'];
const SEARCH_LIMIT = 10;
const SEARCH_LIMIT_MAX = 12; // search does 1 + N detail calls — keep it light

// PURE: map a tmdb.searchTitles meta -> the mobile search DTO. Drops nulls and
// does not mutate the input. Exported for tests.
function toTitleDTO(meta) {
  if (!meta) return null;
  const year = meta.releaseInfo ? (parseInt(meta.releaseInfo, 10) || null) : null;
  return {
    id: meta.id,                       // imdb tt id
    type: meta.type,
    title: meta.name,
    year,
    poster: meta.poster || null,
    synopsis: meta.description || '',
    rating: meta.imdbRating || null,
    tmdb_id: meta._tmdb_id != null ? String(meta._tmdb_id) : null, // for Simkl matching
  };
}

// GET /api/search?q=&type=movie|series[&limit=]
async function searchHandler(req, res) {
  const q = String((req.query && req.query.q) || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Enter at least 2 characters' });
  const type = TYPES.includes(req.query && req.query.type) ? req.query.type : 'movie';
  let limit = parseInt(req.query && req.query.limit, 10) || SEARCH_LIMIT;
  limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, limit));

  const key = settings.keyFor(req.profile, 'tmdb_api_key'); // global-first, per-profile fallback
  if (!key) return res.status(503).json({ error: 'TMDB is not configured' });
  try {
    const metas = await tmdb.searchTitles(key, type, q, limit);
    res.json({ results: metas.map(toTitleDTO).filter(Boolean) });
  } catch (err) {
    res.status(502).json({ error: `Search failed — ${err.message}` });
  }
}

// POST /api/watchlist  { type, tmdb_id?, imdb_id?, title?, year? }
async function watchlistHandler(req, res) {
  const body = req.body || {};
  const { type, tmdb_id, imdb_id, title, year } = body;
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null && !imdb_id) return res.status(400).json({ error: 'tmdb_id or imdb_id is required' });
  if (!req.profile.simkl_auth?.access_token) {
    return res.status(400).json({ error: 'Simkl is not connected — connect it in the portal first' });
  }
  try {
    // Always targets req.profile — a profile id in the body is ignored.
    const out = await simkl.addToPlanToWatch(req.profile, { type, tmdb_id, imdb_id, title, year });
    res.json({ ok: true, added: out.added || {}, existing: out.existing || {}, skipped: !!out.skipped });
  } catch (err) {
    res.status(502).json({ error: `Could not add to watchlist — ${err.message}` });
  }
}

// ---- Step 4: recommendations tabs + swipe ----

const RECS_LIMIT = 200;      // "all items" — the whole pool per type (paginate if it grows)
const RECS_LIMIT_MAX = 500;

// PURE: map a `recommended` pool row -> the mobile Rec DTO. Exported for tests.
function toRecDTO(row) {
  if (!row) return null;
  return {
    id: row.imdb_id,                        // tt id — what suppress/watchlist act on
    tmdb_id: row.tmdb_id != null ? String(row.tmdb_id) : null,
    type: row.type,
    title: row.title,
    year: row.year || null,
    poster: row.poster || null,
    genre: row.primary_genre || null,
    rating: (row.vote_average != null && row.vote_average > 0) ? Number(row.vote_average) : null,
    because: row.because_title || null,     // "because you watched …"
  };
}

// GET /api/recommendations?type=movie|series[&limit=]
// Returns the RAW stored pool for the type (a curation/management view — the
// portal's Advanced tab shows the same table), newest/affinity order.
function recommendationsHandler(req, res) {
  const type = TYPES.includes(req.query && req.query.type) ? req.query.type : 'movie';
  let limit = parseInt(req.query && req.query.limit, 10) || RECS_LIMIT;
  limit = Math.min(RECS_LIMIT_MAX, Math.max(1, limit));
  const rows = recommendationStore.getRecommended(req.profile.id, { type, limit });
  res.json({ type, items: rows.map(toRecDTO).filter((r) => r && r.id) });
}

// POST /api/recommend/suppress  { type, tmdb_id?, imdb_id?, title? }  (swipe-right)
// Reuses the shared dontRecommend.suppress() — identical behaviour to the portal
// and the in-player /dnr link.
async function suppressHandler(req, res) {
  const body = req.body || {};
  const { type, tmdb_id, imdb_id, title } = body;
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null && !imdb_id) return res.status(400).json({ error: 'tmdb_id or imdb_id is required' });
  const result = await dontRecommend.suppress(req.profile, { type, imdbId: imdb_id, tmdbId: tmdb_id, title }, console);
  if (!result.ok) return res.status(result.reason === 'bad-type' ? 400 : 422).json({ error: `could not remove (${result.reason})` });
  res.json({ ok: true, title: result.title, tmdb_id: result.tmdbId, total: recommendationStore.countRecommended(req.profile.id) });
}

// POST /api/recommend/unsuppress  { type, tmdb_id }  (Undo a swipe-remove)
function unsuppressHandler(req, res) {
  const body = req.body || {};
  const { type, tmdb_id } = body;
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null) return res.status(400).json({ error: 'tmdb_id is required' });
  const restored = recommendationStore.removeDontRecommend(req.profile.id, type, tmdb_id);
  res.json({ ok: true, restored });
}

module.exports = {
  toTitleDTO, searchHandler, watchlistHandler,
  toRecDTO, recommendationsHandler, suppressHandler, unsuppressHandler,
  TYPES, SEARCH_LIMIT, SEARCH_LIMIT_MAX,
};

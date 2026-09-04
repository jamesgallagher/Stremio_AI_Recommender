// Mobile Companion data handlers (Step 3+). All are session-guarded by the
// router, so they read `req.profile` (the signed-in profile) and NEVER a
// client-supplied profile id — that's the isolation guarantee.
const settings = require('../../src/settings');
const config = require('../../src/config');
const catalogs = require('../../src/catalogs');
const tmdb = require('../../src/services/tmdb');
const simkl = require('../../src/services/simkl');
const recommendationStore = require('../../src/recommendationStore');
const watchedStore = require('../../src/watchedStore');
const dontRecommend = require('../../src/dontRecommend');

const TYPES = ['movie', 'series'];

// Filters the Companion is allowed to READ and WRITE. The age gate
// (filters.age_limit) is deliberately ABSENT — it is never returned, never
// rendered, and never writable through the phone (it stays a backend-only
// control). The server still USES the profile's age limit internally for the
// vetted-only "entire list" view; it just never leaves the server.
const COMPANION_FILTERS = ['min_rating', 'vote_count_floor', 'max_age_years', 'excluded_genres', 'list_size', 'title_decay_enabled', 'title_decay_days'];
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

// ---- Step 4/5: recommendations tabs + swipe ----

const POOL_LIMIT = 500;      // hard cap when reading the whole pool for a type
// Catalog view carries the served list PLUS a hidden on-deck bench, so removing
// a title can promote the next one ("one in, one out, from the top of the
// bench") with no round-trip. The bench is a slice of the SAME genre-balanced
// selection Stremio serves — selectServe(N) is a strict prefix of
// selectServe(N + k) — so the first `display_count` rows ARE the Stremio
// catalog, and the extra rows are just the promotion buffer.
const CATALOG_BENCH = 40;

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

// GET /api/recommendations?type=movie|series[&view=catalog|all]
// view=catalog (the default, or the profile's companion.catalog_only pref when
// ?view is omitted): the SERVED catalog — exactly what Stremio shows — plus a
// hidden on-deck bench for instant one-in-one-out promotion. `display_count` is
// how many the phone actually shows (the profile's list_size); rows beyond that
// are the bench.
// view=all: the whole ranked recommendation list ("entire recommendations list").
//
// BOTH views run the SAME pipeline — selectServe (the identical filters + genre
// balance Stremio serves), watched-pruned — differing only in the size cap. That
// guarantees the catalog is ALWAYS the exact first `display_count` of the entire
// list (they share one order and one filter set), so the two never disagree.
function recommendationsHandler(req, res) {
  const type = TYPES.includes(req.query && req.query.type) ? req.query.type : 'movie';
  const profile = req.profile;
  const filters = profile.filters || {};

  // Default view follows the saved preference; an explicit ?view=… overrides it.
  const catalogOnly = profile.companion ? profile.companion.catalog_only !== false : true;
  const requested = req.query && req.query.view;
  const view = (requested === 'catalog' || requested === 'all') ? requested : (catalogOnly ? 'catalog' : 'all');

  const rows = recommendationStore.getRecommended(profile.id, { type, limit: POOL_LIMIT });
  const displayCount = recommendationStore.listSizeFor(profile);
  // Catalog fetches list_size + a promotion bench; the entire-list view fetches
  // the whole ranked pool. selectServe(N) is a strict prefix of selectServe(∞),
  // so the catalog is exactly the first `display_count` of the entire list.
  const limit = view === 'all' ? rows.length : displayCount + CATALOG_BENCH;
  const picked = recommendationStore.selectServe(rows, filters, { limit });
  // Watched-prune like the addon does (the pool excludes watched at build; this
  // catches titles watched since) so the phone mirrors the Stremio row exactly.
  const watchedImdb = watchedStore.watchedIdSets(profile.id).imdb;
  const items = picked
    .filter((r) => !watchedImdb.has(r.imdb_id))
    .map(toRecDTO).filter((r) => r && r.id);
  res.json({ type, view, items, display_count: view === 'all' ? items.length : displayCount });
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

// ---- Step 5: settings (editable filters + Companion view pref) ----

// PURE: pull only the Companion-editable filters out of a profile's filters,
// with safe fallbacks. The age gate is NEVER included. Exported for tests.
function toCompanionFilters(f = {}) {
  const out = {};
  for (const k of COMPANION_FILTERS) {
    out[k] = k === 'excluded_genres' ? (Array.isArray(f[k]) ? f[k] : []) : (f[k] ?? null);
  }
  return out;
}
const catalogOnlyOf = (profile) => (profile.companion ? profile.companion.catalog_only !== false : true);

// The extra catalogs this profile may see (Catalogs tab). Age-appropriateness
// uses the profile's age limit WITHOUT exposing it — the same filtering the
// Stremio manifest applies (catalogs.ageAppropriate), so a kids profile never
// sees an over-band catalog. `requirement_met` flags whether the list's data
// source (Simkl / MDBList) is ready. Exported for tests.
function companionCatalogs(profile) {
  return catalogs.EXTRA_CATALOGS
    .filter((def) => catalogs.ageAppropriate(profile, def))
    .map((def) => ({
      id: def.id,
      name: def.name,
      type: def.type,
      enabled: catalogs.isEnabled(profile, def),
      source: def.source,
      min_imdb: def.min_imdb || 0,
      target: def.target || 20,
      dedupe_watched: def.dedupe_watched !== false,
      requirement_met: catalogs.requirementMet(profile, def),
    }));
}

// The full Companion settings payload — Filters tab (editable filters + view
// pref + genre options) and Catalogs tab (age-appropriate extra catalogs). Never
// includes the age gate. Exported for tests.
function companionSettings(profile) {
  return {
    filters: toCompanionFilters(profile.filters || {}),
    catalog_only: catalogOnlyOf(profile),
    genres: Object.keys(tmdb.GENRE_ALIASES).sort(),
    catalogs: companionCatalogs(profile),
  };
}

// GET /api/settings — Filters + Catalogs for the two settings tabs. Deliberately
// omits filters.age_limit (see COMPANION_FILTERS): the age gate is never shown or
// accessible through the Companion.
function settingsGetHandler(req, res) {
  res.json(companionSettings(req.profile));
}

// POST /api/settings — write the editable filters + view pref + catalog toggles.
// STRICT whitelist: only COMPANION_FILTERS + catalog_only + age-appropriate
// catalog ids are ever forwarded to updateProfile, so a crafted body can never
// reach the age gate (age_limit dropped even if present) nor enable a catalog the
// profile isn't allowed to see. Serve-time filters + catalog toggles take effect
// on the next fetch/manifest; vote_count_floor applies on the next rebuild.
function settingsPostHandler(req, res) {
  const b = req.body || {};
  const patch = {};
  const filterPatch = {};
  for (const k of COMPANION_FILTERS) if (b[k] !== undefined) filterPatch[k] = b[k];
  if (Object.keys(filterPatch).length) patch.filters = filterPatch; // age_limit can never be a key here
  if (b.catalog_only !== undefined) patch.companion = { catalog_only: !!b.catalog_only };
  if (b.catalogs && typeof b.catalogs === 'object') {
    // Accept toggles ONLY for catalogs this profile may see (age-appropriate).
    const allowed = new Set(catalogs.EXTRA_CATALOGS.filter((d) => catalogs.ageAppropriate(req.profile, d)).map((d) => d.id));
    const cat = {};
    for (const [id, on] of Object.entries(b.catalogs)) if (allowed.has(id)) cat[id] = !!on;
    if (Object.keys(cat).length) patch.catalogs = cat;
  }
  if (!patch.filters && !patch.companion && !patch.catalogs) return res.status(400).json({ error: 'Nothing to update' });

  let updated;
  try {
    updated = config.updateProfile(req.profile.id, patch); // validates + clamps each field
  } catch (err) {
    return res.status(423).json({ error: `Could not save — ${err.message}` });
  }
  if (!updated) return res.status(404).json({ error: 'Profile not found' });
  res.json({ ok: true, ...companionSettings(updated) });
}

module.exports = {
  toTitleDTO, searchHandler, watchlistHandler,
  toRecDTO, recommendationsHandler, suppressHandler, unsuppressHandler,
  toCompanionFilters, companionCatalogs, companionSettings, settingsGetHandler, settingsPostHandler,
  TYPES, COMPANION_FILTERS, SEARCH_LIMIT, SEARCH_LIMIT_MAX,
};

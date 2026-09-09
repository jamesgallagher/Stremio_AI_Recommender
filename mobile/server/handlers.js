// Mobile Companion data handlers (Step 3+). All are session-guarded by the
// router, so they read `req.profile` (the signed-in profile) and NEVER a
// client-supplied profile id — that's the isolation guarantee.
const settings = require('../../src/settings');
const config = require('../../src/config');
const catalogs = require('../../src/catalogs');
const engines = require('../../src/engines');
const tmdb = require('../../src/services/tmdb');
const simkl = require('../../src/services/simkl');
const recommendationStore = require('../../src/recommendationStore');
const watchedStore = require('../../src/watchedStore');
const dontRecommend = require('../../src/dontRecommend');
const markWatched = require('../../src/markWatched');
const catalogServe = require('../../src/catalogServe');

const TYPES = ['movie', 'series'];

// Filters the Companion is allowed to READ and WRITE. The age gate
// (filters.age_limit) is deliberately ABSENT — it is never returned, never
// rendered, and never writable through the phone (it stays a backend-only
// control). The server still USES the profile's age limit internally for the
// vetted-only "entire list" view; it just never leaves the server.
// v7: engine_movie/engine_series are companion-editable (see docs/engine-abstraction
// SC-02 §5) so a companion save round-trips the engine choice through the same
// strict whitelist as every other filter — and SC-03's rebuild-on-change fires
// for companion saves too. Still no age_limit exposure (the age gate is never a
// companion field). config.updateProfile validates the ids against the registry
// AND the profile's age limit, so a crafted unrestricted id lands on Genesis.
// The engine LIST/dropdown the companion offers is age-filtered server-side in
// SC-05; this card only makes read + write of the choice possible.
const COMPANION_FILTERS = ['min_rating', 'vote_count_floor', 'max_age_years', 'excluded_genres', 'list_size', 'title_decay_enabled', 'title_decay_days', 'engine_movie', 'engine_series'];
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

// POST /api/watchlist/remove  { type, tmdb_id?, imdb_id?, title? }  (MW-04)
// The ✕ on a WATCH LATER cell: remove the title from the Simkl plan-to-watch
// list. Plain list management — explicitly NOT a "not interested" suppression
// (it writes nothing to dont_recommend, so the title can still be recommended).
// The other lists' ✕ is suppression (MW-03); the UI decides which by the cell's
// source. Session-scoped (acts on req.profile), mirrors watchlistHandler's copy.
async function watchlistRemoveHandler(req, res) {
  const body = req.body || {};
  const { type, tmdb_id, imdb_id, title } = body;
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null && !imdb_id) return res.status(400).json({ error: 'tmdb_id or imdb_id is required' });
  if (!req.profile.simkl_auth?.access_token) {
    return res.status(400).json({ error: 'Simkl is not connected — connect it in the portal first' });
  }
  try {
    // Always targets req.profile — a profile id in the body is ignored.
    await simkl.removeFromPlanToWatch(req.profile, { type, tmdb_id, imdb_id, title });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Could not remove from Watch Later — ${err.message}` });
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

// POST /api/watched  { type, tmdb_id?, imdb_id?, title? }  (MW-00 — eye button)
// Marks the title watched via the shared markWatched action (Simkl history write
// + immediate pending-watched serve-prune). Session-scoped: acts on req.profile
// only — there is no id in the path/body to abuse. Mirrors watchlistHandler's
// Simkl-not-connected copy; a Simkl error is a 502 (never a silent failure).
async function watchedHandler(req, res) {
  const body = req.body || {};
  const { type, tmdb_id, imdb_id, title } = body;
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null && !imdb_id) return res.status(400).json({ error: 'tmdb_id or imdb_id is required' });
  if (!req.profile.simkl_auth?.access_token) {
    return res.status(400).json({ error: 'Simkl is not connected — connect it in the portal first' });
  }
  try {
    const out = await markWatched.markWatched(req.profile, { type, imdbId: imdb_id, tmdbId: tmdb_id, title }, console);
    if (!out.ok) return res.status(400).json({ error: `Could not mark watched (${out.reason})` });
    res.json({ ok: true, title: out.title || null });
  } catch (err) {
    res.status(502).json({ error: `Could not mark watched — ${err.message}` });
  }
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

// GET /api/catalogs/:catalogId/preview (CP-02) — the served titles for ONE of
// this profile's catalogs, so the phone can compare "what AI Recommender has"
// against what Nuvio shows, on the device. Session-scoped: the profile is
// req.profile (there is NO :id in the path to abuse — a profile can only ever
// preview its own catalogs). Delegates to CP-01's shared servedCatalog, so the
// list/order/prune/RPDB are identical to the portal preview AND to what the addon
// feeds the client, by construction. record:false keeps it read-only (peeking
// never advances the recommendation decay lifecycle).
//
// Companion age invariant (same discipline as companionCatalogs): an over-band
// extra (Kids/Anime TV-14) on an age-limited profile is a 404 with NO age reason
// leaked, and the payload carries NO age field — just titles/posters/ratings the
// cache has already age-filtered. RPDB posters already carry the rating; the
// numeric badge reads imdbRating (populated for AI/Watch Later by CP-03).
function catalogPreviewHandler(req, res) {
  const profile = req.profile;
  const catalogId = req.params.catalogId;
  // Refuse an over-band extra without hinting why — an age-limited profile must
  // never learn a catalog exists above its band, not even via preview.
  const extraDef = catalogs.getExtra(catalogId);
  if (extraDef && !catalogs.ageAppropriate(profile, extraDef)) {
    return res.status(404).json({ error: 'Catalog not available' });
  }
  const served = catalogServe.servedCatalog(profile, catalogId, { record: false });
  if (!served) return res.status(404).json({ error: 'Unknown catalog' });
  res.json({
    id: served.id,
    name: served.name,
    type: served.type,
    requirement_met: served.requirement_met,
    state: served.state,
    count: served.metas.length,
    // No age field — deliberately. Only the phone-safe meta fields.
    metas: served.metas.map((m) => ({
      id: m.id,
      name: m.name,
      poster: m.poster || null,
      imdbRating: m.imdbRating || null,
      releaseInfo: m.releaseInfo || null,
    })),
  });
}

// PURE: a phone-safe engine descriptor. Only id/name/description — capabilities
// and supported_types (internal flags) never leave the server (SC-05).
const engDTO = (e) => ({ id: e.id, name: e.name, description: e.description });

// The full Companion settings payload — Filters tab (editable filters + view
// pref + genre options + per-type engine choices) and Catalogs tab
// (age-appropriate extra catalogs). Never includes the age gate. Exported for tests.
function companionSettings(profile) {
  return {
    filters: toCompanionFilters(profile.filters || {}), // includes engine_movie/series via COMPANION_FILTERS
    catalog_only: catalogOnlyOf(profile),
    genres: Object.keys(tmdb.GENRE_ALIASES).sort(),
    catalogs: companionCatalogs(profile),
    // Per-type engine choices (SC-05). `available` is AGE-FILTERED and
    // ENABLEMENT-filtered SERVER-SIDE (engines.availableFor → I7 + SC-07): an
    // unrestricted or globally-disabled engine is simply never sent to the phone,
    // and the age limit that does the filtering is NEVER exposed (same discipline
    // companionCatalogs uses for age-band catalogs). `requirements` is the
    // effective engine's per-profile readiness so the UI can warn "needs Simkl" /
    // "needs a key" — its wording carries no age reference.
    engines: {
      available: {
        movie: engines.availableFor(profile, 'movie').map(engDTO),
        series: engines.availableFor(profile, 'series').map(engDTO),
      },
      requirements: {
        movie: engines.resolveFor(profile, 'movie').requirements(profile),
        series: engines.resolveFor(profile, 'series').requirements(profile),
      },
    },
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

  let updated; let engineChanged = [];
  try {
    ({ profile: updated, engineChanged } = config.updateProfile(req.profile.id, patch)); // validates + clamps each field
  } catch (err) {
    return res.status(423).json({ error: `Could not save — ${err.message}` });
  }
  if (!updated) return res.status(404).json({ error: 'Profile not found' });
  // SC-03: a companion engine change clears + rebuilds that slice too (fire-and-
  // forget). age_limit is never a companion field, so a revocation can't originate
  // here — only an explicit engine_movie/engine_series swap.
  if (engineChanged.length) {
    for (const t of engineChanged) recommendationStore.clearType(updated.id, t);
    recommendationStore.ensureBuilt(updated)
      .catch((err) => console.warn(`[rec] ${updated.name}: engine-change rebuild failed — ${err.message}`));
  }
  res.json({ ok: true, ...companionSettings(updated) });
}

module.exports = {
  toTitleDTO, searchHandler, watchlistHandler, watchlistRemoveHandler,
  toRecDTO, recommendationsHandler, suppressHandler, unsuppressHandler, watchedHandler,
  toCompanionFilters, companionCatalogs, companionSettings, settingsGetHandler, settingsPostHandler,
  catalogPreviewHandler,
  TYPES, COMPANION_FILTERS, SEARCH_LIMIT, SEARCH_LIMIT_MAX,
};

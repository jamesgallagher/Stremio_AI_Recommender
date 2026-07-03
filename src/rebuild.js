// Stale-while-revalidate rebuild pipeline.
//
// - Staleness-gated: rebuild only when generated_at is past STALE_MS (24h).
// - Per-profile in-memory lock: overlapping catalog opens serve stale, never
//   trigger a second concurrent job.
// - Backoff: failed attempts set last_attempt_at; no retry within BACKOFF_MS.
// - Failure never purges cache: each catalog type is atomically swapped only on
//   success with >= MIN_METAS usable titles. A 2-item "success" won't clobber a
//   good 20-item list.
const store = require('./store');
const trakt = require('./services/trakt');
const gemini = require('./services/gemini');
const tmdb = require('./services/tmdb');

const STALE_MS = (parseInt(process.env.STALE_HOURS, 10) || 24) * 3600e3;
const BACKOFF_MS = (parseInt(process.env.BACKOFF_MINUTES, 10) || 30) * 60e3;
const MIN_METAS = 5;
const TARGET_COUNT = 20;
const COLD_START_THRESHOLD = 3; // fewer history titles than this -> discover path

const locks = new Set(); // profile ids currently rebuilding

function isStale(catalog) {
  return !catalog || Date.now() - (catalog.generated_at || 0) > STALE_MS;
}

function status(profile) {
  const cache = store.loadCache(profile.id);
  return {
    movie: cache.movie
      ? { generated_at: cache.movie.generated_at, count: cache.movie.metas.length, source: cache.movie.source }
      : null,
    series: cache.series
      ? { generated_at: cache.series.generated_at, count: cache.series.metas.length, source: cache.series.source }
      : null,
    last_attempt_at: cache.last_attempt_at || 0,
    rebuilding: locks.has(profile.id),
    stale: isStale(cache.movie) || isStale(cache.series),
  };
}

// Hard post-resolution filter — the guarantee layer.
// Dedupe on canonical IDs against full watch history, then rating/recency/genre.
function applyHardFilters(metas, type, filters, watched, log = console) {
  const excludeGenreIds = tmdb.excludedGenreIds(filters.excluded_genres, type);
  const cutoff = filters.max_age_years > 0
    ? new Date(new Date().setFullYear(new Date().getFullYear() - filters.max_age_years))
    : null;
  const seen = new Set();
  const out = [];
  for (const meta of metas) {
    if (!meta) continue;
    if (seen.has(meta.id)) continue; // dedupe within the list itself
    if (watched.imdbIds.has(meta.id) || watched.tmdbIds.has(meta._tmdb_id)) {
      log.log(`[filter] "${meta.name}" already watched — dropped`);
      continue;
    }
    if (filters.min_rating > 0 && meta._vote_average > 0 && meta._vote_average < filters.min_rating) {
      log.log(`[filter] "${meta.name}" rating ${meta._vote_average} < ${filters.min_rating} — dropped`);
      continue;
    }
    if (cutoff && meta._release_date && new Date(meta._release_date) < cutoff) {
      log.log(`[filter] "${meta.name}" (${meta._release_date}) outside recency window — dropped`);
      continue;
    }
    if (meta._genre_ids.some((g) => excludeGenreIds.has(g))) {
      log.log(`[filter] "${meta.name}" in excluded genre — dropped`);
      continue;
    }
    seen.add(meta.id);
    out.push(meta);
  }
  return out;
}

// Strip internal fields before the metas are served to Stremio.
function cleanMetas(metas) {
  return metas.map(({ _tmdb_id, _genre_ids, _vote_average, _vote_count, _release_date, ...meta }) => meta);
}

async function buildCatalog(profile, type, log = console) {
  const { keys, filters } = profile;
  const history = await trakt.getRecentHistory(profile, type);
  const watched = await trakt.getWatchedSets(profile, type);

  let metas;
  let source;
  if (history.length < COLD_START_THRESHOLD) {
    // Cold start: skip Gemini entirely, use TMDB discover with the same filters
    log.log(`[rebuild] ${profile.name}/${type}: cold start (${history.length} history titles) — TMDB discover`);
    source = 'discover';
    const discovered = await tmdb.discover(keys.tmdb_api_key, type, filters, TARGET_COUNT * 2, log);
    metas = applyHardFilters(discovered, type, filters, watched, log);
  } else {
    log.log(`[rebuild] ${profile.name}/${type}: ${history.length} history titles — Gemini`);
    source = 'gemini';
    const suggestions = await gemini.getSuggestions(
      keys.gemini_api_key, type, history, filters, watched.titles, log
    );
    // Resolve all suggestions against TMDB in parallel; drop non-resolving
    const resolved = await Promise.all(
      suggestions.map((s) => tmdb.resolveTitle(keys.tmdb_api_key, type, s.title, s.year, log))
    );
    metas = applyHardFilters(resolved, type, filters, watched, log);
  }

  return { metas: cleanMetas(metas.slice(0, TARGET_COUNT)), source };
}

async function rebuildProfile(profile, log = console) {
  if (locks.has(profile.id)) return { skipped: 'locked' };
  locks.add(profile.id);
  const results = {};
  try {
    store.markAttempt(profile.id);
    for (const type of ['movie', 'series']) {
      try {
        const { metas, source } = await buildCatalog(profile, type, log);
        if (metas.length >= MIN_METAS) {
          store.swapCatalog(profile.id, type, metas, source); // atomic swap on success only
          results[type] = { ok: true, count: metas.length, source };
          log.log(`[rebuild] ${profile.name}/${type}: swapped in ${metas.length} titles (${source})`);
        } else {
          results[type] = { ok: false, error: `only ${metas.length} usable titles (< ${MIN_METAS}) — kept previous list` };
          log.warn(`[rebuild] ${profile.name}/${type}: ${results[type].error}`);
        }
      } catch (err) {
        results[type] = { ok: false, error: err.message };
        log.warn(`[rebuild] ${profile.name}/${type} failed: ${err.message} — kept previous list`);
      }
    }
  } finally {
    locks.delete(profile.id);
  }
  return results;
}

// Fire-and-forget SWR trigger from the addon request path.
function ensureFresh(profile, log = console) {
  const cache = store.loadCache(profile.id);
  const stale = isStale(cache.movie) || isStale(cache.series);
  if (!stale) return false;
  if (locks.has(profile.id)) return false;
  if (Date.now() - (cache.last_attempt_at || 0) < BACKOFF_MS) return false;
  if (!profile.trakt_auth?.access_token) return false; // not onboarded yet
  rebuildProfile(profile, log).catch((err) => log.error(`[rebuild] unexpected: ${err.message}`));
  return true;
}

module.exports = {
  ensureFresh,
  rebuildProfile,
  status,
  applyHardFilters,
  cleanMetas,
  isStale,
  STALE_MS,
  MIN_METAS,
  COLD_START_THRESHOLD,
};

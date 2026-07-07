// Stale-while-revalidate rebuild pipeline.
//
// - Staleness-gated: rebuild only when generated_at is past STALE_MS (24h).
// - Per-profile in-memory lock: overlapping catalog opens serve stale, never
//   trigger a second concurrent job.
// - Backoff: failed attempts set last_attempt_at; no retry within BACKOFF_MS.
// - Failure never purges cache: each catalog type is atomically swapped only on
//   success with >= MIN_METAS usable titles.
// - Fill-to-quota: each catalog targets filters.list_size titles; the Gemini
//   path runs extra rounds (expanding the exclusion list) until filled or
//   rounds are exhausted; the discover path walks extra pages.
// - Watched exclusion is cross-type on IMDb IDs: a title watched as a movie
//   on Trakt can never appear in the series catalog (or vice versa), covering
//   docs/miniseries that TMDB and Trakt classify differently.
// - Age limit (kids mode): when filters.age_limit > 0, EVERY candidate is
//   verified against Common Sense Media (via MDBList). No CSM rating => not
//   listed. CSM only — no fallback to other rating systems. A broken MDBList
//   lookup fails the rebuild (old list stays) rather than serving unverified.
const store = require('./store');
const trakt = require('./services/trakt');
const gemini = require('./services/gemini');
const tmdb = require('./services/tmdb');
const mdblist = require('./services/mdblist');

const STALE_MS = (parseInt(process.env.STALE_HOURS, 10) || 24) * 3600e3;
const BACKOFF_MS = (parseInt(process.env.BACKOFF_MINUTES, 10) || 30) * 60e3;
const WATCHED_REFRESH_MS = 60 * 60e3; // exclusion-only refresh cadence
const MIN_METAS = 5;
const DEFAULT_LIST_SIZE = 20;
const MAX_GEMINI_ROUNDS = 4;
const MAX_DISCOVER_PAGES = 10;
const COLD_START_THRESHOLD = 3;

const locks = new Set(); // profile ids currently rebuilding
const exclusionLocks = new Set(); // profile ids currently refreshing watched sets

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

// Cross-type watched exclusion sets. IMDb tt IDs are globally unique, so a
// title Trakt logged as a movie but TMDB resolved as a series (docs and
// miniseries flip type between the two databases) is still excluded. TMDB ids
// stay per-type: movie id 550 and TV id 550 are different titles.
function exclusionSets(watchedByType, type) {
  return {
    imdbIds: new Set([...watchedByType.movie.imdbIds, ...watchedByType.series.imdbIds]),
    tmdbIds: watchedByType[type].tmdbIds,
  };
}

// Hard post-resolution filter — the guarantee layer.
// Dedupe on canonical IDs against full watch history, then rating/recency/genre.
function applyHardFilters(metas, type, filters, watched, log = console, alreadyHave = new Set()) {
  const excludeGenreIds = tmdb.excludedGenreIds(filters.excluded_genres, type);
  const cutoff = filters.max_age_years > 0
    ? new Date(new Date().setFullYear(new Date().getFullYear() - filters.max_age_years))
    : null;
  const seen = new Set(alreadyHave);
  const out = [];
  for (const meta of metas) {
    if (!meta) continue;
    if (seen.has(meta.id)) continue;
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

// Kids-mode gate: strict Common Sense verification via MDBList.
// Every candidate is looked up; unrated titles are dropped, full stop.
async function applyCsmGate(metas, type, profile, log = console) {
  const limit = profile.filters.age_limit || 0;
  if (limit <= 0) return metas;
  if (!profile.keys.mdblist_api_key) {
    throw new Error('Age limit is set but no MDBList API key is configured — cannot verify Common Sense ratings');
  }
  const ages = await mdblist.commonSenseAges(
    profile.keys.mdblist_api_key, type, metas.map((m) => m.id), log
  );
  const out = [];
  for (const meta of metas) {
    const age = ages.get(meta.id);
    if (age === null || age === undefined) {
      log.log(`[csm] "${meta.name}" has no Common Sense rating — dropped (strict mode)`);
      continue;
    }
    if (age > limit) {
      log.log(`[csm] "${meta.name}" rated ${age}+ > limit ${limit}+ — dropped`);
      continue;
    }
    log.log(`[csm] "${meta.name}" rated ${age}+ — allowed`);
    out.push(meta);
  }
  return out;
}

// Strip internal fields before the metas are served to Stremio.
function cleanMetas(metas) {
  return metas.map(({ _tmdb_id, _genre_ids, _vote_average, _vote_count, _release_date, ...meta }) => meta);
}

async function buildCatalog(profile, type, watchedByType, log = console) {
  const { keys, filters } = profile;
  const listSize = filters.list_size || DEFAULT_LIST_SIZE;
  const history = await trakt.getRecentHistory(profile, type);
  const watched = exclusionSets(watchedByType, type);

  const collected = [];
  const haveIds = new Set();
  let source;

  if (history.length < COLD_START_THRESHOLD) {
    // Cold start: TMDB discover with the same filters, page by page until full
    log.log(`[rebuild] ${profile.name}/${type}: cold start (${history.length} history titles) — TMDB discover, target ${listSize}`);
    source = 'discover';
    for (let page = 1; page <= MAX_DISCOVER_PAGES && collected.length < listSize; page++) {
      const pageMetas = await tmdb.discoverPage(keys.tmdb_api_key, type, filters, page, log, watched.tmdbIds);
      if (!pageMetas.length) break;
      let usable = applyHardFilters(pageMetas, type, filters, watched, log, haveIds);
      usable = await applyCsmGate(usable, type, profile, log);
      for (const m of usable) {
        if (collected.length >= listSize) break;
        collected.push(m);
        haveIds.add(m.id);
      }
      log.log(`[rebuild] ${profile.name}/${type}: discover page ${page} -> ${collected.length}/${listSize}`);
    }
  } else {
    log.log(`[rebuild] ${profile.name}/${type}: ${history.length} history titles — Gemini, target ${listSize}`);
    source = 'gemini';
    // Titles listed in previous rebuilds (newest first) — asked to be avoided
    // so the daily list doesn't keep serving the same safe picks.
    const priorTitles = store.getSuggestedHistory(profile.id, type).slice().reverse();
    const suggestedTitles = new Set(); // everything Gemini returned this rebuild
    for (let round = 1; round <= MAX_GEMINI_ROUNDS && collected.length < listSize; round++) {
      const need = listSize - collected.length;
      const askCount = Math.min(40, Math.max(15, need * 2 + 5));
      // Avoid-list: this rebuild's suggestions first (including rejects, so
      // top-up rounds don't return the same rejects), then recently-listed
      // titles from earlier rebuilds. Watched-history exclusion is enforced
      // locally on IDs, not in the prompt.
      const excludeTitles = [...suggestedTitles, ...priorTitles];
      const suggestions = await gemini.getSuggestions(
        keys.gemini_api_key, type, history, filters, excludeTitles, log, askCount
      );
      suggestions.forEach((s) => suggestedTitles.add(s.title));
      const resolved = await Promise.all(
        suggestions.map((s) => tmdb.resolveTitle(keys.tmdb_api_key, type, s.title, s.year, log))
      );
      let usable = applyHardFilters(resolved, type, filters, watched, log, haveIds);
      usable = await applyCsmGate(usable, type, profile, log);
      for (const m of usable) {
        if (collected.length >= listSize) break;
        collected.push(m);
        haveIds.add(m.id);
      }
      log.log(`[rebuild] ${profile.name}/${type}: round ${round} -> ${collected.length}/${listSize}`);
    }
  }

  if (collected.length < listSize) {
    log.warn(`[rebuild] ${profile.name}/${type}: could not fully fill quota (${collected.length}/${listSize}) after all rounds`);
  }
  return { metas: cleanMetas(collected), source };
}

async function rebuildProfile(profile, log = console) {
  if (locks.has(profile.id)) return { skipped: 'locked' };
  locks.add(profile.id);
  const results = {};
  try {
    store.markAttempt(profile.id);
    // Backfill the Trakt account name for profiles connected before we
    // started recording it — surfaces wrong-account authorizations.
    if (profile.trakt_auth?.access_token && !profile.trakt_auth.username) {
      try {
        const username = await trakt.getAccountUsername(profile);
        const config = require('./config');
        config.updateProfile(profile.id, { trakt_auth: { ...profile.trakt_auth, username } });
        log.log(`[trakt] ${profile.name}: profile is authorized as Trakt user "${username}"`);
      } catch { /* non-fatal */ }
    }
    // One watched fetch per rebuild, shared by both catalogs — snapshot for
    // serve-time pruning and the cross-type exclusion sets.
    let watchedByType;
    try {
      // Activity timestamps are read BEFORE the watched lists: a play landing
      // in between makes the snapshot look older than it is, so the next
      // hourly check re-fetches — errors in the safe direction.
      const activity = await trakt.getLastActivities(profile);
      watchedByType = {
        movie: await trakt.getWatchedSets(profile, 'movie'),
        series: await trakt.getWatchedSets(profile, 'series'),
      };
      store.saveWatched(profile.id, 'movie', watchedByType.movie);
      store.saveWatched(profile.id, 'series', watchedByType.series);
      store.saveWatchedActivity(profile.id, activity);
    } catch (err) {
      const error = `Trakt watched fetch failed: ${err.message} — kept previous lists`;
      log.warn(`[rebuild] ${profile.name}: ${error}`);
      return { movie: { ok: false, error }, series: { ok: false, error } };
    }
    for (const type of ['movie', 'series']) {
      try {
        const { metas, source } = await buildCatalog(profile, type, watchedByType, log);
        if (metas.length >= MIN_METAS) {
          store.swapCatalog(profile.id, type, metas, source); // atomic swap on success only
          // Remember what was listed so future rebuilds steer Gemini away
          // from repeating it (rolling, capped avoid-list).
          store.addSuggestedHistory(profile.id, type, metas.map((m) => m.name));
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
  if (locks.has(profile.id) || exclusionLocks.has(profile.id)) return false;
  if (Date.now() - (cache.last_attempt_at || 0) < BACKOFF_MS) return false;
  if (!profile.trakt_auth?.access_token) return false;
  rebuildProfile(profile, log).catch((err) => log.error(`[rebuild] unexpected: ${err.message}`));
  return true;
}

// Cheap hourly exclusion refresh: re-fetch ONLY the watched sets (2 Trakt
// calls) and prune newly-watched titles from the cached lists in place, so
// watched items disappear within the hour instead of waiting for the daily
// rebuild. Never generates new recommendations.
function ensureExclusionsFresh(profile, log = console) {
  const cache = store.loadCache(profile.id);
  if (Date.now() - (cache.watched_synced_at || 0) < WATCHED_REFRESH_MS) return false;
  if (locks.has(profile.id) || exclusionLocks.has(profile.id)) return false;
  if (!profile.trakt_auth?.access_token) return false;
  exclusionLocks.add(profile.id);
  (async () => {
    try {
      // Change detection first: one cheap last_activities call. If nothing
      // was watched since the snapshot, skip the full watched downloads.
      const activity = await trakt.getLastActivities(profile);
      const prev = store.loadCache(profile.id).watched_activity;
      if (prev && prev.movies === activity.movies && prev.episodes === activity.episodes) {
        store.touchWatchedSync(profile.id);
        return;
      }
      const watchedByType = {
        movie: await trakt.getWatchedSets(profile, 'movie'),
        series: await trakt.getWatchedSets(profile, 'series'),
      };
      store.saveWatched(profile.id, 'movie', watchedByType.movie);
      store.saveWatched(profile.id, 'series', watchedByType.series);
      store.saveWatchedActivity(profile.id, activity);
      const unionImdb = new Set([...watchedByType.movie.imdbIds, ...watchedByType.series.imdbIds]);
      for (const type of ['movie', 'series']) {
        const removed = store.pruneWatched(profile.id, type, unionImdb);
        if (removed > 0) {
          log.log(`[exclusions] ${profile.name}/${type}: pruned ${removed} newly-watched title(s)`);
        }
      }
    } catch (err) {
      log.warn(`[exclusions] ${profile.name}: refresh failed: ${err.message}`);
    } finally {
      exclusionLocks.delete(profile.id);
    }
  })();
  return true;
}

module.exports = {
  ensureFresh,
  ensureExclusionsFresh,
  rebuildProfile,
  status,
  applyHardFilters,
  applyCsmGate,
  cleanMetas,
  isStale,
  STALE_MS,
  MIN_METAS,
  DEFAULT_LIST_SIZE,
  COLD_START_THRESHOLD,
};

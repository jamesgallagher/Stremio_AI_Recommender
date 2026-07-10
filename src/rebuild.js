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
// - Extra catalogs (curated MDBList lists, per-profile toggles): built and
//   swapped with the same discipline, but no watched exclusion and no taste
//   input. Popular charts unfiltered; the rest gated on IMDb rating >= 6.
//   The kids-mode CSM gate applies to extras too.
const store = require('./store');
const config = require('./config');
const catalogs = require('./catalogs');
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
const EXTRA_LIST_TARGET = 20; // extra catalogs are fixed at 20 titles
const MAX_EXTRA_PAGES = 5;
const EXTRA_PAGE_SIZE = 50;

const locks = new Set(); // profile ids currently rebuilding
const exclusionLocks = new Set(); // profile ids currently refreshing watched sets
// Per-catalog outcome of each profile's most recent completed rebuild.
// In-memory: the portal polls status.rebuilding after firing a rebuild (the
// endpoint returns immediately — a response held open for a multi-minute
// rebuild gets killed by proxies) and reads the results from here when done.
const lastResults = new Map(); // profile id -> { results, finished_at }

function isRebuilding(profileId) {
  return locks.has(profileId);
}

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
    last_results: lastResults.get(profile.id) || null,
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

// Fetch the full watched state (both types) and persist the snapshot plus the
// last_activities timestamps it corresponds to. With force=false the cheap
// last_activities call runs first and null is returned when nothing was
// watched since the stored snapshot (callers skip the expensive work).
// Activity is read BEFORE the watched lists: a play landing in between makes
// the snapshot look older than it is, so the next hourly check re-fetches —
// errors in the safe direction.
async function syncWatched(profile, { force = false } = {}) {
  const activity = await trakt.getLastActivities(profile);
  if (!force) {
    const prev = store.loadCache(profile.id).watched_activity;
    if (prev && prev.movies === activity.movies && prev.episodes === activity.episodes) return null;
  }
  const watchedByType = {
    movie: await trakt.getWatchedSets(profile, 'movie'),
    series: await trakt.getWatchedSets(profile, 'series'),
  };
  store.saveWatched(profile.id, 'movie', watchedByType.movie);
  store.saveWatched(profile.id, 'series', watchedByType.series);
  store.saveWatchedActivity(profile.id, activity);
  return watchedByType;
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
  const history = watchedByType[type].recent; // taste seed: most recently watched titles
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

// Fisher-Yates shuffle (in place, returns the same array). Used to randomize
// the order of extra catalogs on each rebuild so a static curated list looks
// fresh day to day and rotates different titles into the highlighted top slots.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Extra catalog: one curated MDBList list -> up to 20 metas. Rating-gated
// catalogs drop items whose IMDb rating is below the bar and keep paging until
// filled; popular charts (min_imdb 0) keep every item. The final selection is
// shuffled so the order looks fresh on each daily rebuild instead of serving
// the same fixed sequence. Watched status is ignored by design. Kids-mode age
// limits still apply — a child profile must never bypass the Common Sense gate
// via an extra catalog.
async function buildExtraCatalog(profile, def, log = console) {
  const key = profile.keys.mdblist_api_key;
  if (!key) throw new Error('MDBList API key is required for extra catalogs');
  const collected = [];
  const seen = new Set();
  for (let page = 0; page < MAX_EXTRA_PAGES && collected.length < EXTRA_LIST_TARGET; page++) {
    const items = await mdblist.listItemsPage(key, def.user, def.slug, def.type, {
      limit: EXTRA_PAGE_SIZE, offset: page * EXTRA_PAGE_SIZE, sort: def.sort,
    });
    if (!items.length) break;

    // Batch-enrich items whose list entry lacks a poster or (when gated) a
    // rating — one POST for the whole page instead of per-item lookups.
    const needInfo = items.filter((i) => {
      const id = i.imdb_id || i.ids?.imdb;
      return id && (!i.poster || (def.min_imdb > 0 && mdblist.parseImdbRating(i) === null));
    }).map((i) => i.imdb_id || i.ids?.imdb);
    let infoMap = new Map();
    if (needInfo.length) {
      try {
        infoMap = await mdblist.mediaInfoBatch(key, def.type, needInfo);
      } catch (err) {
        log.warn(`[extra] ${def.id}: batch enrich failed (${err.message}) — serving list data as-is`);
      }
    }

    let pageMetas = [];
    for (const item of items) {
      const imdb = item.imdb_id || item.ids?.imdb;
      if (!imdb || seen.has(imdb)) continue;
      seen.add(imdb);
      const info = infoMap.get(imdb);
      const rating = mdblist.parseImdbRating(item) ?? mdblist.parseImdbRating(info);
      // Unrated titles are kept — the gate only drops a rating that exists
      // and is below the bar (same semantics as the AI min-rating filter).
      if (def.min_imdb > 0 && rating !== null && rating < def.min_imdb) {
        log.log(`[extra] ${def.id}: "${item.title}" IMDb ${rating} < ${def.min_imdb} — dropped`);
        continue;
      }
      pageMetas.push({
        id: imdb,
        type: def.type,
        name: item.title || info?.title || imdb,
        poster: item.poster || info?.poster || null,
        description: item.description || info?.description || '',
        releaseInfo: String(item.release_year || info?.year || '') || null,
        imdbRating: rating !== null ? rating.toFixed(1) : null,
      });
    }
    pageMetas = await applyCsmGate(pageMetas, def.type, profile, log);
    for (const m of pageMetas) {
      if (collected.length >= EXTRA_LIST_TARGET) break;
      collected.push(m);
    }
    log.log(`[extra] ${profile.name}/${def.id}: page ${page + 1} -> ${collected.length}/${EXTRA_LIST_TARGET}`);
  }
  return shuffle(collected); // randomize order so the daily list looks fresh
}

// AI catalogs (movie + series): Trakt-seeded, Gemini/discover, watched-excluded.
async function buildAiCatalogs(profile, results, log) {
  // Backfill the Trakt account name for profiles connected before we
  // started recording it — surfaces wrong-account authorizations.
  if (!profile.trakt_auth.username) {
    try {
      const username = await trakt.getAccountUsername(profile);
      config.updateProfile(profile.id, { trakt_auth: { ...profile.trakt_auth, username } });
      log.log(`[trakt] ${profile.name}: profile is authorized as Trakt user "${username}"`);
    } catch { /* non-fatal */ }
  }
  // One watched fetch per rebuild, shared by both catalogs — snapshot for
  // serve-time pruning, exclusion sets, and the taste seed. force: the full
  // lists are needed even when nothing changed since the last snapshot.
  let watchedByType;
  try {
    watchedByType = await syncWatched(profile, { force: true });
  } catch (err) {
    const error = `Trakt watched fetch failed: ${err.message} — kept previous lists`;
    log.warn(`[rebuild] ${profile.name}: ${error}`);
    results.movie = { ok: false, error };
    results.series = { ok: false, error };
    return;
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
}

// opts.ai / opts.extras scope the rebuild (both default on) so an extras-only
// refresh never burns Gemini quota and vice versa.
async function rebuildProfile(profile, log = console, opts = {}) {
  if (locks.has(profile.id)) return { skipped: 'locked' };
  locks.add(profile.id);
  const results = {};
  try {
    store.markAttempt(profile.id);
    if (opts.ai !== false) {
      if (profile.trakt_auth?.access_token) {
        await buildAiCatalogs(profile, results, log);
      } else {
        const error = 'Trakt not connected — AI catalogs skipped';
        results.movie = { ok: false, error };
        results.series = { ok: false, error };
      }
    }
    if (opts.extras !== false) {
      for (const def of catalogs.enabledExtras(profile)) {
        try {
          const metas = await buildExtraCatalog(profile, def, log);
          if (metas.length >= MIN_METAS) {
            store.swapExtra(profile.id, def.id, metas);
            results[def.id] = { ok: true, count: metas.length };
            log.log(`[extra] ${profile.name}/${def.id}: swapped in ${metas.length} titles`);
          } else {
            results[def.id] = { ok: false, error: `only ${metas.length} usable titles (< ${MIN_METAS}) — kept previous list` };
            log.warn(`[extra] ${profile.name}/${def.id}: ${results[def.id].error}`);
          }
        } catch (err) {
          results[def.id] = { ok: false, error: err.message };
          log.warn(`[extra] ${profile.name}/${def.id} failed: ${err.message} — kept previous list`);
        }
      }
    }
  } finally {
    locks.delete(profile.id);
  }
  lastResults.set(profile.id, { results, finished_at: Date.now() });
  return results;
}

// Fire-and-forget SWR trigger from the addon request path and the scheduler.
// Scoped: only the stale halves (AI vs extras) are rebuilt, and each half is
// skipped when its prerequisite key/auth is missing.
function ensureFresh(profile, log = console) {
  const cache = store.loadCache(profile.id);
  const aiStale = (isStale(cache.movie) || isStale(cache.series))
    && !!profile.trakt_auth?.access_token;
  const extrasStale = !!profile.keys.mdblist_api_key
    && catalogs.enabledExtras(profile).some((d) => isStale(cache.extras?.[d.id]));
  if (!aiStale && !extrasStale) return false;
  if (locks.has(profile.id) || exclusionLocks.has(profile.id)) return false;
  if (Date.now() - (cache.last_attempt_at || 0) < BACKOFF_MS) return false;
  rebuildProfile(profile, log, { ai: aiStale, extras: extrasStale })
    .catch((err) => log.error(`[rebuild] unexpected: ${err.message}`));
  return true;
}

// Cheap hourly exclusion refresh: one last_activities call, and only when
// something new was watched, re-fetch the watched sets and prune those titles
// from the cached lists in place — watched items disappear within the hour
// instead of waiting for the daily rebuild. Never generates recommendations.
function ensureExclusionsFresh(profile, log = console) {
  const cache = store.loadCache(profile.id);
  if (Date.now() - (cache.watched_synced_at || 0) < WATCHED_REFRESH_MS) return false;
  if (locks.has(profile.id) || exclusionLocks.has(profile.id)) return false;
  if (!profile.trakt_auth?.access_token) return false;
  exclusionLocks.add(profile.id);
  (async () => {
    try {
      const watchedByType = await syncWatched(profile);
      if (!watchedByType) {
        store.touchWatchedSync(profile.id); // nothing new watched — snapshot still valid
        return;
      }
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
  buildExtraCatalog,
  status,
  isRebuilding,
  applyHardFilters,
  applyCsmGate,
  cleanMetas,
  isStale,
  STALE_MS,
  MIN_METAS,
  DEFAULT_LIST_SIZE,
  COLD_START_THRESHOLD,
};

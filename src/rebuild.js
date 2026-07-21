// Stale-while-revalidate rebuild pipeline.
//
// - Staleness-gated: rebuild only when generated_at is past STALE_MS (24h).
// - Per-profile in-memory lock: overlapping catalog opens serve stale, never
//   trigger a second concurrent job.
// - Backoff: failed attempts set last_attempt_at; no retry within BACKOFF_MS.
// - Failure never purges cache: each catalog type is atomically swapped only on
//   success with >= MIN_METAS usable titles.
// - Inverted pipeline (Phase 1): code builds a filtered candidate pool (TMDB
//   discover + recommendations/similar, IMDb-rated, exclusion-subtracted) and
//   the LLM ranks it by ID in ONE call. Top list_size displayed + equal bench.
// - Bench backfills the displayed list when items are watched (free, no LLM).
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
const llm = require('./services/groq');
const tmdb = require('./services/tmdb');
const mdblist = require('./services/mdblist');

const STALE_MS = (parseInt(process.env.STALE_HOURS, 10) || 24) * 3600e3;
const BACKOFF_MS = (parseInt(process.env.BACKOFF_MINUTES, 10) || 30) * 60e3;
const WATCHED_REFRESH_MS = 60 * 60e3; // exclusion-only refresh cadence
const MIN_METAS = 5;
const DEFAULT_LIST_SIZE = 20;
const COLD_START_THRESHOLD = 3;
// Bench (hidden reserve) is always the same size as the displayed list.
const POOL_TRIM = 120;           // candidates sent to the ranker (token budget)
const ENRICH_CAP = 150;          // cap on candidates we pay TMDB external_ids for (per pass)
const DISCOVER_PAGES = 5;        // discover pages fetched for the raw pool (first pass)
const DEEP_EXTRA_PAGES = 5;      // extra discover pages when the pool comes up short
const POOL_MIN_FACTOR = 3;       // deepen when pool < 3x list size (ranking needs choice)
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
  const prev = store.loadCache(profile.id).watched_activity || {};
  const watchedChanged = force
    || !(prev.movies === activity.movies && prev.episodes === activity.episodes);
  const watchlistChanged = prev.watchlist !== activity.watchlist;
  let watchedByType = null;
  if (watchedChanged) {
    watchedByType = {
      movie: await trakt.getWatchedSets(profile, 'movie'),
      series: await trakt.getWatchedSets(profile, 'series'),
    };
    store.saveWatched(profile.id, 'movie', watchedByType.movie);
    store.saveWatched(profile.id, 'series', watchedByType.series);
  }
  store.saveWatchedActivity(profile.id, activity); // records watchlist stamp too
  return { watchedByType, watchlistChanged };
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
  return metas.map(({ _tmdb_id, _genre_ids, _vote_average, _vote_count, _release_date, _imdb_rating, _original_language, ...meta }) => meta);
}

// Effective genre names for a candidate meta — Japanese animation surfaces as
// its own "Anime" pseudo-genre so Pixar-style family watches can't buy anime
// a seat in the distribution guard (and vice versa).
function metaGenres(m, type) {
  return tmdb.effectiveGenres(tmdb.genreNames(m._genre_ids, type), m._original_language);
}

// Enriched taste profile: last-N unique watched titles annotated with genres +
// a one-line overview (so recent/unknown titles still steer ranking), plus the
// viewer's most-watched genres as ballast against a recent binge.
async function buildTasteProfile(profile, type, recent, log) {
  const enriched = await Promise.all(recent.map(async (h) => {
    if (!h.tmdb_id) return { title: h.title, year: h.year, genres: [], overview: '' };
    try {
      const d = await tmdb.detailsForSeed(profile.keys.tmdb_api_key, type, h.tmdb_id);
      return { title: h.title, year: h.year, genres: d.genres, overview: d.overview };
    } catch (err) {
      log.warn(`[rebuild] seed enrich ${h.tmdb_id} failed: ${err.message}`);
      return { title: h.title, year: h.year, genres: [], overview: '' };
    }
  }));
  const freq = {};
  for (const h of enriched) for (const g of h.genres) freq[g] = (freq[g] || 0) + 1;
  const topGenres = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);
  return { recent: enriched, topGenres, genreFreq: freq };
}

// Cheap raw filters on a TMDB item (recency, excluded genres, vote-count floor).
// The rating floor is enforced later — the IMDb source needs enrichment first.
function rawPasses(item, type, filters) {
  if (filters.max_age_years > 0) {
    const d = type === 'series' ? item.first_air_date : item.release_date;
    if (d) {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - filters.max_age_years);
      if (new Date(d) < cutoff) return false;
    }
  }
  const ex = tmdb.excludedGenreIds(filters.excluded_genres, type);
  if (ex.size && (item.genre_ids || []).some((g) => ex.has(g))) return false;
  // "Anime" is our pseudo-genre (no TMDB id): Japanese-language animation.
  // Genre id 16 = Animation in both the movie and TV vocabularies.
  if ((filters.excluded_genres || []).includes('Anime')
      && item.original_language === 'ja'
      && (item.genre_ids || []).includes(16)) return false;
  if ((item.vote_count || 0) < tmdb.voteFloor(filters, type)) return false;
  return true;
}

// Build the candidate pool: discover + recommendations/similar -> dedupe ->
// raw filters -> popularity pre-trim -> enrich (imdb id + logo) -> exclude
// watched -> rating gate. Returns enriched metas (internal _fields intact).
async function buildPool(profile, type, watched, seedTmdbIds, listSize, log) {
  const { keys, filters } = profile;
  const target = POOL_MIN_FACTOR * listSize; // ranking needs real choice
  const triedTmdb = new Set(); // everything already collected — never re-enriched
  const haveImdb = new Set();
  const pool = [];

  // Adaptive depth: pass 1 is the normal fetch; pass 2 runs ONLY when heavy
  // exclusions/filters leave the pool under target (a well-watched profile
  // exhausts the popular slice fast) and digs further down the popularity
  // tail plus page 2 of every seed's similar/recommendations.
  const passes = [
    { fromPage: 1, pages: DISCOVER_PAGES, seedPage: 1 },
    { fromPage: DISCOVER_PAGES + 1, pages: DEEP_EXTRA_PAGES, seedPage: 2 },
  ];
  for (let p = 0; p < passes.length; p++) {
    if (p > 0) {
      if (pool.length >= target) break;
      log.log(`[rebuild] ${profile.name}/${type}: pool ${pool.length} < target ${target} — deepening (discover pages ${passes[p].fromPage}+, seed page ${passes[p].seedPage})`);
    }
    // Personalized candidates FIRST into the dedupe map so they keep their
    // flag when discover offers the same title.
    const personal = seedTmdbIds.length
      ? await tmdb.similarAndRecommended(keys.tmdb_api_key, type, seedTmdbIds, log, passes[p].seedPage) : [];
    for (const item of personal) if (item) item._personal = true;
    const raw = [
      ...personal,
      ...await tmdb.discoverRaw(keys.tmdb_api_key, type, filters, { fromPage: passes[p].fromPage, pages: passes[p].pages }),
    ];
    // Dedupe by TMDB id (across passes), drop watched-by-tmdb, apply raw filters.
    const byTmdb = new Map();
    for (const item of raw) {
      if (!item?.id || watched.tmdbIds.has(item.id) || triedTmdb.has(item.id) || byTmdb.has(item.id)) continue;
      if (rawPasses(item, type, filters)) byTmdb.set(item.id, item);
    }
    for (const id of byTmdb.keys()) triedTmdb.add(id);
    // Cap what we pay external_ids for. Personalized (similar/recommended)
    // candidates get priority — they're the long-tail taste matches this pool
    // exists for; a popularity-only cut would hand the cap to discover's
    // blockbusters every time. The personalized slice keeps its round-robin
    // per-seed order (fairness across seeds — re-sorting by popularity would
    // put TMDB's anime-heavy chart-toppers back on top); discover fills the
    // remainder by popularity.
    const byPop = (a, b) => (b.popularity || 0) - (a.popularity || 0);
    const all = [...byTmdb.values()];
    const ranked = [
      ...all.filter((i) => i._personal),
      ...all.filter((i) => !i._personal).sort(byPop),
    ].slice(0, ENRICH_CAP);
    log.log(`[rebuild] ${profile.name}/${type}: raw pool ${all.length} (${all.filter((i) => i._personal).length} personalized) -> enriching ${ranked.length}`);
    // Enrich in chunks — a wide parallel burst risks TMDB throttling.
    const enriched = [];
    for (let i = 0; i < ranked.length; i += 25) {
      const chunk = ranked.slice(i, i + 25);
      enriched.push(...await Promise.all(chunk.map((item) => tmdb.enrichCandidate(keys.tmdb_api_key, type, item, log))));
    }
    let metas = enriched.filter(Boolean);
    // Exclude watched by IMDb (cross-type) + dedupe by IMDb id across passes.
    metas = metas.filter((m) => {
      if (watched.imdbIds.has(m.id) || haveImdb.has(m.id)) return false;
      haveImdb.add(m.id);
      return true;
    });
    // Rating gate: IMDb (via MDBList) or TMDB. Unrated titles are kept — they
    // are not "below the bar" (same semantics as the extra-catalog gate).
    const useImdb = (filters.rating_source || 'imdb') === 'imdb' && !!keys.mdblist_api_key;
    if (filters.min_rating > 0 && useImdb) {
      const ratings = await mdblist.imdbRatings(keys.mdblist_api_key, type, metas.map((m) => m.id), log);
      metas = metas.filter((m) => {
        const r = ratings.get(m.id);
        if (r === null || r === undefined) return true;
        m._imdb_rating = r;
        m.imdbRating = r.toFixed(1);
        return r >= filters.min_rating;
      });
    } else if (filters.min_rating > 0) {
      metas = metas.filter((m) => !(m._vote_average > 0 && m._vote_average < filters.min_rating));
    }
    pool.push(...metas);
  }
  if (pool.length < target) {
    log.warn(`[rebuild] ${profile.name}/${type}: over-constrained profile — pool ${pool.length} after deepening (target ${target}). Consider widening the recency window, lowering min rating, or reducing the vote floor.`);
  }
  return pool;
}

// Trim a pool to `cap`, weighting candidates by how OFTEN their genres appear
// in the viewer's history (then rating). Frequency-weighted, not binary: Drama
// watched 12/20 outweighs Animation watched once, so a single niche title in
// the history can't buy its whole genre a large share of the ranking budget.
function trimByGenreWeight(pool, genreFreq, type, cap) {
  if (pool.length <= cap) return pool;
  return pool
    .map((m) => {
      const names = metaGenres(m, type);
      const weight = names.reduce((n, g) => n + (genreFreq[g] || 0), 0);
      return { m, weight, rating: m._imdb_rating ?? m._vote_average ?? 0 };
    })
    .sort((a, b) => b.weight - a.weight || b.rating - a.rating)
    .slice(0, cap)
    .map((s) => s.m);
}

// Deterministic distribution guard — "code filters, LLM ranks" applied to
// genre balance. Fill the displayed list in ranked order, but cap each
// PRIMARY genre at its share of the viewer's history (min 1 slot, so a new
// genre can still surface). LLM rankings drift toward whatever dominates the
// pool (e.g. TMDB's anime-heavy TV charts); this guarantees the displayed
// list mirrors the taste distribution no matter what the model does.
// Capped-out items are NOT dropped — they lead the bench.
function pickDisplayedByDistribution(orderedMetas, genreFreq, historyCount, type, listSize) {
  if (!historyCount) {
    return { displayed: orderedMetas.slice(0, listSize), rest: orderedMetas.slice(listSize) };
  }
  const counts = {};
  const displayed = [];
  const deferred = [];
  for (const m of orderedMetas) {
    if (displayed.length >= listSize) { deferred.push(m); continue; }
    const primary = metaGenres(m, type)[0] || 'Unknown';
    const cap = Math.max(1, Math.round(listSize * (genreFreq[primary] || 0) / historyCount));
    if ((counts[primary] || 0) >= cap) { deferred.push(m); continue; }
    counts[primary] = (counts[primary] || 0) + 1;
    displayed.push(m);
  }
  // If the caps left the list short, backfill from the deferred in rank order.
  while (displayed.length < listSize && deferred.length) displayed.push(deferred.shift());
  return { displayed, rest: deferred };
}

// One catalog (movie|series): pool -> CSM gate -> trim 120 -> shuffle -> ONE
// ranking call -> split into displayed (top list_size) + bench. Cold start, or
// a pool no larger than the display list, skips the LLM and serves by rating.
async function buildCatalog(profile, type, watchedByType, log = console) {
  const { filters } = profile;
  const listSize = filters.list_size || DEFAULT_LIST_SIZE;
  const recent = watchedByType[type].recent;
  const watched = exclusionSets(watchedByType, type);
  const seedTmdbIds = recent.slice(0, filters.pool_seed_count || 5).map((h) => h.tmdb_id).filter(Boolean);

  let pool = await buildPool(profile, type, watched, seedTmdbIds, listSize, log);
  pool = await applyCsmGate(pool, type, profile, log);
  log.log(`[rebuild] ${profile.name}/${type}: pool ${pool.length} after filters/exclusions`);
  if (pool.length < MIN_METAS) {
    log.warn(`[rebuild] ${profile.name}/${type}: pool only ${pool.length} — over-constrained profile`);
  }

  const splitOut = (metas, source) => {
    const all = cleanMetas(metas);
    return { displayed: all.slice(0, listSize), bench: all.slice(listSize, listSize * 2), source };
  };

  // Cold start / thin pool: no useful ranking to do — serve pool by rating.
  if (recent.length < COLD_START_THRESHOLD || pool.length <= listSize) {
    const why = recent.length < COLD_START_THRESHOLD ? `cold start (${recent.length} history)` : 'pool <= list size';
    log.log(`[rebuild] ${profile.name}/${type}: ${why} — serving pool by rating, no LLM`);
    pool.sort((a, b) => (b._imdb_rating ?? b._vote_average ?? 0) - (a._imdb_rating ?? a._vote_average ?? 0));
    const out = splitOut(pool, 'discover');
    log.log(`[rebuild] ${profile.name}/${type}: displayed (${out.displayed.length}): ${out.displayed.map((m) => m.name).join(', ')}`);
    return out;
  }

  // Rank: enrich taste, trim to the token budget, shuffle (position bias), rank.
  const taste = await buildTasteProfile(profile, type, recent, log);
  const trimmed = shuffle(trimByGenreWeight(pool, taste.genreFreq, type, POOL_TRIM));
  const byId = new Map(trimmed.map((m) => [m.id, m]));
  const candidates = trimmed.map((m) => ({
    id: m.id,
    title: m.name,
    year: m.releaseInfo ? Number(m.releaseInfo) : null,
    genres: metaGenres(m, type), // "Anime" distinct from "Animation" here too
    rating: m._imdb_rating ?? m._vote_average ?? null,
  }));
  // Ask for display + bench, clamped to the pool size — asking for more than
  // exist invites the model to invent ids (which validation would drop,
  // needlessly burning the retry/fallback chain).
  const ranked = await llm.rankCandidates(
    profile.keys.groq_api_key, type, taste, candidates, log,
    Math.min(listSize * 2, trimmed.length), Math.min(listSize, trimmed.length),
  );
  const scoreById = new Map(ranked.map((r) => [r.id, r.score]));
  const ordered = ranked.map((r) => byId.get(r.id)).filter(Boolean);
  // Distribution guard: displayed list mirrors the history's genre shares.
  const balanced = pickDisplayedByDistribution(ordered, taste.genreFreq, taste.recent.length, type, listSize);
  const out = {
    displayed: cleanMetas(balanced.displayed),
    bench: cleanMetas(balanced.rest.slice(0, listSize)),
    source: 'llm',
  };
  // Outcome logging — what actually got displayed, with scores. The prompt
  // alone can't tell you what the ranker chose; this line can.
  log.log(`[rebuild] ${profile.name}/${type}: displayed (${out.displayed.length}, ${balanced.rest.length} deferred/bench): ${out.displayed.map((m) => `${m.name} [${scoreById.get(m.id)}]`).join(', ')}`);
  return out;
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
// Watch Later: mirror of the profile's built-in Trakt watchlist, in the
// user's own order. No taste/rating filters — every item is an explicit user
// choice — but watched titles are excluded (a watch-later list must not show
// what's been seen) and the kids-mode CSM gate still applies. Metas enrich
// via one TMDB details call each; items TMDB can't resolve fall back to a
// minimal tt-id meta (RPDB fills the poster at serve time).
const WATCHLIST_CAP = 100;

async function buildWatchlistCatalog(profile, def, log = console) {
  if (!profile.trakt_auth?.access_token) {
    throw new Error('Trakt is not connected — Watch Later mirrors your Trakt watchlist');
  }
  const items = await trakt.getWatchlist(profile, def.type);
  log.log(`[watchlist] ${profile.name}/${def.type}: ${items.length} item(s) on the Trakt watchlist`);
  const watchedImdb = new Set([
    ...(store.loadCache(profile.id).watched?.movie?.imdb || []),
    ...(store.loadCache(profile.id).watched?.series?.imdb || []),
  ]);
  const capped = items.slice(0, WATCHLIST_CAP);
  const metas = [];
  for (let i = 0; i < capped.length; i += 25) {
    const chunk = capped.slice(i, i + 25);
    metas.push(...await Promise.all(chunk.map(async (it) => {
      if (it.imdb_id && watchedImdb.has(it.imdb_id)) return null;
      if (it.tmdb_id) {
        const m = await tmdb.metaByTmdbId(profile.keys.tmdb_api_key, def.type, it.tmdb_id, log);
        if (m) return m;
      }
      // Minimal fallback — still a valid tt id for Stremio; RPDB poster at serve time.
      return it.imdb_id
        ? { id: it.imdb_id, type: def.type, name: it.title, poster: null, description: '', releaseInfo: it.year ? String(it.year) : null }
        : null;
    })));
  }
  let out = metas.filter((m) => m && !watchedImdb.has(m.id));
  out = await applyCsmGate(out, def.type, profile, log); // kids gate is never bypassed
  return cleanMetas(out);
}

async function buildExtraCatalog(profile, def, log = console) {
  if (def.source === 'trakt_watchlist') return buildWatchlistCatalog(profile, def, log);
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

// AI catalogs (movie + series): Trakt-seeded, LLM/discover, watched-excluded.
async function buildAiCatalogs(profile, results, log) {
  // Hard requirement: no Groq key, no run — the AI catalogs are disabled
  // entirely (including the cold-start path) until a key is added. Checked
  // before any network work.
  if (!profile.keys.groq_api_key) {
    const error = 'Groq API key missing — AI catalogs are disabled until one is added';
    log.warn(`[rebuild] ${profile.name}: ${error}`);
    results.movie = { ok: false, error };
    results.series = { ok: false, error };
    return;
  }
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
    ({ watchedByType } = await syncWatched(profile, { force: true }));
  } catch (err) {
    const error = `Trakt watched fetch failed: ${err.message} — kept previous lists`;
    log.warn(`[rebuild] ${profile.name}: ${error}`);
    results.movie = { ok: false, error };
    results.series = { ok: false, error };
    return;
  }
  const listSize = profile.filters.list_size || DEFAULT_LIST_SIZE;
  for (const type of ['movie', 'series']) {
    try {
      const { displayed, bench, source } = await buildCatalog(profile, type, watchedByType, log);
      if (displayed.length >= MIN_METAS) {
        store.swapCatalog(profile.id, type, displayed, bench, source, listSize); // atomic swap on success only
        results[type] = { ok: true, count: displayed.length, bench: bench.length, source };
        log.log(`[rebuild] ${profile.name}/${type}: swapped in ${displayed.length} + ${bench.length} bench (${source})`);
      } else {
        results[type] = { ok: false, error: `only ${displayed.length} usable titles (< ${MIN_METAS}) — kept previous list` };
        log.warn(`[rebuild] ${profile.name}/${type}: ${results[type].error}`);
      }
    } catch (err) {
      results[type] = { ok: false, error: err.message };
      log.warn(`[rebuild] ${profile.name}/${type} failed: ${err.message} — kept previous list`);
    }
  }
}

// opts.ai / opts.extras scope the rebuild (both default on) so an extras-only
// refresh never burns LLM quota and vice versa.
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
          // Watch Later is a mirror, not a generated list: any size — even
          // empty — is the true state of the user's watchlist, so it always
          // swaps. Curated lists keep the >= MIN_METAS quality gate.
          if (def.source === 'trakt_watchlist' || metas.length >= MIN_METAS) {
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
    && !!profile.trakt_auth?.access_token
    && !!profile.keys.groq_api_key; // hard requirement: no Groq key, no AI rebuilds
  const extrasStale = catalogs.enabledExtras(profile).some(
    (d) => catalogs.requirementMet(profile, d) && isStale(cache.extras?.[d.id]),
  );
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
      const { watchedByType, watchlistChanged } = await syncWatched(profile);
      if (watchedByType) {
        const unionImdb = new Set([...watchedByType.movie.imdbIds, ...watchedByType.series.imdbIds]);
        for (const type of ['movie', 'series']) {
          const removed = store.pruneWatched(profile.id, type, unionImdb);
          if (removed > 0) {
            log.log(`[exclusions] ${profile.name}/${type}: pruned ${removed} newly-watched title(s)`);
          }
        }
      }
      // Watch Later freshness: when last_activities says the watchlist moved,
      // rebuild just the watchlist catalogs (no LLM, a handful of API calls) —
      // titles added from Stremio/Nuvio's long-press appear within the hour.
      if (watchlistChanged) {
        for (const def of catalogs.enabledExtras(profile).filter((d) => d.source === 'trakt_watchlist')) {
          try {
            const metas = await buildExtraCatalog(profile, def, log);
            store.swapExtra(profile.id, def.id, metas);
            log.log(`[watchlist] ${profile.name}/${def.id}: refreshed (${metas.length} titles) — watchlist changed on Trakt`);
          } catch (err) {
            log.warn(`[watchlist] ${profile.name}/${def.id}: refresh failed: ${err.message}`);
          }
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
  applyCsmGate,
  cleanMetas,
  rawPasses,
  trimByGenreWeight,
  pickDisplayedByDistribution,
  isStale,
  STALE_MS,
  MIN_METAS,
  DEFAULT_LIST_SIZE,
  COLD_START_THRESHOLD,
};
